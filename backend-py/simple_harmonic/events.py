"""App event emitter -- the feedback loop for dogfooding.

TS source: packages/backend/src/server/app-events.ts

Captures errors, warnings, and health signals. This slice ports the two
load-bearing, store-independent pieces:

  - scrub_pii: strips API keys, tokens, and emails before persistence. Pattern
    ORDER matters (one pattern uses a lookbehind), and it is shared by both app
    events and the agent trace sink, so it lives here and trace.py imports it.
  - emit_app_event: fire-and-forget. It swallows ALL errors (e.g. the store not
    being initialized during startup), applies per-agent rate limiting, scrubs
    PII, and routes infra/tool events through a telemetry gate.

The TS emitter writes through the store repos (appEvents.insert, teams.byId).
To keep this module decoupled from store/ (which this slice must not touch),
the persistence + telemetry-read are injectable hooks (set_event_sink /
set_telemetry_reader) that default to no-ops. The runtime wires real store
calls in a later slice; the no-op default preserves the "silently skip when the
store isn't ready" behavior verbatim.

Python `re` supports the same lookbehind syntax as the TS regex; the patterns
are copied byte-for-byte with `re.IGNORECASE` where the TS used the `i` flag.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable
from typing import Any, Literal

AppEventLevel = Literal["agent", "team", "tool", "infra"]
Severity = Literal["info", "warning", "error"]

# ---------------------------------------------------------------------------
# PII scrubbing: strip tokens, emails, keys before persistence
#
# ORDER IS LOAD-BEARING. The generic "long secret after = or :" pattern uses a
# lookbehind in the TS source and must run before the email pattern, exactly as
# in the TS array. Python's stdlib `re` rejects the VARIABLE-width lookbehind
# `(?<=[=:]\s*)` that JS accepts, so that one pattern is expressed as a
# capturing prefix `([=:]\s*)` plus a replacement that re-emits the prefix
# (\g<1>) and redacts only the secret — byte-for-byte identical output. Each
# pattern carries its own replacement; all others redact the whole match.
# ---------------------------------------------------------------------------

_REDACTED = "[REDACTED]"

_PII_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # API keys and tokens (common prefixes)
    (re.compile(r"\b(sk-[a-zA-Z0-9_-]{20,})\b"), _REDACTED),
    (re.compile(r"\b(ghp_[a-zA-Z0-9]{36,})\b"), _REDACTED),
    (re.compile(r"\b(gho_[a-zA-Z0-9]{36,})\b"), _REDACTED),
    (re.compile(r"\b(xoxb-[a-zA-Z0-9-]+)\b"), _REDACTED),
    (re.compile(r"\b(xoxp-[a-zA-Z0-9-]+)\b"), _REDACTED),
    (re.compile(r"\b(Bearer\s+[a-zA-Z0-9._-]{20,})\b", re.IGNORECASE), _REDACTED),
    # Generic long secret-looking strings (base64-ish, 32+ chars after = or :).
    # TS: /(?<=[=:]\s*)[A-Za-z0-9+/]{32,}={0,2}\b/g — the prefix is preserved.
    (re.compile(r"([=:]\s*)[A-Za-z0-9+/]{32,}={0,2}\b"), r"\g<1>" + _REDACTED),
    # Email addresses
    (re.compile(r"\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b"), _REDACTED),
]


def scrub_pii(message: str) -> str:
    """Strip API keys, tokens, and emails from a string before persistence.
    Shared by app events and the agent trace sink."""
    scrubbed = message
    for pattern, replacement in _PII_PATTERNS:
        scrubbed = pattern.sub(replacement, scrubbed)
    return scrubbed


# ---------------------------------------------------------------------------
# Rate limiting: 50 events per agent per hour
# ---------------------------------------------------------------------------

RATE_LIMIT = 50
RATE_WINDOW_MS = 3_600_000


class _RateEntry:
    __slots__ = ("count", "limited", "window_start")

    def __init__(self, window_start: float) -> None:
        self.count = 0
        self.window_start = window_start
        self.limited = False


_rate_counts: dict[str, _RateEntry] = {}


def _now_ms() -> float:
    return time.time() * 1000


def _check_rate_limit(agent_id: str | None) -> bool:
    if not agent_id:
        return True  # system events aren't rate-limited
    now = _now_ms()
    entry = _rate_counts.get(agent_id)

    if entry is None or now - entry.window_start > RATE_WINDOW_MS:
        entry = _RateEntry(window_start=now)
        _rate_counts[agent_id] = entry

    entry.count += 1

    if entry.count > RATE_LIMIT:
        if not entry.limited:
            # Emit one final "rate limited" event, then silence
            entry.limited = True
            return True  # allow this one through (the rate_limited event)
        return False  # drop
    return True


# ---------------------------------------------------------------------------
# Injectable hooks (store wiring lands in a later slice; defaults are no-ops)
# ---------------------------------------------------------------------------

EventSink = Callable[[dict[str, Any]], None]
TelemetryReader = Callable[[str], bool]


def _default_sink(_row: dict[str, Any]) -> None:
    # No store wired yet: behave like a not-yet-initialized DB and drop.
    raise RuntimeError("event sink not configured")


_event_sink: EventSink = _default_sink
_telemetry_reader: TelemetryReader | None = None


def set_event_sink(sink: EventSink) -> None:
    """Wire the persistence backend (store.appEvents.insert equivalent)."""
    global _event_sink
    _event_sink = sink


def set_telemetry_reader(reader: TelemetryReader | None) -> None:
    """Wire the team-telemetry lookup (store.teams.byId().telemetryEnabled)."""
    global _telemetry_reader
    _telemetry_reader = reader


def _is_telemetry_enabled(team_id: str) -> bool:
    if _telemetry_reader is None:
        return True  # fail open when no reader is wired
    try:
        return _telemetry_reader(team_id)
    except Exception:
        return True


# ---------------------------------------------------------------------------
# Emit
# ---------------------------------------------------------------------------


def emit_app_event(
    *,
    severity: Severity,
    source: str,
    message: str,
    level: AppEventLevel | None = None,
    team_id: str | None = None,
    agent_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Write an event. Fire-and-forget; swallows ALL errors.

    Guardrails:
      - Rate limited per agent (50/hr)
      - PII scrubbed from message
      - tool/infra events skipped if team has telemetry off
      - infra events always get team_id=None (platform-wide)
    """
    try:
        resolved_level: AppEventLevel = level or "agent"
        scrubbed = scrub_pii(message)

        # Rate limiting
        if not _check_rate_limit(agent_id):
            return

        # If rate limited, replace the message
        entry = _rate_counts.get(agent_id) if agent_id else None
        is_rate_limit_event = bool(entry and entry.limited and entry.count == RATE_LIMIT + 1)
        final_message = (
            f"Rate limited: agent exceeded {RATE_LIMIT} events/hour. "
            "Further events silenced until the window resets."
            if is_rate_limit_event
            else scrubbed
        )

        # Infra events are always team_id=None (platform-wide)
        resolved_team_id = None if resolved_level == "infra" else team_id

        row: dict[str, Any] = {
            "severity": severity,
            "level": resolved_level,
            "source": source,
            "message": final_message,
            "teamId": resolved_team_id,
            "agentId": agent_id,
            "metadata": metadata,
        }

        # Telemetry check for tool/infra events
        if resolved_level in ("tool", "infra") and team_id:
            if not _is_telemetry_enabled(team_id):
                return
            _do_insert(row)
            return

        _do_insert(row)
    except Exception:
        # Store not initialized yet (e.g., during startup). Silently skip.
        pass


def _do_insert(row: dict[str, Any]) -> None:
    try:
        _event_sink(row)
    except Exception as err:
        print(f"[app-events] Failed to write event: {err}")


def reset_rate_limiter_for_tests() -> None:
    """Test hook: clear per-agent rate-limit state."""
    _rate_counts.clear()

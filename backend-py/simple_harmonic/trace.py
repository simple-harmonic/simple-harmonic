"""Server-side play-by-play trace sink.

TS source: packages/backend/src/server/trace.ts

Buffers trace steps and batch-appends them in emission order via a single
background drain loop, so the runner is never blocked and a tick stays
observable live. Steps are PII-scrubbed and truncated before persistence.

Decoupling: the TS sink calls traceEvents.append (store). To avoid touching
store/ in this slice, createTraceSink takes the appender as a callback
(`append`) — an async function receiving the batch of rows. The runtime passes
the real store appender in a later slice. Everything else (the drain/flush race
window, seq counter, tickId reuse, sanitization) is ported faithfully.

The documented race is preserved: a step pushed between the drain loop's last
empty-check and its finally() sees draining=True and is only picked up by
flush()'s second drain.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from simple_harmonic.events import scrub_pii

# Per-string cap. Tool results and thoughts beyond this are cut with a marker.
MAX_STRING_LENGTH = 4000
# Nested values deeper than this are replaced with a placeholder.
MAX_DEPTH = 6
# Arrays/objects keep at most this many entries/keys.
MAX_ENTRIES = 50

# Runner-facing step: { type, data }. Rows handed to `append` carry the full
# persistence shape (camelCase keys, ISO datetimes via emittedAt).
TraceStep = dict[str, Any]
NewTraceEvent = dict[str, Any]
Appender = Callable[[list[NewTraceEvent]], Awaitable[None]]


@dataclass
class PersistentTraceSink:
    tick_id: str
    emit: Callable[[TraceStep], None]
    flush: Callable[[], Awaitable[None]]


async def _noop_append(_batch: list[NewTraceEvent]) -> None:
    # No store wired yet; drop silently (telemetry never breaks a tick).
    return None


def create_trace_sink(
    *,
    team_id: str,
    agent_id: str,
    tick_id: str | None = None,
    append: Appender = _noop_append,
) -> PersistentTraceSink:
    """Build a trace sink. `tick_id` is reused on resume so a tick reads as one
    thread; `append` is the (injectable) async batch persister."""
    resolved_tick_id = tick_id or str(uuid.uuid4())

    @dataclass
    class _State:
        seq: int = 0
        buffer: list[NewTraceEvent] = field(default_factory=list)
        writer: asyncio.Task[None] | None = None
        draining: bool = False

    state = _State()

    async def drain() -> None:
        while state.buffer:
            batch = state.buffer[:]
            state.buffer.clear()
            try:
                await append(batch)
            except Exception as err:
                # Telemetry must never break a tick: drop the batch, carry on.
                print(f"[trace] dropped {len(batch)} step(s): {err}")

    def _start_drain() -> asyncio.Task[None]:
        async def runner() -> None:
            try:
                await drain()
            finally:
                state.draining = False

        return asyncio.ensure_future(runner())

    def emit(step: TraceStep) -> None:
        try:
            state.buffer.append(
                {
                    "teamId": team_id,
                    "agentId": agent_id,
                    "tickId": resolved_tick_id,
                    "seq": state.seq,
                    "type": step.get("type"),
                    "data": sanitize_trace_data(step.get("data") or {}),
                    "emittedAt": datetime.now(UTC),
                }
            )
            state.seq += 1
            if not state.draining:
                state.draining = True
                state.writer = _start_drain()
        except Exception as err:
            print(f"[trace] emit failed: {err}")

    async def flush() -> None:
        if state.writer is not None:
            await state.writer
        # A step pushed in the gap between the drain loop's last empty-check and
        # its finally() sees draining=True and doesn't restart the loop. It is
        # only delayed, never lost: pick it up here.
        if state.buffer:
            state.draining = True
            state.writer = _start_drain()
            await state.writer

    return PersistentTraceSink(tick_id=resolved_tick_id, emit=emit, flush=flush)


# ---------------------------------------------------------------------------
# Sanitization: PII scrub + truncation
# ---------------------------------------------------------------------------


def sanitize_trace_data(data: dict[str, Any]) -> dict[str, Any]:
    try:
        out = _sanitize_value(data, 0)
        if isinstance(out, dict):
            return out
        return {"value": out}
    except Exception as err:
        return {"unserializable": str(err)}


def _sanitize_value(value: Any, depth: int) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        scrubbed = scrub_pii(value)
        if len(scrubbed) <= MAX_STRING_LENGTH:
            return scrubbed
        return (
            f"{scrubbed[:MAX_STRING_LENGTH]}… "
            f"[truncated {len(scrubbed) - MAX_STRING_LENGTH} chars]"
        )
    # bool is a subclass of int; handle both as primitives passed through.
    if isinstance(value, (bool, int, float)):
        return value
    if depth >= MAX_DEPTH:
        return "[max depth]"
    if isinstance(value, (list, tuple)):
        items = list(value)
        kept: list[Any] = [_sanitize_value(v, depth + 1) for v in items[:MAX_ENTRIES]]
        if len(items) > MAX_ENTRIES:
            kept.append(f"… [{len(items) - MAX_ENTRIES} more]")
        return kept
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        entries = list(value.items())
        for k, v in entries[:MAX_ENTRIES]:
            out[str(k)] = _sanitize_value(v, depth + 1)
        if len(entries) > MAX_ENTRIES:
            out["…"] = f"[{len(entries) - MAX_ENTRIES} more keys]"
        return out
    # Functions, etc.: stringify defensively.
    return str(value)


# ---------------------------------------------------------------------------
# Retention: throttled prune hook (store appender injected by the runtime).
# ---------------------------------------------------------------------------

_PRUNE_INTERVAL_MS = 3_600_000
_last_prune_at = 0.0


def _retention_days() -> int:
    raw = os.environ.get("SH_TRACE_RETENTION_DAYS", "")
    try:
        v = int(raw)
    except ValueError:
        return 14
    return v if v > 0 else 14


async def prune_trace_events(
    prune_older_than: Callable[[datetime], Awaitable[None]] | None = None,
    now_ms: float | None = None,
) -> None:
    """Delete trace events older than the retention window (default 14 days,
    override with SH_TRACE_RETENTION_DAYS). Throttled to once per hour."""
    global _last_prune_at
    now = now_ms if now_ms is not None else datetime.now(UTC).timestamp() * 1000
    if now - _last_prune_at < _PRUNE_INTERVAL_MS:
        return
    _last_prune_at = now
    if prune_older_than is None:
        return
    try:
        cutoff = datetime.fromtimestamp((now - _retention_days() * 86_400_000) / 1000, tz=UTC)
        await prune_older_than(cutoff)
    except Exception as err:
        print(f"[trace] prune failed: {err}")


def reset_prune_throttle_for_tests() -> None:
    """Test hook: reset the prune throttle."""
    global _last_prune_at
    _last_prune_at = 0.0

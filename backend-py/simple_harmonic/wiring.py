"""Runtime wiring: connect the store-decoupled slice-4 hooks to the real repos.

TS source: packages/backend/src/server/app-events.ts (the emitter writes through
``appEvents.insert`` + reads ``teams.byId().telemetryEnabled`` directly). In the
Python port the :mod:`simple_harmonic.events` emitter is decoupled from the store
via injectable hooks (``set_event_sink`` / ``set_telemetry_reader``) so the slice-4
module never imports ``store``. This module closes that seam at boot: it points the
event sink at ``appEvents.insert`` and the telemetry reader at a cached
``teams.byId`` lookup.

``appEvents.insert`` is synchronous (telemetry never blocks); the telemetry reader
must also be synchronous (it gates the emit). Reading ``teams.byId`` is async, so
the reader resolves it against a short-lived in-process cache populated lazily —
fail-open on any miss (the emitter already fails open when no reader is wired).
"""

from __future__ import annotations

import asyncio
import contextlib

from simple_harmonic.events import set_event_sink, set_telemetry_reader
from simple_harmonic.store.repos import NewAppEvent, appEvents, teams

_wired = False


def _event_sink(row: dict) -> None:
    """Persist one app event (synchronous; mirrors the TS ``appEvents.insert``)."""
    appEvents.insert(
        NewAppEvent(
            severity=row["severity"],
            level=row["level"],
            source=row["source"],
            message=row["message"],
            teamId=row.get("teamId"),
            agentId=row.get("agentId"),
            metadata=row.get("metadata"),
        )
    )


# Telemetry lookups are gated on the synchronous emit path; the repo read is
# async. Cache resolved values so the reader stays sync and fails open.
_telemetry_cache: dict[str, bool] = {}
# Strong refs to in-flight refresh tasks (the loop only holds weak refs).
_refresh_tasks: set[asyncio.Task[None]] = set()


def _telemetry_reader(team_id: str) -> bool:
    """Whether a team has telemetry enabled (sync; fail-open on unknown).

    On a cache miss this schedules a background refresh and returns True for
    this call. The cap on tool/infra events is best-effort guidance, so a
    one-tick-stale answer is acceptable and never blocks the emit.
    """
    cached = _telemetry_cache.get(team_id)
    if cached is not None:
        return cached
    with contextlib.suppress(RuntimeError):
        loop = asyncio.get_running_loop()
        task = loop.create_task(_refresh_telemetry(team_id))
        _refresh_tasks.add(task)
        task.add_done_callback(_refresh_tasks.discard)
    return True


async def _refresh_telemetry(team_id: str) -> None:
    with contextlib.suppress(Exception):
        team = await teams.byId(team_id)
        if team is not None:
            _telemetry_cache[team_id] = team.telemetryEnabled


def wire_runtime() -> None:
    """Wire the event sink + telemetry reader onto the repos. Idempotent."""
    global _wired
    if _wired:
        return
    set_event_sink(_event_sink)
    set_telemetry_reader(_telemetry_reader)
    _wired = True


def invalidate_telemetry_cache(team_id: str) -> None:
    """Drop one team's cached telemetry value so the next emit re-reads it.

    TS source: app-events.ts ``invalidateTelemetryCache``. Called by the
    telemetry PUT handler after toggling ``telemetryEnabled`` so the change is
    picked up on the very next ``emitAppEvent`` instead of a tick later.
    """
    _telemetry_cache.pop(team_id, None)


def reset_telemetry_cache_for_tests() -> None:
    """Test hook: drop the cached telemetry values."""
    _telemetry_cache.clear()

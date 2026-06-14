"""App events repo.

TS source: packages/backend/src/server/store/repos/app-events.ts

Append-only JSONL. Team/agent/tool events live in the owning team's
events.jsonl; infra and team-less events live in system/events.jsonl. Queries
gather across the relevant files, then filter + sort newest-first + limit,
mirroring the old WHERE/ORDER BY/LIMIT.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from simple_harmonic.store import data_dir as dd
from simple_harmonic.store import fs
from simple_harmonic.store import index_cache as ic
from simple_harmonic.store.repos._runner import locked
from simple_harmonic.store.serialize import revive_dates_all
from simple_harmonic.store.types import AppEvent, AppEventLevel, AppEventSeverity

DATE_KEYS = ("acknowledgedAt", "createdAt")


def _read_path(path: Path) -> list[AppEvent]:
    rows = [r for r in fs.read_jsonl(path) if isinstance(r, dict)]
    revived = revive_dates_all(rows, DATE_KEYS)
    return [AppEvent.model_validate(r) for r in revived]


def _all_event_paths() -> list[Path]:
    """All event-file paths (every team's + the system infra file)."""
    return [dd.team_events_path(loc.dir) for loc in ic.all_team_locs()] + [dd.infra_events_path()]


class NewAppEvent(BaseModel):
    severity: AppEventSeverity
    level: AppEventLevel
    source: str
    message: str
    teamId: str | None = None
    agentId: str | None = None
    metadata: dict[str, object] | None = None


class AppEventQuery(BaseModel):
    teamId: str | None = None
    severity: AppEventSeverity | None = None
    level: AppEventLevel | None = None
    source: str | None = None
    since: datetime | None = None
    limit: int | None = None
    includeInfra: bool = False
    unacknowledgedOnly: bool = False


class AppEventsRepo:
    def insert(self, e: NewAppEvent) -> None:
        """Append one event. Synchronous + fire-and-forget (telemetry never blocks).

        Kept synchronous to match the TS surface exactly. Append is one atomic
        write; it does not read-modify-write existing rows, so it does not need
        the store_lock.
        """
        row = AppEvent(
            id=str(uuid.uuid4()),
            teamId=e.teamId,
            agentId=e.agentId,
            severity=e.severity,
            level=e.level,
            source=e.source,
            message=e.message,
            metadata=e.metadata,
            acknowledgedAt=None,
            createdAt=datetime.now(UTC),
        )
        # Team-scoped events go to the team file (if the team still exists);
        # infra and team-less events go to the system file.
        d = ic.team_dir(e.teamId) if e.teamId else None
        path = dd.team_events_path(d) if d is not None else dd.infra_events_path()
        fs.append_jsonl(path, row.model_dump(by_alias=True))

    async def query(self, q: AppEventQuery | None = None) -> list[AppEvent]:
        query = q or AppEventQuery()
        return await locked(lambda: self._query_sync(query))

    def _query_sync(self, q: AppEventQuery) -> list[AppEvent]:
        # Narrow which files to read: a teamId filter only matches that team's file.
        if q.teamId:
            d = ic.team_dir(q.teamId)
            paths = [dd.team_events_path(d)] if d is not None else []
        else:
            paths = _all_event_paths()

        rows: list[AppEvent] = []
        for p in paths:
            rows.extend(_read_path(p))

        if q.teamId:
            rows = [r for r in rows if r.teamId == q.teamId]
        if q.severity:
            rows = [r for r in rows if r.severity == q.severity]
        if q.level:
            rows = [r for r in rows if r.level == q.level]
        if q.source:
            rows = [r for r in rows if r.source == q.source]
        if q.since is not None:
            rows = [r for r in rows if r.createdAt >= q.since]
        if not q.includeInfra:
            rows = [r for r in rows if r.level != "infra"]
        if q.unacknowledgedOnly:
            rows = [r for r in rows if r.acknowledgedAt is None]

        rows.sort(key=lambda r: r.createdAt, reverse=True)
        return rows[: q.limit if q.limit is not None else 20]

    async def acknowledge(self, ids: list[str]) -> int:
        """Mark events acknowledged by id (founder dismiss). Returns count touched."""
        return await locked(lambda: self._acknowledge_sync(ids))

    def _acknowledge_sync(self, ids: list[str]) -> int:
        wanted = set(ids)
        now = datetime.now(UTC)
        touched = 0
        for path in _all_event_paths():
            rows: list[dict[str, Any]] = [
                r for r in fs.read_jsonl(path) if isinstance(r, dict)
            ]
            changed = False
            for r in rows:
                if r.get("id") in wanted and r.get("acknowledgedAt") is None:
                    r["acknowledgedAt"] = now
                    changed = True
                    touched += 1
            if changed:
                fs.rewrite_jsonl(path, rows)
        return touched


appEvents = AppEventsRepo()

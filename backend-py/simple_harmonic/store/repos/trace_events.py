"""Play-by-play trace repo.

TS source: packages/backend/src/server/store/repos/trace-events.ts

Append-only per-agent trace.jsonl. One row per agent step. Queries gather
across a team's agents (or one agent), filter by tick, and sort by
(emittedAt, seq) to match the old global sort key.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from simple_harmonic.store import data_dir as dd
from simple_harmonic.store import fs
from simple_harmonic.store import index_cache as ic
from simple_harmonic.store.repos._runner import locked
from simple_harmonic.store.serialize import revive_dates_all
from simple_harmonic.store.types import AgentTraceEvent

DATE_KEYS = ("emittedAt", "createdAt")


class NewTraceEvent(BaseModel):
    """A step ready to persist (id/createdAt are filled here)."""

    teamId: str
    agentId: str
    tickId: str
    seq: int
    type: str
    data: dict[str, object]
    emittedAt: datetime


class TraceQuery(BaseModel):
    teamId: str
    agentId: str | None = None
    tickId: str | None = None
    since: datetime | None = None
    order: Literal["asc", "desc"]
    limit: int


def _read_for_dir(agent_dir: Path) -> list[AgentTraceEvent]:
    rows = [r for r in fs.read_jsonl(dd.agent_trace_path(agent_dir)) if isinstance(r, dict)]
    revived = revive_dates_all(rows, DATE_KEYS)
    return [AgentTraceEvent.model_validate(r) for r in revived]


def _sort_key(e: AgentTraceEvent) -> tuple[datetime, int]:
    return (e.emittedAt, e.seq)


class TraceEventsRepo:
    async def append(self, rows: list[NewTraceEvent]) -> None:
        """Append a batch of steps. All rows in a batch may span agents; rows are
        grouped per agent and appended atomically per file.
        """
        await locked(lambda: self._append_sync(rows))

    def _append_sync(self, rows: list[NewTraceEvent]) -> None:
        if not rows:
            return
        by_agent: dict[str, list[object]] = defaultdict(list)
        now = datetime.now(UTC)
        for r in rows:
            full = AgentTraceEvent(
                id=str(uuid.uuid4()),
                teamId=r.teamId,
                agentId=r.agentId,
                tickId=r.tickId,
                seq=r.seq,
                type=r.type,
                data=r.data,
                emittedAt=r.emittedAt,
                createdAt=now,
            )
            by_agent[r.agentId].append(full.model_dump(by_alias=True))
        for agent_id, serialised in by_agent.items():
            loc = ic.agent_loc(agent_id)
            if loc is not None:
                fs.append_jsonl_many(dd.agent_trace_path(loc.dir), serialised)

    async def query(self, q: TraceQuery) -> list[AgentTraceEvent]:
        return await locked(lambda: self._query_sync(q))

    def _query_sync(self, q: TraceQuery) -> list[AgentTraceEvent]:
        if q.agentId:
            loc = ic.agent_loc(q.agentId)
            dirs = [loc.dir] if loc is not None else []
        else:
            dirs = [loc.dir for loc in ic.agent_locs_for_team(q.teamId)]

        rows: list[AgentTraceEvent] = []
        for d in dirs:
            rows.extend(_read_for_dir(d))

        rows = [r for r in rows if r.teamId == q.teamId]
        if q.agentId:
            rows = [r for r in rows if r.agentId == q.agentId]
        if q.tickId:
            rows = [r for r in rows if r.tickId == q.tickId]
        if q.since is not None:
            rows = [r for r in rows if r.emittedAt >= q.since]

        rows.sort(key=_sort_key, reverse=q.order == "desc")
        return rows[: q.limit]

    async def pruneOlderThan(self, cutoff: datetime) -> None:
        """Delete trace steps older than the cutoff across every agent."""
        await locked(lambda: self._prune_older_than_sync(cutoff))

    def _prune_older_than_sync(self, cutoff: datetime) -> None:
        for loc in ic.all_agent_locs():
            path = dd.agent_trace_path(loc.dir)
            rows = _read_for_dir(loc.dir)
            kept = [r for r in rows if r.emittedAt >= cutoff]
            if len(kept) != len(rows):
                fs.rewrite_jsonl(path, [r.model_dump(by_alias=True) for r in kept])


traceEvents = TraceEventsRepo()

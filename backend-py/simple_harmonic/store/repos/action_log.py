"""Action log repo.

TS source: packages/backend/src/server/store/repos/action-log.ts

Append-only per-agent history in actions.jsonl. Reads merge across agents and
sort newest-first to match the old `ORDER BY executed_at DESC` queries.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from datetime import UTC, datetime

from pydantic import BaseModel

from simple_harmonic.store import data_dir as dd
from simple_harmonic.store import fs
from simple_harmonic.store import index_cache as ic
from simple_harmonic.store.repos._runner import locked
from simple_harmonic.store.serialize import revive_dates_all
from simple_harmonic.store.types import ActionLogEntry

DATE_KEYS = ("executedAt",)


def _read_for_agent(agent_id: str) -> list[ActionLogEntry]:
    loc = ic.agent_loc(agent_id)
    if loc is None:
        return []
    rows = [r for r in fs.read_jsonl(dd.agent_actions_path(loc.dir)) if isinstance(r, dict)]
    revived = revive_dates_all(rows, DATE_KEYS)
    return [ActionLogEntry.model_validate(r) for r in revived]


class NewAction(BaseModel):
    actionType: str
    payload: dict[str, object]
    metaAgentApprovalId: str | None = None


class ActionLogRepo:
    async def insert(self, agent_id: str, e: NewAction) -> ActionLogEntry:
        return await locked(lambda: self._insert_sync(agent_id, e))

    def _insert_sync(self, agent_id: str, e: NewAction) -> ActionLogEntry:
        loc = ic.agent_loc(agent_id)
        if loc is None:
            raise ValueError(f"agent {agent_id} not found")
        row = ActionLogEntry(
            id=str(uuid.uuid4()),
            agentId=agent_id,
            metaAgentApprovalId=e.metaAgentApprovalId,
            actionType=e.actionType,
            payload=e.payload,
            executedAt=datetime.now(UTC),
        )
        fs.append_jsonl(dd.agent_actions_path(loc.dir), row.model_dump(by_alias=True))
        return row

    async def byAgents(
        self,
        agent_ids: Iterable[str],
        *,
        limit: int | None = None,
        since: datetime | None = None,
    ) -> list[ActionLogEntry]:
        """Newest-first action entries across the given agents."""
        ids = list(agent_ids)
        return await locked(lambda: self._by_agents_sync(ids, limit, since))

    def _by_agents_sync(
        self, agent_ids: list[str], limit: int | None, since: datetime | None
    ) -> list[ActionLogEntry]:
        rows: list[ActionLogEntry] = []
        for agent_id in agent_ids:
            rows.extend(_read_for_agent(agent_id))
        if since is not None:
            rows = [r for r in rows if r.executedAt > since]
        rows.sort(key=lambda r: r.executedAt, reverse=True)
        return rows[:limit] if limit else rows

    async def recentByAgent(self, agent_id: str, limit: int) -> list[ActionLogEntry]:
        return await self.byAgents([agent_id], limit=limit)


actionLog = ActionLogRepo()

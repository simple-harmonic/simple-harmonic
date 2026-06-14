"""LLM spend ledger repo.

TS source: packages/backend/src/server/store/repos/spend.ts

One global append-only JSONL (system/spend.jsonl), day-keyed. The daily cap
sums costCents for the current UTC day. sumForDay reads raw rows (no date
revival) and tolerates missing fields.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from pydantic import BaseModel

from simple_harmonic.store import data_dir as dd
from simple_harmonic.store import fs
from simple_harmonic.store.repos._runner import locked
from simple_harmonic.store.types import LlmSpendEntry


class NewSpend(BaseModel):
    teamId: str | None = None
    agentId: str | None = None
    model: str
    inputTokens: int
    outputTokens: int
    costCents: float
    day: str  # UTC YYYY-MM-DD


class SpendRepo:
    async def insert(self, e: NewSpend) -> None:
        await locked(lambda: self._insert_sync(e))

    def _insert_sync(self, e: NewSpend) -> None:
        row = LlmSpendEntry(
            id=str(uuid.uuid4()),
            teamId=e.teamId,
            agentId=e.agentId,
            model=e.model,
            inputTokens=e.inputTokens,
            outputTokens=e.outputTokens,
            costCents=e.costCents,
            day=e.day,
            createdAt=datetime.now(UTC),
        )
        fs.append_jsonl(dd.spend_log_path(), row.model_dump(by_alias=True))

    async def sumForDay(self, day: str) -> float:
        """Total costCents recorded for a given UTC day."""
        return await locked(lambda: self._sum_for_day_sync(day))

    def _sum_for_day_sync(self, day: str) -> float:
        total = 0.0
        for r in fs.read_jsonl(dd.spend_log_path()):
            if isinstance(r, dict) and r.get("day") == day:
                cost = r.get("costCents")
                total += cost if isinstance(cost, int | float) else 0
        return total


spend = SpendRepo()

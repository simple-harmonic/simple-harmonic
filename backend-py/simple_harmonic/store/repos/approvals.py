"""Pending approvals repo.

TS source: packages/backend/src/server/store/repos/approvals.ts

Stored per agent in approvals.json (an array). Each destructive tool call
awaiting human sign-off is one entry. Deleting an agent folder removes its
approvals for free, so there is no cascade to manage.

NB: `toolArguments` is a JSON *string*, never auto-parsed.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

from simple_harmonic.store import data_dir as dd
from simple_harmonic.store import fs
from simple_harmonic.store import index_cache as ic
from simple_harmonic.store.repos._runner import locked
from simple_harmonic.store.serialize import revive_dates_all
from simple_harmonic.store.types import ApprovalStatus, PendingApproval

DATE_KEYS = ("createdAt", "resolvedAt")


def _read_raw(agent_dir: Path) -> list[dict[str, Any]]:
    raw = fs.read_json(dd.agent_approvals_path(agent_dir), [])
    return raw if isinstance(raw, list) else []


def _read_for_dir(agent_dir: Path) -> list[PendingApproval]:
    rows = revive_dates_all(_read_raw(agent_dir), DATE_KEYS)
    return [PendingApproval.model_validate(r) for r in rows]


class NewApproval(BaseModel):
    teamId: str
    toolCallId: str
    toolName: str
    toolArguments: str


@dataclass(frozen=True, slots=True)
class ResolveOk:
    agentId: str
    ok: Literal[True] = True


@dataclass(frozen=True, slots=True)
class ResolveErr:
    reason: Literal["not_found", "already"]
    ok: Literal[False] = False


ResolveResult = ResolveOk | ResolveErr


class ApprovalsRepo:
    async def byAgent(self, agent_id: str) -> list[PendingApproval]:
        return await locked(lambda: self._by_agent_sync(agent_id))

    def _by_agent_sync(self, agent_id: str) -> list[PendingApproval]:
        loc = ic.agent_loc(agent_id)
        return _read_for_dir(loc.dir) if loc is not None else []

    async def insertMany(self, agent_id: str, rows: list[NewApproval]) -> None:
        """Append approvals for an agent (all belong to the same agent)."""
        await locked(lambda: self._insert_many_sync(agent_id, rows))

    def _insert_many_sync(self, agent_id: str, rows: list[NewApproval]) -> None:
        loc = ic.agent_loc(agent_id)
        if loc is None or not rows:
            return
        now = datetime.now(UTC)
        existing = _read_raw(loc.dir)
        for r in rows:
            existing.append(
                {
                    "id": str(uuid.uuid4()),
                    "teamId": r.teamId,
                    "agentId": agent_id,
                    "toolCallId": r.toolCallId,
                    "toolName": r.toolName,
                    "toolArguments": r.toolArguments,
                    "status": "pending",
                    "decisionNote": None,
                    "createdAt": now,
                    "resolvedAt": None,
                }
            )
        fs.write_json(dd.agent_approvals_path(loc.dir), existing)

    async def clearForAgent(self, agent_id: str) -> None:
        """Remove all approvals for an agent (consumed on resume / defensive clear)."""
        await locked(lambda: self._clear_for_agent_sync(agent_id))

    def _clear_for_agent_sync(self, agent_id: str) -> None:
        loc = ic.agent_loc(agent_id)
        if loc is None:
            return
        fs.write_json(dd.agent_approvals_path(loc.dir), [])

    async def pendingForTeam(self, team_id: str) -> list[PendingApproval]:
        """All pending approvals across a team's agents."""
        return await locked(lambda: self._pending_for_team_sync(team_id))

    def _pending_for_team_sync(self, team_id: str) -> list[PendingApproval]:
        out: list[PendingApproval] = []
        for loc in ic.agent_locs_for_team(team_id):
            out.extend(a for a in _read_for_dir(loc.dir) if a.status == "pending")
        return out

    async def resolve(
        self,
        team_id: str,
        approval_id: str,
        decision: ApprovalStatus,
        note: str | None,
    ) -> ResolveResult:
        """Resolve one approval within a team. Locates the owning agent by scanning
        the team's agents. Returns the affected agentId, or a reason it could not.
        """
        return await locked(lambda: self._resolve_sync(team_id, approval_id, decision, note))

    def _resolve_sync(
        self,
        team_id: str,
        approval_id: str,
        decision: ApprovalStatus,
        note: str | None,
    ) -> ResolveResult:
        for loc in ic.agent_locs_for_team(team_id):
            rows = _read_raw(loc.dir)
            idx = next((i for i, r in enumerate(rows) if r.get("id") == approval_id), -1)
            if idx == -1:
                continue
            if rows[idx].get("status") != "pending":
                return ResolveErr(reason="already")
            rows[idx]["status"] = decision
            rows[idx]["decisionNote"] = note
            rows[idx]["resolvedAt"] = datetime.now(UTC)
            fs.write_json(dd.agent_approvals_path(loc.dir), rows)
            return ResolveOk(agentId=loc.agentId)
        return ResolveErr(reason="not_found")


approvals = ApprovalsRepo()

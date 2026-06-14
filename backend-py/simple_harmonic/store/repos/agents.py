"""Agents repo.

TS source: packages/backend/src/server/store/repos/agents.ts

Each agent is a folder under its team's agents/ dir, holding agent.json plus
approvals/actions/trace files. The location index maps agentId -> folder.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from simple_harmonic.store import data_dir as dd
from simple_harmonic.store import fs
from simple_harmonic.store import index_cache as ic
from simple_harmonic.store.repos._runner import locked
from simple_harmonic.store.serialize import revive_dates
from simple_harmonic.store.types import Agent, AgentStatus

DATE_KEYS = ("nextRunAt", "createdAt")


def _read_agent(agent_dir: Path) -> Agent | None:
    raw = fs.read_json(dd.agent_json_path(agent_dir), None)
    if not isinstance(raw, dict):
        return None
    return Agent.model_validate(revive_dates(raw, DATE_KEYS))


class NewAgent(BaseModel):
    name: str
    role: str
    archetype: str
    tools: list[str]
    scheduleSeconds: int
    initialPrompt: str
    outputContract: dict[str, object] | None = None
    status: AgentStatus = "running"
    nextRunAt: datetime | None = None


def _build_row(team_id: str, input: NewAgent) -> Agent:
    return Agent(
        id=str(uuid.uuid4()),
        teamId=team_id,
        name=input.name,
        role=input.role,
        archetype=input.archetype,
        tools=input.tools,
        scheduleSeconds=input.scheduleSeconds,
        initialPrompt=input.initialPrompt,
        outputContract=input.outputContract,
        status=input.status,
        nextRunAt=input.nextRunAt,
        inFlight=False,
        conversationState=None,
        createdAt=datetime.now(UTC),
    )


class AgentsRepo:
    async def byId(self, agent_id: str) -> Agent | None:
        return await locked(lambda: self._by_id_sync(agent_id))

    def _by_id_sync(self, agent_id: str) -> Agent | None:
        loc = ic.agent_loc(agent_id)
        return _read_agent(loc.dir) if loc is not None else None

    async def byTeam(self, team_id: str) -> list[Agent]:
        return await locked(
            lambda: [
                a
                for loc in ic.agent_locs_for_team(team_id)
                if (a := _read_agent(loc.dir)) is not None
            ]
        )

    async def byTeams(self, team_ids: Iterable[str]) -> list[Agent]:
        ids = set(team_ids)
        return await locked(
            lambda: [
                a
                for loc in ic.all_agent_locs()
                if loc.teamId in ids and (a := _read_agent(loc.dir)) is not None
            ]
        )

    async def all(self) -> list[Agent]:
        return await locked(
            lambda: [
                a for loc in ic.all_agent_locs() if (a := _read_agent(loc.dir)) is not None
            ]
        )

    async def create(self, team_id: str, input: NewAgent) -> Agent:
        return await locked(lambda: self._create_sync(team_id, input))

    # TS name is `insert`; expose both.
    async def insert(self, team_id: str, input: NewAgent) -> Agent:
        return await self.create(team_id, input)

    def _create_sync(self, team_id: str, input: NewAgent) -> Agent:
        d = ic.team_dir(team_id)
        if d is None:
            raise ValueError(f"team {team_id} not found")
        row = _build_row(team_id, input)
        fs.write_json(
            dd.agent_json_path(dd.team_agents_dir(d) / row.id),
            row.model_dump(by_alias=True),
        )
        ic.invalidate_index()
        return row

    async def insertMany(self, team_id: str, inputs: list[NewAgent]) -> list[Agent]:
        return await locked(lambda: self._insert_many_sync(team_id, inputs))

    def _insert_many_sync(self, team_id: str, inputs: list[NewAgent]) -> list[Agent]:
        d = ic.team_dir(team_id)
        if d is None:
            raise ValueError(f"team {team_id} not found")
        rows = [_build_row(team_id, i) for i in inputs]
        for row in rows:
            fs.write_json(
                dd.agent_json_path(dd.team_agents_dir(d) / row.id),
                row.model_dump(by_alias=True),
            )
        if rows:
            ic.invalidate_index()
        return rows

    async def update(self, agent_id: str, patch: dict[str, Any]) -> Agent | None:
        return await locked(lambda: self._update_sync(agent_id, patch))

    def _update_sync(self, agent_id: str, patch: dict[str, Any]) -> Agent | None:
        loc = ic.agent_loc(agent_id)
        if loc is None:
            return None
        updated = fs.update_json(dd.agent_json_path(loc.dir), {}, lambda cur: {**cur, **patch})
        return Agent.model_validate(revive_dates(updated, DATE_KEYS))

    async def move(self, agent_id: str, to_team_id: str) -> Agent | None:
        """Move an agent's folder to a different team and rewrite its teamId."""
        return await locked(lambda: self._move_sync(agent_id, to_team_id))

    def _move_sync(self, agent_id: str, to_team_id: str) -> Agent | None:
        loc = ic.agent_loc(agent_id)
        dest_dir = ic.team_dir(to_team_id)
        if loc is None or dest_dir is None:
            return None
        new_dir = dd.team_agents_dir(dest_dir) / agent_id
        fs.update_json(
            dd.agent_json_path(loc.dir),
            {},
            lambda cur: {**cur, "teamId": to_team_id},
        )
        fs.move_path(loc.dir, new_dir)
        ic.invalidate_index()
        return _read_agent(new_dir)

    async def delete(self, agent_id: str) -> None:
        await locked(lambda: self._delete_sync(agent_id))

    def _delete_sync(self, agent_id: str) -> None:
        loc = ic.agent_loc(agent_id)
        if loc is None:
            return
        fs.remove_path(loc.dir)
        ic.invalidate_index()

    async def claim(self, agent_id: str, expected_status: AgentStatus) -> bool:
        """Atomically claim an agent for a tick: set inFlight true only if it is
        currently not in flight and in the expected status.

        Node made this race-free for free (synchronous read+write, no await
        between). Under asyncio the read-modify-write runs under the global
        store_lock so two coroutines cannot both observe inFlight=false.
        """
        return await locked(lambda: self._claim_sync(agent_id, expected_status))

    def _claim_sync(self, agent_id: str, expected_status: AgentStatus) -> bool:
        loc = ic.agent_loc(agent_id)
        if loc is None:
            return False
        path = dd.agent_json_path(loc.dir)
        cur = fs.read_json(path, None)
        if (
            not isinstance(cur, dict)
            or cur.get("inFlight") is True
            or cur.get("status") != expected_status
        ):
            return False
        cur["inFlight"] = True
        fs.write_json(path, cur)
        return True

    async def resetAllInFlight(self) -> None:
        """Clear inFlight on every agent (crash recovery on process start)."""
        await locked(self._reset_all_in_flight_sync)

    def _reset_all_in_flight_sync(self) -> None:
        for loc in ic.all_agent_locs():
            path = dd.agent_json_path(loc.dir)
            cur = fs.read_json(path, None)
            if isinstance(cur, dict) and cur.get("inFlight") is True:
                cur["inFlight"] = False
                fs.write_json(path, cur)


agents = AgentsRepo()

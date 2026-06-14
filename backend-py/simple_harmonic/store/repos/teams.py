"""Teams repo.

TS source: packages/backend/src/server/store/repos/teams.ts

Each team is a folder; the folder's location in the recursive tree encodes the
hierarchy. team.json holds the row; the location index maps teamId -> folder.
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
from simple_harmonic.store.serialize import revive_dates
from simple_harmonic.store.types import Team

DATE_KEYS = ("lastUserActiveAt", "createdAt")


def _read_team(team_dir: Path) -> Team | None:
    raw = fs.read_json(dd.team_json_path(team_dir), None)
    if not isinstance(raw, dict):
        return None
    return Team.model_validate(revive_dates(raw, DATE_KEYS))


class NewTeam(BaseModel):
    name: str
    parentTeamId: str | None = None
    goal: str | None = None
    cofounderName: str | None = None
    metaAgentPrompt: str | None = None
    paused: bool = False
    tickCount: int = 0
    telemetryEnabled: bool = True


class TeamsRepo:
    async def all(self) -> list[Team]:
        """All teams, oldest-first."""
        return await locked(self._all_sync)

    def _all_sync(self) -> list[Team]:
        out = [t for loc in ic.all_team_locs() if (t := _read_team(loc.dir)) is not None]
        out.sort(key=lambda t: t.createdAt)
        return out

    async def byId(self, team_id: str) -> Team | None:
        return await locked(lambda: self._by_id_sync(team_id))

    def _by_id_sync(self, team_id: str) -> Team | None:
        d = ic.team_dir(team_id)
        return _read_team(d) if d is not None else None

    async def roots(self) -> list[Team]:
        return await locked(
            lambda: [t for loc in ic.root_team_locs() if (t := _read_team(loc.dir)) is not None]
        )

    async def children(self, parent_id: str) -> list[Team]:
        return await locked(
            lambda: [
                t for loc in ic.child_team_locs(parent_id) if (t := _read_team(loc.dir)) is not None
            ]
        )

    async def listUnpaused(self) -> list[Team]:
        return [t for t in await self.all() if not t.paused]

    async def create(self, input: NewTeam) -> Team:
        return await locked(lambda: self._create_sync(input))

    # TS name is `insert`; `create` is the public-surface name. Alias both.
    async def insert(self, input: NewTeam) -> Team:
        return await self.create(input)

    def _create_sync(self, input: NewTeam) -> Team:
        team_id = str(uuid.uuid4())
        now = datetime.now(UTC)
        parent_team_id = input.parentTeamId
        container = dd.teams_root()
        if parent_team_id:
            parent_dir = ic.team_dir(parent_team_id)
            if parent_dir is None:
                raise ValueError(f"parent team {parent_team_id} not found")
            container = dd.team_children_dir(parent_dir)
        row = Team(
            id=team_id,
            parentTeamId=parent_team_id,
            name=input.name,
            goal=input.goal,
            paused=input.paused,
            tickCount=input.tickCount,
            metaAgentPrompt=input.metaAgentPrompt,
            cofounderName=input.cofounderName,
            telemetryEnabled=input.telemetryEnabled,
            lastUserActiveAt=now,
            createdAt=now,
        )
        fs.write_json(
            dd.team_json_path(container / team_id),
            row.model_dump(by_alias=True),
        )
        ic.invalidate_index()
        return row

    async def update(self, team_id: str, patch: dict[str, Any]) -> Team | None:
        return await locked(lambda: self._update_sync(team_id, patch))

    def _update_sync(self, team_id: str, patch: dict[str, Any]) -> Team | None:
        d = ic.team_dir(team_id)
        if d is None:
            return None
        updated = fs.update_json(dd.team_json_path(d), {}, lambda cur: {**cur, **patch})
        return Team.model_validate(revive_dates(updated, DATE_KEYS))

    async def incrementTickCount(self, team_id: str) -> None:
        await locked(lambda: self._increment_tick_count_sync(team_id))

    def _increment_tick_count_sync(self, team_id: str) -> None:
        d = ic.team_dir(team_id)
        if d is None:
            return

        def mutate(cur: dict[str, Any]) -> dict[str, Any]:
            tick = cur.get("tickCount")
            return {**cur, "tickCount": (tick if isinstance(tick, int) else 0) + 1}

        fs.update_json(dd.team_json_path(d), {}, mutate)

    async def move(self, team_id: str, to_parent_id: str | None) -> Team | None:
        """Move a team folder under a new parent (or to the root). Rewrites parentTeamId.

        TS teams repo has no `move`; the public surface lists it, so we provide
        the file-store analogue of the agents.move pattern.
        """
        return await locked(lambda: self._move_sync(team_id, to_parent_id))

    def _move_sync(self, team_id: str, to_parent_id: str | None) -> Team | None:
        loc = ic.team_loc(team_id)
        if loc is None:
            return None
        if to_parent_id:
            parent_dir = ic.team_dir(to_parent_id)
            if parent_dir is None:
                return None
            container = dd.team_children_dir(parent_dir)
        else:
            container = dd.teams_root()
        new_dir = container / team_id
        fs.update_json(
            dd.team_json_path(loc.dir),
            {},
            lambda cur: {**cur, "parentTeamId": to_parent_id},
        )
        fs.move_path(loc.dir, new_dir)
        ic.invalidate_index()
        return _read_team(new_dir)

    async def delete(self, team_id: str) -> None:
        """Delete a team and its whole subtree (agents, messages, sub-teams)."""
        await locked(lambda: self._delete_sync(team_id))

    def _delete_sync(self, team_id: str) -> None:
        d = ic.team_dir(team_id)
        if d is None:
            return
        fs.remove_path(d)
        ic.invalidate_index()


teams = TeamsRepo()

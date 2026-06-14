"""Location index for the recursive team tree.

TS source: packages/backend/src/server/store/index-cache.ts

Teams nest under their parent's teams/ folder to arbitrary depth, so a team's
on-disk path is not derivable from its id alone. This module walks the tree
once and caches a map of teamId -> TeamLoc and agentId -> AgentLoc. Tree
queries (roots, children, sub-tree) read straight from the cache instead of
re-walking. The cache is invalidated on any team/agent create/delete/move so
the next access rebuilds it; the dataset is small (<100 teams) so a full
rebuild is cheap.

Concurrency note (Python port): Node's event loop made the synchronous walk +
mutation atomic for free. Under asyncio the repos run the cache-touching work
inside a worker thread guarded by a single global asyncio.Lock (see
`store_lock`), so reads never observe a half-built cache and two coroutines
never race a read-modify-write.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from weakref import WeakKeyDictionary

from simple_harmonic.store import data_dir as dd
from simple_harmonic.store import fs

# A single process-wide lock serialising every store read-modify-write — the
# explicit replacement for Node's implicit single-task atomicity. asyncio.Lock
# binds to the loop it is first used on, so we keep one lock per running event
# loop (a module-global singleton would break across pytest's per-test loops).
_locks: WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock] = WeakKeyDictionary()


def store_lock() -> asyncio.Lock:
    """The store lock for the currently-running event loop (created on demand)."""
    loop = asyncio.get_running_loop()
    lock = _locks.get(loop)
    if lock is None:
        lock = asyncio.Lock()
        _locks[loop] = lock
    return lock


@dataclass(frozen=True, slots=True)
class TeamLoc:
    teamId: str
    dir: Path
    parentTeamId: str | None


@dataclass(frozen=True, slots=True)
class AgentLoc:
    agentId: str
    teamId: str
    dir: Path


@dataclass(slots=True)
class _Index:
    teams: dict[str, TeamLoc]
    agents: dict[str, AgentLoc]


_cache: _Index | None = None


def _walk(container_dir: Path, parent_team_id: str | None, idx: _Index) -> None:
    for team_id in fs.list_subdirs(container_dir):
        team_dir = container_dir / team_id
        if not fs.path_exists(dd.team_json_path(team_dir)):
            continue  # not a team folder
        idx.teams[team_id] = TeamLoc(teamId=team_id, dir=team_dir, parentTeamId=parent_team_id)
        agents_dir = dd.team_agents_dir(team_dir)
        for agent_id in fs.list_subdirs(agents_dir):
            idx.agents[agent_id] = AgentLoc(
                agentId=agent_id, teamId=team_id, dir=agents_dir / agent_id
            )
        _walk(dd.team_children_dir(team_dir), team_id, idx)  # recurse into sub-teams


def _build() -> _Index:
    idx = _Index(teams={}, agents={})
    _walk(dd.teams_root(), None, idx)
    return idx


def _index() -> _Index:
    global _cache
    if _cache is None:
        _cache = _build()
    return _cache


def invalidate_index() -> None:
    """Drop the cache so the next access re-walks the tree."""
    global _cache
    _cache = None


def team_loc(team_id: str) -> TeamLoc | None:
    return _index().teams.get(team_id)


def team_dir(team_id: str) -> Path | None:
    loc = _index().teams.get(team_id)
    return loc.dir if loc is not None else None


def all_team_locs() -> list[TeamLoc]:
    return list(_index().teams.values())


def child_team_locs(parent_team_id: str) -> list[TeamLoc]:
    return [t for t in _index().teams.values() if t.parentTeamId == parent_team_id]


def root_team_locs() -> list[TeamLoc]:
    return [t for t in _index().teams.values() if t.parentTeamId is None]


def agent_loc(agent_id: str) -> AgentLoc | None:
    return _index().agents.get(agent_id)


def agent_locs_for_team(team_id: str) -> list[AgentLoc]:
    return [a for a in _index().agents.values() if a.teamId == team_id]


def all_agent_locs() -> list[AgentLoc]:
    return list(_index().agents.values())

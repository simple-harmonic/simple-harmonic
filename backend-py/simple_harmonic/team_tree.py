"""Team tree helpers: queries for the recursive team hierarchy.

TS source: packages/backend/src/server/team-tree.ts

Teams form a tree via ``parentTeamId``. These functions resolve ancestry,
sub-trees, and authorization scoping for lead agents: a lead agent can only
manage teams and agents within its own sub-tree. The tree is small (<100 teams
at the expected scale) so an in-memory traversal over ``teams.all()`` beats
anything cleverer.

The recursive folder layout (each team is a folder; sub-teams live under the
parent's ``teams/`` child dir) already encodes the hierarchy on disk, but these
helpers read the in-memory ``parentTeamId`` edges so the queries match the TS
parent-map traversal byte-for-byte. ``teams.roots()`` / ``teams.children()`` use
the location index directly.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from simple_harmonic.store.repos import teams
from simple_harmonic.store.types import Team


async def _all_teams() -> list[Team]:
    """Every team (cheap at the expected scale of <100 teams)."""
    return await teams.all()


async def get_child_teams(team_id: str) -> list[Team]:
    """The direct children of a team."""
    return await teams.children(team_id)


async def get_root_teams() -> list[Team]:
    """All root teams (no parent)."""
    return await teams.roots()


async def get_sub_tree_ids(team_id: str) -> set[str]:
    """All team IDs in the sub-tree rooted at ``team_id``, inclusive.

    Used for authorization scoping in the management / action_history tools.
    """
    all_teams = await _all_teams()
    child_map: dict[str, list[str]] = {}
    for t in all_teams:
        if t.parentTeamId:
            child_map.setdefault(t.parentTeamId, []).append(t.id)

    result: set[str] = set()
    stack = [team_id]
    while stack:
        current = stack.pop()
        result.add(current)
        stack.extend(child_map.get(current, []))
    return result


async def is_ancestor(ancestor_id: str, team_id: str) -> bool:
    """Whether ``ancestor_id`` is an ancestor of ``team_id`` (or equal to it)."""
    if ancestor_id == team_id:
        return True
    all_teams = await _all_teams()
    parent_map = {t.id: t.parentTeamId for t in all_teams}

    current: str | None = team_id
    visited: set[str] = set()
    while current:
        if current == ancestor_id:
            return True
        if current in visited:
            return False
        visited.add(current)
        parent = parent_map.get(current)
        if not parent:
            return False
        current = parent
    return False


async def get_ancestor_chain(team_id: str) -> list[str]:
    """The full ancestor chain from ``team_id`` up to the root.

    Returns ``[team_id, parentId, grandparentId, ..., rootId]``.
    """
    all_teams = await _all_teams()
    parent_map = {t.id: t.parentTeamId for t in all_teams}

    chain: list[str] = []
    current: str | None = team_id
    visited: set[str] = set()
    while current:
        if current in visited:
            break
        visited.add(current)
        chain.append(current)
        current = parent_map.get(current)
    return chain


@dataclass
class TeamTreeNode:
    """One node in the display tree (TS: TeamTreeNode)."""

    id: str
    name: str
    paused: bool
    children: list[TeamTreeNode] = field(default_factory=list)


async def get_team_tree() -> list[TeamTreeNode]:
    """Build a nested tree structure for display purposes."""
    all_teams = await _all_teams()
    child_map: dict[str | None, list[Team]] = {}
    for t in all_teams:
        key = t.parentTeamId
        child_map.setdefault(key, []).append(t)

    def build_node(team: Team) -> TeamTreeNode:
        children = [build_node(c) for c in child_map.get(team.id, [])]
        return TeamTreeNode(id=team.id, name=team.name, paused=team.paused, children=children)

    roots = child_map.get(None, [])
    return [build_node(t) for t in roots]

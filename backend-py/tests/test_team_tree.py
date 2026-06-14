"""Team-tree helper tests.

Ports the behavioral contract of packages/backend/src/server/team-tree.ts onto
the repo-backed recursive team store: child/root queries, sub-tree id resolution
(authorization scoping), ancestry, and the display tree. The TS package had no
dedicated team-tree.test.ts, so these are written from the source semantics.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from simple_harmonic import team_tree
from simple_harmonic.store import data_dir as dd
from simple_harmonic.store import invalidate_index
from simple_harmonic.store.repos import NewTeam, teams
from simple_harmonic.store.types import Team

# asyncio_mode = "auto" (pyproject) runs ``async def`` tests without a marker.


@pytest.fixture
def store_dir(tmp_path: Path) -> Iterator[Path]:
    root = tmp_path / "data"
    dd.set_data_dir(root)
    invalidate_index()
    dd.ensure_data_dir()
    try:
        yield root
    finally:
        invalidate_index()
        dd.set_data_dir(None)


async def _tree() -> tuple[Team, Team, Team, Team]:
    """Build: A (root) -> B -> C, plus D (root). Returns (A, B, C, D)."""
    a = await teams.create(NewTeam(name="A"))
    b = await teams.create(NewTeam(name="B", parentTeamId=a.id))
    c = await teams.create(NewTeam(name="C", parentTeamId=b.id))
    d = await teams.create(NewTeam(name="D"))
    return a, b, c, d


async def test_get_root_teams(store_dir: Path) -> None:
    a, _b, _c, d = await _tree()
    roots = {t.id for t in await team_tree.get_root_teams()}
    assert roots == {a.id, d.id}


async def test_get_child_teams(store_dir: Path) -> None:
    a, b, c, _d = await _tree()
    a_children = {t.id for t in await team_tree.get_child_teams(a.id)}
    assert a_children == {b.id}
    b_children = {t.id for t in await team_tree.get_child_teams(b.id)}
    assert b_children == {c.id}
    assert await team_tree.get_child_teams(c.id) == []


async def test_get_sub_tree_ids_inclusive(store_dir: Path) -> None:
    a, b, c, d = await _tree()
    # The sub-tree rooted at A includes A, B, C — but not the sibling root D.
    assert await team_tree.get_sub_tree_ids(a.id) == {a.id, b.id, c.id}
    assert await team_tree.get_sub_tree_ids(b.id) == {b.id, c.id}
    assert await team_tree.get_sub_tree_ids(c.id) == {c.id}
    assert await team_tree.get_sub_tree_ids(d.id) == {d.id}


async def test_is_ancestor(store_dir: Path) -> None:
    a, b, c, d = await _tree()
    assert await team_tree.is_ancestor(a.id, c.id) is True  # transitive
    assert await team_tree.is_ancestor(b.id, c.id) is True  # direct
    assert await team_tree.is_ancestor(c.id, c.id) is True  # reflexive
    assert await team_tree.is_ancestor(c.id, a.id) is False  # wrong direction
    assert await team_tree.is_ancestor(d.id, c.id) is False  # unrelated root


async def test_get_ancestor_chain(store_dir: Path) -> None:
    a, b, c, _d = await _tree()
    # [teamId, parentId, ..., rootId]
    assert await team_tree.get_ancestor_chain(c.id) == [c.id, b.id, a.id]
    assert await team_tree.get_ancestor_chain(a.id) == [a.id]


async def test_get_team_tree_nested(store_dir: Path) -> None:
    a, b, c, d = await _tree()
    tree = await team_tree.get_team_tree()
    by_id = {n.id: n for n in tree}
    # Two roots.
    assert set(by_id) == {a.id, d.id}
    # A -> B -> C nesting.
    a_node = by_id[a.id]
    assert [n.id for n in a_node.children] == [b.id]
    assert [n.id for n in a_node.children[0].children] == [c.id]
    assert a_node.name == "A"
    assert a_node.paused is False
    # D is a childless root.
    assert by_id[d.id].children == []

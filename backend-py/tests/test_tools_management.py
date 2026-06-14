"""Management / observe / action_history tool tests (store-backed, offline).

TS source: packages/backend/src/server/tools/{management,observe,action-history}.ts

These tools mutate / read the JSON file store and resolve authorization through
the team sub-tree. They run fully offline over an isolated temp data dir (no
network, no external process), exercising the real repos so the wiring — sub-tree
auth scoping, patch shapes, and the action/event read paths — is verified end to
end.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from simple_harmonic.store import data_dir as dd
from simple_harmonic.store.index_cache import invalidate_index
from simple_harmonic.store.repos import (
    NewAgent,
    NewAppEvent,
    NewTeam,
    actionLog,
    agents,
    appEvents,
    teams,
)
from simple_harmonic.tools.action_history import ActionHistoryArgs, action_history_impl
from simple_harmonic.tools.management import (
    ModifyAgentArgs,
    ModifyAgentUpdates,
    ModifyTeamArgs,
    ModifyTeamUpdates,
    SetTeamGoalArgs,
    SpawnSubTeamAgent,
    SpawnSubTeamArgs,
    modify_agent_impl,
    modify_team_impl,
    set_team_goal_impl,
    spawn_sub_team_impl,
)
from simple_harmonic.tools.observe import observe_app_impl
from simple_harmonic.tools.types import ToolRunContext


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


def ctx(team_id: str, agent_id: str = "agent-1") -> ToolRunContext:
    return ToolRunContext(teamId=team_id, agentId=agent_id, agentName="lead", peers=[])


def _new_agent(name: str, **kw: object) -> NewAgent:
    base: dict[str, object] = {
        "name": name,
        "role": "worker",
        "archetype": "scout",
        "tools": ["read_file"],
        "scheduleSeconds": 60,
        "initialPrompt": "go",
    }
    base.update(kw)
    return NewAgent(**base)  # type: ignore[arg-type]


# --- set_team_goal ----------------------------------------------------------


async def test_set_team_goal_updates_own_team(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="Acme"))
    res = await set_team_goal_impl(SetTeamGoalArgs(goal="ship v1"), ctx(team.id))
    assert res.success is True
    assert (await teams.byId(team.id)).goal == "ship v1"


async def test_set_team_goal_rejects_outside_sub_tree(store_dir: Path) -> None:
    mine = await teams.create(NewTeam(name="Mine"))
    other = await teams.create(NewTeam(name="Other"))
    res = await set_team_goal_impl(
        SetTeamGoalArgs(team_name="Other", goal="x"), ctx(mine.id)
    )
    assert res.success is False
    assert "outside your scope" in res.result
    assert (await teams.byId(other.id)).goal is None


# --- spawn_sub_team + modify_team -------------------------------------------


async def test_spawn_sub_team_creates_team_and_agents(store_dir: Path) -> None:
    parent = await teams.create(NewTeam(name="Parent"))
    res = await spawn_sub_team_impl(
        SpawnSubTeamArgs(
            team_name="Squad",
            agents=[
                SpawnSubTeamAgent(
                    name="a1", role="r", archetype="scout", tools=["read_file"],
                    schedule_seconds=30, initial_prompt="p",
                )
            ],
        ),
        ctx(parent.id),
    )
    assert res.success is True
    children = await teams.children(parent.id)
    assert [c.name for c in children] == ["Squad"]
    assert len(await agents.byTeam(children[0].id)) == 1


async def test_modify_team_delete_removes_sub_tree(store_dir: Path) -> None:
    root = await teams.create(NewTeam(name="Root"))
    child = await teams.create(NewTeam(name="Child", parentTeamId=root.id))
    await agents.create(child.id, _new_agent("c-agent"))
    res = await modify_team_impl(
        ModifyTeamArgs(team_name="Child", action="delete"), ctx(root.id)
    )
    assert res.success is True
    assert await teams.byId(child.id) is None
    assert res.action is not None
    assert res.action.payload["agentsDeleted"] == 1


async def test_modify_team_cannot_delete_own_team(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="Self"))
    res = await modify_team_impl(
        ModifyTeamArgs(team_name="Self", action="delete"), ctx(team.id)
    )
    assert res.success is False
    assert "Cannot delete your own team" in res.result


async def test_modify_team_update_requires_updates(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="T"))
    res = await modify_team_impl(
        ModifyTeamArgs(team_name="T", action="update"), ctx(team.id)
    )
    assert res.success is False
    assert "requires updates" in res.result


async def test_modify_team_update_pauses(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="T"))
    res = await modify_team_impl(
        ModifyTeamArgs(team_name="T", action="update", updates=ModifyTeamUpdates(paused=True)),
        ctx(team.id),
    )
    assert res.success is True
    assert (await teams.byId(team.id)).paused is True


# --- modify_agent -----------------------------------------------------------


async def test_modify_agent_update_tools(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="T"))
    agent = await agents.create(team.id, _new_agent("worker"))
    res = await modify_agent_impl(
        ModifyAgentArgs(
            agent_name="worker",
            action="update",
            updates=ModifyAgentUpdates(tools=["read_file", "http_fetch"]),
        ),
        ctx(team.id),
    )
    assert res.success is True
    assert (await agents.byId(agent.id)).tools == ["read_file", "http_fetch"]


async def test_modify_agent_cannot_delete_self(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="T"))
    agent = await agents.create(team.id, _new_agent("me"))
    res = await modify_agent_impl(
        ModifyAgentArgs(agent_name="me", action="delete"), ctx(team.id, agent.id)
    )
    assert res.success is False
    assert "Cannot delete yourself" in res.result


async def test_modify_agent_move_to_sibling_team(store_dir: Path) -> None:
    root = await teams.create(NewTeam(name="Root"))
    src = await teams.create(NewTeam(name="Src", parentTeamId=root.id))
    dst = await teams.create(NewTeam(name="Dst", parentTeamId=root.id))
    agent = await agents.create(src.id, _new_agent("mover"))
    res = await modify_agent_impl(
        ModifyAgentArgs(agent_name="mover", team_name="Src", action="move", move_to_team="Dst"),
        ctx(root.id),
    )
    assert res.success is True
    assert (await agents.byId(agent.id)).teamId == dst.id


# --- action_history ---------------------------------------------------------


async def test_action_history_self_scope(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="T"))
    agent = await agents.create(team.id, _new_agent("worker"))
    await actionLog.insert(
        agent.id, type("N", (), {"actionType": "research", "payload": {"summary": "found it"},
                                 "metaAgentApprovalId": None})()
    )
    res = await action_history_impl(ActionHistoryArgs(scope="self"), ctx(team.id, agent.id))
    assert res.success is True
    assert "research" in res.result
    assert "found it" in res.result


async def test_action_history_agent_not_found(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="T"))
    res = await action_history_impl(
        ActionHistoryArgs(scope="agent", agent_name="ghost"), ctx(team.id)
    )
    assert res.success is False
    assert "not found" in res.result


async def test_action_history_validation_fail_rendered(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="T"))
    agent = await agents.create(team.id, _new_agent("worker"))
    await actionLog.insert(
        agent.id,
        type("N", (), {
            "actionType": "draft",
            "payload": {
                "summary": "wrote a draft",
                "validation": {
                    "valid": False,
                    "issues": [{"path": "title", "message": "required"}],
                },
            },
            "metaAgentApprovalId": None,
        })(),
    )
    res = await action_history_impl(
        ActionHistoryArgs(scope="self", validation_only=True), ctx(team.id, agent.id)
    )
    assert res.success is True
    assert "FAIL" in res.result
    assert "title: required" in res.result


# --- observe_app ------------------------------------------------------------


async def test_observe_app_returns_team_events(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="T"))
    appEvents.insert(
        NewAppEvent(severity="error", level="tool", source="tool",
                    message="tool blew up", teamId=team.id)
    )
    res = await observe_app_impl(
        type("A", (), {"severity": None, "level": None, "source": None,
                       "hours": None, "limit": None})(),
        ctx(team.id),
    )
    assert res.success is True
    assert "tool blew up" in res.result


async def test_observe_app_never_returns_infra(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="T"))
    # Infra events live in the system file and must never reach an agent.
    appEvents.insert(
        NewAppEvent(severity="error", level="infra", source="api", message="DB DOWN SECRET")
    )
    res = await observe_app_impl(
        type("A", (), {"severity": None, "level": None, "source": None,
                       "hours": None, "limit": None})(),
        ctx(team.id),
    )
    assert res.success is True
    assert "DB DOWN SECRET" not in res.result
    assert "No events found" in res.result

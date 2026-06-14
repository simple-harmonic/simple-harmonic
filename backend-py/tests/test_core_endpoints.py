"""Top-level (non-team) endpoint tests (slice 8).

TS source: packages/backend/src/server/api/{chat,spawn,seed,infra-report,login}.ts
           + agent/[id].ts

Drives the ASGI app for the operator-gated routes (chat/spawn/seed/infra-report/
agent) behind a Bearer OPERATOR_PASSWORD, and the PUBLIC /api/login. Fully
OFFLINE: the planner (``planner_stream``) is monkeypatched with a scripted token
source so the chat SSE streams without any LLM/network call; the agent runner is
never invoked here.

Datetime fidelity: the TS handlers serialize via ``Date#toISOString()`` (ms + Z).
The Python routes render datetimes through ``json_default``, so the ISO assertions
below check the ``...Z`` (not ``+00:00``) shape.
"""

from __future__ import annotations

import json
import re

import pytest
from httpx import AsyncClient

from simple_harmonic.auth import OPERATOR_COOKIE, sha256_hex
from simple_harmonic.routes import core as core_route
from simple_harmonic.store.repos import NewAgent, NewTeam, agents, appEvents, teams
from simple_harmonic.store.repos.app_events import NewAppEvent

# Matches the operator password the conftest fixture sets.
OPERATOR_PASSWORD = "test-operator-pw"

# ISO ms-Z shape (toISOString), e.g. "2026-06-14T12:00:00.123Z".
_ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def _auth() -> dict[str, str]:
    return {"authorization": f"Bearer {OPERATOR_PASSWORD}"}


async def _make_team(name: str = "alpha", **kw: object):
    return await teams.create(NewTeam(name=name, **kw))  # type: ignore[arg-type]


async def _make_agent(team_id: str, name: str = "scout", **kw: object):
    base: dict[str, object] = {
        "name": name,
        "role": "researcher",
        "archetype": "scout",
        "tools": ["search"],
        "scheduleSeconds": 60,
        "initialPrompt": "go",
    }
    base.update(kw)
    return await agents.insert(team_id, NewAgent(**base))  # type: ignore[arg-type]


# ===========================================================================
# login.ts — POST /api/login (PUBLIC; issues the sh_operator cookie)
# ===========================================================================


async def test_login_sets_cookie_on_success(
    client: AsyncClient, operator_password: str
) -> None:
    resp = await client.post("/api/login", json={"password": OPERATOR_PASSWORD})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    set_cookie = resp.headers["set-cookie"]
    expected_value = sha256_hex(OPERATOR_PASSWORD)
    assert f"{OPERATOR_COOKIE}={expected_value}" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "SameSite=Lax" in set_cookie
    assert "Path=/" in set_cookie
    assert "Max-Age=2592000" in set_cookie
    # Not production in tests -> no Secure attribute.
    assert "Secure" not in set_cookie


async def test_login_wrong_password_401(
    client: AsyncClient, operator_password: str
) -> None:
    resp = await client.post("/api/login", json={"password": "nope"})
    assert resp.status_code == 401
    assert resp.json() == {"error": "Invalid password"}
    assert "set-cookie" not in resp.headers


async def test_login_is_public_no_auth_header_needed(
    client: AsyncClient, operator_password: str
) -> None:
    # /api/login is OPEN even with the gate active: no bearer/cookie supplied.
    resp = await client.post("/api/login", json={"password": OPERATOR_PASSWORD})
    assert resp.status_code == 200


async def test_login_cookie_then_authorizes_gated_route(
    client: AsyncClient, operator_password: str
) -> None:
    """The cookie minted by /api/login authorizes a gated route end-to-end."""
    login = await client.post("/api/login", json={"password": OPERATOR_PASSWORD})
    cookie_value = login.headers["set-cookie"].split(";")[0].split("=", 1)[1]
    assert cookie_value == sha256_hex(OPERATOR_PASSWORD)
    resp = await client.get(
        "/api/infra-report",
        headers={"cookie": f"{OPERATOR_COOKIE}={cookie_value}"},
    )
    assert resp.status_code == 200
    assert "events" in resp.json()


# ===========================================================================
# The gate: an unauthenticated gated route is 401
# ===========================================================================


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/infra-report"),
        ("POST", "/api/infra-report"),
        ("POST", "/api/chat"),
        ("POST", "/api/spawn"),
        ("POST", "/api/seed"),
        ("PATCH", "/api/agent/some-id"),
    ],
)
async def test_gated_route_unauthorized_401(
    client: AsyncClient, operator_password: str, method: str, path: str
) -> None:
    # Gate active (operator_password fixture), no bearer/cookie -> 401.
    resp = await client.request(method, path, json={})
    assert resp.status_code == 401
    assert resp.json() == {"error": "unauthorized"}


# ===========================================================================
# chat.ts — POST /api/chat (SSE planner stream)
# ===========================================================================


async def _collect_sse(client: AsyncClient, path: str, **kw) -> list[dict]:
    out: list[dict] = []
    async with client.stream("POST", path, **kw) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        buf = ""
        async for chunk in resp.aiter_text():
            buf += chunk
            while "\n\n" in buf:
                frame, buf = buf.split("\n\n", 1)
                frame = frame.strip()
                if frame.startswith("data: "):
                    out.append(json.loads(frame[len("data: ") :]))
    return out


async def test_chat_missing_messages_400(
    client: AsyncClient, operator_password: str
) -> None:
    resp = await client.post("/api/chat", headers=_auth(), json={})
    assert resp.status_code == 400
    assert resp.json() == {"error": "messages required"}


async def test_chat_streams_mocked_tokens_then_done(
    client: AsyncClient, operator_password: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from simple_harmonic.meta_agent import MessageResult

    async def fake_planner_stream(messages, on_token, deps):
        for tok in ("Hello", " ", "world"):
            on_token(tok)
        return MessageResult(content="Hello world")

    monkeypatch.setattr(core_route, "planner_stream", fake_planner_stream)

    events = await _collect_sse(
        client,
        "/api/chat",
        headers=_auth(),
        json={"messages": [{"role": "user", "content": "hi"}]},
    )
    tokens = [e for e in events if e["type"] == "token"]
    assert [t["text"] for t in tokens] == ["Hello", " ", "world"]
    assert events[-1] == {"type": "done", "content": "Hello world"}


async def test_chat_spawn_result_frame(
    client: AsyncClient, operator_password: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from simple_harmonic.meta_agent import SpawnResult
    from simple_harmonic.meta_agent.types import SpawnTeamAgent, SpawnTeamResult

    spawn_result = SpawnResult(
        content="spawning",
        result=SpawnTeamResult(
            team_name="Acme",
            agents=[
                SpawnTeamAgent(
                    name="a1",
                    role="r",
                    archetype="x",
                    tools=["t"],
                    schedule_seconds=300,
                    initial_prompt="p",
                )
            ],
        ),
    )

    async def fake_planner_stream(messages, on_token, deps):
        return spawn_result

    monkeypatch.setattr(core_route, "planner_stream", fake_planner_stream)

    events = await _collect_sse(
        client,
        "/api/chat",
        headers=_auth(),
        json={"messages": [{"role": "user", "content": "spawn"}]},
    )
    final = events[-1]
    assert final["type"] == "spawn"
    assert final["teamName"] == "Acme"
    assert final["parentTeam"] is None
    assert final["cofounderName"] is None
    assert final["agents"][0]["name"] == "a1"
    assert final["content"] == "spawning"


async def test_chat_modify_agent_applies_update(
    client: AsyncClient, operator_password: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from simple_harmonic.meta_agent import ModifyAgentResultEnvelope
    from simple_harmonic.meta_agent.types import ModifyAgentResult, ModifyAgentUpdates

    t = await _make_team("Beta")
    a = await _make_agent(t.id, "worker")

    envelope = ModifyAgentResultEnvelope(
        content="modifying",
        result=ModifyAgentResult(
            agent_name="worker",
            team_name="Beta",
            updates=ModifyAgentUpdates(schedule_seconds=120),
        ),
    )

    async def fake_planner_stream(messages, on_token, deps):
        return envelope

    monkeypatch.setattr(core_route, "planner_stream", fake_planner_stream)

    events = await _collect_sse(
        client,
        "/api/chat",
        headers=_auth(),
        json={"messages": [{"role": "user", "content": "modify"}]},
    )
    final = events[-1]
    assert final["type"] == "modify_agent"
    assert final["applied"] == {"ok": True}
    # The store row actually changed.
    refreshed = await agents.byId(a.id)
    assert refreshed is not None
    assert refreshed.scheduleSeconds == 120


async def test_chat_error_frame_on_planner_exception(
    client: AsyncClient, operator_password: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def boom(messages, on_token, deps):
        raise RuntimeError("planner exploded")

    monkeypatch.setattr(core_route, "planner_stream", boom)

    events = await _collect_sse(
        client,
        "/api/chat",
        headers=_auth(),
        json={"messages": [{"role": "user", "content": "hi"}]},
    )
    assert events[-1] == {"type": "error", "message": "planner exploded"}


# ===========================================================================
# spawn.ts — POST /api/spawn
# ===========================================================================


async def test_spawn_missing_agents_400(
    client: AsyncClient, operator_password: str
) -> None:
    resp = await client.post("/api/spawn", headers=_auth(), json={"agents": []})
    assert resp.status_code == 400
    assert resp.json() == {"error": "agents required"}


async def test_spawn_root_team_adds_harmon(
    client: AsyncClient, operator_password: str
) -> None:
    resp = await client.post(
        "/api/spawn",
        headers=_auth(),
        json={
            "teamName": "Launch Crew",
            "agents": [
                {
                    "name": "scout",
                    "role": "research",
                    "archetype": "researcher",
                    "tools": ["send_message"],
                    "schedule_seconds": 300,
                    "initial_prompt": "scout the market",
                }
            ],
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["parentTeamId"] is None
    team_id = body["teamId"]

    team_agents = await agents.byTeam(team_id)
    names = {a.name for a in team_agents}
    # The user agent + auto-spawned Harmon (cofounder, lowercased/kebab).
    assert "scout" in names
    assert "harmon" in names
    harmon = next(a for a in team_agents if a.name == "harmon")
    assert harmon.archetype == "meta-agent"
    assert harmon.scheduleSeconds == 3600


async def test_spawn_sub_team_no_harmon(
    client: AsyncClient, operator_password: str
) -> None:
    parent = await _make_team("Parent")
    resp = await client.post(
        "/api/spawn",
        headers=_auth(),
        json={
            "teamName": "Child",
            "parentTeamId": parent.id,
            "agents": [
                {
                    "name": "worker",
                    "role": "do",
                    "archetype": "executor",
                    "tools": [],
                    "schedule_seconds": 60,
                    "initial_prompt": "work",
                }
            ],
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["parentTeamId"] == parent.id
    team_agents = await agents.byTeam(body["teamId"])
    assert {a.name for a in team_agents} == {"worker"}  # no Harmon on sub-teams


async def test_spawn_unknown_parent_name_400(
    client: AsyncClient, operator_password: str
) -> None:
    resp = await client.post(
        "/api/spawn",
        headers=_auth(),
        json={
            "parentTeam": "ghost",
            "agents": [
                {
                    "name": "w",
                    "role": "r",
                    "archetype": "x",
                    "tools": [],
                    "schedule_seconds": 60,
                    "initial_prompt": "p",
                }
            ],
        },
    )
    assert resp.status_code == 400
    assert resp.json() == {"error": 'Parent team "ghost" not found'}


# ===========================================================================
# seed.ts — POST /api/seed
# ===========================================================================


async def test_seed_creates_team_messages_tasks(
    client: AsyncClient, operator_password: str
) -> None:
    resp = await client.post("/api/seed", headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert body["messageCount"] == 27
    assert body["taskCount"] == 9
    assert len(body["agents"]) == 4
    team_id = body["teamId"]

    # The 4 demo agents were inserted.
    team_agents = await agents.byTeam(team_id)
    assert {a.name for a in team_agents} == {"Scout", "Relay", "Chisel", "Pulse"}

    # a2ax actually recorded messages + tasks.
    a2ax = core_route.get_a2ax()
    messages = await a2ax.list_messages(team_id)
    assert len(messages) > 0
    tasks = await a2ax.list_tasks(team_id)
    assert len(tasks) == 9


async def test_seed_conflict_when_team_exists(
    client: AsyncClient, operator_password: str
) -> None:
    first = await client.post("/api/seed", headers=_auth())
    assert first.status_code == 200
    second = await client.post("/api/seed", headers=_auth())
    assert second.status_code == 409
    body = second.json()
    assert body["error"] == "Mock team already exists"
    assert body["teamId"] == first.json()["teamId"]


# ===========================================================================
# infra-report.ts — GET + POST /api/infra-report
# ===========================================================================


async def test_infra_report_get_returns_infra_and_tool_events(
    client: AsyncClient, operator_password: str
) -> None:
    # infra + tool events are unacknowledged by default; an agent-level event is
    # excluded.
    appEvents.insert(
        NewAppEvent(severity="error", level="infra", source="db", message="infra boom")
    )
    appEvents.insert(
        NewAppEvent(severity="warning", level="tool", source="github", message="tool warn")
    )
    appEvents.insert(
        NewAppEvent(severity="info", level="agent", source="x", message="agent noise")
    )

    resp = await client.get("/api/infra-report", headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    messages = {e["message"] for e in body["events"]}
    assert messages == {"infra boom", "tool warn"}
    assert body["total"] == 2
    assert body["infraCount"] == 1
    assert body["toolCount"] == 1
    # createdAt rendered as ms-Z (toISOString shape).
    for e in body["events"]:
        assert _ISO_Z.match(e["createdAt"])


async def test_infra_report_post_acknowledges(
    client: AsyncClient, operator_password: str
) -> None:
    appEvents.insert(
        NewAppEvent(severity="error", level="infra", source="db", message="infra boom")
    )
    # Find its id via the report.
    report = await client.get("/api/infra-report", headers=_auth())
    event_id = report.json()["events"][0]["id"]

    resp = await client.post(
        "/api/infra-report", headers=_auth(), json={"eventIds": [event_id]}
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "acknowledged": 1}

    # Acknowledged event no longer shows in the (unacknowledged-only) report.
    after = await client.get("/api/infra-report", headers=_auth())
    assert after.json()["total"] == 0


async def test_infra_report_post_missing_event_ids_400(
    client: AsyncClient, operator_password: str
) -> None:
    resp = await client.post("/api/infra-report", headers=_auth(), json={})
    assert resp.status_code == 400
    assert resp.json() == {"error": "eventIds array required"}


# ===========================================================================
# agent/[id].ts — PATCH /api/agent/{id}
# ===========================================================================


async def test_patch_agent_updates_allowed_fields(
    client: AsyncClient, operator_password: str
) -> None:
    t = await _make_team("t")
    a = await _make_agent(t.id, "worker")

    resp = await client.patch(
        f"/api/agent/{a.id}",
        headers=_auth(),
        json={"name": "renamed", "scheduleSeconds": 90, "ignored": "x"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "renamed"
    assert body["scheduleSeconds"] == 90
    assert _ISO_Z.match(body["createdAt"])

    refreshed = await agents.byId(a.id)
    assert refreshed is not None
    assert refreshed.name == "renamed"
    assert refreshed.scheduleSeconds == 90


async def test_patch_agent_invalid_status_400(
    client: AsyncClient, operator_password: str
) -> None:
    t = await _make_team("t")
    a = await _make_agent(t.id, "worker")
    resp = await client.patch(
        f"/api/agent/{a.id}", headers=_auth(), json={"status": "awaiting_approval"}
    )
    assert resp.status_code == 400
    assert resp.json() == {"error": "invalid status"}


async def test_patch_agent_no_valid_fields_400(
    client: AsyncClient, operator_password: str
) -> None:
    t = await _make_team("t")
    a = await _make_agent(t.id, "worker")
    resp = await client.patch(f"/api/agent/{a.id}", headers=_auth(), json={"goal": "x"})
    assert resp.status_code == 400
    assert resp.json() == {"error": "no valid fields"}


async def test_patch_agent_not_found_404(
    client: AsyncClient, operator_password: str
) -> None:
    resp = await client.patch(
        "/api/agent/does-not-exist", headers=_auth(), json={"name": "x"}
    )
    assert resp.status_code == 404
    assert resp.json() == {"error": "not found"}


async def test_patch_agent_wake_resets_next_run_and_status(
    client: AsyncClient, operator_password: str
) -> None:
    t = await _make_team("t")
    a = await _make_agent(t.id, "worker", status="paused")

    resp = await client.patch(f"/api/agent/{a.id}", headers=_auth(), json={"wake": True})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "running"
    assert _ISO_Z.match(body["nextRunAt"])


async def test_patch_agent_awaiting_approval_conflict_409(
    client: AsyncClient, operator_password: str
) -> None:
    t = await _make_team("t")
    a = await _make_agent(t.id, "worker")
    # Park the agent awaiting approval, then a status/wake change must 409.
    await agents.update(a.id, {"status": "awaiting_approval"})

    resp = await client.patch(
        f"/api/agent/{a.id}", headers=_auth(), json={"status": "running"}
    )
    assert resp.status_code == 409
    assert "awaiting approval" in resp.json()["error"]

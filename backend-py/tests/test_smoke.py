"""Offline smoke test: app boots, endpoints respond with contract shapes,
and the a2ax models round-trip.
"""

from __future__ import annotations

from datetime import UTC, datetime

from httpx import AsyncClient

from simple_harmonic.a2ax import (
    AgentToken,
    Channel,
    Message,
    Task,
    create_agent_card,
    direct_channel_id,
    has_scope,
    is_valid_transition,
)
from simple_harmonic.auth import OPERATOR_COOKIE, sha256_hex


async def test_health_ok(client: AsyncClient) -> None:
    resp = await client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert isinstance(body["version"], str)


async def test_platform_status_default_shape(
    client: AsyncClient, operator_password: str
) -> None:
    # settings/* is now operator-gated: authenticate with a Bearer token.
    resp = await client.get(
        "/api/settings/platform-status",
        headers={"authorization": f"Bearer {operator_password}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    # Default healthy row when unset (not a 404).
    assert body["id"] == 1
    assert body["status"] == "healthy"
    assert body["message"] is None
    # updatedAt is an ISO-8601 string.
    assert isinstance(body["updatedAt"], str)
    datetime.fromisoformat(body["updatedAt"])
    assert set(body.keys()) == {"id", "status", "message", "updatedAt"}


async def test_platform_status_via_operator_cookie(
    client: AsyncClient, operator_password: str
) -> None:
    # The sh_operator cookie (= sha256(password)) authenticates too.
    cookie = f"{OPERATOR_COOKIE}={sha256_hex(operator_password)}"
    resp = await client.get(
        "/api/settings/platform-status", headers={"cookie": cookie}
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "healthy"


async def test_gated_route_rejects_unauthenticated(
    client: AsyncClient, operator_password: str
) -> None:
    # With OPERATOR_PASSWORD set, an unauthenticated gated request is rejected.
    resp = await client.get("/api/settings/platform-status")
    assert resp.status_code == 401
    assert resp.json() == {"error": "unauthorized"}


async def test_gated_route_rejects_wrong_password(
    client: AsyncClient, operator_password: str
) -> None:
    resp = await client.get(
        "/api/settings/platform-status",
        headers={"authorization": "Bearer wrong-password"},
    )
    assert resp.status_code == 401


async def test_teams_open_when_gate_active(
    client: AsyncClient, operator_password: str
) -> None:
    # /api/teams stays open even with the gate active (handler reads no session).
    resp = await client.get("/api/teams")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_tick_open_when_gate_active(
    client: AsyncClient, operator_password: str
) -> None:
    # /api/tick is cron-gated separately and must NOT require the operator cookie.
    resp = await client.get("/api/tick")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


async def test_health_open_when_gate_active(
    client: AsyncClient, operator_password: str
) -> None:
    # /health is a liveness probe and stays open.
    resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


async def test_teams_empty_on_fresh_store(client: AsyncClient) -> None:
    resp = await client.get("/api/teams")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_teams_repo_backed_newest_first(client: AsyncClient) -> None:
    # The /api/teams endpoint now reads the slice-2 repos (NOT the retired
    # slice-1 JsonFileStore): a created team surfaces with the repo-backed shape,
    # newest-first.
    from datetime import timedelta

    from simple_harmonic.store.repos import NewTeam, teams

    first = await teams.create(NewTeam(name="alpha"))
    second = await teams.create(NewTeam(name="beta"))
    # Force a distinct createdAt so the newest-first ordering is deterministic
    # (back-to-back creates can otherwise tie to the same microsecond).
    older = (first.createdAt - timedelta(seconds=1)).isoformat()
    await teams.update(first.id, {"createdAt": older})

    resp = await client.get("/api/teams")
    assert resp.status_code == 200
    body = resp.json()
    assert {t["id"] for t in body} == {first.id, second.id}
    assert [t["id"] for t in body] == [second.id, first.id]  # newest-first
    # Repo-backed serialization: createdAt is an ISO-8601 string that re-parses.
    datetime.fromisoformat(body[0]["createdAt"])
    assert body[0]["name"] == "beta"
    assert body[0]["tickCount"] == 0


async def test_tick_runs(client: AsyncClient) -> None:
    resp = await client.get("/api/tick")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["agentsRan"] == 0
    datetime.fromisoformat(body["timestamp"])


def test_message_round_trips() -> None:
    now = datetime.now(UTC)
    msg = Message(
        id="m1",
        teamId="t1",
        channelType="direct",
        channelId=direct_channel_id("a", "b"),
        fromAgentId="a",
        kind="text",
        content="hello",
        createdAt=now,
    )
    dumped = msg.model_dump(mode="json", by_alias=True)
    assert dumped["channelId"] == "direct:a:b"
    assert dumped["status"] == "pending"  # default on insert
    assert dumped["role"] == "agent"
    revived = Message.model_validate(dumped)
    assert revived == msg


def test_task_transitions_and_round_trip() -> None:
    now = datetime.now(UTC)
    task = Task(
        id="k1",
        teamId="t1",
        channelId="task:k1",
        requestorId="a",
        assigneeId="b",
        title="do thing",
        description="",
        createdAt=now,
        updatedAt=now,
    )
    assert task.state == "submitted"
    assert is_valid_transition("submitted", "accepted") is True
    assert is_valid_transition("completed", "working") is False
    assert Task.model_validate(task.model_dump(mode="json", by_alias=True)) == task


def test_channel_round_trips() -> None:
    now = datetime.now(UTC)
    ch = Channel(id="c1", teamId="t1", channelType="group", name="eng", createdAt=now)
    assert Channel.model_validate(ch.model_dump(mode="json", by_alias=True)) == ch


def test_agent_card_defaults() -> None:
    card = create_agent_card(id="a1", name="Scout", endpoint="local://a1")
    assert card.capabilities.broadcast is True
    assert card.capabilities.streaming is False
    assert card.skills == []
    dumped = card.model_dump(mode="json", by_alias=True)
    assert dumped["id"] == "a1"
    assert dumped["capabilities"]["tasks"] is True


def test_token_scopes() -> None:
    now = datetime.now(UTC)
    token = AgentToken(agentId="a1", teamId="t1", token="deadbeef", createdAt=now)
    # Default scope set includes message:send but not admin / task:cancel.
    assert has_scope(token, "message:send") is True
    assert has_scope(token, "task:cancel") is False
    admin = AgentToken(
        agentId="a2", teamId="t1", token="cafe", scopes=["admin"], createdAt=now
    )
    # admin grants everything.
    assert has_scope(admin, "task:cancel") is True

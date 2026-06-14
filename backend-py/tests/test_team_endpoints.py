"""team/[id]/* endpoint tests (slice 8).

TS source: packages/backend/src/server/api/team/id/*.ts

Every handler is exercised for its happy path plus the contract edges (missing
agentId 400s, 404s, the 201 on POST messages). All of /api/team/* is OPEN — no
operator gate — so no auth headers are attached.

Fully OFFLINE: teams/agents are created through the repos and messages/tasks
through the a2ax singleton (a JSON-file transport over the isolated temp data
dir). No network, no LLM.

Datetime fidelity: the TS handlers serialize via ``Date#toISOString()`` (ms
precision + ``Z``). The Python route renders datetimes through the store's
``json_default``, so the assertions below check the ``...Z`` (not ``+00:00``)
shape where the TS contract is explicit about ISO strings.
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from simple_harmonic.a2ax_singleton import get_a2ax
from simple_harmonic.routes import team as team_route
from simple_harmonic.store.repos import (
    NewAgent,
    NewTeam,
    NewTraceEvent,
    actionLog,
    agents,
    approvals,
    teams,
    traceEvents,
)
from simple_harmonic.store.repos.action_log import NewAction
from simple_harmonic.store.repos.approvals import NewApproval

# A datetime that serialized to ISO ms-Z (the TS toISOString() shape), e.g.
# "2026-06-14T12:00:00.123Z" — never "+00:00" / microseconds.
_ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


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
# index.ts — GET + PATCH /api/team/{id}
# ===========================================================================


async def test_get_team_returns_team_agents_and_subtree(client: AsyncClient) -> None:
    parent = await _make_team("parent")
    child = await _make_team("child", parentTeamId=parent.id)
    a1 = await _make_agent(parent.id, "p-agent")
    a2 = await _make_agent(child.id, "c-agent")

    resp = await client.get(f"/api/team/{parent.id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["team"]["id"] == parent.id
    assert {a["id"] for a in body["agents"]} == {a1.id}
    assert {t["id"] for t in body["childTeams"]} == {child.id}
    assert {a["id"] for a in body["childAgents"]} == {a2.id}
    # Dates render ms-Z (toISOString shape).
    assert _ISO_Z.match(body["team"]["createdAt"])
    # index.ts passes raw store rows: nullable fields stay `null` (on-disk shape),
    # unlike the POST /messages in-memory object where undefined is omitted.
    assert body["team"]["parentTeamId"] is None
    assert body["team"]["goal"] is None


async def test_get_team_404(client: AsyncClient) -> None:
    resp = await client.get("/api/team/does-not-exist")
    assert resp.status_code == 404
    assert resp.json() == {"error": "not found"}


async def test_get_team_no_subtree_leaves_children_empty(client: AsyncClient) -> None:
    t = await _make_team("solo")
    resp = await client.get(f"/api/team/{t.id}")
    body = resp.json()
    assert body["childTeams"] == []
    assert body["childAgents"] == []


async def test_patch_team_updates_allowed_fields(client: AsyncClient) -> None:
    t = await _make_team("old")
    resp = await client.patch(
        f"/api/team/{t.id}",
        json={"name": "new", "cofounderName": "Ada", "ignored": "x"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "new"
    assert body["cofounderName"] == "Ada"


async def test_patch_team_no_valid_fields_400(client: AsyncClient) -> None:
    t = await _make_team("t")
    resp = await client.patch(f"/api/team/{t.id}", json={"goal": "nope"})
    assert resp.status_code == 400
    assert resp.json() == {"error": "no valid fields"}


async def test_patch_team_404(client: AsyncClient) -> None:
    resp = await client.patch("/api/team/missing", json={"name": "x"})
    assert resp.status_code == 404
    assert resp.json() == {"error": "not found"}


# ===========================================================================
# agent-hub.ts — GET /api/team/{id}/agent-hub
# ===========================================================================


async def test_agent_hub_requires_agent_id(client: AsyncClient) -> None:
    t = await _make_team()
    resp = await client.get(f"/api/team/{t.id}/agent-hub")
    assert resp.status_code == 400
    assert resp.json() == {"error": "agentId query param required"}


async def test_agent_hub_404_for_unknown_agent(client: AsyncClient) -> None:
    t = await _make_team()
    resp = await client.get(f"/api/team/{t.id}/agent-hub", params={"agentId": "ghost"})
    assert resp.status_code == 404
    assert resp.json() == {"error": "agent not found"}


async def test_agent_hub_builds_timeline(client: AsyncClient) -> None:
    t = await _make_team()
    a = await _make_agent(t.id, "scout")
    b = await _make_agent(t.id, "builder")

    # One action by the agent.
    await actionLog.insert(a.id, NewAction(actionType="search", payload={"q": "x"}))
    # A direct message from b -> a (received by a).
    a2ax = get_a2ax()
    await a2ax.send_direct(t.id, b.id, a.id, "hi scout")

    resp = await client.get(f"/api/team/{t.id}/agent-hub", params={"agentId": a.id})
    assert resp.status_code == 200
    body = resp.json()
    assert body["agentId"] == a.id
    assert body["agentName"] == "scout"
    assert body["agentRole"] == "researcher"
    types = {e["type"] for e in body["timeline"]}
    assert "action" in types
    assert "received" in types
    received = next(e for e in body["timeline"] if e["type"] == "received")
    assert received["fromName"] == "builder"
    assert _ISO_Z.match(received["timestamp"])


async def test_agent_hub_cofounder_pseudo_agent(client: AsyncClient) -> None:
    t = await _make_team(cofounderName="Ada")
    resp = await client.get(
        f"/api/team/{t.id}/agent-hub",
        params={"agentId": team_route.COFOUNDER_AGENT_ID},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["agentName"] == "Ada"
    assert body["agentRole"] == "AI Cofounder"


# ===========================================================================
# approvals.ts — GET + POST /api/team/{id}/approvals
# ===========================================================================


async def test_approvals_list_pending(client: AsyncClient) -> None:
    t = await _make_team()
    a = await _make_agent(t.id)
    await approvals.insertMany(
        a.id,
        [
            NewApproval(
                teamId=t.id,
                toolCallId="call-1",
                toolName="delete_file",
                toolArguments='{"path":"/tmp/x"}',
            )
        ],
    )
    resp = await client.get(f"/api/team/{t.id}/approvals")
    assert resp.status_code == 200
    rows = resp.json()["approvals"]
    assert len(rows) == 1
    assert rows[0]["toolName"] == "delete_file"
    assert rows[0]["agentId"] == a.id


async def test_approvals_post_resolves(client: AsyncClient) -> None:
    t = await _make_team()
    a = await _make_agent(t.id)
    await approvals.insertMany(
        a.id,
        [
            NewApproval(
                teamId=t.id, toolCallId="c", toolName="rm", toolArguments="{}"
            )
        ],
    )
    pending = await approvals.pendingForTeam(t.id)
    approval_id = pending[0].id

    resp = await client.post(
        f"/api/team/{t.id}/approvals",
        json={"approvalId": approval_id, "decision": "approved"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "decision": "approved"}
    # No longer pending.
    assert await approvals.pendingForTeam(t.id) == []


async def test_approvals_post_validation_400(client: AsyncClient) -> None:
    t = await _make_team()
    resp = await client.post(
        f"/api/team/{t.id}/approvals", json={"approvalId": "x", "decision": "maybe"}
    )
    assert resp.status_code == 400


async def test_approvals_post_not_found_404(client: AsyncClient) -> None:
    t = await _make_team()
    await _make_agent(t.id)
    resp = await client.post(
        f"/api/team/{t.id}/approvals",
        json={"approvalId": "missing", "decision": "approved"},
    )
    assert resp.status_code == 404
    assert resp.json() == {"error": "approval not found"}


async def test_approvals_post_already_resolved_409(client: AsyncClient) -> None:
    t = await _make_team()
    a = await _make_agent(t.id)
    await approvals.insertMany(
        a.id,
        [NewApproval(teamId=t.id, toolCallId="c", toolName="rm", toolArguments="{}")],
    )
    approval_id = (await approvals.pendingForTeam(t.id))[0].id
    await approvals.resolve(t.id, approval_id, "approved", None)

    resp = await client.post(
        f"/api/team/{t.id}/approvals",
        json={"approvalId": approval_id, "decision": "rejected"},
    )
    assert resp.status_code == 409
    assert resp.json() == {"error": "approval already resolved"}


# ===========================================================================
# conversations.ts — GET /api/team/{id}/conversations
# ===========================================================================


async def test_conversations_requires_agent_id(client: AsyncClient) -> None:
    t = await _make_team()
    resp = await client.get(f"/api/team/{t.id}/conversations")
    assert resp.status_code == 400


async def test_conversations_groups_threads(client: AsyncClient) -> None:
    t = await _make_team()
    a = await _make_agent(t.id, "scout")
    b = await _make_agent(t.id, "builder")
    a2ax = get_a2ax()
    await a2ax.send_direct(t.id, a.id, b.id, "ping")
    await a2ax.send_direct(t.id, b.id, a.id, "pong")

    resp = await client.get(
        f"/api/team/{t.id}/conversations", params={"agentId": a.id}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["agentName"] == "scout"
    assert len(body["threads"]) == 1
    thread = body["threads"][0]
    assert thread["channelType"] == "direct"
    assert thread["peerAgentName"] == "builder"
    assert len(thread["messages"]) == 2
    assert _ISO_Z.match(thread["messages"][0]["createdAt"])
    # The agent's own message is marked isSelf.
    self_msgs = [m for m in thread["messages"] if m["isSelf"]]
    assert any(m["fromAgentId"] == a.id for m in self_msgs)


async def test_conversations_team_overview_sees_all(client: AsyncClient) -> None:
    t = await _make_team()
    a = await _make_agent(t.id, "scout")
    b = await _make_agent(t.id, "builder")
    a2ax = get_a2ax()
    await a2ax.broadcast(t.id, a.id, "all hands")
    await a2ax.send_direct(t.id, a.id, b.id, "1:1")

    resp = await client.get(
        f"/api/team/{t.id}/conversations", params={"agentId": "team"}
    )
    body = resp.json()
    assert body["agentName"] == "Team Overview"
    channel_types = {th["channelType"] for th in body["threads"]}
    assert {"broadcast", "direct"} <= channel_types


# ===========================================================================
# heartbeat.ts — POST /api/team/{id}/heartbeat
# ===========================================================================


async def test_heartbeat_touches_last_active(client: AsyncClient) -> None:
    t = await _make_team()
    before = (await teams.byId(t.id)).lastUserActiveAt
    resp = await client.post(f"/api/team/{t.id}/heartbeat")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    after = (await teams.byId(t.id)).lastUserActiveAt
    assert after >= before


# ===========================================================================
# messages.ts — GET + POST /api/team/{id}/messages
# ===========================================================================


async def test_messages_get_requires_agent_id(client: AsyncClient) -> None:
    t = await _make_team()
    resp = await client.get(f"/api/team/{t.id}/messages")
    assert resp.status_code == 400


async def test_messages_get_enriches_names(client: AsyncClient) -> None:
    t = await _make_team()
    a = await _make_agent(t.id, "scout")
    b = await _make_agent(t.id, "builder")
    a2ax = get_a2ax()
    await a2ax.send_direct(t.id, b.id, a.id, "for scout")

    resp = await client.get(f"/api/team/{t.id}/messages", params={"agentId": a.id})
    assert resp.status_code == 200
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["fromAgentName"] == "builder"
    assert _ISO_Z.match(rows[0]["createdAt"])


async def test_messages_post_direct_returns_201(client: AsyncClient) -> None:
    t = await _make_team()
    a = await _make_agent(t.id, "scout")
    b = await _make_agent(t.id, "builder")
    resp = await client.post(
        f"/api/team/{t.id}/messages",
        json={"fromAgentId": a.id, "toAgentId": b.id, "content": "hello"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["content"] == "hello"
    assert body["channelType"] == "direct"
    assert body["fromAgentId"] == a.id
    assert body["role"] == "agent"
    assert body["status"] == "pending"
    # Unset optionals are OMITTED (TS `undefined` -> JSON omits), not null.
    assert "urgent" not in body
    assert "parts" not in body
    assert "payload" not in body
    assert "replyTo" not in body
    # expiresAt IS set on this path (= _expiry()), so it stays, ms-Z shaped.
    assert _ISO_Z.match(body["expiresAt"])
    assert _ISO_Z.match(body["createdAt"])


async def test_messages_post_broadcast_201(client: AsyncClient) -> None:
    t = await _make_team()
    a = await _make_agent(t.id, "scout")
    resp = await client.post(
        f"/api/team/{t.id}/messages",
        json={"fromAgentId": a.id, "content": "all", "channelType": "broadcast"},
    )
    assert resp.status_code == 201
    assert resp.json()["channelType"] == "broadcast"


async def test_messages_post_missing_fields_400(client: AsyncClient) -> None:
    t = await _make_team()
    resp = await client.post(f"/api/team/{t.id}/messages", json={"content": "x"})
    assert resp.status_code == 400
    assert resp.json() == {"error": "fromAgentId and content required"}


async def test_messages_post_direct_without_target_400(client: AsyncClient) -> None:
    t = await _make_team()
    a = await _make_agent(t.id, "scout")
    resp = await client.post(
        f"/api/team/{t.id}/messages",
        json={"fromAgentId": a.id, "content": "x"},
    )
    assert resp.status_code == 400
    assert resp.json() == {"error": "toAgentId required for direct messages"}


async def test_messages_post_group_without_channel_400(client: AsyncClient) -> None:
    t = await _make_team()
    a = await _make_agent(t.id, "scout")
    resp = await client.post(
        f"/api/team/{t.id}/messages",
        json={"fromAgentId": a.id, "content": "x", "channelType": "group"},
    )
    assert resp.status_code == 400
    assert resp.json() == {"error": "channelId required for group messages"}


# ===========================================================================
# pause.ts — POST /api/team/{id}/pause
# ===========================================================================


async def test_pause_toggles(client: AsyncClient) -> None:
    t = await _make_team()
    assert (await teams.byId(t.id)).paused is False

    resp = await client.post(f"/api/team/{t.id}/pause")
    assert resp.status_code == 200
    assert resp.json() == {"paused": True}
    assert (await teams.byId(t.id)).paused is True

    resp2 = await client.post(f"/api/team/{t.id}/pause")
    assert resp2.json() == {"paused": False}


async def test_pause_404(client: AsyncClient) -> None:
    resp = await client.post("/api/team/missing/pause")
    assert resp.status_code == 404


# ===========================================================================
# tasks.ts — GET /api/team/{id}/tasks
# ===========================================================================


async def test_tasks_requires_agent_id(client: AsyncClient) -> None:
    t = await _make_team()
    resp = await client.get(f"/api/team/{t.id}/tasks")
    assert resp.status_code == 400


async def test_tasks_enriched(client: AsyncClient) -> None:
    t = await _make_team()
    a = await _make_agent(t.id, "scout")
    b = await _make_agent(t.id, "builder")
    a2ax = get_a2ax()
    from simple_harmonic.a2ax import CreateTaskInput

    await a2ax.create_task(
        CreateTaskInput(
            teamId=t.id,
            requestorId=a.id,
            assigneeId=b.id,
            title="Build thing",
            description="do it",
        )
    )

    resp = await client.get(f"/api/team/{t.id}/tasks", params={"agentId": "team"})
    assert resp.status_code == 200
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["title"] == "Build thing"
    assert rows[0]["requestorName"] == "scout"
    assert rows[0]["assigneeName"] == "builder"
    assert _ISO_Z.match(rows[0]["createdAt"])
    assert _ISO_Z.match(rows[0]["updatedAt"])


# ===========================================================================
# narration.ts — GET /api/team/{id}/narration (SSE)
# ===========================================================================


async def test_narration_empty_when_no_agents(client: AsyncClient) -> None:
    t = await _make_team()
    resp = await client.get(f"/api/team/{t.id}/narration")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    text = resp.text
    assert text == 'data: {"type": "history", "entries": []}\n\n'


async def test_narration_streams_history_then_update(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Bound the live-poll loop so the SSE generator is promptly finite, and shrink
    # the interval so the test does not sleep for seconds.
    monkeypatch.setattr(team_route, "NARRATION_POLL_S", 0.0)
    monkeypatch.setattr(team_route, "MAX_UPDATE_PASSES", 1)

    t = await _make_team()
    a = await _make_agent(t.id, "scout")
    # One history entry.
    await actionLog.insert(a.id, NewAction(actionType="boot", payload={}))

    events = await _collect_sse(client, f"/api/team/{t.id}/narration")
    assert events[0]["type"] == "history"
    assert len(events[0]["entries"]) == 1
    assert events[0]["entries"][0]["actionType"] == "boot"
    # The single bounded update pass found nothing new (no event emitted), so the
    # stream is just the history event. The generator terminated cleanly.
    assert all(e["type"] in {"history", "update"} for e in events)


async def test_narration_update_emits_new_entries(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The live-update path emits an ``update`` frame for entries that appear
    after the history snapshot.

    Driven by an injectable finite source: the first ``byAgents`` call (history)
    returns empty, the second (the single bounded poll pass) returns one fresh
    entry. This is deterministic — no reliance on insert-timing races against the
    streaming generator.
    """
    monkeypatch.setattr(team_route, "NARRATION_POLL_S", 0.0)
    monkeypatch.setattr(team_route, "MAX_UPDATE_PASSES", 1)

    t = await _make_team()
    a = await _make_agent(t.id, "scout")

    from datetime import UTC, datetime

    from simple_harmonic.store.types import ActionLogEntry

    fresh = ActionLogEntry(
        id="late-1",
        agentId=a.id,
        actionType="late",
        payload={},
        executedAt=datetime.now(UTC),
    )
    calls = {"n": 0}

    async def fake_by_agents(agent_ids, *, limit=None, since=None):
        calls["n"] += 1
        # 1st call = history (empty), 2nd call = poll pass (one fresh entry).
        return [] if calls["n"] == 1 else [fresh]

    monkeypatch.setattr(team_route.actionLog, "byAgents", fake_by_agents)

    events = await _collect_sse(client, f"/api/team/{t.id}/narration")
    assert events[0] == {"type": "history", "entries": []}
    updates = [e for e in events if e["type"] == "update"]
    assert len(updates) == 1
    assert updates[0]["entries"][0]["actionType"] == "late"
    assert updates[0]["entries"][0]["id"] == "late-1"


# ===========================================================================
# trace.ts — GET /api/team/{id}/trace (SSE)
# ===========================================================================


async def test_trace_streams_history(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(team_route, "TRACE_POLL_S", 0.0)
    monkeypatch.setattr(team_route, "MAX_UPDATE_PASSES", 1)

    t = await _make_team()
    a = await _make_agent(t.id, "scout")
    from datetime import UTC, datetime

    await traceEvents.append(
        [
            NewTraceEvent(
                teamId=t.id,
                agentId=a.id,
                tickId="tick-1",
                seq=0,
                type="thought",
                data={"text": "thinking"},
                emittedAt=datetime.now(UTC),
            )
        ]
    )

    events = await _collect_sse(client, f"/api/team/{t.id}/trace")
    assert events[0]["type"] == "history"
    assert len(events[0]["entries"]) == 1
    assert events[0]["entries"][0]["type"] == "thought"
    assert events[0]["entries"][0]["tickId"] == "tick-1"


# ---------------------------------------------------------------------------
# SSE collection helper
# ---------------------------------------------------------------------------


async def _collect_sse(client: AsyncClient, path: str) -> list[dict]:
    """Read a bounded SSE stream and parse each ``data: {json}`` frame.

    Relies on MAX_UPDATE_PASSES being set so the server generator terminates.
    """
    out: list[dict] = []
    async with client.stream("GET", path) as resp:
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


# ---------------------------------------------------------------------------
# Gate: /api/team/* stays OPEN even with the operator gate active.
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def gated_client(app, operator_password: str) -> AsyncIterator[AsyncClient]:
    """A client over the app with the operator gate ACTIVE (operator_password set).

    Used to prove /api/team/* needs no auth.
    """
    transport = ASGITransport(app=app)
    async with (
        AsyncClient(transport=transport, base_url="http://test") as ac,
        app.router.lifespan_context(app),
    ):
        yield ac


async def test_team_routes_open_under_active_gate(gated_client: AsyncClient) -> None:
    t = await _make_team()
    # No Authorization header — must still pass (team/* is open).
    resp = await gated_client.get(f"/api/team/{t.id}")
    assert resp.status_code == 200
    assert resp.json()["team"]["id"] == t.id

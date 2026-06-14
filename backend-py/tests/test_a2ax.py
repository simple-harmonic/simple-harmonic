"""Tests for the full a2ax protocol port.

Ported from packages/a2ax/tests/protocol.test.ts plus explicit coverage for each
load-bearing behavior of the subsystem:

  1. Per-recipient read tracking (one row, many readers).
  2. completeTask() force-sets completed without transition validation.
  3. directChannelId sort + relevance reconstruction + own-message exclusion.
  4. getAgentContext runs 4 per-channel queries, caps, concatenates, formats.
  5. JsonFileTransport hydrate/write-through/Date re-coercion + metadata.teamId.
  6. All Transport methods are async over in-memory (memory) / blocking fs (file).

The MemoryTransport and JsonFileTransport are exercised against the same
behaviors so the two stay in lockstep.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from simple_harmonic.a2ax import (
    A2AX,
    A2AXOptions,
    AgentToken,
    Channel,
    CreateMessageInput,
    CreateTaskInput,
    JsonFileTransport,
    MemoryTransport,
    MessageQuery,
    create_agent_card,
    direct_channel_id,
    is_valid_transition,
)
from simple_harmonic.a2ax.transport import Transport

TEAM_ID = "team-1"
AGENT_A = "agent-a"
AGENT_B = "agent-b"
AGENT_C = "agent-c"
AGENT_D = "agent-d"


def _make_team_tree(root: Path, *team_ids: str) -> None:
    """Create <root>/teams/<teamId>/team.json marker files for the file store."""
    for team_id in team_ids:
        team_dir = root / "teams" / team_id
        team_dir.mkdir(parents=True, exist_ok=True)
        (team_dir / "team.json").write_text(
            json.dumps({"id": team_id, "name": team_id}), encoding="utf-8"
        )


@pytest.fixture
def memory_a2ax() -> A2AX:
    return A2AX(A2AXOptions(transport=MemoryTransport()))


@pytest.fixture
def file_a2ax(tmp_path: Path) -> A2AX:
    _make_team_tree(tmp_path, TEAM_ID, "team-2")
    transport = JsonFileTransport(tmp_path / "teams")
    return A2AX(A2AXOptions(transport=transport))


# Run every shared scenario against both transports.
@pytest.fixture(params=["memory", "file"])
def a2ax(request: pytest.FixtureRequest, tmp_path: Path) -> A2AX:
    if request.param == "memory":
        return A2AX(A2AXOptions(transport=MemoryTransport()))
    _make_team_tree(tmp_path, TEAM_ID, "team-2")
    return A2AX(A2AXOptions(transport=JsonFileTransport(tmp_path / "teams")))


# --- direct messaging --------------------------------------------------------


async def test_sends_and_receives_a_direct_message(a2ax: A2AX) -> None:
    await a2ax.send_direct(TEAM_ID, AGENT_A, AGENT_B, "hello from A")

    ctx = await a2ax.get_agent_context(TEAM_ID, AGENT_B)
    assert len(ctx.messages) == 1
    assert ctx.messages[0].content == "hello from A"
    assert ctx.messages[0].channelType == "direct"
    assert "hello from A" in ctx.formatted


async def test_does_not_show_own_messages(a2ax: A2AX) -> None:
    await a2ax.send_direct(TEAM_ID, AGENT_A, AGENT_B, "hello")

    ctx = await a2ax.get_agent_context(TEAM_ID, AGENT_A)
    assert len(ctx.messages) == 0


async def test_marks_messages_as_read(a2ax: A2AX) -> None:
    await a2ax.send_direct(TEAM_ID, AGENT_A, AGENT_B, "read me")

    ctx1 = await a2ax.get_agent_context(TEAM_ID, AGENT_B)
    assert len(ctx1.messages) == 1

    await a2ax.mark_context_read(AGENT_B, ctx1.messageIds)

    ctx2 = await a2ax.get_agent_context(TEAM_ID, AGENT_B)
    assert len(ctx2.messages) == 0


# --- broadcast ---------------------------------------------------------------


async def test_delivers_broadcast_to_all_agents(a2ax: A2AX) -> None:
    await a2ax.broadcast(TEAM_ID, AGENT_A, "announcement for everyone")

    ctx_b = await a2ax.get_agent_context(TEAM_ID, AGENT_B)
    ctx_c = await a2ax.get_agent_context(TEAM_ID, AGENT_C)

    assert len(ctx_b.messages) == 1
    assert len(ctx_c.messages) == 1
    assert ctx_b.messages[0].content == "announcement for everyone"


async def test_broadcast_read_by_one_stays_unread_for_others(a2ax: A2AX) -> None:
    """LOAD-BEARING #1: per-recipient read tracking."""
    await a2ax.broadcast(TEAM_ID, AGENT_A, "team announcement")

    ctx_b = await a2ax.get_agent_context(TEAM_ID, AGENT_B)
    assert len(ctx_b.messages) == 1
    await a2ax.mark_context_read(AGENT_B, ctx_b.messageIds)

    # B has now read it; C and D must STILL see it.
    assert len((await a2ax.get_agent_context(TEAM_ID, AGENT_B)).messages) == 0
    assert len((await a2ax.get_agent_context(TEAM_ID, AGENT_C)).messages) == 1
    assert len((await a2ax.get_agent_context(TEAM_ID, AGENT_D)).messages) == 1


async def test_sender_does_not_see_own_broadcast(a2ax: A2AX) -> None:
    await a2ax.broadcast(TEAM_ID, AGENT_A, "my broadcast")

    ctx_a = await a2ax.get_agent_context(TEAM_ID, AGENT_A)
    assert len(ctx_a.messages) == 0


# --- group messaging ---------------------------------------------------------


async def test_creates_group_and_delivers_to_members_only(a2ax: A2AX) -> None:
    result = await a2ax.create_group(TEAM_ID, "content-team", [AGENT_A, AGENT_B])
    channel_id = result["channelId"]

    await a2ax.send_to_group(TEAM_ID, channel_id, AGENT_A, "group message")

    ctx_b = await a2ax.get_agent_context(TEAM_ID, AGENT_B)
    ctx_c = await a2ax.get_agent_context(TEAM_ID, AGENT_C)

    group_msgs = [m for m in ctx_b.messages if m.kind == "text"]
    assert len(group_msgs) == 1
    assert group_msgs[0].content == "group message"

    assert len([m for m in ctx_c.messages if m.kind == "text"]) == 0


async def test_group_message_read_by_one_stays_unread_for_others(a2ax: A2AX) -> None:
    result = await a2ax.create_group(TEAM_ID, "trio", [AGENT_A, AGENT_B, AGENT_C])
    channel_id = result["channelId"]
    await a2ax.send_to_group(TEAM_ID, channel_id, AGENT_A, "group note")

    ctx_b = await a2ax.get_agent_context(TEAM_ID, AGENT_B)
    assert any(m.content == "group note" for m in ctx_b.messages)
    await a2ax.mark_context_read(AGENT_B, ctx_b.messageIds)

    ctx_b2 = await a2ax.get_agent_context(TEAM_ID, AGENT_B)
    assert not any(m.content == "group note" for m in ctx_b2.messages)
    ctx_c = await a2ax.get_agent_context(TEAM_ID, AGENT_C)
    assert any(m.content == "group note" for m in ctx_c.messages)


async def test_allows_joining_and_leaving_groups(a2ax: A2AX) -> None:
    result = await a2ax.create_group(TEAM_ID, "test-group", [AGENT_A])
    channel_id = result["channelId"]

    await a2ax.send_to_group(TEAM_ID, channel_id, AGENT_A, "before join")
    ctx_c = await a2ax.get_agent_context(TEAM_ID, AGENT_C)
    assert len([m for m in ctx_c.messages if m.kind == "text"]) == 0

    await a2ax.join_group(channel_id, AGENT_C)
    await a2ax.send_to_group(TEAM_ID, channel_id, AGENT_A, "after join")

    ctx_c = await a2ax.get_agent_context(TEAM_ID, AGENT_C)
    text_msgs = [m for m in ctx_c.messages if m.kind == "text"]
    assert len(text_msgs) >= 1


async def test_leave_group_stops_delivery(a2ax: A2AX) -> None:
    result = await a2ax.create_group(TEAM_ID, "g", [AGENT_A, AGENT_B])
    channel_id = result["channelId"]
    await a2ax.leave_group(channel_id, AGENT_B)
    await a2ax.send_to_group(TEAM_ID, channel_id, AGENT_A, "post-leave")
    ctx_b = await a2ax.get_agent_context(TEAM_ID, AGENT_B)
    assert not any(m.content == "post-leave" for m in ctx_b.messages)


async def test_join_group_rejects_non_group_channel(a2ax: A2AX) -> None:
    await a2ax.send_direct(TEAM_ID, AGENT_A, AGENT_B, "x")
    with pytest.raises(ValueError, match="is not a group"):
        await a2ax.join_group(direct_channel_id(AGENT_A, AGENT_B), AGENT_C)


# --- task management ---------------------------------------------------------


async def test_creates_a_task_and_delivers_to_assignee(a2ax: A2AX) -> None:
    result = await a2ax.create_task(
        CreateTaskInput(
            teamId=TEAM_ID,
            requestorId=AGENT_A,
            assigneeId=AGENT_B,
            title="Write summary",
            description="Summarize this week's research findings",
        )
    )
    task = result["task"]
    assert task.state == "submitted"

    ctx = await a2ax.get_agent_context(TEAM_ID, AGENT_B)
    task_msgs = [m for m in ctx.messages if m.kind == "task.create"]
    assert len(task_msgs) == 1
    assert task_msgs[0].content == "Summarize this week's research findings"


async def test_follows_task_lifecycle(a2ax: A2AX) -> None:
    result = await a2ax.create_task(
        CreateTaskInput(
            teamId=TEAM_ID,
            requestorId=AGENT_A,
            assigneeId=AGENT_B,
            title="Test task",
            description="Do the thing",
        )
    )
    task = result["task"]

    await a2ax.update_task_state(task.id, AGENT_B, "accepted")
    await a2ax.update_task_state(task.id, AGENT_B, "working")
    completed = await a2ax.complete_task(task.id, AGENT_B, "Done. Here are the results.")

    assert completed.state == "completed"


async def test_rejects_invalid_state_transitions(a2ax: A2AX) -> None:
    result = await a2ax.create_task(
        CreateTaskInput(
            teamId=TEAM_ID,
            requestorId=AGENT_A,
            assigneeId=AGENT_B,
            title="Test",
            description="Test",
        )
    )
    task = result["task"]
    with pytest.raises(ValueError, match="Invalid transition"):
        await a2ax.update_task_state(task.id, AGENT_B, "completed")


async def test_complete_task_force_sets_from_terminal_state(a2ax: A2AX) -> None:
    """LOAD-BEARING #2: completeTask does NOT validate the transition.

    From a terminal 'failed' state, updateTaskState would refuse any move, but
    completeTask force-sets completed regardless.
    """
    result = await a2ax.create_task(
        CreateTaskInput(
            teamId=TEAM_ID,
            requestorId=AGENT_A,
            assigneeId=AGENT_B,
            title="t",
            description="d",
        )
    )
    task = result["task"]
    await a2ax.update_task_state(task.id, AGENT_B, "accepted")
    await a2ax.update_task_state(task.id, AGENT_B, "working")
    await a2ax.update_task_state(task.id, AGENT_B, "failed")  # terminal

    # updateTaskState would reject failed -> completed ...
    assert is_valid_transition("failed", "completed") is False
    with pytest.raises(ValueError, match="Invalid transition"):
        await a2ax.update_task_state(task.id, AGENT_B, "completed")

    # ... but completeTask force-sets it anyway.
    completed = await a2ax.complete_task(task.id, AGENT_B, "forced done")
    assert completed.state == "completed"


async def test_task_messages_relevant_to_requestor_and_assignee_only(
    a2ax: A2AX,
) -> None:
    result = await a2ax.create_task(
        CreateTaskInput(
            teamId=TEAM_ID,
            requestorId=AGENT_A,
            assigneeId=AGENT_B,
            title="t",
            description="d",
        )
    )
    task = result["task"]
    await a2ax.update_task_state(task.id, AGENT_B, "accepted", "on it")

    # Requestor A sees the task.status from B (not its own task.create).
    ctx_a = await a2ax.get_agent_context(TEAM_ID, AGENT_A)
    assert any(m.kind == "task.status" for m in ctx_a.messages)
    # Uninvolved C sees nothing.
    ctx_c = await a2ax.get_agent_context(TEAM_ID, AGENT_C)
    assert len([m for m in ctx_c.messages if m.channelType == "task"]) == 0


# --- agent cards -------------------------------------------------------------


async def test_registers_and_retrieves_an_agent_card(a2ax: A2AX) -> None:
    card = create_agent_card(
        id=AGENT_A,
        name="Research Scout",
        endpoint="/api/agent/agent-a",
        skills=[],
        metadata={"teamId": TEAM_ID},
    )
    await a2ax.register_card(card)
    retrieved = await a2ax.get_card(AGENT_A)

    assert retrieved is not None
    assert retrieved.name == "Research Scout"
    assert retrieved.capabilities.broadcast is True


async def test_discover_agents_returns_only_same_team(a2ax: A2AX) -> None:
    """LOAD-BEARING #5 (partial): team scoping rides on metadata.teamId."""
    await a2ax.register_card(
        create_agent_card(
            id="card-1", name="One", endpoint="/1", metadata={"teamId": TEAM_ID}
        )
    )
    await a2ax.register_card(
        create_agent_card(
            id="card-2", name="Two", endpoint="/2", metadata={"teamId": "team-2"}
        )
    )

    team1 = await a2ax.discover_agents(TEAM_ID)
    assert [c.id for c in team1] == ["card-1"]


# --- auth --------------------------------------------------------------------


async def test_issues_and_validates_a_token(a2ax: A2AX) -> None:
    token = await a2ax.issue_token(AGENT_A, TEAM_ID)

    identity = await a2ax.authenticate(token)
    assert identity is not None
    assert identity["agentId"] == AGENT_A

    assert await a2ax.authorize(token, "message:send") is True
    assert await a2ax.authorize(token, "admin") is False


async def test_rejects_invalid_tokens(a2ax: A2AX) -> None:
    identity = await a2ax.authenticate("fake-token")
    assert identity is None


async def test_expired_token_is_rejected(a2ax: A2AX) -> None:
    transport: Transport = a2ax._transport  # type: ignore[attr-defined]
    past = datetime.now(UTC) - timedelta(hours=1)
    await transport.create_token(
        AgentToken(
            agentId=AGENT_A,
            teamId=TEAM_ID,
            token="expired",
            createdAt=past,
            expiresAt=past,
        )
    )
    assert await a2ax.authenticate("expired") is None
    assert await a2ax.authorize("expired", "message:send") is False


# --- context formatting ------------------------------------------------------


async def test_formats_empty_context_as_empty_string(a2ax: A2AX) -> None:
    ctx = await a2ax.get_agent_context(TEAM_ID, AGENT_A)
    assert ctx.formatted == ""
    assert len(ctx.messages) == 0


async def test_respects_max_context_messages_limit(tmp_path: Path) -> None:
    """LOAD-BEARING #4: per-query cap honored by getAgentContext."""
    small = A2AX(A2AXOptions(transport=MemoryTransport(), max_context_messages=2))
    await small.send_direct(TEAM_ID, AGENT_A, AGENT_B, "msg 1")
    await small.send_direct(TEAM_ID, AGENT_A, AGENT_B, "msg 2")
    await small.send_direct(TEAM_ID, AGENT_A, AGENT_B, "msg 3")

    ctx = await small.get_agent_context(TEAM_ID, AGENT_B)
    assert len(ctx.messages) == 2


async def test_context_format_prefixes(a2ax: A2AX) -> None:
    """LOAD-BEARING #4: per-channel-type prefix formatting for prompt injection."""
    await a2ax.send_direct(TEAM_ID, AGENT_A, AGENT_B, "direct hi")
    ctx = await a2ax.get_agent_context(TEAM_ID, AGENT_B)
    assert ctx.formatted.startswith("--- Messages since last tick ---")
    assert f"[direct from {AGENT_A}]:" in ctx.formatted
    assert ctx.formatted.endswith("---")


# --- LOAD-BEARING #3: directChannelId sort + relevance + own-exclusion --------


def test_direct_channel_id_sorts_the_pair() -> None:
    assert direct_channel_id("b", "a") == "direct:a:b"
    assert direct_channel_id("a", "b") == "direct:a:b"
    assert direct_channel_id("z", "z") == "direct:z:z"


async def test_direct_relevance_reconstructs_channel_id(a2ax: A2AX) -> None:
    # A -> B: channelId is direct:agent-a:agent-b. Reconstructed for B as
    # directChannelId(B, A) == same id, so B sees it; an unrelated agent does not.
    await a2ax.send_direct(TEAM_ID, AGENT_A, AGENT_B, "for B")
    ctx_b = await a2ax.get_agent_context(TEAM_ID, AGENT_B)
    assert len(ctx_b.messages) == 1
    ctx_c = await a2ax.get_agent_context(TEAM_ID, AGENT_C)
    assert len([m for m in ctx_c.messages if m.channelType == "direct"]) == 0


# --- LOAD-BEARING #6 + expiry: maintenance + read views ----------------------


async def test_expire_messages_marks_expired_and_hides_from_context(a2ax: A2AX) -> None:
    transport: Transport = a2ax._transport  # type: ignore[attr-defined]
    past = datetime.now(UTC) - timedelta(days=1)
    await transport.insert_message(
        CreateMessageInput(
            teamId=TEAM_ID,
            channelType="broadcast",
            channelId="team:team-1",
            fromAgentId=AGENT_A,
            kind="text",
            content="stale",
            expiresAt=past,
        )
    )
    count = await a2ax.expire_messages()
    assert count == 1
    ctx_b = await a2ax.get_agent_context(TEAM_ID, AGENT_B)
    assert not any(m.content == "stale" for m in ctx_b.messages)


async def test_list_messages_returns_all_team_rows_chronologically(a2ax: A2AX) -> None:
    await a2ax.send_direct(TEAM_ID, AGENT_A, AGENT_B, "one")
    await a2ax.send_direct(TEAM_ID, AGENT_A, AGENT_B, "two")
    rows = await a2ax.list_messages(TEAM_ID)
    contents = [m.content for m in rows]
    assert "one" in contents
    assert "two" in contents
    assert rows == sorted(rows, key=lambda m: m.createdAt)


async def test_list_tasks_filters_by_participant(a2ax: A2AX) -> None:
    await a2ax.create_task(
        CreateTaskInput(
            teamId=TEAM_ID,
            requestorId=AGENT_A,
            assigneeId=AGENT_B,
            title="t",
            description="d",
        )
    )
    all_tasks = await a2ax.list_tasks(TEAM_ID)
    assert len(all_tasks) == 1
    a_tasks = await a2ax.list_tasks(TEAM_ID, AGENT_A)
    assert len(a_tasks) == 1
    c_tasks = await a2ax.list_tasks(TEAM_ID, AGENT_C)
    assert len(c_tasks) == 0


async def test_query_messages_unread_excludes_expired(a2ax: A2AX) -> None:
    transport: Transport = a2ax._transport  # type: ignore[attr-defined]
    past = datetime.now(UTC) - timedelta(days=1)
    await transport.insert_message(
        CreateMessageInput(
            teamId=TEAM_ID,
            channelType="broadcast",
            channelId="team:team-1",
            fromAgentId=AGENT_A,
            kind="text",
            content="will expire",
            expiresAt=past,
        )
    )
    await transport.mark_expired(datetime.now(UTC))
    results = await transport.query_messages(
        MessageQuery(teamId=TEAM_ID, agentId=AGENT_B, unreadOnly=True)
    )
    assert not any(m.content == "will expire" for m in results)


# --- LOAD-BEARING #5: JsonFileTransport hydrate / write-through / re-coerce ----


async def test_json_file_transport_persists_and_rehydrates(tmp_path: Path) -> None:
    _make_team_tree(tmp_path, TEAM_ID)
    teams_root = tmp_path / "teams"

    a2ax1 = A2AX(A2AXOptions(transport=JsonFileTransport(teams_root)))
    await a2ax1.send_direct(TEAM_ID, AGENT_A, AGENT_B, "persisted")
    await a2ax1.create_task(
        CreateTaskInput(
            teamId=TEAM_ID,
            requestorId=AGENT_A,
            assigneeId=AGENT_B,
            title="persist task",
            description="d",
        )
    )

    # log.jsonl must exist on disk.
    log_path = teams_root / TEAM_ID / "messages" / "log.jsonl"
    assert log_path.exists()

    # A fresh transport over the same root hydrates lazily and serves the data.
    a2ax2 = A2AX(A2AXOptions(transport=JsonFileTransport(teams_root)))
    ctx_b = await a2ax2.get_agent_context(TEAM_ID, AGENT_B)
    assert any(m.content == "persisted" for m in ctx_b.messages)
    tasks = await a2ax2.list_tasks(TEAM_ID)
    assert len(tasks) == 1
    assert tasks[0].title == "persist task"


async def test_json_file_transport_recoerces_dates_on_load(tmp_path: Path) -> None:
    """Date strings on disk are re-coerced to datetime on hydrate."""
    _make_team_tree(tmp_path, TEAM_ID)
    teams_root = tmp_path / "teams"

    a2ax1 = A2AX(A2AXOptions(transport=JsonFileTransport(teams_root)))
    # An already-expired message persisted to disk as an ISO string.
    past = datetime.now(UTC) - timedelta(days=1)
    transport1: Transport = a2ax1._transport  # type: ignore[attr-defined]
    await transport1.insert_message(
        CreateMessageInput(
            teamId=TEAM_ID,
            channelType="broadcast",
            channelId="team:team-1",
            fromAgentId=AGENT_A,
            kind="text",
            content="dated",
            expiresAt=past,
        )
    )

    # Reload and confirm the dates came back as real, tz-aware datetimes — not
    # naive ones and not strings. A naive datetime here would crash mark_expired
    # with an aware-vs-naive TypeError, so this guards the whole re-coercion path.
    transport2 = JsonFileTransport(teams_root)
    rows = await transport2.list_team_messages(TEAM_ID)
    assert len(rows) == 1
    assert isinstance(rows[0].createdAt, datetime)
    assert rows[0].createdAt.tzinfo is not None
    assert rows[0].expiresAt is not None
    assert rows[0].expiresAt.tzinfo is not None
    # The reloaded expiresAt is usable in the comparison mark_expired runs.
    assert await transport2.mark_expired(datetime.now(UTC)) == 1


async def test_json_file_transport_read_receipts_survive_reload(tmp_path: Path) -> None:
    """Per-recipient reads (LOAD-BEARING #1) persist to reads.jsonl and reload."""
    _make_team_tree(tmp_path, TEAM_ID)
    teams_root = tmp_path / "teams"

    a2ax1 = A2AX(A2AXOptions(transport=JsonFileTransport(teams_root)))
    await a2ax1.broadcast(TEAM_ID, AGENT_A, "reload me")
    ctx_b = await a2ax1.get_agent_context(TEAM_ID, AGENT_B)
    await a2ax1.mark_context_read(AGENT_B, ctx_b.messageIds)

    reads_path = teams_root / TEAM_ID / "messages" / "reads.jsonl"
    assert reads_path.exists()

    # New transport: B already read it, C has not.
    a2ax2 = A2AX(A2AXOptions(transport=JsonFileTransport(teams_root)))
    assert len((await a2ax2.get_agent_context(TEAM_ID, AGENT_B)).messages) == 0
    assert len((await a2ax2.get_agent_context(TEAM_ID, AGENT_C)).messages) == 1


async def test_json_file_transport_card_scoping_via_metadata(tmp_path: Path) -> None:
    _make_team_tree(tmp_path, TEAM_ID, "team-2")
    teams_root = tmp_path / "teams"
    a2ax1 = A2AX(A2AXOptions(transport=JsonFileTransport(teams_root)))
    await a2ax1.register_card(
        create_agent_card(
            id="c1", name="One", endpoint="/1", metadata={"teamId": TEAM_ID}
        )
    )
    await a2ax1.register_card(
        create_agent_card(
            id="c2", name="Two", endpoint="/2", metadata={"teamId": "team-2"}
        )
    )

    cards_path = teams_root / TEAM_ID / "messages" / "cards.json"
    assert cards_path.exists()
    persisted = json.loads(cards_path.read_text(encoding="utf-8"))
    assert [c["id"] for c in persisted] == ["c1"]

    a2ax2 = A2AX(A2AXOptions(transport=JsonFileTransport(teams_root)))
    assert [c.id for c in await a2ax2.discover_agents(TEAM_ID)] == ["c1"]


async def test_json_file_transport_expiry_rewrites_log(tmp_path: Path) -> None:
    _make_team_tree(tmp_path, TEAM_ID)
    teams_root = tmp_path / "teams"
    transport = JsonFileTransport(teams_root)
    past = datetime.now(UTC) - timedelta(days=1)
    await transport.insert_message(
        CreateMessageInput(
            teamId=TEAM_ID,
            channelType="broadcast",
            channelId="team:team-1",
            fromAgentId=AGENT_A,
            kind="text",
            content="expiring",
            expiresAt=past,
        )
    )
    count = await transport.mark_expired(datetime.now(UTC))
    assert count == 1

    # The rewritten log carries status=expired.
    log_path = teams_root / TEAM_ID / "messages" / "log.jsonl"
    rows = [json.loads(line) for line in log_path.read_text().splitlines() if line]
    assert rows[0]["status"] == "expired"


async def test_json_file_transport_discovers_nested_teams(tmp_path: Path) -> None:
    """LOAD-BEARING #5: hydrate() walks the RECURSIVE team tree.

    A child team lives under <parent>/teams/<child>/. The walk must descend into
    each team's teams/ subfolder and locate its messages dir — a flat top-level
    scan would miss nested teams entirely.
    """
    teams_root = tmp_path / "teams"
    parent_dir = teams_root / "parent"
    parent_dir.mkdir(parents=True)
    (parent_dir / "team.json").write_text(
        json.dumps({"id": "parent"}), encoding="utf-8"
    )
    child_dir = parent_dir / "teams" / "child"
    child_dir.mkdir(parents=True)
    (child_dir / "team.json").write_text(
        json.dumps({"id": "child"}), encoding="utf-8"
    )

    a2ax1 = A2AX(A2AXOptions(transport=JsonFileTransport(teams_root)))
    # A message for the nested child team must resolve to the nested messages dir.
    await a2ax1.send_direct("child", AGENT_A, AGENT_B, "nested hello")
    nested_log = child_dir / "messages" / "log.jsonl"
    assert nested_log.exists()

    # A fresh transport hydrates the whole tree (parent + nested child) and serves
    # the child's data — proving the recursive descent ran on hydrate.
    a2ax2 = A2AX(A2AXOptions(transport=JsonFileTransport(teams_root)))
    ctx_b = await a2ax2.get_agent_context("child", AGENT_B)
    assert [m.content for m in ctx_b.messages] == ["nested hello"]


async def test_json_file_transport_rediscovers_team_added_after_hydrate(
    tmp_path: Path,
) -> None:
    """LOAD-BEARING #5: dirForTeam re-walks ONCE if a team appeared post-hydrate.

    The first query hydrates against team-1 only. A second team folder created
    afterward must still be writable — _dir_for_team re-walks the tree on the miss.
    """
    teams_root = tmp_path / "teams"
    _make_team_tree(tmp_path, TEAM_ID)
    transport = JsonFileTransport(teams_root)

    # Hydrate against the single known team.
    await transport.list_team_messages(TEAM_ID)

    # A new team folder appears on disk only now.
    _make_team_tree(tmp_path, "team-late")

    msg = await transport.insert_message(
        CreateMessageInput(
            teamId="team-late",
            channelType="broadcast",
            channelId="team:team-late",
            fromAgentId=AGENT_A,
            kind="text",
            content="late arrival",
        )
    )
    assert msg.content == "late arrival"
    late_log = teams_root / "team-late" / "messages" / "log.jsonl"
    assert late_log.exists()
    rows = await transport.list_team_messages("team-late")
    assert [r.content for r in rows] == ["late arrival"]


async def test_json_file_transport_unknown_team_raises(tmp_path: Path) -> None:
    _make_team_tree(tmp_path, TEAM_ID)
    transport = JsonFileTransport(tmp_path / "teams")
    with pytest.raises(ValueError, match="folder not found"):
        await transport.insert_message(
            CreateMessageInput(
                teamId="nope",
                channelType="broadcast",
                channelId="team:nope",
                fromAgentId=AGENT_A,
                kind="text",
                content="x",
            )
        )


# --- channel creation stamps createdAt (transport-side override) -------------


async def test_create_channel_stamps_created_at() -> None:
    transport = MemoryTransport()
    ch = await transport.create_channel(
        Channel(
            id="group:x",
            teamId=TEAM_ID,
            channelType="group",
            name="x",
            createdAt=datetime(1970, 1, 1, tzinfo=UTC),
        )
    )
    assert ch.createdAt.year >= 2020


# --- LOAD-BEARING #6: both adapters satisfy the Transport protocol -----------


def test_both_adapters_satisfy_transport_protocol(tmp_path: Path) -> None:
    """Every Transport method is implemented by both adapters.

    The runtime-checkable Protocol pins the full 22-method surface (5 messages +
    7 channels + 4 tasks + 3 cards + 3 auth); a missing async method on either
    adapter would fail this isinstance check.
    """
    _make_team_tree(tmp_path, TEAM_ID)
    assert isinstance(MemoryTransport(), Transport)
    assert isinstance(JsonFileTransport(tmp_path / "teams"), Transport)


# --- auth: token revocation (write-through on the file adapter) --------------


async def test_revoke_token_invalidates_and_persists(a2ax: A2AX) -> None:
    """revokeToken deletes the token; auth then fails for it.

    On the file adapter this also exercises the write-through delete path
    (_persist_tokens after pop), which is otherwise untested.
    """
    transport: Transport = a2ax._transport  # type: ignore[attr-defined]
    token = await a2ax.issue_token(AGENT_A, TEAM_ID)
    assert await a2ax.authenticate(token) is not None

    await transport.revoke_token(token)

    assert await a2ax.authenticate(token) is None
    assert await transport.get_token(token) is None


async def test_revoke_token_write_through_survives_reload(tmp_path: Path) -> None:
    """LOAD-BEARING #5: revoking a token rewrites tokens.json without it."""
    _make_team_tree(tmp_path, TEAM_ID)
    teams_root = tmp_path / "teams"

    a2ax1 = A2AX(A2AXOptions(transport=JsonFileTransport(teams_root)))
    keep = await a2ax1.issue_token(AGENT_A, TEAM_ID)
    drop = await a2ax1.issue_token(AGENT_B, TEAM_ID)
    await a2ax1._transport.revoke_token(drop)  # type: ignore[attr-defined]

    tokens_path = teams_root / TEAM_ID / "messages" / "tokens.json"
    persisted = json.loads(tokens_path.read_text(encoding="utf-8"))
    assert [t["token"] for t in persisted] == [keep]

    # A fresh transport hydrates only the surviving token.
    a2ax2 = A2AX(A2AXOptions(transport=JsonFileTransport(teams_root)))
    assert await a2ax2.authenticate(keep) is not None
    assert await a2ax2.authenticate(drop) is None


# --- LOAD-BEARING #4: combined cap across all four channel-type queries -------


async def test_agent_context_cap_applies_across_channel_types(tmp_path: Path) -> None:
    """getAgentContext caps the CONCATENATED list, not each per-channel query.

    With the cap at 3 and a direct + a broadcast + two group messages relevant to
    B (4 total), the returned context must be exactly 3 — proving the slice runs
    on the merged, chronologically-sorted list after the four sub-queries.
    """
    a2ax = A2AX(A2AXOptions(transport=MemoryTransport(), max_context_messages=3))
    result = await a2ax.create_group(TEAM_ID, "g", [AGENT_A, AGENT_B])
    channel_id = result["channelId"]

    await a2ax.send_direct(TEAM_ID, AGENT_A, AGENT_B, "d1")
    await a2ax.broadcast(TEAM_ID, AGENT_A, "b1")
    await a2ax.send_to_group(TEAM_ID, channel_id, AGENT_A, "g1")
    await a2ax.send_to_group(TEAM_ID, channel_id, AGENT_A, "g2")

    ctx = await a2ax.get_agent_context(TEAM_ID, AGENT_B)
    assert len(ctx.messages) == 3
    assert len(ctx.messageIds) == 3
    # The retained three are the chronologically-earliest of the relevant set.
    assert ctx.messages == sorted(ctx.messages, key=lambda m: m.createdAt)

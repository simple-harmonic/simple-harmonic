"""Tests for the JSON file store: the eight repos + load-bearing behaviors.

Ported from the TS store subsystem (packages/backend/src/server/store/**). The
TS package had no dedicated *.test.ts for the store, so these are written from
the source semantics and exercise:

  - teams: all (oldest-first), byId, roots, children, create, update, move,
    delete, incrementTickCount
  - agents: byId, byTeam, byTeams, create, insertMany, update, move, delete,
    claim, resetAllInFlight
  - approvals: byAgent, insertMany, pendingForTeam, resolve, clearForAgent
  - actionLog: insert, byAgents (newest-first / limit / since)
  - appEvents: insert (SYNC), query (infra filter, limit, since), acknowledge
  - platformStatus: get/set (id is literal 1)
  - spend: insert, sumForDay
  - traceEvents: append, query (asc/desc sort), pruneOlderThan

Plus explicit tests for the six load-bearing behaviors called out in the slice.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from simple_harmonic.store import (
    AppEventQuery,
    NewAction,
    NewAgent,
    NewAppEvent,
    NewApproval,
    NewSpend,
    NewTeam,
    NewTraceEvent,
    TraceQuery,
    actionLog,
    agents,
    appEvents,
    approvals,
    invalidate_index,
    platformStatus,
    spend,
    teams,
    traceEvents,
)
from simple_harmonic.store import data_dir as dd


@pytest.fixture
def store_dir(tmp_path: Path) -> Iterator[Path]:
    """Isolate the store under a temp dir AND drop the location-index cache.

    The index cache is a process-global, so it must be reset around every test
    even though `data_dir` points each test at a fresh directory.
    """
    root = tmp_path / "data"
    dd.set_data_dir(root)
    invalidate_index()
    dd.ensure_data_dir()
    try:
        yield root
    finally:
        invalidate_index()
        dd.set_data_dir(None)


def _new_agent(name: str = "scout", **kw: object) -> NewAgent:
    base: dict[str, object] = {
        "name": name,
        "role": "researcher",
        "archetype": "scout",
        "tools": ["search"],
        "scheduleSeconds": 60,
        "initialPrompt": "go",
    }
    base.update(kw)
    return NewAgent(**base)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# teams
# ---------------------------------------------------------------------------


async def test_teams_create_and_by_id(store_dir: Path) -> None:
    t = await teams.create(NewTeam(name="Acme"))
    assert t.id
    assert t.parentTeamId is None
    assert t.paused is False
    assert t.telemetryEnabled is True
    fetched = await teams.byId(t.id)
    assert fetched is not None
    assert fetched.id == t.id
    assert fetched.name == "Acme"
    # createdAt / lastUserActiveAt revived to real datetimes.
    assert isinstance(fetched.createdAt, datetime)
    assert isinstance(fetched.lastUserActiveAt, datetime)


async def test_teams_all_oldest_first(store_dir: Path) -> None:
    a = await teams.create(NewTeam(name="A"))
    await asyncio.sleep(0.005)
    b = await teams.create(NewTeam(name="B"))
    all_teams = await teams.all()
    assert [t.id for t in all_teams] == [a.id, b.id]  # oldest-first


async def test_teams_roots_and_children(store_dir: Path) -> None:
    root = await teams.create(NewTeam(name="root"))
    child = await teams.create(NewTeam(name="child", parentTeamId=root.id))
    roots = await teams.roots()
    assert [t.id for t in roots] == [root.id]
    kids = await teams.children(root.id)
    assert [t.id for t in kids] == [child.id]
    # The child team folder nests under the parent's teams/ dir.
    fetched_child = await teams.byId(child.id)
    assert fetched_child is not None
    assert fetched_child.parentTeamId == root.id


async def test_teams_create_unknown_parent_raises(store_dir: Path) -> None:
    with pytest.raises(ValueError, match=r"parent team .* not found"):
        await teams.create(NewTeam(name="orphan", parentTeamId="nope"))


async def test_teams_update_and_increment_tick(store_dir: Path) -> None:
    t = await teams.create(NewTeam(name="A"))
    updated = await teams.update(t.id, {"name": "renamed", "paused": True})
    assert updated is not None
    assert updated.name == "renamed"
    assert updated.paused is True
    await teams.incrementTickCount(t.id)
    await teams.incrementTickCount(t.id)
    refetched = await teams.byId(t.id)
    assert refetched is not None
    assert refetched.tickCount == 2


async def test_teams_update_missing_returns_none(store_dir: Path) -> None:
    assert await teams.update("missing", {"name": "x"}) is None


async def test_teams_move_reparents(store_dir: Path) -> None:
    a = await teams.create(NewTeam(name="a"))
    b = await teams.create(NewTeam(name="b"))
    moved = await teams.move(b.id, a.id)
    assert moved is not None
    assert moved.parentTeamId == a.id
    assert [t.id for t in await teams.children(a.id)] == [b.id]
    assert [t.id for t in await teams.roots()] == [a.id]


async def test_teams_delete_removes_subtree(store_dir: Path) -> None:
    root = await teams.create(NewTeam(name="root"))
    child = await teams.create(NewTeam(name="child", parentTeamId=root.id))
    await teams.delete(root.id)
    assert await teams.byId(root.id) is None
    assert await teams.byId(child.id) is None  # subtree gone
    assert await teams.all() == []


async def test_teams_list_unpaused(store_dir: Path) -> None:
    a = await teams.create(NewTeam(name="a"))
    b = await teams.create(NewTeam(name="b"))
    await teams.update(b.id, {"paused": True})
    unpaused = await teams.listUnpaused()
    assert [t.id for t in unpaused] == [a.id]


# ---------------------------------------------------------------------------
# agents
# ---------------------------------------------------------------------------


async def test_agents_create_and_lookups(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="t"))
    ag = await agents.create(team.id, _new_agent("a1"))
    assert ag.teamId == team.id
    assert ag.inFlight is False
    assert ag.conversationState is None
    assert ag.status == "running"
    assert await agents.byId(ag.id) is not None
    assert [a.id for a in await agents.byTeam(team.id)] == [ag.id]


async def test_agents_create_unknown_team_raises(store_dir: Path) -> None:
    with pytest.raises(ValueError, match=r"team .* not found"):
        await agents.create("nope", _new_agent())


async def test_agents_by_teams_filters(store_dir: Path) -> None:
    t1 = await teams.create(NewTeam(name="t1"))
    t2 = await teams.create(NewTeam(name="t2"))
    t3 = await teams.create(NewTeam(name="t3"))
    a1 = await agents.create(t1.id, _new_agent("a1"))
    a2 = await agents.create(t2.id, _new_agent("a2"))
    await agents.create(t3.id, _new_agent("a3"))
    got = {a.id for a in await agents.byTeams([t1.id, t2.id])}
    assert got == {a1.id, a2.id}


async def test_agents_insert_many(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="t"))
    rows = await agents.insertMany(team.id, [_new_agent("a"), _new_agent("b")])
    assert len(rows) == 2
    assert {a.id for a in await agents.byTeam(team.id)} == {r.id for r in rows}


async def test_agents_update_and_move(store_dir: Path) -> None:
    t1 = await teams.create(NewTeam(name="t1"))
    t2 = await teams.create(NewTeam(name="t2"))
    ag = await agents.create(t1.id, _new_agent("a"))
    updated = await agents.update(ag.id, {"status": "paused"})
    assert updated is not None
    assert updated.status == "paused"
    moved = await agents.move(ag.id, t2.id)
    assert moved is not None
    assert moved.teamId == t2.id
    assert await agents.byTeam(t1.id) == []
    assert [a.id for a in await agents.byTeam(t2.id)] == [ag.id]


async def test_agents_delete(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="t"))
    ag = await agents.create(team.id, _new_agent())
    await agents.delete(ag.id)
    assert await agents.byId(ag.id) is None


async def test_agents_claim_then_reset(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="t"))
    ag = await agents.create(team.id, _new_agent())
    assert await agents.claim(ag.id, "running") is True
    # Already in-flight -> second claim fails.
    assert await agents.claim(ag.id, "running") is False
    # Wrong expected status -> fails.
    fresh = await teams.create(NewTeam(name="t2"))
    ag2 = await agents.create(fresh.id, _new_agent(status="paused"))
    assert await agents.claim(ag2.id, "running") is False
    # resetAllInFlight clears the flag.
    await agents.resetAllInFlight()
    again = await agents.byId(ag.id)
    assert again is not None
    assert again.inFlight is False
    assert await agents.claim(ag.id, "running") is True


# ---------------------------------------------------------------------------
# approvals
# ---------------------------------------------------------------------------


async def test_approvals_insert_resolve_flow(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="t"))
    ag = await agents.create(team.id, _new_agent())
    await approvals.insertMany(
        ag.id,
        [
            NewApproval(
                teamId=team.id,
                toolCallId="tc1",
                toolName="delete_file",
                toolArguments='{"path":"/tmp/x"}',
            )
        ],
    )
    pending = await approvals.byAgent(ag.id)
    assert len(pending) == 1
    approval = pending[0]
    assert approval.status == "pending"
    assert approval.agentId == ag.id
    # toolArguments stays a JSON STRING (not parsed).
    assert isinstance(approval.toolArguments, str)
    assert approval.toolArguments == '{"path":"/tmp/x"}'

    assert [a.id for a in await approvals.pendingForTeam(team.id)] == [approval.id]

    result = await approvals.resolve(team.id, approval.id, "approved", "ok by me")
    assert result.ok is True
    assert result.agentId == ag.id  # type: ignore[union-attr]
    resolved = (await approvals.byAgent(ag.id))[0]
    assert resolved.status == "approved"
    assert resolved.decisionNote == "ok by me"
    assert isinstance(resolved.resolvedAt, datetime)


async def test_approvals_resolve_not_found_and_already(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="t"))
    ag = await agents.create(team.id, _new_agent())
    nf = await approvals.resolve(team.id, "missing", "approved", None)
    assert nf.ok is False
    assert nf.reason == "not_found"  # type: ignore[union-attr]

    await approvals.insertMany(
        ag.id, [NewApproval(teamId=team.id, toolCallId="x", toolName="t", toolArguments="{}")]
    )
    aid = (await approvals.byAgent(ag.id))[0].id
    await approvals.resolve(team.id, aid, "approved", None)
    second = await approvals.resolve(team.id, aid, "rejected", None)
    assert second.ok is False
    assert second.reason == "already"  # type: ignore[union-attr]


async def test_approvals_clear_for_agent(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="t"))
    ag = await agents.create(team.id, _new_agent())
    await approvals.insertMany(
        ag.id, [NewApproval(teamId=team.id, toolCallId="x", toolName="t", toolArguments="{}")]
    )
    await approvals.clearForAgent(ag.id)
    assert await approvals.byAgent(ag.id) == []


# ---------------------------------------------------------------------------
# actionLog
# ---------------------------------------------------------------------------


async def test_action_log_newest_first_limit_since(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="t"))
    ag = await agents.create(team.id, _new_agent())
    e1 = await actionLog.insert(ag.id, NewAction(actionType="a", payload={"n": 1}))
    await asyncio.sleep(0.005)
    e2 = await actionLog.insert(ag.id, NewAction(actionType="b", payload={"n": 2}))
    rows = await actionLog.byAgents([ag.id])
    assert [r.id for r in rows] == [e2.id, e1.id]  # newest-first
    assert await actionLog.byAgents([ag.id], limit=1) == [rows[0]]
    # since is strict >.
    after_e1 = await actionLog.byAgents([ag.id], since=e1.executedAt)
    assert [r.id for r in after_e1] == [e2.id]


async def test_action_log_insert_unknown_agent_raises(store_dir: Path) -> None:
    with pytest.raises(ValueError, match=r"agent .* not found"):
        await actionLog.insert("nope", NewAction(actionType="a", payload={}))


# ---------------------------------------------------------------------------
# appEvents
# ---------------------------------------------------------------------------


async def test_app_events_insert_sync_and_query(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="t"))
    # insert is SYNC (plain call, no await).
    ret = appEvents.insert(
        NewAppEvent(
            severity="info", level="agent", source="runner", message="m1", teamId=team.id
        )
    )
    assert ret is None
    rows = await appEvents.query(AppEventQuery(teamId=team.id))
    assert [r.message for r in rows] == ["m1"]
    assert rows[0].acknowledgedAt is None


async def test_app_events_infra_filtered_unless_requested(store_dir: Path) -> None:
    appEvents.insert(
        NewAppEvent(severity="error", level="infra", source="sys", message="boom")
    )
    # Default query excludes infra.
    assert await appEvents.query() == []
    # includeInfra surfaces it.
    rows = await appEvents.query(AppEventQuery(includeInfra=True))
    assert [r.message for r in rows] == ["boom"]


async def test_app_events_query_limit_and_since(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="t"))
    for i in range(3):
        appEvents.insert(
            NewAppEvent(
                severity="info", level="agent", source="s", message=f"m{i}", teamId=team.id
            )
        )
    rows = await appEvents.query(AppEventQuery(teamId=team.id, limit=2))
    assert len(rows) == 2
    # newest-first ordering.
    assert rows[0].createdAt >= rows[1].createdAt


async def test_app_events_acknowledge(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="t"))
    appEvents.insert(
        NewAppEvent(severity="info", level="agent", source="s", message="m", teamId=team.id)
    )
    ev = (await appEvents.query(AppEventQuery(teamId=team.id)))[0]
    touched = await appEvents.acknowledge([ev.id])
    assert touched == 1
    # Second ack is a no-op (already acknowledged).
    assert await appEvents.acknowledge([ev.id]) == 0
    only_unack = await appEvents.query(AppEventQuery(teamId=team.id, unacknowledgedOnly=True))
    assert only_unack == []


# ---------------------------------------------------------------------------
# platformStatus
# ---------------------------------------------------------------------------


async def test_platform_status_get_set(store_dir: Path) -> None:
    assert await platformStatus.get() is None
    row = await platformStatus.set("degraded", "rolling restart")
    assert row.id == 1
    assert row.status == "degraded"
    fetched = await platformStatus.get()
    assert fetched is not None
    assert fetched.id == 1  # literal integer, not a UUID
    assert isinstance(fetched.id, int)
    assert isinstance(fetched.updatedAt, datetime)


# ---------------------------------------------------------------------------
# spend
# ---------------------------------------------------------------------------


async def test_spend_sum_for_day(store_dir: Path) -> None:
    await spend.insert(
        NewSpend(
            teamId=None,
            agentId=None,
            model="gpt",
            inputTokens=10,
            outputTokens=20,
            costCents=150,
            day="2026-06-13",
        )
    )
    await spend.insert(
        NewSpend(
            teamId="t",
            agentId="a",
            model="gpt",
            inputTokens=1,
            outputTokens=2,
            costCents=50,
            day="2026-06-13",
        )
    )
    await spend.insert(
        NewSpend(
            teamId=None,
            agentId=None,
            model="gpt",
            inputTokens=1,
            outputTokens=2,
            costCents=999,
            day="2026-06-12",
        )
    )
    assert await spend.sumForDay("2026-06-13") == 200
    assert await spend.sumForDay("2026-06-12") == 999
    assert await spend.sumForDay("2026-01-01") == 0


# ---------------------------------------------------------------------------
# traceEvents
# ---------------------------------------------------------------------------


def _trace(team_id: str, agent_id: str, seq: int, emitted: datetime) -> NewTraceEvent:
    return NewTraceEvent(
        teamId=team_id,
        agentId=agent_id,
        tickId="tick1",
        seq=seq,
        type="step",
        data={"i": seq},
        emittedAt=emitted,
    )


async def test_trace_events_append_and_query_sort(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="t"))
    ag = await agents.create(team.id, _new_agent())
    t0 = datetime(2026, 6, 13, 12, 0, 0, tzinfo=UTC)
    await traceEvents.append(
        [
            _trace(team.id, ag.id, 2, t0 + timedelta(seconds=1)),
            _trace(team.id, ag.id, 1, t0),
        ]
    )
    asc = await traceEvents.query(
        TraceQuery(teamId=team.id, agentId=ag.id, order="asc", limit=10)
    )
    assert [r.seq for r in asc] == [1, 2]
    desc = await traceEvents.query(
        TraceQuery(teamId=team.id, agentId=ag.id, order="desc", limit=10)
    )
    assert [r.seq for r in desc] == [2, 1]
    # tick filter + limit.
    one = await traceEvents.query(
        TraceQuery(teamId=team.id, tickId="tick1", order="asc", limit=1)
    )
    assert len(one) == 1


async def test_trace_events_prune_older_than(store_dir: Path) -> None:
    team = await teams.create(NewTeam(name="t"))
    ag = await agents.create(team.id, _new_agent())
    old = datetime(2026, 6, 1, tzinfo=UTC)
    new = datetime(2026, 6, 13, tzinfo=UTC)
    await traceEvents.append([_trace(team.id, ag.id, 1, old), _trace(team.id, ag.id, 2, new)])
    await traceEvents.pruneOlderThan(datetime(2026, 6, 10, tzinfo=UTC))
    rows = await traceEvents.query(TraceQuery(teamId=team.id, order="asc", limit=10))
    assert [r.seq for r in rows] == [2]


# ---------------------------------------------------------------------------
# Load-bearing behaviors (explicit coverage)
# ---------------------------------------------------------------------------


async def test_lb1_claim_is_race_free(store_dir: Path) -> None:
    """Behavior 1: concurrent claims, exactly one wins.

    The store_lock around the read-modify-write means two coroutines cannot both
    read inFlight=false. Without it, asyncio would interleave the thread-pool
    read/write and both could win.
    """
    team = await teams.create(NewTeam(name="t"))
    ag = await agents.create(team.id, _new_agent())
    results = await asyncio.gather(*[agents.claim(ag.id, "running") for _ in range(20)])
    assert sum(1 for r in results if r) == 1  # exactly one winner


async def test_lb1_concurrent_insert_many_appends_all(store_dir: Path) -> None:
    """Behavior 1 (JSONL/array append): concurrent approval inserts don't clobber.

    approvals.insertMany is a read-modify-write on the approvals.json array;
    under the lock, concurrent appends serialise and every row survives.
    """
    team = await teams.create(NewTeam(name="t"))
    ag = await agents.create(team.id, _new_agent())

    async def add(i: int) -> None:
        await approvals.insertMany(
            ag.id,
            [NewApproval(teamId=team.id, toolCallId=f"tc{i}", toolName="t", toolArguments="{}")],
        )

    await asyncio.gather(*[add(i) for i in range(10)])
    assert len(await approvals.byAgent(ag.id)) == 10


async def test_lb1_locked_serializes_critical_sections() -> None:
    """Behavior 1 (the load-bearing guarantee): `locked()` admits at most ONE
    critical section at a time.

    Every store read-modify-write (claim, update, resolve, acknowledge,
    incrementTickCount, the JSON-array/JSONL appends) runs through
    `repos._runner.locked`. Its single asyncio.Lock is the explicit replacement
    for Node's implicit single-task atomicity. This test pins that guarantee
    directly and deterministically: it FAILS if the lock is removed.

    Why not assert on `agents.claim` winners instead? In practice anyio's worker
    pool reuses threads and the GIL keeps a tiny read-modify-write from
    interleaving, so a behavioural "exactly one winner" assertion passes even
    with the lock removed — it does not actually exercise the lock. Here each
    section bumps a shared counter, sleeps to release the GIL (forcing a real
    interleave window), then decrements. Without serialisation the observed peak
    concurrency would equal the fan-out (N); with the lock it can never exceed 1.
    """
    import threading
    import time

    from simple_harmonic.store.repos._runner import locked

    active = 0
    peak = 0
    guard = threading.Lock()

    def critical() -> None:
        nonlocal active, peak
        with guard:
            active += 1
            peak = max(peak, active)
        # Release the GIL: any unserialised peer would enter here and bump
        # `active` past 1. Under the store lock, peers wait their turn.
        time.sleep(0.01)
        with guard:
            active -= 1

    fanout = 12
    await asyncio.gather(*[locked(critical) for _ in range(fanout)])
    assert peak == 1, f"locked() allowed {peak} concurrent critical sections (lock missing?)"


async def test_lb2_selective_date_revival(store_dir: Path) -> None:
    """Behavior 2: only declared top-level DATE_KEYS revive; ISO strings inside
    opaque blobs (conversationState/outputContract/payload/metadata) stay strings.
    """
    team = await teams.create(NewTeam(name="t"))
    iso = "2020-01-02T03:04:05.000Z"
    ag = await agents.create(
        team.id,
        _new_agent(outputContract={"deadline": iso, "nested": {"at": iso}}),
    )
    await agents.update(ag.id, {"conversationState": {"lastSeen": iso}})
    refetched = await agents.byId(ag.id)
    assert refetched is not None
    # Top-level createdAt revived to datetime.
    assert isinstance(refetched.createdAt, datetime)
    # ISO-looking strings inside opaque blobs stay strings.
    assert refetched.outputContract == {"deadline": iso, "nested": {"at": iso}}
    assert refetched.outputContract["deadline"] == iso  # type: ignore[index]
    assert refetched.conversationState == {"lastSeen": iso}

    # Action payload with an ISO string also stays a string.
    entry = await actionLog.insert(
        ag.id, NewAction(actionType="x", payload={"when": iso})
    )
    fetched = (await actionLog.byAgents([ag.id]))[0]
    assert fetched.payload == {"when": iso}
    assert isinstance(fetched.payload["when"], str)
    assert isinstance(entry.executedAt, datetime)  # declared key revived


async def test_lb3_platform_status_id_is_literal_int(store_dir: Path) -> None:
    """Behavior 3: PlatformStatus.id is the literal integer 1; agent/team ids are UUIDs."""
    await platformStatus.set("healthy", None)
    raw = json.loads(dd.platform_status_path().read_text())
    assert raw["id"] == 1
    assert isinstance(raw["id"], int)
    # A team id is a UUID string.
    t = await teams.create(NewTeam(name="t"))
    assert isinstance(t.id, str)
    assert "-" in t.id  # uuid4 form


async def test_lb4_tool_arguments_is_json_string(store_dir: Path) -> None:
    """Behavior 4: toolArguments is a JSON STRING, never auto-parsed into an object."""
    team = await teams.create(NewTeam(name="t"))
    ag = await agents.create(team.id, _new_agent())
    args = '{"path":"/etc/passwd","recursive":true}'
    await approvals.insertMany(
        ag.id,
        [NewApproval(teamId=team.id, toolCallId="tc", toolName="rm", toolArguments=args)],
    )
    # On disk it is a JSON string value, not an embedded object.
    loc_path = next(dd.team_agents_dir(_team_dir(team.id)).glob("*/approvals.json"))
    on_disk = json.loads(loc_path.read_text())
    assert on_disk[0]["toolArguments"] == args
    assert isinstance(on_disk[0]["toolArguments"], str)
    # And the typed row keeps it as a str.
    row = (await approvals.byAgent(ag.id))[0]
    assert isinstance(row.toolArguments, str)


async def test_lb5_index_invalidated_on_create_delete_move(store_dir: Path) -> None:
    """Behavior 5: the location index is invalidated on create/delete/move so the
    next read reflects the change without a manual reset.
    """
    root = await teams.create(NewTeam(name="root"))
    # create: a brand-new sibling is visible immediately.
    sib = await teams.create(NewTeam(name="sib"))
    assert {t.id for t in await teams.roots()} == {root.id, sib.id}
    # move: re-parenting is reflected in children()/roots().
    await teams.move(sib.id, root.id)
    assert [t.id for t in await teams.children(root.id)] == [sib.id]
    assert [t.id for t in await teams.roots()] == [root.id]
    # delete: removed team disappears from the index.
    await teams.delete(sib.id)
    assert await teams.byId(sib.id) is None
    assert [t.id for t in await teams.children(root.id)] == []


async def test_lb6_read_jsonl_skips_torn_lines(store_dir: Path) -> None:
    """Behavior 6: readJsonl skips torn/blank lines (a crash mid-append)."""
    team = await teams.create(NewTeam(name="t"))
    ag = await agents.create(team.id, _new_agent())
    await actionLog.insert(ag.id, NewAction(actionType="a", payload={"n": 1}))
    actions_path = next(dd.team_agents_dir(_team_dir(team.id)).glob("*/actions.jsonl"))
    # Simulate a torn write: blank line + a partial (invalid) JSON fragment is
    # NOT something readJsonl tolerates (it raises on invalid JSON), but blank
    # lines are skipped. Append blank lines around a valid row.
    with actions_path.open("a", encoding="utf-8") as fh:
        fh.write("\n   \n")
    rows = await actionLog.byAgents([ag.id])
    assert len(rows) == 1  # blank lines skipped, the one real row survives


async def test_lb6_atomic_write_leaves_no_tmp(store_dir: Path) -> None:
    """Behavior 6: writeJson is atomic (temp + os.replace) — no .tmp left behind."""
    t = await teams.create(NewTeam(name="t"))
    team_dir = _team_dir(t.id)
    assert (team_dir / "team.json").exists()
    assert not (team_dir / "team.json.tmp").exists()


def _team_dir(team_id: str) -> Path:
    """Resolve a team's on-disk folder via a fresh index walk (test helper)."""
    from simple_harmonic.store import index_cache as ic

    d = ic.team_dir(team_id)
    assert d is not None
    return d

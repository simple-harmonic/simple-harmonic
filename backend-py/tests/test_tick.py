"""Tick orchestrator tests — the self-scheduling agent loop.

Ports the behavioral contract of packages/backend/src/server/api/tick.ts:

  - a due agent runs (run_agent mocked)
  - a paused team / not-due agent is skipped (approve_agent_tick gate)
  - agents.claim prevents a double-run (an already-in-flight agent is skipped)
  - the spend cap blocks a tick, and FAILS OPEN on a ledger read error
  - with_timeout bounds a hung run (the agent is errored + rescheduled)
  - try_resume_agent HOLD / RESUME / DENY trichotomy

Everything is OFFLINE: ``run_agent`` and the LLM cascade are mocked, so no
network call and no real model is touched. The a2ax bus + store run over an
isolated temp data dir.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from simple_harmonic import tick as tick_mod
from simple_harmonic.a2ax_singleton import reset_a2ax_for_tests
from simple_harmonic.meta_agent.types import (
    AgentRunResult,
    AgentSuspension,
    PendingToolCall,
)
from simple_harmonic.store import data_dir as dd
from simple_harmonic.store import invalidate_index
from simple_harmonic.store.repos import NewAgent, NewApproval, agents, approvals, teams
from simple_harmonic.store.types import Agent, Team

# asyncio_mode = "auto" (pyproject) runs ``async def`` tests without a marker.


# ---------------------------------------------------------------------------
# Fixtures + helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def store_dir(tmp_path: Path) -> Iterator[Path]:
    """Isolate the store + a2ax under a temp dir and drop the location index."""
    root = tmp_path / "data"
    dd.set_data_dir(root)
    invalidate_index()
    dd.ensure_data_dir()
    reset_a2ax_for_tests()
    tick_mod.reset_in_flight_guard_for_tests()
    try:
        yield root
    finally:
        invalidate_index()
        dd.set_data_dir(None)
        reset_a2ax_for_tests()
        tick_mod.reset_in_flight_guard_for_tests()


@pytest.fixture(autouse=True)
def _stub_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    """Never build a real cascade client (the Python OpenAI SDK raises with no
    key). The mocked run_agent ignores the client anyway."""
    monkeypatch.setattr(tick_mod, "_resolve_tick_llm", lambda: (object(), "test-model"))


@pytest.fixture(autouse=True)
def _stub_spend(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default: spend is within budget and recording is a no-op. Individual
    tests override check_spend_allowed to exercise the cap / fail-open paths."""
    from simple_harmonic.llm import spend as spend_mod

    async def _allowed(now: datetime | None = None) -> Any:
        return spend_mod.SpendStatus(allowed=True, spentCents=0, capCents=5000)

    async def _record(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(tick_mod, "check_spend_allowed", _allowed)
    monkeypatch.setattr(tick_mod, "record_spend", _record)


async def _make_team(*, paused: bool = False) -> Team:
    from simple_harmonic.store.repos import NewTeam

    return await teams.create(NewTeam(name="Eng", paused=paused))


async def _make_agent(
    team_id: str,
    *,
    status: str = "running",
    next_run_at: datetime | None = None,
    schedule_seconds: int = 60,
) -> Agent:
    due = next_run_at if next_run_at is not None else datetime.now(UTC) - timedelta(seconds=1)
    return await agents.create(
        team_id,
        NewAgent(
            name="scout",
            role="Researcher",
            archetype="ops-monitor",
            tools=["send_message"],
            scheduleSeconds=schedule_seconds,
            initialPrompt="You are a scout.",
            status=status,  # type: ignore[arg-type]
            nextRunAt=due,
        ),
    )


def _stub_run_agent(
    monkeypatch: pytest.MonkeyPatch,
    result: AgentRunResult | None = None,
    *,
    record: list[Any] | None = None,
) -> None:
    """Replace tick's run_agent with a mock returning ``result`` (default: a
    plain thought). Records each AgentConfig into ``record`` if provided."""
    out = result or AgentRunResult(actionType="agent_thought", payload={"thought": "hi"})

    async def _fake(config: Any) -> AgentRunResult:
        if record is not None:
            record.append(config)
        return out

    monkeypatch.setattr(tick_mod, "run_agent", _fake)


# ---------------------------------------------------------------------------
# Due agent runs
# ---------------------------------------------------------------------------


async def test_due_agent_runs(store_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    team = await _make_team()
    agent = await _make_agent(team.id)
    configs: list[Any] = []
    _stub_run_agent(monkeypatch, record=configs)

    body = await tick_mod.run_tick()

    assert body["ok"] is True
    assert body["agentsRan"] == 1
    # run_agent saw the right agent.
    assert len(configs) == 1
    assert configs[0].agentId == agent.id

    # The agent is back to running with a fresh nextRunAt and the claim released.
    after = await agents.byId(agent.id)
    assert after is not None
    assert after.status == "running"
    assert after.inFlight is False
    assert after.nextRunAt is not None and after.nextRunAt > datetime.now(UTC)

    # The team's tickCount advanced once.
    team_after = await teams.byId(team.id)
    assert team_after is not None
    assert team_after.tickCount == team.tickCount + 1


async def test_fresh_run_suspends_and_parks(
    store_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A fresh run that suspends parks the agent (awaiting_approval), writes the
    approval rows, and does NOT advance nextRunAt (handleRunResult)."""
    team = await _make_team()
    agent = await _make_agent(team.id)
    before = await agents.byId(agent.id)
    assert before is not None

    suspension = AgentSuspension(
        messages=[{"role": "assistant", "content": None, "tool_calls": []}],
        pending=[PendingToolCall(id="call-x", name="write_file", arguments='{"path":"a"}')],
        round=0,
    )
    result = AgentRunResult(
        actionType="suspended",
        payload={"agent": "scout", "pending": [{"id": "call-x", "name": "write_file"}]},
        suspension=suspension,
    )
    _stub_run_agent(monkeypatch, result=result)

    body = await tick_mod.run_tick()

    # It RAN (then suspended) -> counts as ran.
    assert body["agentsRan"] == 1

    after = await agents.byId(agent.id)
    assert after is not None
    assert after.status == "awaiting_approval"
    assert after.inFlight is False
    # nextRunAt is NOT advanced while parked.
    assert after.nextRunAt == before.nextRunAt
    # The pending destructive call was written as a pending approval row.
    rows = await approvals.byAgent(agent.id)
    assert [r.toolCallId for r in rows] == ["call-x"]
    assert rows[0].status == "pending"
    assert rows[0].toolName == "write_file"


# ---------------------------------------------------------------------------
# Skips: paused team / not-due agent
# ---------------------------------------------------------------------------


async def test_paused_team_is_skipped(store_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    team = await _make_team(paused=True)
    await _make_agent(team.id)
    configs: list[Any] = []
    _stub_run_agent(monkeypatch, record=configs)

    body = await tick_mod.run_tick()

    # A paused team is filtered out before any agent work (listUnpaused).
    assert body["agentsRan"] == 0
    assert configs == []
    # tickCount does NOT advance for a paused (skipped) team.
    team_after = await teams.byId(team.id)
    assert team_after is not None
    assert team_after.tickCount == team.tickCount


async def test_not_due_agent_is_skipped(
    store_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    team = await _make_team()
    future = datetime.now(UTC) + timedelta(hours=1)
    await _make_agent(team.id, next_run_at=future)
    configs: list[Any] = []
    _stub_run_agent(monkeypatch, record=configs)

    body = await tick_mod.run_tick()

    assert body["agentsRan"] == 0
    assert configs == []
    # The team still ticked (it is active); the agent just wasn't due.
    team_after = await teams.byId(team.id)
    assert team_after is not None
    assert team_after.tickCount == team.tickCount + 1


async def test_paused_agent_is_skipped(
    store_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    team = await _make_team()
    await _make_agent(team.id, status="paused")
    configs: list[Any] = []
    _stub_run_agent(monkeypatch, record=configs)

    body = await tick_mod.run_tick()
    assert body["agentsRan"] == 0
    assert configs == []


# ---------------------------------------------------------------------------
# claim prevents a double-run
# ---------------------------------------------------------------------------


async def test_claim_prevents_double_run(
    store_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    team = await _make_team()
    agent = await _make_agent(team.id)
    # Simulate an overlapping tick that already claimed this agent. Arm the
    # once-per-process inFlight reset as already fired so this tick does NOT
    # clear the flag (the reset is crash recovery, not a per-tick clear).
    await agents.update(agent.id, {"inFlight": True})
    monkeypatch.setattr(tick_mod, "_did_reset_in_flight", True)

    configs: list[Any] = []
    _stub_run_agent(monkeypatch, record=configs)

    body = await tick_mod.run_tick()

    # approve_agent_tick rejects an in-flight agent, so it never even reaches the
    # claim — and run_agent is never called (no double-run).
    assert body["agentsRan"] == 0
    assert configs == []
    # The flag is left intact (the gate skipped it; nothing touched it).
    after = await agents.byId(agent.id)
    assert after is not None
    assert after.inFlight is True


async def test_claim_race_loses_when_already_claimed(
    store_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the agent passes the gate but a concurrent claim already took it, the
    fresh run bails on a failed claim (the atomic claim is the real guard)."""
    team = await _make_team()
    await _make_agent(team.id)

    # Force claim() to report the agent already taken, exercising the bail path
    # AFTER the gate allowed it. Mirrors a concurrent tick winning the claim.
    async def _claim_fails(_agent_id: str, _expected: str) -> bool:
        return False

    monkeypatch.setattr(tick_mod.agents, "claim", _claim_fails)
    configs: list[Any] = []
    _stub_run_agent(monkeypatch, record=configs)

    body = await tick_mod.run_tick()
    assert body["agentsRan"] == 0
    assert configs == []


# ---------------------------------------------------------------------------
# Spend cap: blocks + fails open
# ---------------------------------------------------------------------------


async def test_spend_cap_blocks_tick(
    store_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from simple_harmonic.llm import spend as spend_mod

    team = await _make_team()
    await _make_agent(team.id)
    configs: list[Any] = []
    _stub_run_agent(monkeypatch, record=configs)

    async def _over_cap(now: datetime | None = None) -> Any:
        return spend_mod.SpendStatus(allowed=False, spentCents=6000, capCents=5000)

    monkeypatch.setattr(tick_mod, "check_spend_allowed", _over_cap)

    body = await tick_mod.run_tick()

    # The whole tick short-circuits before any agent work.
    assert body["agentsRan"] == 0
    assert body["skipped"] == "spend_cap"
    assert body["spentCents"] == 6000
    assert body["capCents"] == 5000
    assert configs == []


async def test_spend_cap_fails_open_on_read_error(
    store_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from simple_harmonic.llm import spend as spend_mod

    team = await _make_team()
    agent = await _make_agent(team.id)
    configs: list[Any] = []
    _stub_run_agent(monkeypatch, record=configs)

    # A ledger read error surfaces as unknown=True; the tick proceeds (fail-open).
    async def _unknown(now: datetime | None = None) -> Any:
        return spend_mod.SpendStatus(
            allowed=True, spentCents=-1, capCents=5000, unknown=True
        )

    monkeypatch.setattr(tick_mod, "check_spend_allowed", _unknown)

    body = await tick_mod.run_tick()

    # Fail-open: the agent still ran despite the unreadable ledger.
    assert body["agentsRan"] == 1
    assert len(configs) == 1
    assert configs[0].agentId == agent.id


# ---------------------------------------------------------------------------
# with_timeout bounds a hung run
# ---------------------------------------------------------------------------


async def test_timeout_errors_and_reschedules_agent(
    store_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    team = await _make_team()
    agent = await _make_agent(team.id, schedule_seconds=30)

    # A hung run that ignores cancellation long enough to blow the budget.
    async def _hang(_config: Any) -> AgentRunResult:
        await asyncio.sleep(5)
        return AgentRunResult(actionType="noop", payload={})

    monkeypatch.setattr(tick_mod, "run_agent", _hang)
    # Tiny budget so the timeout fires immediately.
    monkeypatch.setenv("SH_AGENT_TIMEOUT_MS", "20")

    body = await tick_mod.run_tick()

    # The timed-out run reports it did NOT run, and the team still ticks once
    # (the timeout did not burn the whole pass).
    assert body["agentsRan"] == 0

    after = await agents.byId(agent.id)
    assert after is not None
    assert after.status == "errored"
    assert after.inFlight is False
    # Rescheduled so the tick can't tight-loop.
    assert after.nextRunAt is not None and after.nextRunAt > datetime.now(UTC)


async def test_with_timeout_returns_value_when_fast(store_dir: Path) -> None:
    async def _quick(_signal: Any) -> str:
        return "done"

    out = await tick_mod.with_timeout(_quick, 1000, "fast")
    assert out == "done"


async def test_with_timeout_raises_agent_timeout(store_dir: Path) -> None:
    import asyncio

    async def _slow(signal: Any) -> str:
        await asyncio.sleep(5)
        return "never"

    with pytest.raises(tick_mod.AgentTimeoutError):
        await tick_mod.with_timeout(_slow, 20, "slow")


# ---------------------------------------------------------------------------
# try_resume_agent: HOLD / RESUME / DENY
# ---------------------------------------------------------------------------


def _suspension(pending: list[tuple[str, str, str]]) -> dict[str, Any]:
    """Build a parked AgentSuspension dict (conversationState) with the given
    pending destructive tool calls: (id, name, arguments)."""
    s = AgentSuspension(
        messages=[
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": tc_id,
                        "type": "function",
                        "function": {"name": name, "arguments": args},
                    }
                    for (tc_id, name, args) in pending
                ],
            }
        ],
        pending=[
            PendingToolCall(id=tc_id, name=name, arguments=args)
            for (tc_id, name, args) in pending
        ],
        round=0,
    )
    return s.model_dump(by_alias=True)


async def _park_agent(
    team: Team, agent: Agent, pending: list[tuple[str, str, str]]
) -> None:
    """Park an agent awaiting approval with the given pending calls + approval
    rows (all pending/undecided)."""
    await agents.update(
        agent.id,
        {"status": "awaiting_approval", "conversationState": _suspension(pending)},
    )
    await approvals.insertMany(
        agent.id,
        [
            NewApproval(
                teamId=team.id, toolCallId=tc_id, toolName=name, toolArguments=args
            )
            for (tc_id, name, args) in pending
        ],
    )


async def test_resume_holds_when_one_approval_still_pending(
    store_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    team = await _make_team()
    agent = await _make_agent(team.id, status="awaiting_approval")
    await _park_agent(
        team,
        agent,
        [("call-1", "write_file", "{}"), ("call-2", "run_command", "{}")],
    )

    # Decide only ONE of the two approvals; the other stays pending.
    pend = await approvals.byAgent(agent.id)
    first = next(r for r in pend if r.toolCallId == "call-1")
    await approvals.resolve(team.id, first.id, "approved", None)

    configs: list[Any] = []
    _stub_run_agent(monkeypatch, record=configs)

    body = await tick_mod.run_tick()

    # HOLD: neither resumed (run_agent not called) nor rejected (still parked).
    assert body["agentsRan"] == 0
    assert configs == []
    after = await agents.byId(agent.id)
    assert after is not None
    assert after.status == "awaiting_approval"
    assert after.inFlight is False
    # Approval rows are untouched (still one pending).
    rows = await approvals.byAgent(agent.id)
    assert any(r.status == "pending" for r in rows)


async def test_resume_holds_when_approval_rows_missing(
    store_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    team = await _make_team()
    agent = await _make_agent(team.id, status="awaiting_approval")
    # Park with a suspension but DO NOT write approval rows (incomplete park).
    await agents.update(
        agent.id,
        {
            "status": "awaiting_approval",
            "conversationState": _suspension([("call-1", "write_file", "{}")]),
        },
    )

    configs: list[Any] = []
    _stub_run_agent(monkeypatch, record=configs)

    body = await tick_mod.run_tick()

    # Missing rows -> HOLD (do not treat the absent decision as a rejection).
    assert body["agentsRan"] == 0
    assert configs == []
    after = await agents.byId(agent.id)
    assert after is not None
    assert after.status == "awaiting_approval"


async def test_resume_runs_when_all_decided(
    store_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    team = await _make_team()
    agent = await _make_agent(team.id, status="awaiting_approval")
    await _park_agent(
        team,
        agent,
        [("call-1", "write_file", "{}"), ("call-2", "run_command", "{}")],
    )

    # Decide BOTH approvals (one approved, one rejected).
    pend = await approvals.byAgent(agent.id)
    by_call = {r.toolCallId: r for r in pend}
    await approvals.resolve(team.id, by_call["call-1"].id, "approved", None)
    await approvals.resolve(team.id, by_call["call-2"].id, "rejected", "nope")

    decisions_seen: list[Any] = []

    async def _fake(config: Any) -> AgentRunResult:
        # The runner receives the verdicts via config.resume.decisions.
        decisions_seen.append(config.resume)
        return AgentRunResult(actionType="agent_thought", payload={"thought": "resumed"})

    monkeypatch.setattr(tick_mod, "run_agent", _fake)

    body = await tick_mod.run_tick()

    # RESUME: run_agent was called with the resume state + decisions.
    assert body["agentsRan"] == 1
    assert len(decisions_seen) == 1
    resume = decisions_seen[0]
    assert resume is not None
    verdicts = {d.id: d.approved for d in resume.decisions}
    assert verdicts == {"call-1": True, "call-2": False}

    # The agent returned to running, state cleared, approvals consumed.
    after = await agents.byId(agent.id)
    assert after is not None
    assert after.status == "running"
    assert after.inFlight is False
    assert after.conversationState is None
    assert await approvals.byAgent(agent.id) == []


async def test_resume_denied_call_is_skipped_others_resume(
    store_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A DENIED approval aborts that specific tool call but the rest resume — the
    runner applies the verdicts. Here we assert the tick passes BOTH verdicts
    through (approved=False for the denied call, True for the approved one) so
    the runner can skip the denied one and run the rest."""
    team = await _make_team()
    agent = await _make_agent(team.id, status="awaiting_approval")
    await _park_agent(
        team,
        agent,
        [("call-approved", "write_file", "{}"), ("call-denied", "run_command", "{}")],
    )

    pend = await approvals.byAgent(agent.id)
    by_call = {r.toolCallId: r for r in pend}
    await approvals.resolve(team.id, by_call["call-approved"].id, "approved", None)
    await approvals.resolve(
        team.id, by_call["call-denied"].id, "rejected", "too risky"
    )

    seen: list[Any] = []

    async def _fake(config: Any) -> AgentRunResult:
        seen.append(config.resume.decisions)
        return AgentRunResult(actionType="agent_thought", payload={"thought": "done"})

    monkeypatch.setattr(tick_mod, "run_agent", _fake)

    body = await tick_mod.run_tick()

    assert body["agentsRan"] == 1
    (decisions,) = seen
    verdicts = {d.id: d.approved for d in decisions}
    assert verdicts["call-approved"] is True
    assert verdicts["call-denied"] is False  # denied -> the runner skips this call
    # The denied call's note is threaded through for the rejection message.
    denied = next(d for d in decisions if d.id == "call-denied")
    assert denied.note == "too risky"


async def test_resume_with_no_state_clears_and_holds(
    store_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An agent parked awaiting_approval with NO conversationState is defensively
    reset to running (not resumed, not left dangling)."""
    team = await _make_team()
    agent = await _make_agent(team.id, status="awaiting_approval")
    await agents.update(agent.id, {"conversationState": None})

    configs: list[Any] = []
    _stub_run_agent(monkeypatch, record=configs)

    body = await tick_mod.run_tick()

    assert body["agentsRan"] == 0
    assert configs == []
    after = await agents.byId(agent.id)
    assert after is not None
    assert after.status == "running"
    assert after.inFlight is False


# ---------------------------------------------------------------------------
# Endpoint wiring: /api/tick runs the real orchestrator, cron-gated
# ---------------------------------------------------------------------------


async def test_tick_endpoint_runs_orchestrator(
    store_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from httpx import ASGITransport, AsyncClient

    from simple_harmonic.app import create_app
    from simple_harmonic.store.repo_store import RepoStore

    team = await _make_team()
    agent = await _make_agent(team.id)
    configs: list[Any] = []
    _stub_run_agent(monkeypatch, record=configs)

    app = create_app(store=RepoStore(), start_tick_loop=False)
    transport = ASGITransport(app=app)
    async with (
        AsyncClient(transport=transport, base_url="http://test") as ac,
        app.router.lifespan_context(app),
    ):
        # No CRON_SECRET + non-production => cron gate is permissive (dev).
        resp = await ac.post("/api/tick")

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["agentsRan"] == 1
    datetime.fromisoformat(body["timestamp"])
    assert [c.agentId for c in configs] == [agent.id]


async def test_tick_endpoint_cron_gated_in_production(
    store_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from httpx import ASGITransport, AsyncClient

    from simple_harmonic.app import create_app
    from simple_harmonic.settings import get_settings
    from simple_harmonic.store.repo_store import RepoStore

    # Production without CRON_SECRET: the tick endpoint fails closed (401).
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.delenv("CRON_SECRET", raising=False)
    get_settings.cache_clear()
    _stub_run_agent(monkeypatch)

    app = create_app(store=RepoStore(), start_tick_loop=False)
    transport = ASGITransport(app=app)
    try:
        async with (
            AsyncClient(transport=transport, base_url="http://test") as ac,
            app.router.lifespan_context(app),
        ):
            resp = await ac.post("/api/tick")
        assert resp.status_code == 401
        assert resp.json() == {"error": "unauthorized"}
    finally:
        get_settings.cache_clear()

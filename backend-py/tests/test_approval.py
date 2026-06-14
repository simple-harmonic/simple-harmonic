"""Tests for the pure approval gate (port of approval.test.ts)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from simple_harmonic.meta_agent.approval import (
    approve_agent_action,
    approve_agent_tick,
)

NOW = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)


@dataclass
class FakeAgent:
    id: str = "a1"
    name: str = "Scout"
    status: str = "running"
    inFlight: bool = False
    nextRunAt: datetime | None = NOW - timedelta(seconds=1)  # due by default


@dataclass
class FakeTeam:
    id: str = "t1"
    paused: bool = False


@dataclass
class FakeCall:
    toolName: str
    arguments: dict[str, object]


# --- approve_agent_tick ----------------------------------------------------


def test_tick_allowed_when_due_and_running() -> None:
    d = approve_agent_tick(FakeTeam(), FakeAgent(), NOW)
    assert d.allowed is True
    assert d.reason_code is None


def test_tick_team_paused() -> None:
    d = approve_agent_tick(FakeTeam(paused=True), FakeAgent(), NOW)
    assert d.allowed is False
    assert d.reason_code == "team_paused"


def test_tick_agent_paused() -> None:
    d = approve_agent_tick(FakeTeam(), FakeAgent(status="paused"), NOW)
    assert d.reason_code == "agent_paused"


def test_tick_agent_errored() -> None:
    d = approve_agent_tick(FakeTeam(), FakeAgent(status="errored"), NOW)
    assert d.reason_code == "agent_errored"


def test_tick_awaiting_approval_does_not_run_fresh() -> None:
    d = approve_agent_tick(FakeTeam(), FakeAgent(status="awaiting_approval"), NOW)
    assert d.allowed is False
    assert d.reason_code == "awaiting_approval"


def test_tick_in_flight_blocks_overlap() -> None:
    d = approve_agent_tick(FakeTeam(), FakeAgent(inFlight=True), NOW)
    assert d.reason_code == "agent_in_flight"


def test_tick_not_due_when_next_run_in_future() -> None:
    d = approve_agent_tick(FakeTeam(), FakeAgent(nextRunAt=NOW + timedelta(minutes=5)), NOW)
    assert d.reason_code == "not_due"


def test_tick_not_due_when_next_run_unset() -> None:
    d = approve_agent_tick(FakeTeam(), FakeAgent(nextRunAt=None), NOW)
    assert d.reason_code == "not_due"


def test_tick_precedence_team_paused_beats_everything() -> None:
    # Team paused wins even if the agent is also in a blocking state.
    d = approve_agent_tick(FakeTeam(paused=True), FakeAgent(status="errored"), NOW)
    assert d.reason_code == "team_paused"


# --- approve_agent_action --------------------------------------------------


def test_action_safe_tool_allowed() -> None:
    call = FakeCall("send_message", {"to": "b"})
    d = approve_agent_action(FakeTeam(), FakeAgent(), call, lambda _n, _a=None: False)
    assert d.allowed is True


def test_action_destructive_tool_held() -> None:
    call = FakeCall("write_file", {"path": "x"})
    d = approve_agent_action(FakeTeam(), FakeAgent(), call, lambda _n, _a=None: True)
    assert d.allowed is False
    assert d.reason_code == "destructive_unconfirmed"
    assert "write_file" in d.reason


def test_action_default_classifier_holds_everything() -> None:
    # No classifier => fail safe: even an innocuous-looking call is held.
    call = FakeCall("report_action", {})
    d = approve_agent_action(FakeTeam(), FakeAgent(), call)
    assert d.allowed is False
    assert d.reason_code == "destructive_unconfirmed"


def test_action_classifier_receives_name_and_args() -> None:
    seen: list[tuple[str, object]] = []

    def classifier(name: str, raw: object = None) -> bool:
        seen.append((name, raw))
        return False

    call = FakeCall("github_api", {"method": "GET"})
    approve_agent_action(FakeTeam(), FakeAgent(), call, classifier)
    assert seen == [("github_api", {"method": "GET"})]

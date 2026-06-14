"""Approval gate — a pure, I/O-free decision module.

TS source: packages/backend/src/lib/meta-agent/approval.ts

Two pure decisions:

- ``approve_agent_tick`` — may an agent run THIS tick? Rejects when the team is
  paused, the agent is paused/errored/awaiting_approval, the agent is already
  in-flight (no overlapping ticks), or it is not due yet. The tick loop calls
  this.
- ``approve_agent_action`` — may a single tool call run without human sign-off?
  ``is_destructive`` is the source of truth; a safe tool is allowed, a
  destructive one is held with reason code ``destructive_unconfirmed``. An
  UNKNOWN tool (no classifier vouches for it) is treated as destructive — fail
  safe — and the default classifier holds everything.

Kept pure (no DB, no SDK) so it stays trivially testable, mirroring the TS.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, Protocol, runtime_checkable

AgentStatus = Literal["running", "paused", "errored", "awaiting_approval"]

ApprovalReasonCode = Literal[
    "team_paused",
    "agent_paused",
    "agent_errored",
    "agent_in_flight",
    "awaiting_approval",
    "not_due",
    "destructive_unconfirmed",
]


@runtime_checkable
class AgentLike(Protocol):
    """Structural view of an agent row. camelCase mirrors the store/TS fields."""

    id: str
    name: str
    status: AgentStatus
    inFlight: bool
    nextRunAt: datetime | None


@runtime_checkable
class TeamLike(Protocol):
    id: str
    paused: bool


@runtime_checkable
class ToolCallLike(Protocol):
    toolName: str
    arguments: dict[str, object]


@dataclass(frozen=True, slots=True)
class ApprovalDecision:
    """``allowed=True`` carries no reason; a denial carries reason + code."""

    allowed: bool
    reason: str = ""
    reason_code: ApprovalReasonCode | None = None


# Source-of-truth predicate: (tool_name, raw_args) -> is this destructive?
DestructiveClassifier = Callable[[str, object], bool]


def approve_agent_tick(
    team: TeamLike, agent: AgentLike, now: datetime | None = None
) -> ApprovalDecision:
    """Decide whether an agent should run on this tick.

    Pure: pass in team + agent state plus an optional clock, get back a
    decision. The tick loop calls this; tests can call it directly.
    """
    moment = now if now is not None else datetime.now(UTC)
    if team.paused:
        return ApprovalDecision(False, "Team is paused.", "team_paused")
    if agent.status == "paused":
        return ApprovalDecision(False, f"{agent.name} is paused.", "agent_paused")
    if agent.status == "errored":
        return ApprovalDecision(
            False, f"{agent.name} is errored; resolve before resuming.", "agent_errored"
        )
    if agent.status == "awaiting_approval":
        # Parked mid-tick waiting on a human decision: it does NOT run a fresh
        # tick; the tick loop resumes it separately once approvals resolve.
        return ApprovalDecision(
            False,
            f"{agent.name} is awaiting approval of a pending action.",
            "awaiting_approval",
        )
    if agent.inFlight:
        return ApprovalDecision(
            False, f"{agent.name} is mid-tick; waiting for it to finish.", "agent_in_flight"
        )
    if agent.nextRunAt is None or agent.nextRunAt > moment:
        return ApprovalDecision(False, f"{agent.name} not due yet.", "not_due")
    return ApprovalDecision(True)


def _hold_everything(_tool_name: str, _raw_args: object = None) -> bool:
    """Default classifier: with no registry to vouch for a tool, hold it."""
    return True


def approve_agent_action(
    _team: TeamLike,
    _agent: AgentLike,
    call: ToolCallLike,
    is_destructive: DestructiveClassifier = _hold_everything,
) -> ApprovalDecision:
    """Decide whether a single tool call may execute without human sign-off.

    Safe tools are allowed; destructive (or unknown) tools are held with reason
    code ``destructive_unconfirmed``, which the runner turns into a suspension
    and the tick loop turns into a pending_approvals row.
    """
    if not is_destructive(call.toolName, call.arguments):
        return ApprovalDecision(True)
    return ApprovalDecision(
        False,
        f"Tool '{call.toolName}' requires approval before it runs.",
        "destructive_unconfirmed",
    )

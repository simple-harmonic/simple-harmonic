"""Meta-agent engine types — the data shapes the orchestration core speaks.

TS source:
  - packages/backend/src/lib/meta-agent/types.ts   (OpenAIToolDef)
  - packages/backend/src/lib/meta-agent/runner.ts   (AgentConfig, AgentSuspension,
    PendingToolCall, ToolDecision, ResumeState, AgentRunResult, AgentPromptConfig)
  - packages/backend/src/lib/meta-agent/codex-harness.ts (CodexThreadSuspension,
    isCodexThreadSuspension)
  - packages/backend/src/lib/meta-agent/trace.ts    (TraceEventType, TraceStep, TraceSink)
  - packages/backend/src/lib/meta-agent/planner.ts   (PlannerResult discriminated union)

Two families of shapes live here:

* In-process call frames (``AgentConfig``, ``ResumeState``, ``TraceStep``) are
  dataclasses: they carry live objects (the LLM client, the a2ax bus, an
  ``asyncio`` cancellation token, a callable trace sink) and never cross the
  wire, so Pydantic validation would only add cost.

* Persisted / wire shapes (``AgentSuspension``, ``CodexThreadSuspension``,
  ``PendingToolCall``, ``ToolDecision``, the ``PlannerResult`` union, and their
  sub-models) are Pydantic v2 models with camelCase field names. They round-trip
  through ``agents.conversationState`` (the parked suspension) and the planner
  HTTP surface untouched.

The two suspension shapes share ``agents.conversationState`` and are
disambiguated ONLY by :func:`is_codex_thread_suspension` (``kind == "codex-thread"``
and ``threadId`` is a ``str``). See the runner's resume path and the tick route's
``try_resume_agent`` for how the discriminator is read off persisted JSON.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field

from simple_harmonic.llm.client import LLMClient
from simple_harmonic.meta_agent.contract import ValidationResult
from simple_harmonic.tools.registry import ToolRegistry
from simple_harmonic.tools.types import A2AXSender, OpenAIToolDef, PeerAgent, ToolResult

# OpenAI-wire-format function/tool definition passed in the ``tools`` array.
# Re-exported from the slice-6 tools layer so callers that follow the TS import
# sites (types.ts) all resolve from one place.
__all__ = [
    "AgentConfig",
    "AgentPromptConfig",
    "AgentRunResult",
    "AgentSuspension",
    "CodexThreadSuspension",
    "CredentialRequest",
    "MessageResult",
    "ModifyAgentResult",
    "ModifyAgentResultEnvelope",
    "ModifyAgentUpdates",
    "OpenAIToolDef",
    "PendingToolCall",
    "PlannerMessage",
    "PlannerResult",
    "RequestCredentialResult",
    "ResumeState",
    "SpawnResult",
    "SpawnTeamAgent",
    "SpawnTeamResult",
    "ToolDecision",
    "TraceEventType",
    "TraceSink",
    "TraceStep",
    "is_codex_thread_suspension",
]


# ---------------------------------------------------------------------------
# Play-by-play trace (trace.ts)
# ---------------------------------------------------------------------------

# The runner emits one TraceStep for every observable step of a tick. The sink
# is supplied by the caller; the runner stays storage-agnostic. Emitting is
# fire-and-forget: the runner wraps every sink call in try/except so a buggy
# sink can never break a tick.
TraceEventType = Literal[
    "tick_started",
    "llm_request",
    "llm_response",
    "tool_started",
    "tool_finished",
    "approval_requested",
    "decision_applied",
    "tick_finished",
    "tick_failed",
]


@dataclass
class TraceStep:
    """One play-by-play step. ``data`` is a free-form payload per ``type``."""

    type: TraceEventType
    data: dict[str, Any]


# Sink receiving play-by-play steps. Must not block; must not throw.
TraceSink = Callable[[TraceStep], None]


# ---------------------------------------------------------------------------
# Pending tool calls + human decisions (runner.ts)
# ---------------------------------------------------------------------------


class PendingToolCall(BaseModel):
    """A tool call the LLM asked for, in OpenAI wire shape.

    ``arguments`` is the raw JSON arguments STRING as emitted by the LLM (parsed
    lazily so a malformed call can be fed back to the model rather than raised).
    """

    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    arguments: str


class ToolDecision(BaseModel):
    """Human decision for one pending tool call, supplied on resume."""

    model_config = ConfigDict(populate_by_name=True)

    # Matches PendingToolCall.id.
    id: str
    approved: bool
    # Optional note shown to the LLM (e.g. why it was rejected).
    note: str | None = None


# ---------------------------------------------------------------------------
# Suspension shapes (runner.ts AgentSuspension / codex-harness.ts CodexThreadSuspension)
# ---------------------------------------------------------------------------


class AgentSuspension(BaseModel):
    """Opaque-to-callers serialized conversation at the point of suspension.

    Plain JSON: the tick route persists it in ``agents.conversationState`` and
    hands it back verbatim on resume. The runner is the only place that
    understands the shape.
    """

    model_config = ConfigDict(populate_by_name=True)

    # Full OpenAI-format message list up to and including the assistant turn
    # whose tool calls triggered the suspension.
    messages: list[dict[str, Any]] = Field(default_factory=list)
    # Destructive tool calls awaiting a human decision.
    pending: list[PendingToolCall] = Field(default_factory=list)
    # Safe calls from the same assistant turn, deferred so every call gets a
    # result on resume.
    deferredSafe: list[PendingToolCall] | None = None
    # Actions already logged this tick before the suspension (safe tools).
    actions: list[ToolResult] = Field(default_factory=list)
    # Loop round at the point of suspension, so resume continues counting.
    round: int = 0


class CodexThreadSuspension(BaseModel):
    """Suspension for a parked codex-thread tick (engine mode).

    Unlike :class:`AgentSuspension` there is NO message transcript here: codex
    persists the conversation in its thread; we only carry the handle and the
    pending call. The ``kind`` discriminator is how the tick route tells the two
    shapes apart (see :func:`is_codex_thread_suspension`).
    """

    model_config = ConfigDict(populate_by_name=True)

    kind: Literal["codex-thread"] = "codex-thread"
    threadId: str
    # Destructive calls awaiting a human decision (one per pause in practice).
    pending: list[PendingToolCall] = Field(default_factory=list)
    # Actions already logged this tick before the pause.
    actions: list[ToolResult] = Field(default_factory=list)


def is_codex_thread_suspension(value: Any) -> bool:
    """Discriminate the two suspension shapes parked in
    ``agents.conversationState``.

    True only when the value is a codex-thread suspension: a mapping (or model)
    with ``kind == "codex-thread"`` and a ``threadId`` that is a ``str``. Mirrors
    the TS type-guard ``isCodexThreadSuspension`` so the resume path can route
    persisted JSON to the right runner. Do NOT conflate this with a plain
    :class:`AgentSuspension`, which carries a message transcript and no ``kind``.
    """
    if isinstance(value, CodexThreadSuspension):
        return True
    if isinstance(value, AgentSuspension):
        return False
    if isinstance(value, BaseModel):
        value = value.model_dump()
    if not isinstance(value, dict):
        return False
    return value.get("kind") == "codex-thread" and isinstance(value.get("threadId"), str)


# ---------------------------------------------------------------------------
# Resume state + agent config (runner.ts)
# ---------------------------------------------------------------------------


@dataclass
class ResumeState:
    """Resume a previously suspended tick: the parked suspension plus the human
    decisions applied to its pending destructive calls."""

    suspension: AgentSuspension
    decisions: list[ToolDecision]


# The subset of AgentConfig the prompt builders read. The codex app-server
# harness satisfies this without constructing an LLM client. Mirrors the TS
# ``AgentPromptConfig`` Pick<>.
@dataclass
class AgentPromptConfig:
    name: str
    archetype: str
    tools: list[str]
    initialPrompt: str
    peers: list[PeerAgent] = field(default_factory=list)
    teamGoal: str | None = None
    recentHistory: str | None = None
    recentValidations: str | None = None
    outputContract: dict[str, Any] | None = None
    a2axContext: str | None = None
    appHealthContext: str | None = None


@dataclass
class AgentConfig(AgentPromptConfig):
    """Everything :func:`simple_harmonic.meta_agent.runner.run_agent` needs.

    Carries live objects (the LLM client, the a2ax bus, an ``asyncio`` event used
    as the cancellation token, a callable trace sink), so it is a dataclass, not
    a Pydantic model. Inherits the prompt-only fields from
    :class:`AgentPromptConfig`.
    """

    # Team + identity context for tool execution.
    teamId: str = ""
    agentId: str = ""
    # a2ax instance for sending messages.
    a2ax: A2AXSender | None = None
    # OpenAI-compatible client for LLM calls.
    llm: LLMClient | None = None
    # Model to use for LLM calls.
    model: str | None = None
    # Cancellation token propagated from the tick budget so provider calls can
    # cancel. An ``asyncio.Event`` whose ``set()`` state means "aborted",
    # mirroring the TS ``AbortSignal`` threaded through ``options.signal``.
    signal: asyncio.Event | None = None
    # Classifier: does this tool require human approval before it runs? Defaults
    # to the registry's risk labels.
    isDestructive: Callable[[str, Any], bool] | None = None
    # Registry for tool definitions and execution. Defaults to the internal
    # message-passing registry; the app passes the full registry.
    toolRegistry: ToolRegistry | None = None
    # Resume a previously suspended tick.
    resume: ResumeState | None = None
    # Optional play-by-play sink.
    trace: TraceSink | None = None


@dataclass
class AgentRunResult:
    """Result of a tick. ``actionType`` is "suspended" when paused for approval;
    otherwise the action type. ``payload`` is always present so callers that
    only read actionType/payload keep working; the approval-aware tick route
    checks ``suspension``."""

    actionType: str
    payload: dict[str, Any]
    # Present iff the tick suspended for human approval.
    suspension: AgentSuspension | None = None
    # Present when the agent has an output contract.
    validation: ValidationResult | None = None


# ---------------------------------------------------------------------------
# Planner discriminated union (planner.ts)
# ---------------------------------------------------------------------------


class PlannerMessage(BaseModel):
    """One turn of the founder<->planner conversation."""

    model_config = ConfigDict(populate_by_name=True)

    role: Literal["user", "assistant"]
    content: str


class SpawnTeamAgent(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str
    role: str
    archetype: str
    tools: list[str]
    schedule_seconds: int
    initial_prompt: str


class SpawnTeamResult(BaseModel):
    # The TS type marks team_name required, but the planner returns the spawn arm
    # on JSON validity alone (an unchecked cast), so a tool call that omits it
    # still parses. Default "" keeps strict validation (nested agents stay typed)
    # while tolerating the absence — see planner._try_parse.
    model_config = ConfigDict(populate_by_name=True)

    team_name: str = ""
    parent_team: str | None = None
    cofounder_name: str | None = None
    agents: list[SpawnTeamAgent] = Field(default_factory=list)


class ModifyAgentUpdates(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    tools: list[str] | None = None
    initial_prompt: str | None = None
    schedule_seconds: int | None = None
    status: Literal["running", "paused"] | None = None
    role: str | None = None
    output_contract: dict[str, Any] | None = None


class ModifyAgentResult(BaseModel):
    # Defaults mirror the unchecked TS cast (see SpawnTeamResult): the arm is
    # selected on JSON validity, so a partial tool call still parses.
    model_config = ConfigDict(populate_by_name=True)

    agent_name: str = ""
    team_name: str = ""
    updates: ModifyAgentUpdates = Field(default_factory=lambda: ModifyAgentUpdates())


class CredentialRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    key: str = ""
    label: str = ""
    reason: str = ""
    help_url: str | None = None


# The four arms of the planner's discriminated union. Each carries a literal
# ``type`` tag; ``Field(discriminator="type")`` (below) tells Pydantic which arm
# to parse. ``content`` is the streamed assistant text; the tool arms additionally
# carry the parsed tool-call ``result``.


class MessageResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["message"] = "message"
    content: str


class SpawnResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["spawn"] = "spawn"
    content: str
    result: SpawnTeamResult


class ModifyAgentResultEnvelope(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["modify_agent"] = "modify_agent"
    content: str
    result: ModifyAgentResult


class RequestCredentialResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["request_credential"] = "request_credential"
    content: str
    result: CredentialRequest


# Discriminated union on ``type`` — the Python port of the TS
# ``PlannerResult`` union. Use ``PlannerResultAdapter`` (planner.py) to parse
# wire JSON into the right arm.
PlannerResult = Annotated[
    Union[  # noqa: UP007 - discriminated union needs explicit Union for the discriminator
        MessageResult,
        SpawnResult,
        ModifyAgentResultEnvelope,
        RequestCredentialResult,
    ],
    Field(discriminator="type"),
]

"""Meta-agent orchestration engine (slice 7 core).

TS source: packages/backend/src/lib/meta-agent/index.ts

Re-exports the engine surface: the planner, the agent runner, the output-contract
validator, the play-by-play trace types, and the two suspension shapes. The tool
registry and default tools are REUSED from the slice-6 :mod:`simple_harmonic.tools`
package (the TS ``ToolRegistry`` / ``createDefaultRegistry`` live there in Python),
so they are re-exported from there rather than redefined here.

LLM adapters (slice 7): the Anthropic + Codex provider adapters live in
:mod:`simple_harmonic.meta_agent.anthropic_adapter` and
:mod:`simple_harmonic.meta_agent.codex_adapter`. Importing this package wires them
into the slice-5 resolver hooks (``candidates.codex_client_factory`` ->
``create_codex_app_server_client``; ``candidates.anthropic_client_factory`` ->
``create_anthropic_client``) via :func:`simple_harmonic.meta_agent.wiring.wire_candidate_factories`.
The codex hook is the ``codex app-server`` engine adapted to the ``LLMClient``
contract; the agent tick still drives codex via ``run_codex_agent_tick`` directly.

The pure approval gate (``approve_agent_tick`` / ``approve_agent_action`` from
lib/meta-agent/approval.ts) lives in :mod:`simple_harmonic.meta_agent.approval`
and is re-exported here; the tick loop (slice 8) calls ``approve_agent_tick``.

Not yet ported (out of slice-7 scope; tracked as a shared-seam gap): the
``AGENT_TOOL_DEFS`` / ``executeTool`` back-compat shims (lib/meta-agent/tools.ts).
The runner does NOT depend on them; its destructive-vs-safe classification flows
through ``registry.is_destructive`` and the optional ``AgentConfig.isDestructive``
predicate.
"""

from __future__ import annotations

from simple_harmonic.meta_agent.anthropic_adapter import (
    create_anthropic_client,
)
from simple_harmonic.meta_agent.approval import (
    AgentLike,
    ApprovalDecision,
    ApprovalReasonCode,
    DestructiveClassifier,
    TeamLike,
    ToolCallLike,
    approve_agent_action,
    approve_agent_tick,
)
from simple_harmonic.meta_agent.codex_adapter import (
    CodexAppServerClient,
    CodexAppServerError,
    CodexHarnessResult,
    JsonRpcTransport,
    ThreadHandlers,
    create_codex_app_server_client,
    default_server_request_result,
    run_codex_agent_tick,
)
from simple_harmonic.meta_agent.contract import (
    ContractIssue,
    ValidationResult,
    validate_contract,
)
from simple_harmonic.meta_agent.default_prompt import DEFAULT_META_AGENT_PROMPT
from simple_harmonic.meta_agent.planner import (
    PlannerConfig,
    PlannerDeps,
    PlannerResponse,
    planner_stream,
)
from simple_harmonic.meta_agent.runner import (
    FALLBACK_TOOL_NAMES,
    MAX_TOOL_ROUNDS,
    build_system_prompt,
    build_tick_prompt,
    run_agent,
    summarize,
    tool_allowlist,
)
from simple_harmonic.meta_agent.types import (
    AgentConfig,
    AgentPromptConfig,
    AgentRunResult,
    AgentSuspension,
    CodexThreadSuspension,
    CredentialRequest,
    MessageResult,
    ModifyAgentResult,
    ModifyAgentResultEnvelope,
    ModifyAgentUpdates,
    PendingToolCall,
    PlannerMessage,
    PlannerResult,
    RequestCredentialResult,
    ResumeState,
    SpawnResult,
    SpawnTeamAgent,
    SpawnTeamResult,
    ToolDecision,
    TraceEventType,
    TraceSink,
    TraceStep,
    is_codex_thread_suspension,
)

# Wire the slice-7 adapters into the slice-5 resolver hooks at import time
# (mirrors the TS server/llm.ts importing createCodexClient/createAnthropicClient).
from simple_harmonic.meta_agent.wiring import wire_candidate_factories

# Reused from slice 6 (the Python home of the ported ToolRegistry + default tools).
from simple_harmonic.tools.registry import ToolRegistry, schema_to_parameters

wire_candidate_factories()

__all__ = [
    "DEFAULT_META_AGENT_PROMPT",
    "FALLBACK_TOOL_NAMES",
    "MAX_TOOL_ROUNDS",
    "AgentConfig",
    "AgentLike",
    "AgentPromptConfig",
    "AgentRunResult",
    "AgentSuspension",
    "ApprovalDecision",
    "ApprovalReasonCode",
    "CodexAppServerClient",
    "CodexAppServerError",
    "CodexHarnessResult",
    "CodexThreadSuspension",
    "ContractIssue",
    "CredentialRequest",
    "DestructiveClassifier",
    "JsonRpcTransport",
    "MessageResult",
    "ModifyAgentResult",
    "ModifyAgentResultEnvelope",
    "ModifyAgentUpdates",
    "PendingToolCall",
    "PlannerConfig",
    "PlannerDeps",
    "PlannerMessage",
    "PlannerResponse",
    "PlannerResult",
    "RequestCredentialResult",
    "ResumeState",
    "SpawnResult",
    "SpawnTeamAgent",
    "SpawnTeamResult",
    "TeamLike",
    "ThreadHandlers",
    "ToolCallLike",
    "ToolDecision",
    "ToolRegistry",
    "TraceEventType",
    "TraceSink",
    "TraceStep",
    "ValidationResult",
    "approve_agent_action",
    "approve_agent_tick",
    "build_system_prompt",
    "build_tick_prompt",
    "create_anthropic_client",
    "create_codex_app_server_client",
    "default_server_request_result",
    "is_codex_thread_suspension",
    "planner_stream",
    "run_agent",
    "run_codex_agent_tick",
    "schema_to_parameters",
    "summarize",
    "tool_allowlist",
    "validate_contract",
]

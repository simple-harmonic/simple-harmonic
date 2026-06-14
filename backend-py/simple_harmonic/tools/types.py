"""Tool execution types — the data carried into and out of a tool impl.

TS source:
  packages/backend/src/lib/meta-agent/tools.ts  (ToolExecContext / ToolRunContext
    / ToolResult / ToolExecResult / PeerAgent / A2AXSender)
  packages/backend/src/lib/meta-agent/types.ts  (OpenAIToolDef)

These are pure data shapes shared by the registry and every tool impl. They are
dataclasses (not Pydantic models): they never cross the wire as request/response
bodies, they carry an injected a2ax sender (a live object, not JSON), and the
registry's ``execute`` path returns :class:`ToolExecResult` directly to the
runner. Pydantic would add validation cost and JSON-coercion semantics we don't
want for an in-process call frame.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class ToolResult:
    """An action a tool produced, to be logged to the action feed."""

    actionType: str
    payload: dict[str, Any]


@dataclass
class PeerAgent:
    """Peer agent info passed to tool execution context."""

    id: str
    name: str
    role: str


@dataclass
class ToolExecResult:
    """What every tool impl returns. ``success=False`` with an explanatory
    ``result`` string is the universal error channel — impls and the registry
    never raise out of ``execute`` (the runner feeds ``result`` back to the
    model for self-correction)."""

    toolName: str
    success: bool
    result: str
    action: ToolResult | None = None


class A2AXSender(Protocol):
    """The agent-to-agent message bus surface a tool impl may use."""

    def send_direct(
        self, team_id: str, sender: str, to: str, content: str
    ) -> Awaitable[object]: ...

    def broadcast(self, team_id: str, sender: str, content: str) -> Awaitable[object]: ...


@dataclass
class ToolExecContext:
    """Context available to a tool's public callers. Does NOT carry the a2ax
    sender — back-compat callers pass that separately, merged into the
    ToolRunContext the registry impls receive."""

    teamId: str
    agentId: str
    agentName: str
    peers: list[PeerAgent] = field(default_factory=list)


@dataclass
class ToolRunContext(ToolExecContext):
    """What a registry tool implementation actually receives: ctx + the a2ax
    bus. ``a2ax`` defaults to ``None`` so impls that never touch the bus (fs,
    shell, network) can be exercised without one."""

    a2ax: A2AXSender | None = None


# OpenAI-wire-format function/tool definition passed in the `tools` array. A
# plain dict (the OpenAI/Anthropic SDKs accept dicts here), built by the
# registry from a tool's pydantic schema.
OpenAIToolDef = dict[str, Any]


# An impl is an async callable ``(args_model, ctx) -> ToolExecResult``. ``args``
# is the already-validated pydantic model instance the registry parsed.
ToolImpl = Callable[[Any, ToolRunContext], Awaitable[ToolExecResult]]

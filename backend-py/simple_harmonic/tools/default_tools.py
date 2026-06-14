"""Default (internal) tools — the message-passing tools every agent has.

TS source: packages/backend/src/lib/meta-agent/default-tools.ts

These are send_message, broadcast, report_action as registry entries with
pydantic args models. They are "internal": they only touch the a2ax bus and the
action log, never the outside world, so they are ``safe`` and never pass through
the approval gate. Their impls read the a2ax sender from the run context
(``ctx.a2ax``), keeping this module free of any concrete a2ax/server dependency.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from simple_harmonic.tools.registry import ToolDefinition, ToolRegistry
from simple_harmonic.tools.types import ToolExecResult, ToolResult, ToolRunContext


class SendMessageArgs(BaseModel):
    to_agent: str = Field(
        description="Name of the agent to send to (e.g. 'content-scheduler')"
    )
    content: str = Field(description="The message content")


class BroadcastArgs(BaseModel):
    content: str = Field(description="The broadcast message content")


class ReportActionArgs(BaseModel):
    action_type: str = Field(
        description=(
            "Short label for the action (e.g. 'draft_reply', 'research_summary', "
            "'metrics_check')"
        )
    )
    summary: str = Field(description="Brief description of what you did or found")
    details: dict[str, object] | None = Field(
        default=None, description="Any structured data relevant to the action"
    )


async def _send_message(args: SendMessageArgs, ctx: ToolRunContext) -> ToolExecResult:
    peer = next(
        (p for p in ctx.peers if p.name.lower() == args.to_agent.lower()),
        None,
    )
    if peer is None:
        available = ", ".join(p.name for p in ctx.peers)
        return ToolExecResult(
            toolName="send_message",
            success=False,
            result=f'Agent "{args.to_agent}" not found. Available agents: {available}',
        )
    assert ctx.a2ax is not None
    await ctx.a2ax.send_direct(ctx.teamId, ctx.agentId, peer.id, args.content)
    return ToolExecResult(
        toolName="send_message",
        success=True,
        result=f"Message sent to {peer.name}",
        action=ToolResult(
            actionType="message_sent",
            payload={"to": peer.name, "toId": peer.id, "content": args.content},
        ),
    )


async def _broadcast(args: BroadcastArgs, ctx: ToolRunContext) -> ToolExecResult:
    assert ctx.a2ax is not None
    await ctx.a2ax.broadcast(ctx.teamId, ctx.agentId, args.content)
    return ToolExecResult(
        toolName="broadcast",
        success=True,
        result=f"Broadcast sent to all {len(ctx.peers)} peers",
        action=ToolResult(
            actionType="broadcast_sent",
            payload={"content": args.content, "peerCount": len(ctx.peers)},
        ),
    )


async def _report_action(args: ReportActionArgs, _ctx: ToolRunContext) -> ToolExecResult:
    details = args.details or {}
    return ToolExecResult(
        toolName="report_action",
        success=True,
        result=f"Action logged: {args.action_type}",
        action=ToolResult(
            actionType=args.action_type,
            payload={"summary": args.summary, **details},
        ),
    )


def create_default_registry() -> ToolRegistry:
    """Build a registry pre-loaded with the three internal tools."""
    registry = ToolRegistry()

    registry.register(
        ToolDefinition(
            name="send_message",
            description=(
                "Send a direct message to another agent in the team. Use this to "
                "coordinate, delegate, share findings, or ask questions."
            ),
            category="internal",
            risk="safe",
            schema=SendMessageArgs,
        ),
        _send_message,
    )

    registry.register(
        ToolDefinition(
            name="broadcast",
            description=(
                "Send a message to ALL agents in the team. Use for announcements, "
                "status updates, or information everyone needs."
            ),
            category="internal",
            risk="safe",
            schema=BroadcastArgs,
        ),
        _broadcast,
    )

    registry.register(
        ToolDefinition(
            name="report_action",
            description=(
                "Report an action you took or a finding from your work. This gets "
                "logged to the team's action log and narration feed."
            ),
            category="internal",
            risk="safe",
            schema=ReportActionArgs,
        ),
        _report_action,
    )

    return registry

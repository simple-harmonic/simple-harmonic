"""A2AX Protocol — the primary API surface for agent communication.

TS source: packages/a2ax/src/core/protocol.ts

The A2AX facade wraps a Transport and exposes the high-level operations agents
use: direct/broadcast/group messaging, task lifecycle, per-tick context
injection, agent-card discovery, and token auth. All channel-creation,
relevance, and read-tracking semantics are delegated to the Transport; the
facade only orchestrates.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from simple_harmonic.a2ax.channel import (
    Channel,
    broadcast_channel_id,
    direct_channel_id,
    group_channel_id,
    task_channel_id,
)
from simple_harmonic.a2ax.message import (
    ChannelType,
    CreateMessageInput,
    Message,
    MessageKind,
    Part,
)
from simple_harmonic.a2ax.task import (
    CreateTaskInput,
    Task,
    TaskState,
    UpdateTaskInput,
    is_valid_transition,
)
from simple_harmonic.a2ax.token import (
    DEFAULT_SCOPES,
    AgentToken,
    Scope,
    generate_token,
    has_scope,
)
from simple_harmonic.a2ax.transport import MessageQuery, Transport
from simple_harmonic.a2ax.types import AgentCard

# Default message expiry: 7 days.
_DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

# Placeholder timestamp for channels handed to the transport, which overrides
# createdAt server-side (mirrors the TS Omit<Channel, "createdAt"> contract).
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


@dataclass
class A2AXOptions:
    """Options for creating an A2AX instance (TS: A2AXOptions)."""

    transport: Transport
    max_context_messages: int = 20
    default_expiry_ms: int = _DEFAULT_EXPIRY_MS


@dataclass
class AgentContext:
    """Context block ready to inject into an agent's prompt (TS: AgentContext)."""

    messages: list[Message] = field(default_factory=list)
    formatted: str = ""
    messageIds: list[str] = field(default_factory=list)


def _now() -> datetime:
    return datetime.now(UTC)


class A2AX:
    """A2AX Protocol — the primary interface for agent communication.

    TS source: A2AX class in core/protocol.ts.
    """

    def __init__(self, opts: A2AXOptions) -> None:
        self._transport = opts.transport
        self._max_context_messages = opts.max_context_messages
        self._default_expiry_ms = opts.default_expiry_ms

    def _expiry(self) -> datetime:
        return _now() + timedelta(milliseconds=self._default_expiry_ms)

    # --- Direct messaging (1:1) ----------------------------------------------

    async def send_direct(
        self,
        team_id: str,
        from_agent_id: str,
        to_agent_id: str,
        content: str,
        *,
        kind: MessageKind = "text",
        parts: list[Part] | None = None,
        payload: dict[str, object] | None = None,
        urgent: bool | None = None,
    ) -> Message:
        channel_id = direct_channel_id(from_agent_id, to_agent_id)
        await self._ensure_channel(channel_id, team_id, "direct")
        return await self._transport.insert_message(
            CreateMessageInput(
                teamId=team_id,
                channelType="direct",
                channelId=channel_id,
                fromAgentId=from_agent_id,
                kind=kind,
                content=content,
                parts=parts,
                payload=payload,
                urgent=urgent,
                expiresAt=self._expiry(),
            )
        )

    # --- Broadcast (one-to-all) ----------------------------------------------

    async def broadcast(
        self,
        team_id: str,
        from_agent_id: str,
        content: str,
        *,
        kind: MessageKind = "text",
        parts: list[Part] | None = None,
        payload: dict[str, object] | None = None,
    ) -> Message:
        channel_id = broadcast_channel_id(team_id)
        await self._ensure_channel(channel_id, team_id, "broadcast", "team-broadcast")
        return await self._transport.insert_message(
            CreateMessageInput(
                teamId=team_id,
                channelType="broadcast",
                channelId=channel_id,
                fromAgentId=from_agent_id,
                kind=kind,
                content=content,
                parts=parts,
                payload=payload,
                expiresAt=self._expiry(),
            )
        )

    # --- Group messaging -----------------------------------------------------

    async def create_group(
        self, team_id: str, name: str, member_ids: list[str]
    ) -> dict[str, str]:
        group_id = str(uuid.uuid4())
        channel_id = group_channel_id(group_id)

        await self._transport.create_channel(
            Channel(
                id=channel_id,
                teamId=team_id,
                channelType="group",
                name=name,
                createdAt=_EPOCH,
            )
        )

        for agent_id in member_ids:
            await self._transport.add_member(channel_id, agent_id)

        await self._transport.insert_message(
            CreateMessageInput(
                teamId=team_id,
                channelType="group",
                channelId=channel_id,
                fromAgentId=member_ids[0],
                role="system",
                kind="system.created",
                content=f'Group "{name}" created with {len(member_ids)} members',
            )
        )

        return {"channelId": channel_id}

    async def send_to_group(
        self,
        team_id: str,
        channel_id: str,
        from_agent_id: str,
        content: str,
        *,
        kind: MessageKind = "text",
        parts: list[Part] | None = None,
        payload: dict[str, object] | None = None,
    ) -> Message:
        return await self._transport.insert_message(
            CreateMessageInput(
                teamId=team_id,
                channelType="group",
                channelId=channel_id,
                fromAgentId=from_agent_id,
                kind=kind,
                content=content,
                parts=parts,
                payload=payload,
                expiresAt=self._expiry(),
            )
        )

    async def join_group(self, channel_id: str, agent_id: str) -> None:
        channel = await self._transport.get_channel(channel_id)
        if channel is None or channel.channelType != "group":
            raise ValueError(f"Channel {channel_id} is not a group")
        await self._transport.add_member(channel_id, agent_id)

    async def leave_group(self, channel_id: str, agent_id: str) -> None:
        await self._transport.remove_member(channel_id, agent_id)

    # --- Task management -----------------------------------------------------

    async def create_task(self, input: CreateTaskInput) -> dict[str, object]:
        task = await self._transport.create_task(input)
        channel_id = task_channel_id(task.id)

        await self._transport.create_channel(
            Channel(
                id=channel_id,
                teamId=input.teamId,
                channelType="task",
                name=input.title,
                createdAt=_EPOCH,
            )
        )

        await self._transport.insert_message(
            CreateMessageInput(
                teamId=input.teamId,
                channelType="task",
                channelId=channel_id,
                fromAgentId=input.requestorId,
                kind="task.create",
                content=input.description,
                payload={"title": input.title, "assigneeId": input.assigneeId},
                urgent=True,
            )
        )

        return {"task": task, "channelId": channel_id}

    async def update_task_state(
        self,
        task_id: str,
        agent_id: str,
        new_state: TaskState,
        content: str | None = None,
    ) -> Task:
        task = await self._transport.get_task(task_id)
        if task is None:
            raise ValueError(f"Task {task_id} not found")

        if not is_valid_transition(task.state, new_state):
            raise ValueError(f"Invalid transition: {task.state} -> {new_state}")

        updated = await self._transport.update_task(
            task_id, UpdateTaskInput(state=new_state)
        )
        channel_id = task_channel_id(task_id)

        await self._transport.insert_message(
            CreateMessageInput(
                teamId=task.teamId,
                channelType="task",
                channelId=channel_id,
                fromAgentId=agent_id,
                kind="task.status",
                content=content if content is not None else f"Task moved to {new_state}",
                payload={"state": new_state},
            )
        )

        return updated

    async def complete_task(
        self,
        task_id: str,
        agent_id: str,
        content: str,
        *,
        parts: list[Part] | None = None,
        payload: dict[str, object] | None = None,
    ) -> Task:
        task = await self._transport.get_task(task_id)
        if task is None:
            raise ValueError(f"Task {task_id} not found")

        # NB: completeTask FORCE-sets state=completed from any state (incl.
        # terminal) — it does NOT validate the transition, unlike
        # updateTaskState.
        updated = await self._transport.update_task(
            task_id, UpdateTaskInput(state="completed")
        )
        channel_id = task_channel_id(task_id)

        await self._transport.insert_message(
            CreateMessageInput(
                teamId=task.teamId,
                channelType="task",
                channelId=channel_id,
                fromAgentId=agent_id,
                kind="task.result",
                content=content,
                parts=parts,
                payload=payload,
            )
        )

        return updated

    # --- Agent context (for tick injection) ----------------------------------

    async def get_agent_context(self, team_id: str, agent_id: str) -> AgentContext:
        # Four separate per-channel-type queries, each capped at maxContextMessages.
        direct_msgs = await self._transport.query_messages(
            self._ctx_query(team_id, agent_id, "direct")
        )
        broadcast_msgs = await self._transport.query_messages(
            self._ctx_query(team_id, agent_id, "broadcast")
        )
        group_msgs = await self._transport.query_messages(
            self._ctx_query(team_id, agent_id, "group")
        )
        task_msgs = await self._transport.query_messages(
            self._ctx_query(team_id, agent_id, "task")
        )

        all_messages = sorted(
            [*direct_msgs, *broadcast_msgs, *group_msgs, *task_msgs],
            key=lambda m: m.createdAt,
        )[: self._max_context_messages]

        message_ids = [m.id for m in all_messages]
        formatted = self._format_context(all_messages)

        return AgentContext(
            messages=all_messages, formatted=formatted, messageIds=message_ids
        )

    def _ctx_query(
        self, team_id: str, agent_id: str, channel_type: ChannelType
    ) -> MessageQuery:
        return MessageQuery(
            teamId=team_id,
            agentId=agent_id,
            unreadOnly=True,
            channelType=channel_type,
            limit=self._max_context_messages,
        )

    async def mark_context_read(self, agent_id: str, message_ids: list[str]) -> None:
        if len(message_ids) > 0:
            await self._transport.mark_read(agent_id, message_ids)

    # --- Read views (team dashboards — not relevance-filtered) ---------------

    async def list_messages(self, team_id: str, limit: int | None = None) -> list[Message]:
        return await self._transport.list_team_messages(team_id, limit)

    async def list_tasks(self, team_id: str, agent_id: str | None = None) -> list[Task]:
        return await self._transport.list_tasks(team_id, agent_id)

    # --- Agent Cards ---------------------------------------------------------

    async def register_card(self, card: AgentCard) -> AgentCard:
        return await self._transport.upsert_card(card)

    async def get_card(self, agent_id: str) -> AgentCard | None:
        return await self._transport.get_card(agent_id)

    async def discover_agents(self, team_id: str) -> list[AgentCard]:
        return await self._transport.list_cards(team_id)

    # --- Auth ----------------------------------------------------------------

    async def issue_token(
        self, agent_id: str, team_id: str, scopes: list[Scope] | None = None
    ) -> str:
        token = generate_token()
        await self._transport.create_token(
            AgentToken(
                agentId=agent_id,
                teamId=team_id,
                token=token,
                scopes=list(scopes) if scopes is not None else list(DEFAULT_SCOPES),
                createdAt=_now(),
            )
        )
        return token

    async def authenticate(self, token: str) -> dict[str, str] | None:
        t = await self._transport.get_token(token)
        if t is None:
            return None
        if t.expiresAt and t.expiresAt < _now():
            return None
        return {"agentId": t.agentId, "teamId": t.teamId}

    async def authorize(self, token: str, scope: Scope) -> bool:
        t = await self._transport.get_token(token)
        if t is None:
            return False
        if t.expiresAt and t.expiresAt < _now():
            return False
        return has_scope(t, scope)

    # --- Maintenance ---------------------------------------------------------

    async def expire_messages(self) -> int:
        return await self._transport.mark_expired(_now())

    # --- Private helpers -----------------------------------------------------

    async def _ensure_channel(
        self,
        channel_id: str,
        team_id: str,
        channel_type: ChannelType,
        name: str | None = None,
    ) -> None:
        existing = await self._transport.get_channel(channel_id)
        if existing is None:
            await self._transport.create_channel(
                Channel(
                    id=channel_id,
                    teamId=team_id,
                    channelType=channel_type,
                    name=name,
                    createdAt=_EPOCH,
                )
            )

    def _format_context(self, messages: list[Message]) -> str:
        if len(messages) == 0:
            return ""
        lines = [f"{self._format_prefix(m)}\n{m.content}" for m in messages]
        body = "\n\n".join(lines)
        return f"--- Messages since last tick ---\n\n{body}\n---"

    def _format_prefix(self, m: Message) -> str:
        if m.channelType == "direct":
            return f"[direct from {m.fromAgentId}]:"
        if m.channelType == "broadcast":
            return f"[broadcast from {m.fromAgentId}]:"
        if m.channelType == "group":
            return f"[{m.channelId} from {m.fromAgentId}]:"
        if m.channelType == "task":
            return f"[{m.channelId} from {m.fromAgentId}] ({m.kind}):"
        return f"[{m.fromAgentId}]:"

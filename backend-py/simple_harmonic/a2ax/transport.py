"""Transport contract + the in-memory reference implementation.

TS source: packages/a2ax/src/core/transport.ts (the Transport interface +
MessageQuery) and packages/a2ax/src/transport/memory.ts (MemoryTransport).

The Transport is the storage layer for a2ax: 22 async methods over messages,
channels, tasks, agent cards, and tokens (5 messages + 7 channels + 4 tasks +
3 cards + 3 auth). Adapters (memory, json-file) implement it. MemoryTransport is
the canonical reference for the query/relevance semantics that every other
adapter must reproduce.

All methods are async (matching the TS `Promise`-returning interface), even
though MemoryTransport's logic is synchronous in-memory work.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict

from simple_harmonic.a2ax.channel import Channel, ChannelMember, direct_channel_id
from simple_harmonic.a2ax.message import CreateMessageInput, Message
from simple_harmonic.a2ax.task import CreateTaskInput, Task, UpdateTaskInput
from simple_harmonic.a2ax.token import AgentToken
from simple_harmonic.a2ax.types import AgentCard


class MessageQuery(BaseModel):
    """Query filter for fetching messages (TS: MessageQuery)."""

    model_config = ConfigDict(populate_by_name=True)

    teamId: str
    agentId: str
    unreadOnly: bool | None = None
    limit: int | None = None
    channelType: str | None = None


@runtime_checkable
class Transport(Protocol):
    """Storage-agnostic API that adapters implement (22 async methods).

    TS source: Transport interface in core/transport.ts.
    """

    # --- Messages ---
    async def insert_message(self, input: CreateMessageInput) -> Message: ...
    async def query_messages(self, query: MessageQuery) -> list[Message]: ...
    async def list_team_messages(self, team_id: str, limit: int | None = None) -> list[Message]: ...
    async def mark_read(self, agent_id: str, message_ids: list[str]) -> None: ...
    async def mark_expired(self, before: datetime) -> int: ...

    # --- Channels ---
    async def get_channel(self, channel_id: str) -> Channel | None: ...
    async def create_channel(self, channel: Channel) -> Channel: ...
    async def list_channels(self, team_id: str) -> list[Channel]: ...
    async def add_member(self, channel_id: str, agent_id: str) -> ChannelMember: ...
    async def remove_member(self, channel_id: str, agent_id: str) -> None: ...
    async def get_members(self, channel_id: str) -> list[ChannelMember]: ...
    async def get_memberships(self, agent_id: str) -> list[ChannelMember]: ...

    # --- Tasks ---
    async def create_task(self, input: CreateTaskInput) -> Task: ...
    async def get_task(self, task_id: str) -> Task | None: ...
    async def update_task(self, task_id: str, input: UpdateTaskInput) -> Task: ...
    async def list_tasks(self, team_id: str, agent_id: str | None = None) -> list[Task]: ...

    # --- Agent Cards ---
    async def get_card(self, agent_id: str) -> AgentCard | None: ...
    async def upsert_card(self, card: AgentCard) -> AgentCard: ...
    async def list_cards(self, team_id: str) -> list[AgentCard]: ...

    # --- Auth ---
    async def create_token(self, token: AgentToken) -> AgentToken: ...
    async def get_token(self, token: str) -> AgentToken | None: ...
    async def revoke_token(self, token: str) -> None: ...


def _now() -> datetime:
    return datetime.now(UTC)


def _read_key(message_id: str, agent_id: str) -> str:
    """Per-recipient read-tracking key (TS: `${messageId}:${agentId}`)."""
    return f"{message_id}:{agent_id}"


def _card_team_id(card: AgentCard) -> object | None:
    """A card's owning team rides on metadata.teamId (no teamId field)."""
    if card.metadata is None:
        return None
    return card.metadata.get("teamId")


class MemoryTransport:
    """In-memory Transport — the canonical reference for query/relevance logic.

    TS source: transport/memory.ts. Implements the Transport protocol.
    """

    def __init__(self) -> None:
        self._messages: list[Message] = []
        # Per-recipient read tracking keyed `${messageId}:${agentId}`. A broadcast
        # or group message is a single row, so reads MUST be per-agent — otherwise
        # one reader hides it from everyone else.
        self._reads: set[str] = set()
        self._channels: dict[str, Channel] = {}
        self._members: list[ChannelMember] = []
        self._tasks: dict[str, Task] = {}
        self._cards: dict[str, AgentCard] = {}
        self._tokens: dict[str, AgentToken] = {}

    # --- Messages ---

    async def insert_message(self, input: CreateMessageInput) -> Message:
        msg = Message(
            id=str(uuid.uuid4()),
            teamId=input.teamId,
            channelType=input.channelType,
            channelId=input.channelId,
            fromAgentId=input.fromAgentId,
            role=input.role if input.role is not None else "agent",
            kind=input.kind,
            content=input.content,
            parts=input.parts,
            artifacts=input.artifacts,
            payload=input.payload,
            replyTo=input.replyTo,
            status="pending",
            urgent=input.urgent,
            expiresAt=input.expiresAt,
            createdAt=_now(),
        )
        self._messages.append(msg)
        return msg

    async def query_messages(self, query: MessageQuery) -> list[Message]:
        return _query_messages(
            self._messages, self._reads, self._members, self._tasks, query
        )

    async def list_team_messages(
        self, team_id: str, limit: int | None = None
    ) -> list[Message]:
        rows = sorted(
            (m for m in self._messages if m.teamId == team_id),
            key=lambda m: m.createdAt,
        )
        return rows[:limit] if limit else rows

    async def mark_read(self, agent_id: str, message_ids: list[str]) -> None:
        for message_id in message_ids:
            self._reads.add(_read_key(message_id, agent_id))

    async def mark_expired(self, before: datetime) -> int:
        count = 0
        for m in self._messages:
            if m.expiresAt and m.expiresAt < before and m.status != "expired":
                m.status = "expired"
                count += 1
        return count

    # --- Channels ---

    async def get_channel(self, channel_id: str) -> Channel | None:
        return self._channels.get(channel_id)

    async def create_channel(self, channel: Channel) -> Channel:
        full = channel.model_copy(update={"createdAt": _now()})
        self._channels[full.id] = full
        return full

    async def list_channels(self, team_id: str) -> list[Channel]:
        return [c for c in self._channels.values() if c.teamId == team_id]

    async def add_member(self, channel_id: str, agent_id: str) -> ChannelMember:
        existing = next(
            (
                m
                for m in self._members
                if m.channelId == channel_id and m.agentId == agent_id
            ),
            None,
        )
        if existing is not None:
            return existing
        member = ChannelMember(channelId=channel_id, agentId=agent_id, joinedAt=_now())
        self._members.append(member)
        return member

    async def remove_member(self, channel_id: str, agent_id: str) -> None:
        self._members = [
            m
            for m in self._members
            if not (m.channelId == channel_id and m.agentId == agent_id)
        ]

    async def get_members(self, channel_id: str) -> list[ChannelMember]:
        return [m for m in self._members if m.channelId == channel_id]

    async def get_memberships(self, agent_id: str) -> list[ChannelMember]:
        return [m for m in self._members if m.agentId == agent_id]

    # --- Tasks ---

    async def create_task(self, input: CreateTaskInput) -> Task:
        task_id = str(uuid.uuid4())
        now = _now()
        task = Task(
            id=task_id,
            teamId=input.teamId,
            channelId=f"task:{task_id}",
            requestorId=input.requestorId,
            assigneeId=input.assigneeId,
            title=input.title,
            description=input.description,
            state="submitted",
            metadata=input.metadata,
            createdAt=now,
            updatedAt=now,
        )
        self._tasks[task.id] = task
        return task

    async def get_task(self, task_id: str) -> Task | None:
        return self._tasks.get(task_id)

    async def update_task(self, task_id: str, input: UpdateTaskInput) -> Task:
        task = self._tasks.get(task_id)
        if task is None:
            raise ValueError(f"Task {task_id} not found")
        if input.state:
            task.state = input.state
        if input.metadata:
            task.metadata = {**(task.metadata or {}), **input.metadata}
        task.updatedAt = _now()
        return task

    async def list_tasks(self, team_id: str, agent_id: str | None = None) -> list[Task]:
        results = [t for t in self._tasks.values() if t.teamId == team_id]
        if agent_id:
            results = [
                t
                for t in results
                if t.assigneeId == agent_id or t.requestorId == agent_id
            ]
        return results

    # --- Agent Cards ---

    async def get_card(self, agent_id: str) -> AgentCard | None:
        return self._cards.get(agent_id)

    async def upsert_card(self, card: AgentCard) -> AgentCard:
        self._cards[card.id] = card
        return card

    async def list_cards(self, team_id: str) -> list[AgentCard]:
        # teamId rides on metadata; filter strictly so cards never leak across teams.
        return [c for c in self._cards.values() if _card_team_id(c) == team_id]

    # --- Auth ---

    async def create_token(self, token: AgentToken) -> AgentToken:
        self._tokens[token.token] = token
        return token

    async def get_token(self, token: str) -> AgentToken | None:
        return self._tokens.get(token)

    async def revoke_token(self, token: str) -> None:
        self._tokens.pop(token, None)


def _query_messages(
    messages: list[Message],
    reads: set[str],
    members: list[ChannelMember],
    tasks: dict[str, Task],
    query: MessageQuery,
) -> list[Message]:
    """Shared query/relevance logic (MemoryTransport and JsonFileTransport).

    Faithfully mirrors MemoryTransport.queryMessages: team filter, unread filter
    (per-recipient key + not-expired), channelType filter, then relevance — which
    ALWAYS excludes the agent's own messages, reconstructs directChannelId for
    direct relevance, treats every broadcast as relevant, gates group on
    membership, and gates task on requestor/assignee involvement.
    """
    results = [m for m in messages if m.teamId == query.teamId]

    if query.unreadOnly:
        results = [
            m
            for m in results
            if m.status != "expired" and _read_key(m.id, query.agentId) not in reads
        ]

    if query.channelType:
        results = [m for m in results if m.channelType == query.channelType]

    results = [m for m in results if _is_relevant(m, query.agentId, members, tasks)]

    results.sort(key=lambda m: m.createdAt)

    if query.limit:
        results = results[: query.limit]

    return results


def _is_relevant(
    m: Message,
    agent_id: str,
    members: list[ChannelMember],
    tasks: dict[str, Task],
) -> bool:
    if m.fromAgentId == agent_id:
        return False  # Don't show own messages
    if m.channelType == "direct":
        return m.channelId == direct_channel_id(agent_id, m.fromAgentId)
    if m.channelType == "broadcast":
        return True
    if m.channelType == "group":
        return any(
            mb.channelId == m.channelId and mb.agentId == agent_id for mb in members
        )
    if m.channelType == "task":
        for t in tasks.values():
            if m.channelId == f"task:{t.id}" and agent_id in (
                t.assigneeId,
                t.requestorId,
            ):
                return True
        return False
    return False

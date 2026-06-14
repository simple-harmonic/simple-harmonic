"""JSON-file transport adapter for a2ax.

TS source: packages/a2ax/src/adapters/json-file.ts

Stores each team's communication state under that team's folder in the recursive
data tree::

    <teamDir>/messages/
    ├─ log.jsonl      messages (append; rewritten on bulk expiry)
    ├─ reads.jsonl    per-recipient read receipts (append)
    ├─ channels.json  members.json  tasks.json   (rewritten on change)
    └─ cards.json     tokens.json

Query/relevance logic is identical to MemoryTransport: the adapter holds the
state in memory (hydrated once by walking the team tree) so the methods that
arrive without a teamId — markRead, getTask, getToken, … — resolve in O(1), and
writes are mirrored through to the owning team's files. Single-process,
single-writer, like the rest of the file store.

Blocking fs work is dispatched off the event loop via `anyio.to_thread`.
Date strings are re-coerced to datetime on load by Pydantic `model_validate`.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path

import anyio

from simple_harmonic.a2ax import file_store as fstore
from simple_harmonic.a2ax.channel import Channel, ChannelMember
from simple_harmonic.a2ax.message import CreateMessageInput, Message
from simple_harmonic.a2ax.task import CreateTaskInput, Task, UpdateTaskInput
from simple_harmonic.a2ax.token import AgentToken
from simple_harmonic.a2ax.transport import (
    MessageQuery,
    _card_team_id,
    _query_messages,
    _read_key,
)
from simple_harmonic.a2ax.types import AgentCard


def _now() -> datetime:
    return datetime.now(UTC)


def _dump(model: object) -> dict[str, object]:
    """Serialize a Pydantic model to JSON-safe dict (ISO datetimes, aliases)."""
    return model.model_dump(mode="json", by_alias=True)  # type: ignore[attr-defined]


class JsonFileTransport:
    """Concrete `Transport` backed by JSON files on the recursive team tree.

    TS source: adapters/json-file.ts. Implements the Transport protocol; the
    query/relevance logic is shared with MemoryTransport via `_query_messages`.
    """

    def __init__(self, teams_root: str | Path) -> None:
        """:param teams_root: absolute path to <dataDir>/teams."""
        self._teams_root = Path(teams_root)
        self._messages: list[Message] = []
        self._reads: set[str] = set()  # `${messageId}:${agentId}`
        self._channels: dict[str, Channel] = {}
        self._members: list[ChannelMember] = []
        self._tasks: dict[str, Task] = {}
        self._cards: dict[str, AgentCard] = {}
        self._tokens: dict[str, AgentToken] = {}

        self._team_dirs: dict[str, Path] = {}  # teamId -> messages dir
        self._loaded: set[Path] = set()  # dirs already read into memory
        self._hydrated = False

    # --- Hydration + path resolution -----------------------------------------

    def _hydrate(self) -> None:
        if self._hydrated:
            return
        self._team_dirs = fstore.discover_team_message_dirs(self._teams_root)
        for directory in self._team_dirs.values():
            self._load_dir(directory)
        self._hydrated = True

    def _load_dir(self, directory: Path) -> None:
        if directory in self._loaded:
            return
        self._loaded.add(directory)
        for raw in fstore.read_jsonl(directory / "log.jsonl"):
            self._messages.append(Message.model_validate(raw))
        for raw in fstore.read_jsonl(directory / "reads.jsonl"):
            self._reads.add(_read_key(raw["messageId"], raw["agentId"]))
        for raw in fstore.read_json(directory / "channels.json", []):
            ch = Channel.model_validate(raw)
            self._channels[ch.id] = ch
        for raw in fstore.read_json(directory / "members.json", []):
            self._members.append(ChannelMember.model_validate(raw))
        for raw in fstore.read_json(directory / "tasks.json", []):
            t = Task.model_validate(raw)
            self._tasks[t.id] = t
        for raw in fstore.read_json(directory / "cards.json", []):
            c = AgentCard.model_validate(raw)
            self._cards[c.id] = c
        for raw in fstore.read_json(directory / "tokens.json", []):
            tok = AgentToken.model_validate(raw)
            self._tokens[tok.token] = tok

    def _dir_for_team(self, team_id: str) -> Path:
        """Resolve a team's messages dir, re-walking once if it appeared late."""
        directory = self._team_dirs.get(team_id)
        if directory is None:
            self._team_dirs = fstore.discover_team_message_dirs(self._teams_root)
            directory = self._team_dirs.get(team_id)
            if directory is not None:
                self._load_dir(directory)
        if directory is None:
            raise ValueError(
                f"a2ax: team {team_id} folder not found under {self._teams_root}"
            )
        return directory

    # --- Per-collection persistence (filter memory by team, rewrite file) -----

    def _persist_channels(self, team_id: str) -> None:
        fstore.write_json(
            self._dir_for_team(team_id) / "channels.json",
            [_dump(c) for c in self._channels.values() if c.teamId == team_id],
        )

    def _persist_members(self, team_id: str) -> None:
        rows = [
            m
            for m in self._members
            if (ch := self._channels.get(m.channelId)) is not None
            and ch.teamId == team_id
        ]
        fstore.write_json(
            self._dir_for_team(team_id) / "members.json", [_dump(m) for m in rows]
        )

    def _persist_tasks(self, team_id: str) -> None:
        fstore.write_json(
            self._dir_for_team(team_id) / "tasks.json",
            [_dump(t) for t in self._tasks.values() if t.teamId == team_id],
        )

    def _persist_cards(self, team_id: str) -> None:
        fstore.write_json(
            self._dir_for_team(team_id) / "cards.json",
            [_dump(c) for c in self._cards.values() if _card_team_id(c) == team_id],
        )

    def _persist_tokens(self, team_id: str) -> None:
        fstore.write_json(
            self._dir_for_team(team_id) / "tokens.json",
            [_dump(t) for t in self._tokens.values() if t.teamId == team_id],
        )

    # --- Messages ------------------------------------------------------------

    async def insert_message(self, input: CreateMessageInput) -> Message:
        return await anyio.to_thread.run_sync(self._insert_message_sync, input)

    def _insert_message_sync(self, input: CreateMessageInput) -> Message:
        self._hydrate()
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
        fstore.append_jsonl(self._dir_for_team(input.teamId) / "log.jsonl", _dump(msg))
        return msg

    async def query_messages(self, query: MessageQuery) -> list[Message]:
        return await anyio.to_thread.run_sync(self._query_messages_sync, query)

    def _query_messages_sync(self, query: MessageQuery) -> list[Message]:
        self._hydrate()
        return _query_messages(
            self._messages, self._reads, self._members, self._tasks, query
        )

    async def list_team_messages(
        self, team_id: str, limit: int | None = None
    ) -> list[Message]:
        return await anyio.to_thread.run_sync(
            self._list_team_messages_sync, team_id, limit
        )

    def _list_team_messages_sync(
        self, team_id: str, limit: int | None
    ) -> list[Message]:
        self._hydrate()
        rows = sorted(
            (m for m in self._messages if m.teamId == team_id),
            key=lambda m: m.createdAt,
        )
        return rows[:limit] if limit else rows

    async def mark_read(self, agent_id: str, message_ids: list[str]) -> None:
        await anyio.to_thread.run_sync(self._mark_read_sync, agent_id, message_ids)

    def _mark_read_sync(self, agent_id: str, message_ids: list[str]) -> None:
        self._hydrate()
        for message_id in message_ids:
            key = _read_key(message_id, agent_id)
            if key in self._reads:
                continue
            self._reads.add(key)
            msg = next((m for m in self._messages if m.id == message_id), None)
            if msg is not None:
                fstore.append_jsonl(
                    self._dir_for_team(msg.teamId) / "reads.jsonl",
                    {
                        "messageId": message_id,
                        "agentId": agent_id,
                        "readAt": _now().isoformat(),
                    },
                )

    async def mark_expired(self, before: datetime) -> int:
        return await anyio.to_thread.run_sync(self._mark_expired_sync, before)

    def _mark_expired_sync(self, before: datetime) -> int:
        self._hydrate()
        affected: set[str] = set()
        count = 0
        for m in self._messages:
            if m.expiresAt and m.expiresAt < before and m.status != "expired":
                m.status = "expired"
                affected.add(m.teamId)
                count += 1
        for team_id in affected:
            fstore.rewrite_jsonl(
                self._dir_for_team(team_id) / "log.jsonl",
                [_dump(m) for m in self._messages if m.teamId == team_id],
            )
        return count

    # --- Channels ------------------------------------------------------------

    async def get_channel(self, channel_id: str) -> Channel | None:
        return await anyio.to_thread.run_sync(self._get_channel_sync, channel_id)

    def _get_channel_sync(self, channel_id: str) -> Channel | None:
        self._hydrate()
        return self._channels.get(channel_id)

    async def create_channel(self, channel: Channel) -> Channel:
        return await anyio.to_thread.run_sync(self._create_channel_sync, channel)

    def _create_channel_sync(self, channel: Channel) -> Channel:
        self._hydrate()
        full = channel.model_copy(update={"createdAt": _now()})
        self._channels[full.id] = full
        self._persist_channels(full.teamId)
        return full

    async def list_channels(self, team_id: str) -> list[Channel]:
        return await anyio.to_thread.run_sync(self._list_channels_sync, team_id)

    def _list_channels_sync(self, team_id: str) -> list[Channel]:
        self._hydrate()
        return [c for c in self._channels.values() if c.teamId == team_id]

    async def add_member(self, channel_id: str, agent_id: str) -> ChannelMember:
        return await anyio.to_thread.run_sync(
            self._add_member_sync, channel_id, agent_id
        )

    def _add_member_sync(self, channel_id: str, agent_id: str) -> ChannelMember:
        self._hydrate()
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
        ch = self._channels.get(channel_id)
        if ch is not None:
            self._persist_members(ch.teamId)
        return member

    async def remove_member(self, channel_id: str, agent_id: str) -> None:
        await anyio.to_thread.run_sync(self._remove_member_sync, channel_id, agent_id)

    def _remove_member_sync(self, channel_id: str, agent_id: str) -> None:
        self._hydrate()
        ch = self._channels.get(channel_id)
        self._members = [
            m
            for m in self._members
            if not (m.channelId == channel_id and m.agentId == agent_id)
        ]
        if ch is not None:
            self._persist_members(ch.teamId)

    async def get_members(self, channel_id: str) -> list[ChannelMember]:
        return await anyio.to_thread.run_sync(self._get_members_sync, channel_id)

    def _get_members_sync(self, channel_id: str) -> list[ChannelMember]:
        self._hydrate()
        return [m for m in self._members if m.channelId == channel_id]

    async def get_memberships(self, agent_id: str) -> list[ChannelMember]:
        return await anyio.to_thread.run_sync(self._get_memberships_sync, agent_id)

    def _get_memberships_sync(self, agent_id: str) -> list[ChannelMember]:
        self._hydrate()
        return [m for m in self._members if m.agentId == agent_id]

    # --- Tasks ---------------------------------------------------------------

    async def create_task(self, input: CreateTaskInput) -> Task:
        return await anyio.to_thread.run_sync(self._create_task_sync, input)

    def _create_task_sync(self, input: CreateTaskInput) -> Task:
        self._hydrate()
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
        self._persist_tasks(input.teamId)
        return task

    async def get_task(self, task_id: str) -> Task | None:
        return await anyio.to_thread.run_sync(self._get_task_sync, task_id)

    def _get_task_sync(self, task_id: str) -> Task | None:
        self._hydrate()
        return self._tasks.get(task_id)

    async def update_task(self, task_id: str, input: UpdateTaskInput) -> Task:
        return await anyio.to_thread.run_sync(self._update_task_sync, task_id, input)

    def _update_task_sync(self, task_id: str, input: UpdateTaskInput) -> Task:
        self._hydrate()
        task = self._tasks.get(task_id)
        if task is None:
            raise ValueError(f"Task {task_id} not found")
        if input.state:
            task.state = input.state
        if input.metadata:
            task.metadata = {**(task.metadata or {}), **input.metadata}
        task.updatedAt = _now()
        self._persist_tasks(task.teamId)
        return task

    async def list_tasks(self, team_id: str, agent_id: str | None = None) -> list[Task]:
        return await anyio.to_thread.run_sync(self._list_tasks_sync, team_id, agent_id)

    def _list_tasks_sync(self, team_id: str, agent_id: str | None) -> list[Task]:
        self._hydrate()
        results = [t for t in self._tasks.values() if t.teamId == team_id]
        if agent_id:
            results = [
                t
                for t in results
                if t.assigneeId == agent_id or t.requestorId == agent_id
            ]
        return results

    # --- Agent Cards ---------------------------------------------------------

    async def get_card(self, agent_id: str) -> AgentCard | None:
        return await anyio.to_thread.run_sync(self._get_card_sync, agent_id)

    def _get_card_sync(self, agent_id: str) -> AgentCard | None:
        self._hydrate()
        return self._cards.get(agent_id)

    async def upsert_card(self, card: AgentCard) -> AgentCard:
        return await anyio.to_thread.run_sync(self._upsert_card_sync, card)

    def _upsert_card_sync(self, card: AgentCard) -> AgentCard:
        self._hydrate()
        self._cards[card.id] = card
        team_id = _card_team_id(card)
        if isinstance(team_id, str):
            self._persist_cards(team_id)
        return card

    async def list_cards(self, team_id: str) -> list[AgentCard]:
        return await anyio.to_thread.run_sync(self._list_cards_sync, team_id)

    def _list_cards_sync(self, team_id: str) -> list[AgentCard]:
        self._hydrate()
        return [c for c in self._cards.values() if _card_team_id(c) == team_id]

    # --- Auth ----------------------------------------------------------------

    async def create_token(self, token: AgentToken) -> AgentToken:
        return await anyio.to_thread.run_sync(self._create_token_sync, token)

    def _create_token_sync(self, token: AgentToken) -> AgentToken:
        self._hydrate()
        self._tokens[token.token] = token
        self._persist_tokens(token.teamId)
        return token

    async def get_token(self, token: str) -> AgentToken | None:
        return await anyio.to_thread.run_sync(self._get_token_sync, token)

    def _get_token_sync(self, token: str) -> AgentToken | None:
        self._hydrate()
        return self._tokens.get(token)

    async def revoke_token(self, token: str) -> None:
        await anyio.to_thread.run_sync(self._revoke_token_sync, token)

    def _revoke_token_sync(self, token: str) -> None:
        self._hydrate()
        t = self._tokens.get(token)
        self._tokens.pop(token, None)
        if t is not None:
            self._persist_tokens(t.teamId)

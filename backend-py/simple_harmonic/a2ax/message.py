"""Message envelope + a2ax channel extensions.

TS source: packages/a2ax/src/types/message.ts
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ChannelType = Literal["direct", "broadcast", "group", "task"]
MessageStatus = Literal["pending", "delivered", "read", "expired"]
MessageRole = Literal["agent", "meta", "system", "user"]
GeneralKind = Literal["text", "data", "artifact", "ack", "error"]
TaskKind = Literal[
    "task.create",
    "task.accept",
    "task.status",
    "task.input_required",
    "task.result",
    "task.cancel",
    "task.reject",
]
SystemKind = Literal["system.join", "system.leave", "system.created"]
# MessageKind = GeneralKind | TaskKind | SystemKind. Left as plain str on the
# model so the union of literals does not over-constrain round-tripping.
MessageKind = str


class Part(BaseModel):
    """A unit of content (A2A-compatible). Exactly one content field expected."""

    model_config = ConfigDict(populate_by_name=True)

    text: str | None = None
    raw: str | None = None
    url: str | None = None
    data: dict[str, object] | None = None
    mediaType: str | None = None
    filename: str | None = None
    metadata: dict[str, object] | None = None


class Artifact(BaseModel):
    """A named collection of output parts."""

    model_config = ConfigDict(populate_by_name=True)

    artifactId: str
    name: str | None = None
    description: str | None = None
    parts: list[Part] = Field(default_factory=list)
    metadata: dict[str, object] | None = None


class Message(BaseModel):
    """The core message envelope."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    teamId: str
    channelType: ChannelType
    channelId: str
    fromAgentId: str
    role: MessageRole = "agent"
    kind: MessageKind = "text"
    content: str
    parts: list[Part] | None = None
    artifacts: list[Artifact] | None = None
    payload: dict[str, object] | None = None
    replyTo: str | None = None
    status: MessageStatus = "pending"
    urgent: bool | None = None
    expiresAt: datetime | None = None
    createdAt: datetime


class CreateMessageInput(BaseModel):
    """Input for creating a new message (Transport.insertMessage)."""

    model_config = ConfigDict(populate_by_name=True)

    teamId: str
    channelType: ChannelType
    channelId: str
    fromAgentId: str
    role: MessageRole | None = None
    kind: MessageKind
    content: str
    parts: list[Part] | None = None
    artifacts: list[Artifact] | None = None
    payload: dict[str, object] | None = None
    replyTo: str | None = None
    urgent: bool | None = None
    expiresAt: datetime | None = None

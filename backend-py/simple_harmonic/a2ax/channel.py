"""Channel types + deterministic channel-ID helpers.

TS source: packages/a2ax/src/types/channel.ts
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict

from simple_harmonic.a2ax.message import ChannelType


class Channel(BaseModel):
    """A communication channel. createChannel stamps createdAt server-side."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    teamId: str
    channelType: ChannelType
    name: str | None = None
    metadata: dict[str, object] | None = None
    createdAt: datetime


class ChannelMember(BaseModel):
    """Channel membership. Identity is the (channelId, agentId) pair."""

    model_config = ConfigDict(populate_by_name=True)

    channelId: str
    agentId: str
    joinedAt: datetime


def direct_channel_id(agent_a: str, agent_b: str) -> str:
    """Deterministic direct channel id from two agent ids (sorted)."""
    first, second = sorted([agent_a, agent_b])
    return f"direct:{first}:{second}"


def broadcast_channel_id(team_id: str) -> str:
    return f"team:{team_id}"


def group_channel_id(group_id: str) -> str:
    return f"group:{group_id}"


def task_channel_id(task_id: str) -> str:
    return f"task:{task_id}"

"""a2ax (A2A-Extended) core types, ported as Pydantic v2 models.

TS source: packages/a2ax/src/types/*.ts

These model the on-the-wire / in-memory protocol shapes faithfully. Field names
stay camelCase to match the TS JSON exactly (so frontend + cross-runtime parity
holds). Channel-ID helpers and the task-transition table are ported as plain
functions/constants.
"""

from __future__ import annotations

from simple_harmonic.a2ax.channel import (
    Channel,
    ChannelMember,
    broadcast_channel_id,
    direct_channel_id,
    group_channel_id,
    task_channel_id,
)
from simple_harmonic.a2ax.json_file_transport import JsonFileTransport
from simple_harmonic.a2ax.message import (
    Artifact,
    ChannelType,
    CreateMessageInput,
    GeneralKind,
    Message,
    MessageRole,
    MessageStatus,
    Part,
    SystemKind,
    TaskKind,
)
from simple_harmonic.a2ax.protocol import (
    A2AX,
    A2AXOptions,
    AgentContext,
)
from simple_harmonic.a2ax.task import (
    TASK_TRANSITIONS,
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
from simple_harmonic.a2ax.transport import (
    MemoryTransport,
    MessageQuery,
    Transport,
)
from simple_harmonic.a2ax.types import (
    AgentCapabilities,
    AgentCard,
    AgentCardSignature,
    AgentProvider,
    AgentSkill,
    OAuthFlow,
    OAuthFlows,
    SecurityScheme,
    create_agent_card,
)

__all__ = [
    "A2AX",
    "DEFAULT_SCOPES",
    "TASK_TRANSITIONS",
    "A2AXOptions",
    "AgentCapabilities",
    "AgentCard",
    "AgentCardSignature",
    "AgentContext",
    "AgentProvider",
    "AgentSkill",
    "AgentToken",
    "Artifact",
    "Channel",
    "ChannelMember",
    "ChannelType",
    "CreateMessageInput",
    "CreateTaskInput",
    "GeneralKind",
    "JsonFileTransport",
    "MemoryTransport",
    "Message",
    "MessageQuery",
    "MessageRole",
    "MessageStatus",
    "OAuthFlow",
    "OAuthFlows",
    "Part",
    "Scope",
    "SecurityScheme",
    "SystemKind",
    "Task",
    "TaskKind",
    "TaskState",
    "Transport",
    "UpdateTaskInput",
    "broadcast_channel_id",
    "create_agent_card",
    "direct_channel_id",
    "generate_token",
    "group_channel_id",
    "has_scope",
    "is_valid_transition",
    "task_channel_id",
]

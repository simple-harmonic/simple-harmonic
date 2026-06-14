"""Row shapes for the JSON file store, as Pydantic models.

TS source: packages/backend/src/server/store/types.ts

Field names + camelCase + datetime-vs-str distinctions match the TS rows, so
Response JSON is byte-identical (datetimes serialize to ISO-8601 strings).
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

AgentStatus = Literal["running", "paused", "errored", "awaiting_approval"]
ApprovalStatus = Literal["pending", "approved", "rejected"]
AppEventSeverity = Literal["info", "warning", "error"]
AppEventLevel = Literal["agent", "team", "tool", "infra"]
PlatformStatusValue = Literal["healthy", "degraded", "maintenance"]


class Team(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    parentTeamId: str | None = None
    name: str
    goal: str | None = None
    paused: bool = False
    tickCount: int = 0
    metaAgentPrompt: str | None = None
    cofounderName: str | None = None
    telemetryEnabled: bool = True
    lastUserActiveAt: datetime
    createdAt: datetime


class Agent(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    teamId: str
    name: str
    role: str
    archetype: str
    tools: list[str] = Field(default_factory=list)
    scheduleSeconds: int
    initialPrompt: str
    outputContract: dict[str, object] | None = None
    status: AgentStatus = "running"
    nextRunAt: datetime | None = None
    inFlight: bool = False
    conversationState: dict[str, object] | None = None
    createdAt: datetime


class PendingApproval(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    teamId: str
    agentId: str
    toolCallId: str
    toolName: str
    toolArguments: str
    status: ApprovalStatus = "pending"
    decisionNote: str | None = None
    createdAt: datetime
    resolvedAt: datetime | None = None


class AppEvent(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    teamId: str | None = None
    agentId: str | None = None
    severity: AppEventSeverity
    level: AppEventLevel
    source: str
    message: str
    metadata: dict[str, object] | None = None
    acknowledgedAt: datetime | None = None
    createdAt: datetime


class PlatformStatus(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: int = 1
    status: PlatformStatusValue
    message: str | None = None
    updatedAt: datetime


class ActionLogEntry(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    agentId: str
    metaAgentApprovalId: str | None = None
    actionType: str
    payload: dict[str, object] = Field(default_factory=dict)
    executedAt: datetime


class AgentTraceEvent(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    teamId: str
    agentId: str
    tickId: str
    seq: int
    type: str
    data: dict[str, object] = Field(default_factory=dict)
    emittedAt: datetime
    createdAt: datetime


class LlmSpendEntry(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    teamId: str | None = None
    agentId: str | None = None
    model: str
    inputTokens: int
    outputTokens: int
    costCents: float
    day: str  # UTC YYYY-MM-DD
    createdAt: datetime


class ApiToolConfig(BaseModel):
    """Shape of .simple-harmonic/skills/<name>.json config field.

    TS source: types.ts ApiToolConfig. No longer backed by any table.
    """

    model_config = ConfigDict(populate_by_name=True)

    baseUrl: str
    connectorKey: str
    authHeader: str | None = None
    authPrefix: str | None = None
    allowedMethods: list[str] = Field(default_factory=list)
    defaultHeaders: dict[str, str] | None = None
    pathPrefix: str | None = None

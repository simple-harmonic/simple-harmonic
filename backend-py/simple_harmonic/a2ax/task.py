"""Task lifecycle types + transition table.

TS source: packages/a2ax/src/types/task.ts
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

TaskState = Literal[
    "submitted",
    "accepted",
    "working",
    "input_required",
    "completed",
    "failed",
    "canceled",
    "rejected",
]


class Task(BaseModel):
    """A structured work request between agents."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    teamId: str
    channelId: str
    requestorId: str
    assigneeId: str
    title: str
    description: str
    state: TaskState = "submitted"
    metadata: dict[str, object] | None = None
    createdAt: datetime
    updatedAt: datetime


class CreateTaskInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    teamId: str
    requestorId: str
    assigneeId: str
    title: str
    description: str
    metadata: dict[str, object] | None = None


class UpdateTaskInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    state: TaskState | None = None
    metadata: dict[str, object] | None = None


# Valid task-state transitions (terminal states map to []).
TASK_TRANSITIONS: dict[TaskState, list[TaskState]] = {
    "submitted": ["accepted", "rejected", "canceled"],
    "accepted": ["working", "canceled"],
    "working": ["input_required", "completed", "failed", "canceled"],
    "input_required": ["working", "canceled"],
    "completed": [],
    "failed": [],
    "canceled": [],
    "rejected": [],
}


def is_valid_transition(from_state: TaskState, to_state: TaskState) -> bool:
    return to_state in TASK_TRANSITIONS[from_state]

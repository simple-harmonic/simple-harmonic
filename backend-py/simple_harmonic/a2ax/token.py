"""Agent auth tokens + scopes.

TS source: packages/a2ax/src/types/auth.ts
"""

from __future__ import annotations

import secrets
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Scope = Literal[
    "message:send",
    "message:read",
    "task:create",
    "task:update",
    "task:cancel",
    "broadcast:send",
    "group:join",
    "group:leave",
    "group:send",
    "group:create",
    "card:read",
    "card:write",
    "admin",
]

# The 8-item default scope set issued to team-internal agents.
DEFAULT_SCOPES: tuple[Scope, ...] = (
    "message:send",
    "message:read",
    "task:create",
    "task:update",
    "broadcast:send",
    "group:join",
    "group:send",
    "card:read",
)


class AgentToken(BaseModel):
    """A bearer token issued to an agent at spawn time."""

    model_config = ConfigDict(populate_by_name=True)

    agentId: str
    teamId: str
    token: str
    scopes: list[str] = Field(default_factory=lambda: list(DEFAULT_SCOPES))
    expiresAt: datetime | None = None
    createdAt: datetime


def has_scope(token: AgentToken, scope: Scope) -> bool:
    """True if the token carries the scope OR the wildcard 'admin' scope."""
    return scope in token.scopes or "admin" in token.scopes


def generate_token() -> str:
    """32 random bytes as lowercase hex (matches the TS generateToken())."""
    return secrets.token_hex(32)

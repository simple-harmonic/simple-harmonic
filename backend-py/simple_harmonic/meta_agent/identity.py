"""Fixed identity sentinels for the cofounder + human participants.

TS source: packages/backend/src/lib/meta-agent/identity.ts

The AI cofounder and human users participate in agent messaging via fixed
sentinel UUIDs so they can send/receive direct messages and tasks like any other
agent. The route layer translates the POV sentinels ("cofounder"/"user") to the
real UUIDs before querying.
"""

from __future__ import annotations

from dataclasses import dataclass

# All-zeros except the "c0f0" tail for easy recognition in logs.
COFOUNDER_AGENT_ID = "00000000-0000-0000-0000-00000000c0f0"
# Default cofounder display name. Each team can override via teams.cofounderName.
DEFAULT_COFOUNDER_NAME = "Harmon"

# Primary "You" human identity ("fffe" tail).
PRIMARY_USER_AGENT_ID = "00000000-0000-0000-0000-00000000fffe"
PRIMARY_USER_DISPLAY_NAME = "You"

# Back-compat aliases (legacy single-user API surface).
USER_AGENT_ID = PRIMARY_USER_AGENT_ID
USER_DISPLAY_NAME = PRIMARY_USER_DISPLAY_NAME

# POV sentinels used by the messaging view; APIs translate these to real UUIDs.
COFOUNDER_POV = "cofounder"
USER_POV = "user"


@dataclass(frozen=True, slots=True)
class HumanParticipant:
    id: str
    name: str


def get_team_humans(_team_id: str) -> list[HumanParticipant]:
    """The humans associated with a team. v0.0 ships a fixed singleton."""
    return [HumanParticipant(id=PRIMARY_USER_AGENT_ID, name=PRIMARY_USER_DISPLAY_NAME)]


def resolve_cofounder_name(team_cofounder_name: str | None) -> str:
    return (team_cofounder_name or "").strip() or DEFAULT_COFOUNDER_NAME

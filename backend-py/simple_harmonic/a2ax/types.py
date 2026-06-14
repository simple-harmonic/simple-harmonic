"""Agent Card (A2A-spec compliant) + nested OpenAPI-flavored shapes.

TS source: packages/a2ax/src/types/agent-card.ts
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class AgentCapabilities(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    streaming: bool
    pushNotifications: bool
    extendedAgentCard: bool
    broadcast: bool | None = None
    groups: bool | None = None
    tasks: bool | None = None


class AgentSkill(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    description: str | None = None
    inputSchema: dict[str, object] | None = None
    outputSchema: dict[str, object] | None = None
    acceptedMediaTypes: list[str] | None = None


class AgentProvider(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str
    url: str | None = None
    contact: str | None = None


class OAuthFlow(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    authorizationUrl: str | None = None
    tokenUrl: str
    refreshUrl: str | None = None
    scopes: dict[str, str] = Field(default_factory=dict)


class OAuthFlows(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    authorizationCode: OAuthFlow | None = None
    clientCredentials: OAuthFlow | None = None
    deviceCode: OAuthFlow | None = None


class SecurityScheme(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["apiKey", "http", "oauth2", "openIdConnect", "mutualTls"]
    name: str | None = None
    in_: Literal["header", "query"] | None = Field(default=None, alias="in")
    scheme: str | None = None
    bearerFormat: str | None = None
    flows: OAuthFlows | None = None
    openIdConnectUrl: str | None = None
    certificateUrl: str | None = None
    description: str | None = None


class AgentCardSignature(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    algorithm: str
    signature: str
    keyId: str | None = None


class AgentCard(BaseModel):
    """The full Agent Card. teamId is NOT a field (smuggled in metadata.teamId)."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    description: str | None = None
    provider: AgentProvider | None = None
    endpoint: str
    capabilities: AgentCapabilities
    skills: list[AgentSkill] = Field(default_factory=list)
    securitySchemes: dict[str, SecurityScheme] | None = None
    security: list[dict[str, list[str]]] | None = None
    signature: AgentCardSignature | None = None
    metadata: dict[str, object] | None = None


def create_agent_card(
    *,
    id: str,
    name: str,
    endpoint: str,
    description: str | None = None,
    provider: AgentProvider | None = None,
    capabilities: AgentCapabilities | None = None,
    skills: list[AgentSkill] | None = None,
    securitySchemes: dict[str, SecurityScheme] | None = None,
    security: list[dict[str, list[str]]] | None = None,
    signature: AgentCardSignature | None = None,
    metadata: dict[str, object] | None = None,
) -> AgentCard:
    """Create a minimal agent card with the TS createAgentCard() defaults."""
    return AgentCard(
        id=id,
        name=name,
        endpoint=endpoint,
        description=description,
        provider=provider,
        capabilities=capabilities
        or AgentCapabilities(
            streaming=False,
            pushNotifications=False,
            extendedAgentCard=False,
            broadcast=True,
            groups=True,
            tasks=True,
        ),
        skills=skills if skills is not None else [],
        securitySchemes=securitySchemes,
        security=security,
        signature=signature,
        metadata=metadata,
    )

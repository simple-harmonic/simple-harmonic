"""Planner — Harmon's onboarding conversation backend.

TS source: packages/backend/src/lib/meta-agent/planner.ts

``planner_stream`` runs the cofounder (Harmon) conversation: it streams assistant
tokens via an ``on_token`` callback while accumulating one optional tool call,
then returns a :data:`~simple_harmonic.meta_agent.types.PlannerResult` — a
discriminated union on ``type`` (``message`` / ``spawn`` / ``modify_agent`` /
``request_credential``). A malformed tool-call argument string degrades to a
plain ``message`` (never raises).

Two backend paths, picked by ``deps.api_key_source``:
  * "codex"  -> the ChatGPT-subscription Responses SSE endpoint, via the injected
    proxy-aware ``deps.fetch_impl``.
  * anything else -> OpenAI Chat Completions streaming, via the OpenAI SDK.

Dependency injection (matching the TS ``PlannerDeps``)
------------------------------------------------------
The planner is library-core: it must not import the server config/auth modules
directly. The caller resolves config + auth + a proxy-aware fetch and passes them
in. For the OpenAI path the SDK client is built through the pluggable module hook
:data:`openai_client_factory` (the same seam pattern as
:mod:`simple_harmonic.llm.candidates`), so tests override it with a fake
streaming client and never touch the network.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from simple_harmonic.meta_agent.default_prompt import DEFAULT_META_AGENT_PROMPT
from simple_harmonic.meta_agent.types import (
    MessageResult,
    ModifyAgentResult,
    ModifyAgentResultEnvelope,
    PlannerMessage,
    PlannerResult,
    RequestCredentialResult,
    SpawnResult,
    SpawnTeamResult,
)

__all__ = [
    "DEFAULT_META_AGENT_PROMPT",
    "PlannerConfig",
    "PlannerDeps",
    "PlannerResponse",
    "openai_client_factory",
    "planner_stream",
]

CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"


# ---------------------------------------------------------------------------
# Tool definitions (shared between both paths)
# ---------------------------------------------------------------------------

SPAWN_TOOL_DEF: dict[str, Any] = {
    "name": "spawn_team",
    "description": (
        "Spawn a team of agents. Can be a root team or a sub-team of an existing "
        "team. Call this when you and the founder have aligned on a team composition."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "team_name": {
                "type": "string",
                "description": (
                    "Short, human-friendly team name derived from the company or "
                    "focus area (e.g., 'Acme Studio', 'Newsletter Ops', 'Indie "
                    "Launch'). 1-4 words. NOT auto-generated from archetypes."
                ),
            },
            "parent_team": {
                "type": "string",
                "description": (
                    "Optional. Name of the existing parent team to nest this team "
                    "under. Omit for a root team."
                ),
            },
            "cofounder_name": {
                "type": "string",
                "description": (
                    "Optional. The name the founder wants to call you (their AI "
                    "cofounder). Default is 'Harmon'. Only set if the founder "
                    "explicitly named you during the conversation."
                ),
            },
            "agents": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "Kebab-case agent name"},
                        "role": {"type": "string", "description": "One-line role description"},
                        "archetype": {
                            "type": "string",
                            "description": (
                                "Free-form archetype describing the agent's function "
                                "(e.g. 'bug-hunter', 'content-scheduler', "
                                "'deploy-monitor', 'sales-analyst'). Not limited to a "
                                "preset list."
                            ),
                        },
                        "tools": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Tool names this agent can use",
                        },
                        "schedule_seconds": {
                            "type": "number",
                            "description": (
                                "How often this agent wakes up and acts, in seconds. "
                                "Typical values: 300 (5 min) for monitors, 600 (10 "
                                "min) for content/ops, 1800 (30 min) for research. "
                                "Range: 60-3600. Do NOT use 86400 (daily)."
                            ),
                        },
                        "initial_prompt": {
                            "type": "string",
                            "description": "System prompt for this agent",
                        },
                    },
                    "required": [
                        "name",
                        "role",
                        "archetype",
                        "tools",
                        "schedule_seconds",
                        "initial_prompt",
                    ],
                },
            },
        },
        "required": ["team_name", "agents"],
    },
}

MODIFY_AGENT_TOOL_DEF: dict[str, Any] = {
    "name": "modify_agent",
    "description": (
        "Modify an existing agent's configuration. Use this to add/remove tools, "
        "update the system prompt, change the schedule, or pause/resume an agent."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "agent_name": {
                "type": "string",
                "description": (
                    "Name of the agent to modify (e.g. 'bug-hunter', "
                    "'content-scheduler')."
                ),
            },
            "team_name": {
                "type": "string",
                "description": (
                    "Team the agent belongs to. Required to disambiguate if the same "
                    "agent name exists in multiple teams."
                ),
            },
            "updates": {
                "type": "object",
                "properties": {
                    "tools": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "Replace the agent's full tool list. Include all tools the "
                            "agent should have, not just the new ones."
                        ),
                    },
                    "initial_prompt": {
                        "type": "string",
                        "description": "Replace the agent's system prompt.",
                    },
                    "schedule_seconds": {
                        "type": "number",
                        "description": "Change how often the agent runs, in seconds.",
                    },
                    "status": {
                        "type": "string",
                        "enum": ["running", "paused"],
                        "description": "Pause or resume the agent.",
                    },
                    "role": {
                        "type": "string",
                        "description": "Update the agent's role description.",
                    },
                    "output_contract": {
                        "type": "object",
                        "description": (
                            "JSON Schema defining the agent's expected output "
                            "structure. The agent's report_action payload is validated "
                            "against this each tick. Example: "
                            '{"type":"object","required":["bugs"],"properties":'
                            '{"bugs":{"type":"array","items":{"type":"object",'
                            '"required":["file","description","severity"],'
                            '"properties":{"file":{"type":"string"},'
                            '"description":{"type":"string"},'
                            '"severity":{"type":"string"}}}}}}'
                        ),
                    },
                },
            },
        },
        "required": ["agent_name", "team_name", "updates"],
    },
}

REQUEST_CREDENTIAL_TOOL_DEF: dict[str, Any] = {
    "name": "request_credential",
    "description": (
        "Request a credential (API key, token, secret) from the founder. Use this "
        "when you identify that the team needs a specific credential to operate. The "
        "credential is encrypted and stored in Apollo (the secrets manager). It is "
        "never stored in the database or any file agents can access."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "key": {
                "type": "string",
                "description": (
                    "Environment variable name (e.g. 'GITHUB_TOKEN', "
                    "'ANTHROPIC_API_KEY'). Uppercase with underscores."
                ),
            },
            "label": {
                "type": "string",
                "description": "Human-friendly name (e.g. 'GitHub Personal Access Token').",
            },
            "reason": {
                "type": "string",
                "description": "One sentence explaining why this credential is needed.",
            },
            "help_url": {
                "type": "string",
                "description": "Optional URL where the user can create/find this credential.",
            },
        },
        "required": ["key", "label", "reason"],
    },
}


# ---------------------------------------------------------------------------
# Dependency injection
# ---------------------------------------------------------------------------


@dataclass
class PlannerConfig:
    """Resolved LLM config (the TS ``PlannerDeps["config"]``)."""

    model: str
    openaiApiKey: str | None = None
    openaiBaseUrl: str | None = None


class PlannerResponse(Protocol):
    """The response shape the injected ``fetch_impl`` returns (codex path).

    Models the subset of an ``httpx.Response`` the SSE reader needs: status,
    an async UTF-8 ``text()`` for error bodies, and ``aiter_bytes()`` yielding
    body chunks. ``ok`` mirrors the TS ``Response.ok``.
    """

    @property
    def ok(self) -> bool: ...

    @property
    def status(self) -> int: ...

    async def text(self) -> str: ...

    def aiter_bytes(self) -> Any: ...


FetchImpl = Callable[..., Awaitable[PlannerResponse]]


@dataclass
class PlannerDeps:
    """Everything the planner needs, injected (no server imports in the core)."""

    config: PlannerConfig
    # Backend selector: "codex" routes to the Codex subscription path.
    api_key_source: str
    # Codex subscription auth (used only when api_key_source == "codex").
    codex_access_token: str | None
    codex_account_id: str
    # Proxy-aware fetch, injected so the core doesn't import proxy_fetch.
    fetch_impl: FetchImpl


# Pluggable OpenAI streaming client builder (the planner's test seam). Replaced
# in tests with a fake that yields scripted chunks; defaults to the real SDK.
def _default_openai_client_factory(config: PlannerConfig) -> Any:  # pragma: no cover - network
    from openai import AsyncOpenAI

    return AsyncOpenAI(
        api_key=config.openaiApiKey or None,
        base_url=config.openaiBaseUrl or None,
        timeout=30.0,
    )


openai_client_factory: Callable[[PlannerConfig], Any] = _default_openai_client_factory


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def planner_stream(
    messages: Sequence[PlannerMessage],
    on_token: Callable[[str], None],
    deps: PlannerDeps,
) -> PlannerResult:
    """Stream the planner turn, returning the parsed discriminated-union result."""
    if deps.api_key_source == "codex":
        return await _codex_responses_stream(messages, on_token, deps)
    return await _openai_chat_stream(messages, on_token, deps)


# ---------------------------------------------------------------------------
# Path A: OpenAI Chat Completions (Platform API key / env var)
# ---------------------------------------------------------------------------


async def _openai_chat_stream(
    messages: Sequence[PlannerMessage],
    on_token: Callable[[str], None],
    deps: PlannerDeps,
) -> PlannerResult:
    client = openai_client_factory(deps.config)
    stream = await client.chat.completions.create(
        model=deps.config.model,
        stream=True,
        messages=[
            {"role": "system", "content": DEFAULT_META_AGENT_PROMPT},
            *[{"role": m.role, "content": m.content} for m in messages],
        ],
        tools=[
            {"type": "function", "function": SPAWN_TOOL_DEF},
            {"type": "function", "function": MODIFY_AGENT_TOOL_DEF},
            {"type": "function", "function": REQUEST_CREDENTIAL_TOOL_DEF},
        ],
    )

    full_text = ""
    tool_call_name = ""
    tool_call_args = ""

    async for chunk in stream:
        choices = _get(chunk, "choices") or []
        if not choices:
            continue
        delta = _get(choices[0], "delta")
        if not delta:
            continue

        content = _get(delta, "content")
        if content:
            full_text += content
            on_token(content)

        tool_calls = _get(delta, "tool_calls")
        if tool_calls:
            for tc in tool_calls:
                fn = _get(tc, "function")
                if fn is not None:
                    name = _get(fn, "name")
                    if name:
                        tool_call_name = name
                    args = _get(fn, "arguments")
                    if args:
                        tool_call_args += args

    return _finalize(full_text, tool_call_name, tool_call_args)


def _get(obj: Any, key: str) -> Any:
    """Read ``key`` off a mapping or an SDK object (deltas may be either)."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


# ---------------------------------------------------------------------------
# Path B: Codex Subscription via chatgpt.com/backend-api/codex/responses
# ---------------------------------------------------------------------------


def _codex_headers(deps: PlannerDeps) -> dict[str, str]:
    token = deps.codex_access_token
    if not token:
        raise ValueError("No Codex access token available")
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "ChatGPT-Account-ID": deps.codex_account_id or "",
        "User-Agent": "codex_cli_rs/0.0.0",
        "originator": "codex_cli_rs",
    }


async def _codex_responses_stream(
    messages: Sequence[PlannerMessage],
    on_token: Callable[[str], None],
    deps: PlannerDeps,
) -> PlannerResult:
    body = {
        "model": deps.config.model,
        "instructions": DEFAULT_META_AGENT_PROMPT,
        "input": [{"role": m.role, "content": m.content} for m in messages],
        "tools": [
            {
                "type": "function",
                "name": SPAWN_TOOL_DEF["name"],
                "description": SPAWN_TOOL_DEF["description"],
                "parameters": SPAWN_TOOL_DEF["parameters"],
            },
            {
                "type": "function",
                "name": MODIFY_AGENT_TOOL_DEF["name"],
                "description": MODIFY_AGENT_TOOL_DEF["description"],
                "parameters": MODIFY_AGENT_TOOL_DEF["parameters"],
            },
            {
                "type": "function",
                "name": REQUEST_CREDENTIAL_TOOL_DEF["name"],
                "description": REQUEST_CREDENTIAL_TOOL_DEF["description"],
                "parameters": REQUEST_CREDENTIAL_TOOL_DEF["parameters"],
            },
        ],
        "store": False,
        "stream": True,
    }

    res = await deps.fetch_impl(
        CODEX_RESPONSES_URL,
        method="POST",
        headers=_codex_headers(deps),
        body=json.dumps(body),
    )

    if not res.ok:
        text = ""
        try:
            text = await res.text()
        except Exception:
            text = ""
        raise RuntimeError(f"Codex API error {res.status}: {text[:200]}")

    full_text = ""
    tool_call_name = ""
    tool_call_args = ""

    buffer = ""
    async for chunk in res.aiter_bytes():
        buffer += chunk.decode("utf-8") if isinstance(chunk, (bytes, bytearray)) else chunk

        lines = buffer.split("\n")
        buffer = lines.pop() if lines else ""

        current_event = ""
        for line in lines:
            if line.startswith("event: "):
                current_event = line[len("event: ") :].strip()
                continue
            if not line.startswith("data: "):
                continue

            payload = line[len("data: ") :]
            try:
                data = json.loads(payload)
            except (ValueError, TypeError):
                continue
            if not isinstance(data, dict):
                continue

            event_type = data.get("type") or current_event

            if event_type == "response.output_text.delta":
                delta = data.get("delta")
                if delta:
                    full_text += delta
                    on_token(delta)
            elif event_type == "response.output_item.added":
                item = data.get("item")
                if isinstance(item, dict) and item.get("type") == "function_call" and item.get(
                    "name"
                ):
                    tool_call_name = item["name"]
            elif event_type == "response.function_call_arguments.delta":
                delta = data.get("delta")
                if delta:
                    tool_call_args += delta

    return _finalize(full_text, tool_call_name, tool_call_args)


# ---------------------------------------------------------------------------
# Shared: finalize result from accumulated text + tool call
# ---------------------------------------------------------------------------


def _finalize(full_text: str, tool_call_name: str, tool_call_args: str) -> PlannerResult:
    if tool_call_name == "spawn_team" and tool_call_args:
        parsed = _try_parse(tool_call_args, SpawnTeamResult)
        if parsed is not None:
            return SpawnResult(content=full_text, result=parsed)

    if tool_call_name == "modify_agent" and tool_call_args:
        parsed = _try_parse(tool_call_args, ModifyAgentResult)
        if parsed is not None:
            return ModifyAgentResultEnvelope(content=full_text, result=parsed)

    if tool_call_name == "request_credential" and tool_call_args:
        from simple_harmonic.meta_agent.types import CredentialRequest

        parsed = _try_parse(tool_call_args, CredentialRequest)
        if parsed is not None:
            return RequestCredentialResult(content=full_text, result=parsed)

    return MessageResult(content=full_text or "I need a moment. Try again.")


def _try_parse(raw: str, model: type[Any]) -> Any:
    """Parse a tool-call argument string into ``model``; ``None`` ONLY on malformed
    JSON, so a bad tool call degrades to a plain message.

    Arm selection in the TS planner hinges on JSON validity alone: it does
    ``JSON.parse(args) as SpawnTeamResult`` with no shape check, so a tool call
    that parses but omits, say, ``team_name`` still yields the ``spawn`` arm. We
    mirror that: strict validation when the shape matches, else a no-validation
    ``model_construct`` over the dict so the arm is still produced. A non-object
    payload (the cast couldn't have produced a struct) degrades to a message.
    """
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        return model.model_validate(data)
    except Exception:
        # Faithful to the unchecked TS cast: keep the parsed object, skip
        # validation. Only known fields are populated; extras are ignored.
        known = {k: v for k, v in data.items() if k in model.model_fields}
        return model.model_construct(**known)

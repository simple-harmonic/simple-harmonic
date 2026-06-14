"""Provider adapters: real SDK clients wrapped in the :class:`LLMClient` shape.

TS source:
  - ``new OpenAI({ baseURL, apiKey, timeout })`` cast to LLMClient, in
    packages/backend/src/server/llm.ts (used for both "openai" and "openrouter")
  - ``createAnthropicClient`` from
    packages/backend/src/lib/meta-agent/anthropic-adapter.ts

These adapters translate between the OpenAI-chat-shaped :class:`LLMClient`
contract and the concrete async SDKs. They make NO network call at import time
and none in tests (the cascade/resolver tests use fake clients).

SHARED SEAM (slice 7): the meta-agent Anthropic adapter that slice 7 ports owns
the full OpenAI<->Anthropic message/tool translation. This module ports the
*subset* the resolver needs to build cascade candidates. Slice 7 may replace
:func:`create_anthropic_client` with its richer adapter as long as the result
still satisfies :class:`LLMClient` and returns :class:`LLMResponse`.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from simple_harmonic.llm.client import (
    Choice,
    ChoiceMessage,
    CompletionOptions,
    LLMClient,
    LLMResponse,
    ToolCall,
    ToolCallFunction,
    Usage,
    make_client,
)

if TYPE_CHECKING:
    from openai import AsyncOpenAI

DEFAULT_TIMEOUT_S = 120.0
DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514"


# ---------------------------------------------------------------------------
# OpenAI-compatible (used for both direct OpenAI and OpenRouter via base_url)
# ---------------------------------------------------------------------------


def create_openai_client(
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    timeout: float = DEFAULT_TIMEOUT_S,
) -> LLMClient:
    """Wrap ``AsyncOpenAI`` (pointed at OpenAI or, via ``base_url``, OpenRouter)
    as an :class:`LLMClient`. The SDK response already matches the OpenAI wire
    shape, so it maps onto :class:`LLMResponse` field-for-field."""
    from openai import AsyncOpenAI

    sdk: AsyncOpenAI = AsyncOpenAI(
        api_key=api_key or "",
        base_url=base_url or None,
        timeout=timeout,
    )

    async def create(
        params: dict[str, Any], options: CompletionOptions | None = None
    ) -> LLMResponse:
        raw = await sdk.chat.completions.create(**params)
        return _openai_to_response(raw)

    return make_client(create)


def _openai_to_response(raw: Any) -> LLMResponse:
    """Coerce an OpenAI SDK completion (a pydantic model) into :class:`LLMResponse`.
    ``model_dump`` round-trips it through plain dicts so we never depend on the
    SDK's internal class identity."""
    data = raw.model_dump() if hasattr(raw, "model_dump") else dict(raw)
    return LLMResponse.model_validate(data)


# ---------------------------------------------------------------------------
# Anthropic (wraps AsyncAnthropic in the OpenAI-chat shape)
# ---------------------------------------------------------------------------


def create_anthropic_client(
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    timeout: float = 60.0,
) -> LLMClient:
    """Wrap ``AsyncAnthropic`` as an :class:`LLMClient`, translating OpenAI-style
    params to/from the Anthropic Messages API (the subset the resolver needs)."""
    from anthropic import AsyncAnthropic

    sdk = AsyncAnthropic(api_key=api_key or None, base_url=base_url or None, timeout=timeout)

    async def create(
        params: dict[str, Any], options: CompletionOptions | None = None
    ) -> LLMResponse:
        system, messages = _convert_messages(params.get("messages") or [])
        tools = _convert_tools(params.get("tools"))

        anthropic_params: dict[str, Any] = {
            "model": str(params.get("model") or DEFAULT_ANTHROPIC_MODEL),
            "max_tokens": params.get("max_tokens") or 1024,
            "messages": messages,
        }
        if system:
            anthropic_params["system"] = system
        if tools:
            anthropic_params["tools"] = tools

        response = await sdk.messages.create(**anthropic_params)
        return _anthropic_to_response(response)

    return make_client(create)


def _convert_tools(tools: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    if not tools:
        return None
    out: list[dict[str, Any]] = []
    for t in tools:
        fn = t.get("function", {})
        out.append(
            {
                "name": fn.get("name"),
                "description": fn.get("description") or "",
                "input_schema": fn.get("parameters") or {"type": "object", "properties": {}},
            }
        )
    return out


def _convert_messages(
    messages: list[dict[str, Any]],
) -> tuple[str | None, list[dict[str, Any]]]:
    """Map OpenAI roles to Anthropic, extracting the system prompt."""
    system: str | None = None
    converted: list[dict[str, Any]] = []

    for msg in messages:
        role = msg.get("role")
        if role == "system":
            text = str(msg.get("content") or "")
            system = (system + "\n\n" + text) if system else text
            continue

        if role == "tool":
            converted.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": msg.get("tool_call_id"),
                            "content": str(msg.get("content") or ""),
                        }
                    ],
                }
            )
            continue

        if role == "assistant":
            tool_calls = msg.get("tool_calls")
            if tool_calls:
                content: list[Any] = []
                if msg.get("content"):
                    content.append({"type": "text", "text": str(msg["content"])})
                for tc in tool_calls:
                    fn = tc.get("function", {})
                    try:
                        tc_input = json.loads(fn.get("arguments") or "{}")
                    except (ValueError, TypeError):
                        tc_input = {}
                    content.append(
                        {
                            "type": "tool_use",
                            "id": tc.get("id"),
                            "name": fn.get("name"),
                            "input": tc_input,
                        }
                    )
                converted.append({"role": "assistant", "content": content})
            else:
                converted.append({"role": "assistant", "content": str(msg.get("content") or "")})
            continue

        converted.append({"role": "user", "content": str(msg.get("content") or "")})

    return system, converted


def _anthropic_to_response(response: Any) -> LLMResponse:
    """Translate an Anthropic Messages response into :class:`LLMResponse`,
    echoing the serving model so spend + cascade attribute the call correctly."""
    text_content: str | None = None
    tool_calls: list[ToolCall] = []

    for block in getattr(response, "content", []) or []:
        btype = getattr(block, "type", None)
        if btype == "text":
            text_content = (text_content or "") + getattr(block, "text", "")
        elif btype == "tool_use":
            tool_calls.append(
                ToolCall(
                    id=getattr(block, "id", ""),
                    function=ToolCallFunction(
                        name=getattr(block, "name", ""),
                        arguments=json.dumps(getattr(block, "input", {})),
                    ),
                )
            )

    finish_reason = "tool_calls" if getattr(response, "stop_reason", None) == "tool_use" else "stop"
    usage_obj = getattr(response, "usage", None)
    in_tok = getattr(usage_obj, "input_tokens", 0) or 0
    out_tok = getattr(usage_obj, "output_tokens", 0) or 0

    return LLMResponse(
        model=getattr(response, "model", None),
        choices=[
            Choice(
                message=ChoiceMessage(
                    content=text_content,
                    tool_calls=tool_calls or None,
                ),
                finish_reason=finish_reason,
            )
        ],
        usage=Usage(
            input_tokens=in_tok,
            output_tokens=out_tok,
            prompt_tokens=in_tok,
            completion_tokens=out_tok,
        ),
    )

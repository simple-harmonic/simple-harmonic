"""The LLM client contract: the Protocol every provider adapter satisfies.

TS source: the ``LLMClient`` / ``LLMResponse`` shapes declared in
packages/backend/src/lib/meta-agent/runner.ts.

The runner (slice 7) calls models through a tiny OpenAI-chat-shaped surface:
``llm.chat.completions.create(params, options)``. Everything in this slice — the
cascade, the spend counter, the provider adapters — speaks that same shape, so
the cascade can wrap any adapter and the counting wrapper can wrap the cascade.

SHARED SEAM (slice 7): runner.py will import :class:`LLMClient`,
:class:`LLMResponse`, and :class:`CompletionOptions` from here rather than
redeclaring them. The Anthropic/Codex meta-agent adapters that slice 7 ports
must return :class:`LLMResponse` and accept :class:`CompletionOptions` so they
drop straight into :func:`simple_harmonic.llm.cascade.create_cascade_llm`.

Cancellation model
------------------
TS threads an ``AbortSignal`` through ``options.signal`` and the cascade checks
``options.signal.aborted``. The idiomatic Python equivalent is an
``asyncio.Event`` used as a one-shot cancellation token: ``set()`` means
"aborted". :class:`CompletionOptions.signal` carries it. The cascade reads
``signal.is_set()`` to decide whether to keep falling through providers.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field


class Usage(BaseModel):
    """Token usage block. Carries both the Anthropic (``input_tokens``/
    ``output_tokens``) and OpenAI (``prompt_tokens``/``completion_tokens``)
    spellings so the counting wrapper can read whichever a provider emits."""

    model_config = ConfigDict(populate_by_name=True, extra="allow")

    input_tokens: int | None = None
    output_tokens: int | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None


class ToolCallFunction(BaseModel):
    name: str
    arguments: str


class ToolCall(BaseModel):
    id: str
    function: ToolCallFunction
    type: str = "function"


class ChoiceMessage(BaseModel):
    content: str | None = None
    tool_calls: list[ToolCall] | None = None


class Choice(BaseModel):
    message: ChoiceMessage
    finish_reason: str = "stop"


class LLMResponse(BaseModel):
    """An OpenAI-chat-shaped completion response.

    ``model`` is the *serving* model id. The cascade stamps it with the
    candidate's model when a provider omits it; the spend counter prefers it
    over the requested model so fallback calls are priced against the model that
    actually ran. ``extra="allow"`` keeps any provider-specific fields a real
    SDK response carries.
    """

    model_config = ConfigDict(extra="allow")

    choices: list[Choice] = Field(default_factory=list)
    model: str | None = None
    usage: Usage | None = None


@dataclass
class CompletionOptions:
    """Per-call options. ``signal`` is the cancellation token (an
    ``asyncio.Event`` whose ``set()`` state means "aborted"), mirroring the TS
    ``AbortSignal`` passed as ``options.signal``."""

    signal: asyncio.Event | None = None


@dataclass
class CompletionsNamespace:
    """The ``.completions`` namespace, exposing ``create``. Mirrors the nested
    ``chat.completions.create`` access path of the OpenAI SDK so adapters and
    the cascade are drop-in for each other."""

    create: Any


@dataclass
class ChatNamespace:
    """The ``.chat`` namespace, exposing ``.completions``."""

    completions: CompletionsNamespace = field(
        default_factory=lambda: CompletionsNamespace(create=None)
    )


@runtime_checkable
class LLMClient(Protocol):
    """Minimal OpenAI-compatible async chat client.

    A conforming object exposes ``client.chat.completions.create(params,
    options=None)`` returning an awaitable :class:`LLMResponse`. ``params`` is a
    plain dict (``model``, ``messages``, ``tools``, ...); ``options`` is an
    optional :class:`CompletionOptions` carrying the cancellation token.
    """

    chat: ChatNamespace


def make_client(create: Any) -> LLMClient:
    """Wrap a bare ``create(params, options=None)`` coroutine function as an
    :class:`LLMClient`. Convenience for adapters and test doubles so they don't
    each rebuild the ``chat.completions`` nesting by hand."""
    return _SimpleClient(chat=ChatNamespace(completions=CompletionsNamespace(create=create)))


@dataclass
class _SimpleClient:
    chat: ChatNamespace

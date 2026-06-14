"""Anthropic meta-agent adapter — ``AsyncAnthropic`` wrapped in the LLMClient shape.

TS source: packages/backend/src/lib/meta-agent/anthropic-adapter.ts

This is the *richer* sibling of :func:`simple_harmonic.llm.adapters.create_anthropic_client`:
it threads the cancellation token through into the in-flight Anthropic call so a
tick whose budget is exceeded actually aborts the request, mirroring the TS
adapter passing ``{ signal: options.signal }`` into ``client.messages.create``.
The slice-5 resolver wraps the SDK without cancellation; this one wires the
``CompletionOptions`` token (an ``asyncio.Event``) into the call.

:data:`simple_harmonic.llm.candidates.anthropic_client_factory` is pointed here
(see :func:`simple_harmonic.meta_agent.wiring.wire_candidate_factories`) so every
resolved Anthropic cascade candidate gets the cancellation-aware client.

The OpenAI<->Anthropic message/tool translation is identical to the slice-5
adapter (same wire shapes) and is REUSED from it rather than re-derived: this
module imports :func:`_convert_messages`, :func:`_convert_tools`, and
:func:`_anthropic_to_response` from :mod:`simple_harmonic.llm.adapters`.

Cancellation model
-------------------
The TS adapter passes the ``AbortSignal`` to the SDK, which aborts the HTTP
request when it fires. The Python ``AsyncAnthropic`` SDK aborts an in-flight
request when the awaiting task is cancelled, so the faithful mapping is:

  * if the token is already set, raise ``asyncio.CancelledError`` BEFORE issuing
    the request (the cascade reads ``signal.is_set()`` and bails, matching the TS
    ``signal.aborted`` short-circuit);
  * otherwise race the SDK coroutine against ``signal.wait()``; if the token
    fires first, cancel the SDK task (aborting the request) and raise
    ``asyncio.CancelledError``.

No network call happens at import time, and none in tests (the SDK is mocked).
"""

from __future__ import annotations

import asyncio
from typing import Any

from simple_harmonic.llm.adapters import (
    DEFAULT_ANTHROPIC_MODEL,
    _anthropic_to_response,
    _convert_messages,
    _convert_tools,
)
from simple_harmonic.llm.client import (
    CompletionOptions,
    LLMClient,
    LLMResponse,
    make_client,
)

# The TS adapter defaults the SDK timeout to 60_000ms.
DEFAULT_TIMEOUT_S = 60.0


def create_anthropic_client(
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    timeout: float = DEFAULT_TIMEOUT_S,
) -> LLMClient:
    """Create a cancellation-aware Anthropic :class:`LLMClient`.

    Same signature as :func:`simple_harmonic.llm.adapters.create_anthropic_client`
    (so it is a drop-in for ``candidates.anthropic_client_factory``), but the
    returned ``create`` threads the :class:`CompletionOptions` cancellation token
    into the in-flight ``messages.create`` call.
    """
    from anthropic import AsyncAnthropic

    sdk = AsyncAnthropic(api_key=api_key or None, base_url=base_url or None, timeout=timeout)

    async def create(
        params: dict[str, Any], options: CompletionOptions | None = None
    ) -> LLMResponse:
        signal = options.signal if options is not None else None
        # Mirror the TS `signal.aborted` short-circuit: never start an aborted call.
        if signal is not None and signal.is_set():
            raise asyncio.CancelledError("anthropic call aborted before start")

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

        response = await _create_with_signal(
            sdk.messages.create(**anthropic_params), signal
        )
        return _anthropic_to_response(response)

    return make_client(create)


async def _create_with_signal(coro: Any, signal: asyncio.Event | None) -> Any:
    """Await ``coro``, cancelling it if ``signal`` fires first.

    The faithful mapping of the TS ``{ signal }`` option: cancelling the task
    awaiting an ``AsyncAnthropic`` request aborts the underlying HTTP request, so
    when the abort token fires we cancel the SDK task and surface
    ``asyncio.CancelledError`` (which the cascade treats as the abort path)."""
    if signal is None:
        return await coro

    sdk_task = asyncio.ensure_future(coro)
    signal_task = asyncio.ensure_future(signal.wait())
    try:
        done, _pending = await asyncio.wait(
            {sdk_task, signal_task}, return_when=asyncio.FIRST_COMPLETED
        )
        if sdk_task in done:
            return sdk_task.result()
        # Signal fired first: abort the in-flight request.
        sdk_task.cancel()
        with _suppress_cancelled():
            await sdk_task
        raise asyncio.CancelledError("anthropic call aborted by signal")
    finally:
        signal_task.cancel()
        with _suppress_cancelled():
            await signal_task


class _suppress_cancelled:
    """``contextlib.suppress(asyncio.CancelledError)`` as a small reusable guard.

    A plain ``contextlib.suppress`` would also swallow a cancellation targeting
    the *outer* task; here we only ever await tasks we ourselves just cancelled,
    so suppressing their ``CancelledError`` is safe and intended."""

    def __enter__(self) -> _suppress_cancelled:
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        return exc_type is not None and issubclass(exc_type, asyncio.CancelledError)

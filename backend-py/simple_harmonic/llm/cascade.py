"""Cascade LLM client + token-counting wrapper.

TS source:
  - ``createCascadeLLM`` from packages/backend/src/lib/meta-agent/cascade.ts
  - ``makeCountingLLM`` from packages/backend/src/server/spend.ts (grouped here
    per the slice plan: both are thin client-wrappers over an LLMClient)

The cascade composes an ordered list of ``(provider, model, client)`` candidates
into a single :class:`~simple_harmonic.llm.client.LLMClient`. Each completion
call walks the chain in order: first success wins, and any provider error falls
through to the next candidate, so one rate-limited or down provider can't stall
an agent tick while another key is configured.
"""

from __future__ import annotations

import contextlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from simple_harmonic.llm.client import (
    CompletionOptions,
    LLMClient,
    LLMResponse,
    Usage,
    make_client,
)


@dataclass
class LLMCandidate:
    """One cascade step.

    ``provider`` is a short id for logs/events ("anthropic", "openrouter").
    ``model`` overrides ``params["model"]`` for this attempt. ``llm`` is the
    backing client.
    """

    provider: str
    model: str
    llm: LLMClient


@dataclass
class FallbackInfo:
    """Passed to :class:`CascadeOptions.on_fallback` once per failed candidate."""

    provider: str
    model: str
    error: BaseException
    # The candidate tried next; ``None`` on the last failure.
    next: NextCandidate | None = None


@dataclass
class NextCandidate:
    provider: str
    model: str


@dataclass
class CascadeOptions:
    """Cascade behavior hooks. ``on_fallback`` fires once per failed candidate,
    before the next one is tried; its exceptions are swallowed (a buggy observer
    must never break a tick)."""

    on_fallback: Callable[[FallbackInfo], None] | None = None


def create_cascade_llm(
    candidates: list[LLMCandidate],
    opts: CascadeOptions | None = None,
) -> LLMClient:
    """Compose candidates into a single cascading :class:`LLMClient`.

    On each ``create`` call the chain is walked in order:
      * the candidate's ``model`` overrides ``params["model"]`` for the attempt;
      * on success the *serving* model is stamped onto the response when the
        provider omitted it (so spend attributes fallback calls correctly), and
        the response is returned;
      * on a provider error the call falls through to the next candidate, BUT if
        the cancellation signal is already aborted it re-raises immediately
        rather than burning the remaining wall-clock budget on more providers;
      * if every candidate fails, the last error is re-raised.
    """
    options = opts or CascadeOptions()
    if not candidates:
        raise ValueError("create_cascade_llm requires at least one candidate")

    async def create(
        params: dict[str, Any], options_arg: CompletionOptions | None = None
    ) -> LLMResponse:
        last_err: BaseException | None = None
        for i, c in enumerate(candidates):
            try:
                res = await c.llm.chat.completions.create(
                    {**params, "model": c.model}, options_arg
                )
                # Stamp the serving model so the spend counter attributes
                # fallback calls to the model that actually ran.
                if not res.model:
                    res.model = c.model
                return res
            except BaseException as err:
                last_err = err
                # The caller's wall-clock budget aborted the call: stop now
                # instead of burning the rest of the budget on more providers.
                if options_arg is not None and options_arg.signal is not None and (
                    options_arg.signal.is_set()
                ):
                    raise
                nxt = candidates[i + 1] if i + 1 < len(candidates) else None
                if options.on_fallback is not None:
                    # a buggy observer must never break a tick
                    with contextlib.suppress(Exception):
                        options.on_fallback(
                            FallbackInfo(
                                provider=c.provider,
                                model=c.model,
                                error=err,
                                next=(
                                    NextCandidate(provider=nxt.provider, model=nxt.model)
                                    if nxt is not None
                                    else None
                                ),
                            )
                        )
        assert last_err is not None  # candidates is non-empty
        raise last_err

    return make_client(create)


@dataclass
class UsageAccumulator:
    """Running token totals + the model spend should be priced against."""

    inputTokens: int = 0
    outputTokens: int = 0
    model: str = ""


@dataclass
class CountingLLM:
    llm: LLMClient
    usage: UsageAccumulator


def make_counting_llm(llm: LLMClient, model: str) -> CountingLLM:
    """Wrap an LLM client so every completion call accumulates token usage.

    Used per-agent in the tick loop so each agent run records its own spend.
    Prefers the response's ``model`` over the requested one: under the cascade
    the serving model can differ from the requested one, and mispricing follows
    directly from getting that wrong.
    """
    usage = UsageAccumulator(inputTokens=0, outputTokens=0, model=model)

    async def create(
        params: dict[str, Any], options_arg: CompletionOptions | None = None
    ) -> LLMResponse:
        res = await llm.chat.completions.create(params, options_arg)
        u: Usage | None = res.usage
        if u is not None:
            usage.inputTokens += (u.input_tokens or u.prompt_tokens) or 0
            usage.outputTokens += (u.output_tokens or u.completion_tokens) or 0
        # Prefer the response's model: with the cascade the serving model can
        # differ from the requested one.
        rm = res.model
        pm = params.get("model")
        usage.model = rm or pm or usage.model
        return res

    return CountingLLM(llm=make_client(create), usage=usage)


# Re-export so callers that follow the TS import sites (cascade vs runner) all
# resolve from one place.
_CreateFn = Callable[[dict[str, Any], CompletionOptions | None], Awaitable[LLMResponse]]

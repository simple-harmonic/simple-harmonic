"""LLM provider resolution: build the ordered cascade of configured providers.

TS source: packages/backend/src/server/llm.ts

Precedence (highest first):
  1. Codex CLI subscription (when the api-key source is "codex")
  2. Anthropic (ANTHROPIC_API_KEY)
  3. OpenRouter (OPENROUTER_API_KEY) — one cascade step per configured model
  4. OpenAI platform key (config file or OPENAI_API_KEY)

Each step is gated by which providers are configured (env / config file / the
codex token surfaced through slice-4 ``config``). With nothing configured it
falls back to a key-less OpenAI candidate, which surfaces a clear auth error on
first call rather than failing at resolve time.

SHARED SEAM (slice 7): the concrete client builders are pluggable module hooks
(:data:`anthropic_client_factory`, :data:`codex_client_factory`,
:data:`openai_client_factory`) — exactly the pattern slice-4 ``config`` uses for
``codex_access_token``. They default to the adapters in
:mod:`simple_harmonic.llm.adapters`; slice 7 points the codex hook at its
meta-agent ``createCodexClient`` and may point the anthropic hook at its richer
adapter. Tests override these hooks with fake clients so resolution never
touches the network.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass, field

from simple_harmonic.config import get_api_key_source, get_config
from simple_harmonic.llm import adapters
from simple_harmonic.llm.cascade import (
    CascadeOptions,
    LLMCandidate,
    create_cascade_llm,
)
from simple_harmonic.llm.client import LLMClient

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

DEFAULT_CODEX_MODEL = "gpt-5.5"
DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514"
# OpenRouter ids are vendor-namespaced; same model family the direct Anthropic
# path defaults to.
DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4"
DEFAULT_TIMEOUT_S = 120.0


# --- Pluggable client builders (the slice-7 seam) --------------------------

# Slice 7 sets this to the meta-agent codex adapter (createCodexClient). The
# default raises if reached, because reaching it means the api-key source is
# "codex" yet no codex adapter is wired — a wiring bug, not a runtime fallback.
def _default_codex_factory(model: str) -> LLMClient:  # pragma: no cover - replaced by slice 7
    raise RuntimeError(
        "No codex client factory configured. Slice 7 wires "
        "candidates.codex_client_factory to the meta-agent codex adapter."
    )


codex_client_factory: Callable[[str], LLMClient] = _default_codex_factory
anthropic_client_factory: Callable[..., LLMClient] = adapters.create_anthropic_client
openai_client_factory: Callable[..., LLMClient] = adapters.create_openai_client


@dataclass
class ResolveOptions:
    """Resolution knobs. ``timeout_s`` is the per-request client timeout
    (default 120s, matching the tick budget)."""

    timeout_s: float = DEFAULT_TIMEOUT_S


def resolve_llm_candidates(opts: ResolveOptions | None = None) -> list[LLMCandidate]:
    """Every configured provider as a cascade candidate, in priority order.

    Always returns at least one candidate (see module docstring).
    """
    options = opts or ResolveOptions()
    cfg = get_config()
    source = get_api_key_source()
    timeout = options.timeout_s
    candidates: list[LLMCandidate] = []

    if source == "codex":
        model = cfg.model or DEFAULT_CODEX_MODEL
        candidates.append(
            LLMCandidate(provider="codex", model=model, llm=codex_client_factory(model))
        )

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    if anthropic_key:
        candidates.append(
            LLMCandidate(
                provider="anthropic",
                model=os.environ.get("ANTHROPIC_MODEL") or DEFAULT_ANTHROPIC_MODEL,
                llm=anthropic_client_factory(api_key=anthropic_key, timeout=timeout),
            )
        )

    openrouter_key = os.environ.get("OPENROUTER_API_KEY")
    if openrouter_key:
        llm = openai_client_factory(
            api_key=openrouter_key,
            base_url=os.environ.get("OPENROUTER_BASE_URL") or OPENROUTER_BASE_URL,
            timeout=timeout,
        )
        # Primary model plus optional comma-separated fallbacks, each its own
        # cascade step so the chain walks them in order. Deduped, order-stable.
        raw_models = [
            os.environ.get("OPENROUTER_MODEL") or DEFAULT_OPENROUTER_MODEL,
            *(os.environ.get("OPENROUTER_FALLBACK_MODELS") or "").split(","),
        ]
        models = [m.strip() for m in raw_models if m.strip()]
        for model in _dedupe(models):
            candidates.append(LLMCandidate(provider="openrouter", model=model, llm=llm))

    # Direct OpenAI(-compatible) platform key. Skipped under the codex source:
    # there cfg.openaiApiKey holds the ChatGPT token, not a platform key.
    if source in ("config", "env"):
        candidates.append(_openai_candidate(cfg, timeout))

    if not candidates:
        candidates.append(_openai_candidate(cfg, timeout))

    return candidates


def _openai_candidate(cfg: object, timeout: float) -> LLMCandidate:
    return LLMCandidate(
        provider="openai",
        model=getattr(cfg, "model", ""),
        llm=openai_client_factory(
            api_key=getattr(cfg, "openaiApiKey", "") or None,
            base_url=getattr(cfg, "openaiBaseUrl", "") or None,
            timeout=timeout,
        ),
    )


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for it in items:
        if it not in seen:
            seen.add(it)
            out.append(it)
    return out


@dataclass
class ResolvedLLM:
    llm: LLMClient
    # The primary candidate's model id (the tick's modelOverride).
    model: str
    # "provider/model" per cascade step, for logs and status surfaces.
    chain: list[str] = field(default_factory=list)


def resolve_llm(
    opts: ResolveOptions | None = None,
    cascade_opts: CascadeOptions | None = None,
) -> ResolvedLLM:
    """Resolve all configured providers into a single cascading LLM client."""
    candidates = resolve_llm_candidates(opts)
    return ResolvedLLM(
        llm=create_cascade_llm(candidates, cascade_opts),
        model=candidates[0].model,
        chain=[f"{c.provider}/{c.model}" for c in candidates],
    )

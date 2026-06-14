"""Tests for the LLM cascade + provider resolution.

Ported from packages/backend/tests/unit/llm-cascade.test.ts. Everything is
OFFLINE: the cascade is exercised with fake clients implementing the LLMClient
Protocol, and resolution overrides the client-builder hooks so no real SDK or
network is touched.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator

import pytest

from simple_harmonic.config import AppConfig, CodingBackendConfig
from simple_harmonic.llm import candidates as cand_mod
from simple_harmonic.llm.candidates import (
    OPENROUTER_BASE_URL,
    resolve_llm,
    resolve_llm_candidates,
)
from simple_harmonic.llm.cascade import (
    CascadeOptions,
    LLMCandidate,
    create_cascade_llm,
)
from simple_harmonic.llm.client import LLMResponse, make_client

# --- Fake LLMClient doubles (implement the Protocol) -----------------------


def _fake_client(create):
    """Wrap a bare async create(params, options) as an LLMClient."""
    return make_client(create)


def succeeds(response: LLMResponse | None = None):
    """A client whose create resolves; records the params it was called with."""
    calls: list[dict] = []

    async def _create(params, options=None):
        calls.append(params)
        return response if response is not None else LLMResponse(choices=[])

    client = _fake_client(_create)
    client.calls = calls  # type: ignore[attr-defined]
    return client


def raises(err: BaseException):
    calls: list[dict] = []

    async def _create(params, options=None):
        calls.append(params)
        raise err

    client = _fake_client(_create)
    client.calls = calls  # type: ignore[attr-defined]
    return client


def aborts(signal_holder: dict):
    """A client that aborts the passed signal then raises (simulates a tick
    budget timeout firing mid-call)."""
    err = RuntimeError("tick budget exceeded")
    signal_holder["err"] = err

    async def _create(params, options=None):
        if options is not None and options.signal is not None:
            options.signal.set()
        raise err

    return _fake_client(_create)


def candidate(provider: str, model: str, client) -> LLMCandidate:
    return LLMCandidate(provider=provider, model=model, llm=client)


# ---------------------------------------------------------------------------
# create_cascade_llm
# ---------------------------------------------------------------------------


async def test_serves_from_first_candidate_and_stamps_model() -> None:
    c = succeeds(LLMResponse(choices=[]))
    llm = create_cascade_llm([candidate("anthropic", "claude-sonnet-4", c)])

    res = await llm.chat.completions.create({"model": "requested", "messages": []})

    assert c.calls[0]["model"] == "claude-sonnet-4"
    assert res.model == "claude-sonnet-4"


async def test_keeps_model_already_present_on_response() -> None:
    c = succeeds(LLMResponse(choices=[], model="served-2026-01"))
    llm = create_cascade_llm([candidate("openai", "o4-mini", c)])
    res = await llm.chat.completions.create({"messages": []})
    assert res.model == "served-2026-01"


async def test_falls_through_to_next_on_error_and_reports_fallback() -> None:
    first = raises(RuntimeError("429 rate limited"))
    second = succeeds(LLMResponse(choices=[]))
    fallbacks: list = []
    llm = create_cascade_llm(
        [
            candidate("anthropic", "claude-sonnet-4", first),
            candidate("openrouter", "openai/gpt-5.5", second),
        ],
        CascadeOptions(on_fallback=fallbacks.append),
    )

    res = await llm.chat.completions.create({"messages": []})

    assert second.calls[0]["model"] == "openai/gpt-5.5"
    assert res.model == "openai/gpt-5.5"
    assert len(fallbacks) == 1
    info = fallbacks[0]
    assert info.provider == "anthropic"
    assert info.model == "claude-sonnet-4"
    assert info.next is not None
    assert (info.next.provider, info.next.model) == ("openrouter", "openai/gpt-5.5")


async def test_rethrows_immediately_when_aborted_no_fallback() -> None:
    holder: dict = {}
    first = aborts(holder)
    second = succeeds()
    fallbacks: list = []
    signal = asyncio.Event()
    llm = create_cascade_llm(
        [candidate("anthropic", "a", first), candidate("openai", "b", second)],
        CascadeOptions(on_fallback=fallbacks.append),
    )

    from simple_harmonic.llm.client import CompletionOptions

    with pytest.raises(RuntimeError) as exc:
        await llm.chat.completions.create({"messages": []}, CompletionOptions(signal=signal))

    assert exc.value is holder["err"]
    assert second.calls == []  # never tried
    assert fallbacks == []  # no fallback fired


async def test_rethrows_when_signal_already_aborted_before_first_call() -> None:
    """Short-circuit also fires when the tick budget expired *before* the chain
    was entered: the first provider's error must re-raise immediately, with no
    later provider tried and no fallback fired — distinct from the case where
    the failing provider itself sets the signal."""
    from simple_harmonic.llm.client import CompletionOptions

    first_err = RuntimeError("first provider down")
    first = raises(first_err)
    second = succeeds()
    fallbacks: list = []
    signal = asyncio.Event()
    signal.set()  # already aborted before any provider runs

    llm = create_cascade_llm(
        [candidate("anthropic", "a", first), candidate("openai", "b", second)],
        CascadeOptions(on_fallback=fallbacks.append),
    )

    with pytest.raises(RuntimeError) as exc:
        await llm.chat.completions.create({"messages": []}, CompletionOptions(signal=signal))

    assert exc.value is first_err
    assert second.calls == []  # later provider never tried
    assert fallbacks == []  # no fallback fired


async def test_throws_last_error_when_every_candidate_fails() -> None:
    e1 = RuntimeError("first down")
    e2 = RuntimeError("second down")
    fallbacks: list = []
    llm = create_cascade_llm(
        [
            candidate("anthropic", "a", raises(e1)),
            candidate("openai", "b", raises(e2)),
        ],
        CascadeOptions(on_fallback=fallbacks.append),
    )

    with pytest.raises(RuntimeError) as exc:
        await llm.chat.completions.create({"messages": []})
    assert exc.value is e2
    assert len(fallbacks) == 2
    assert fallbacks[-1].provider == "openai"
    assert fallbacks[-1].model == "b"
    assert fallbacks[-1].next is None


async def test_throwing_on_fallback_observer_does_not_break_cascade() -> None:
    def _boom(_info):
        raise RuntimeError("buggy observer")

    llm = create_cascade_llm(
        [
            candidate("anthropic", "a", raises(RuntimeError("down"))),
            candidate("openai", "b", succeeds(LLMResponse(choices=[]))),
        ],
        CascadeOptions(on_fallback=_boom),
    )
    res = await llm.chat.completions.create({"messages": []})
    assert res is not None


def test_requires_at_least_one_candidate() -> None:
    with pytest.raises(ValueError, match="at least one candidate"):
        create_cascade_llm([])


# ---------------------------------------------------------------------------
# resolve_llm_candidates / resolve_llm  (offline: hooks + config overridden)
# ---------------------------------------------------------------------------

_ENV_KEYS = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
    "OPENROUTER_FALLBACK_MODELS",
    "OPENROUTER_BASE_URL",
]


@pytest.fixture
def resolver_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict]:
    """Clear provider env, stub get_config/get_api_key_source, and replace the
    client-builder hooks with fakes that record their kwargs. No network."""
    for k in _ENV_KEYS:
        monkeypatch.delenv(k, raising=False)

    state: dict = {
        "source": "none",
        "config": _cfg(openaiApiKey="", openaiBaseUrl="https://api.openai.com/v1", model="o4-mini"),
        "anthropic_kwargs": [],
        "openai_kwargs": [],
        "codex_models": [],
    }

    monkeypatch.setattr(cand_mod, "get_config", lambda: state["config"])
    monkeypatch.setattr(cand_mod, "get_api_key_source", lambda: state["source"])

    def _anthropic(**kwargs):
        state["anthropic_kwargs"].append(kwargs)
        return make_client(_noop_create)

    def _openai(**kwargs):
        state["openai_kwargs"].append(kwargs)
        return make_client(_noop_create)

    def _codex(model: str):
        state["codex_models"].append(model)
        return make_client(_noop_create)

    monkeypatch.setattr(cand_mod, "anthropic_client_factory", _anthropic)
    monkeypatch.setattr(cand_mod, "openai_client_factory", _openai)
    monkeypatch.setattr(cand_mod, "codex_client_factory", _codex)
    yield state


async def _noop_create(params, options=None):
    return LLMResponse(choices=[])


def _cfg(*, openaiApiKey: str, openaiBaseUrl: str, model: str) -> AppConfig:
    return AppConfig(
        openaiApiKey=openaiApiKey,
        openaiBaseUrl=openaiBaseUrl,
        model=model,
        dataDir="/tmp/data",
        codingBackend="codex",
        codingConfig={
            "codex": CodingBackendConfig(),
            "claude-code": CodingBackendConfig(),
            "opencode": CodingBackendConfig(),
        },
    )


def test_orders_codex_anthropic_openrouter_skips_openai_under_codex(
    resolver_env: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    resolver_env["source"] = "codex"
    resolver_env["config"] = _cfg(openaiApiKey="chatgpt-token", openaiBaseUrl="", model="")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")

    c = resolve_llm_candidates()

    assert [x.provider for x in c] == ["codex", "anthropic", "openrouter"]
    assert c[0].model == "gpt-5.5"
    assert resolver_env["codex_models"] == ["gpt-5.5"]


def test_expands_openrouter_models_into_deduped_steps(
    resolver_env: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
    monkeypatch.setenv("OPENROUTER_MODEL", "anthropic/claude-sonnet-4")
    monkeypatch.setenv(
        "OPENROUTER_FALLBACK_MODELS",
        " openai/gpt-5.5, google/gemini-2.5-pro ,anthropic/claude-sonnet-4,",
    )

    c = resolve_llm_candidates()

    assert [x.model for x in c if x.provider == "openrouter"] == [
        "anthropic/claude-sonnet-4",
        "openai/gpt-5.5",
        "google/gemini-2.5-pro",
    ]
    # OpenRouter client built with the OpenRouter base url + key.
    assert resolver_env["openai_kwargs"][0]["api_key"] == "sk-or-test"
    assert resolver_env["openai_kwargs"][0]["base_url"] == OPENROUTER_BASE_URL


def test_appends_direct_openai_after_anthropic_and_openrouter(
    resolver_env: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    resolver_env["source"] = "env"
    resolver_env["config"] = _cfg(
        openaiApiKey="sk-openai", openaiBaseUrl="https://api.openai.com/v1", model="o4-mini"
    )
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-haiku-4-5")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")

    c = resolve_llm_candidates()

    assert [f"{x.provider}/{x.model}" for x in c] == [
        "anthropic/claude-haiku-4-5",
        "openrouter/anthropic/claude-sonnet-4",
        "openai/o4-mini",
    ]
    assert resolver_env["anthropic_kwargs"][0]["api_key"] == "sk-ant-test"
    assert resolver_env["anthropic_kwargs"][0]["timeout"] == 120.0


def test_falls_back_to_keyless_openai_when_nothing_configured(resolver_env: dict) -> None:
    c = resolve_llm_candidates()
    assert len(c) == 1
    assert c[0].provider == "openai"
    assert c[0].model == "o4-mini"


def test_resolve_llm_exposes_primary_model_and_chain(
    resolver_env: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")

    resolved = resolve_llm()

    assert resolved.model == "claude-sonnet-4-20250514"
    assert resolved.chain == [
        "anthropic/claude-sonnet-4-20250514",
        "openrouter/anthropic/claude-sonnet-4",
    ]


async def test_resolved_cascade_actually_calls_through(
    resolver_env: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End-to-end (offline): resolve a 2-provider chain where the first fails,
    confirm the cascade falls through and stamps the serving model."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")

    # Override the hooks to return controllable fakes (first raises, second ok).
    first = raises(RuntimeError("anthropic down"))
    second = succeeds(LLMResponse(choices=[]))
    monkeypatch.setattr(cand_mod, "anthropic_client_factory", lambda **kw: first)
    monkeypatch.setattr(cand_mod, "openai_client_factory", lambda **kw: second)

    resolved = resolve_llm()
    res = await resolved.llm.chat.completions.create({"messages": []})
    assert res.model == "anthropic/claude-sonnet-4"  # served by the openrouter step

"""Tests for simple_harmonic.llm.spend.

Ported from packages/backend/tests/unit/spend.test.ts. The spend ledger is
isolated under a temp data dir (the ``data_dir`` fixture). Fail-open is tested
by making the ledger read raise.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import pytest

from simple_harmonic.llm import spend as spend_mod
from simple_harmonic.llm.client import LLMResponse, Usage, make_client
from simple_harmonic.llm.spend import (
    check_spend_allowed,
    cost_cents,
    daily_cap_cents,
    make_counting_llm,
    record_spend,
    today_utc,
)
from simple_harmonic.store.repos.spend import NewSpend
from simple_harmonic.store.repos.spend import spend as spend_repo


@pytest.fixture(autouse=True)
def _clear_cap_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Each test owns SH_DAILY_SPEND_CAP_CENTS; clear it by default."""
    monkeypatch.delenv("SH_DAILY_SPEND_CAP_CENTS", raising=False)
    yield


async def _seed(cost: float, day: str) -> None:
    await spend_repo.insert(
        NewSpend(
            teamId=None,
            agentId=None,
            model="claude-sonnet-4",
            inputTokens=1,
            outputTokens=1,
            costCents=cost,
            day=day,
        )
    )


# --- cost_cents ------------------------------------------------------------


def test_cost_cents_claude_sonnet_rounds_up() -> None:
    # 1M in @ 300c + 1M out @ 1500c = 1800c
    assert cost_cents("claude-sonnet-4-20250514", 1_000_000, 1_000_000) == 1800
    # 1000 in @ 300c/M = 0.3c -> ceil 1
    assert cost_cents("claude-sonnet-4", 1000, 0) == 1


def test_cost_cents_expensive_fallback_for_unknown_model() -> None:
    assert cost_cents("mystery-model", 1_000_000, 0) == 1500


def test_cost_cents_strips_openrouter_namespace() -> None:
    assert cost_cents("anthropic/claude-sonnet-4", 1_000_000, 1_000_000) == 1800
    assert cost_cents("openai/gpt-5.5", 1_000_000, 0) == 125


# --- daily_cap_cents -------------------------------------------------------


def test_daily_cap_defaults_and_override(monkeypatch: pytest.MonkeyPatch) -> None:
    assert daily_cap_cents() == 5000
    monkeypatch.setenv("SH_DAILY_SPEND_CAP_CENTS", "1234")
    assert daily_cap_cents() == 1234


def test_daily_cap_ignores_non_numeric_and_non_positive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SH_DAILY_SPEND_CAP_CENTS", "not-a-number")
    assert daily_cap_cents() == 5000
    monkeypatch.setenv("SH_DAILY_SPEND_CAP_CENTS", "0")
    assert daily_cap_cents() == 5000
    monkeypatch.setenv("SH_DAILY_SPEND_CAP_CENTS", "-10")
    assert daily_cap_cents() == 5000


# --- today_utc -------------------------------------------------------------


def test_today_utc_returns_yyyy_mm_dd() -> None:
    assert today_utc(datetime(2026, 6, 5, 23, 30, 0, tzinfo=UTC)) == "2026-06-05"


def test_today_utc_converts_non_utc_offset_to_the_utc_day() -> None:
    """Mirrors TS ``now.toISOString().slice(0, 10)``: a +05:00 local moment just
    after midnight is still the *previous* UTC day, so the conversion (not a bare
    ``.date()``) is load-bearing."""
    from datetime import timedelta, timezone

    plus_five = timezone(timedelta(hours=5))
    # 2026-06-06T02:00+05:00 == 2026-06-05T21:00Z
    assert today_utc(datetime(2026, 6, 6, 2, 0, 0, tzinfo=plus_five)) == "2026-06-05"


def test_today_utc_defaults_to_now() -> None:
    # Just confirm shape (offline, no fixed clock): YYYY-MM-DD.
    out = today_utc()
    assert len(out) == 10 and out[4] == "-" and out[7] == "-"


# --- check_spend_allowed ---------------------------------------------------


async def test_check_spend_under_cap_allowed_at_or_over_blocked(
    data_dir, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SH_DAILY_SPEND_CAP_CENTS", "5000")
    now = datetime(2026, 6, 5, 0, 0, 0, tzinfo=UTC)
    day = today_utc(now)

    await _seed(100, day)  # total 100
    assert (await check_spend_allowed(now)).allowed is True

    await _seed(4900, day)  # total 5000 (>= cap)
    assert (await check_spend_allowed(now)).allowed is False

    await _seed(4999, day)  # total 9999
    assert (await check_spend_allowed(now)).allowed is False


async def test_check_spend_fails_open_on_read_error(
    data_dir, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fail-open: a ledger read error returns allowed=True, unknown=True."""

    async def _boom(_day: str) -> float:
        raise OSError("ledger unreadable")

    monkeypatch.setattr(spend_repo, "sumForDay", _boom)
    res = await check_spend_allowed(datetime.now(UTC))
    assert res.allowed is True
    assert res.unknown is True
    assert res.spentCents == -1


async def test_check_spend_fails_open_when_ledger_path_unreadable(
    data_dir, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Point the spend repo's read at an unreadable path -> still fails open."""

    def _explode() -> float:
        raise PermissionError("EACCES")

    # _sum_for_day_sync is the blocking read the async wrapper runs off-thread.
    monkeypatch.setattr(spend_repo, "_sum_for_day_sync", lambda _day: _explode())
    res = await check_spend_allowed(datetime.now(UTC))
    assert res.allowed is True
    assert res.unknown is True


# --- record_spend ----------------------------------------------------------


async def test_record_spend_skips_zero_usage_inserts_nonzero(
    data_dir, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[NewSpend] = []

    async def _insert(e: NewSpend) -> None:
        calls.append(e)

    monkeypatch.setattr(spend_repo, "insert", _insert)

    await record_spend(datetime.now(UTC), model="claude-sonnet-4", input_tokens=0, output_tokens=0)
    assert calls == []

    await record_spend(
        datetime.now(UTC), model="claude-sonnet-4", input_tokens=100, output_tokens=50
    )
    assert len(calls) == 1
    assert calls[0].costCents == cost_cents("claude-sonnet-4", 100, 50)


async def test_record_spend_swallows_write_errors(
    data_dir, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Best-effort: a ledger write failure never propagates."""

    async def _boom(_e: NewSpend) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(spend_repo, "insert", _boom)
    # Must not raise.
    await record_spend(
        datetime.now(UTC), model="claude-sonnet-4", input_tokens=100, output_tokens=50
    )


async def test_record_spend_actually_persists_a_row(data_dir) -> None:
    now = datetime(2026, 6, 5, 12, 0, 0, tzinfo=UTC)
    await record_spend(now, model="gpt-5.5", input_tokens=1_000_000, output_tokens=0)
    total = await spend_repo.sumForDay(today_utc(now))
    assert total == 125  # gpt-5 rate: 125c / 1M in


# --- make_counting_llm -----------------------------------------------------


async def test_counting_llm_accumulates_usage_across_calls() -> None:
    async def _create(params, options=None):
        return LLMResponse(choices=[], usage=Usage(input_tokens=10, output_tokens=4))

    base = make_client(_create)
    counting = make_counting_llm(base, "claude-sonnet-4")
    await counting.llm.chat.completions.create({"model": "claude-sonnet-4", "messages": []})
    await counting.llm.chat.completions.create({"model": "claude-sonnet-4", "messages": []})
    assert counting.usage.inputTokens == 20
    assert counting.usage.outputTokens == 8


async def test_counting_llm_reads_openai_token_aliases() -> None:
    async def _create(params, options=None):
        return LLMResponse(choices=[], usage=Usage(prompt_tokens=7, completion_tokens=3))

    counting = make_counting_llm(make_client(_create), "m")
    await counting.llm.chat.completions.create({"model": "m", "messages": []})
    assert counting.usage.inputTokens == 7
    assert counting.usage.outputTokens == 3


async def test_counting_llm_attributes_serving_model_over_requested() -> None:
    async def _create(params, options=None):
        # The cascade stamps the model that actually served the call.
        return LLMResponse(
            choices=[],
            model="openrouter-served/gpt-5.5",
            usage=Usage(input_tokens=1, output_tokens=1),
        )

    counting = make_counting_llm(make_client(_create), "claude-sonnet-4")
    await counting.llm.chat.completions.create({"model": "claude-sonnet-4", "messages": []})
    assert counting.usage.model == "openrouter-served/gpt-5.5"


async def test_counting_llm_falls_back_to_requested_model_when_response_omits_it() -> None:
    async def _create(params, options=None):
        return LLMResponse(choices=[], usage=Usage(input_tokens=1, output_tokens=1))

    counting = make_counting_llm(make_client(_create), "init-model")
    await counting.llm.chat.completions.create({"model": "requested-model", "messages": []})
    assert counting.usage.model == "requested-model"


def test_make_counting_llm_reexported_from_cascade() -> None:
    # Slice plan groups make_counting_llm under cascade.py; spend re-exports it.
    from simple_harmonic.llm.cascade import make_counting_llm as cascade_mcl

    assert spend_mod.make_counting_llm is cascade_mcl

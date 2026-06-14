"""LLM spend ledger + daily cap.

TS source: packages/backend/src/server/spend.ts

Bounds runaway cost from the autonomous tick loop (the $50/day cap named in
CLAUDE.md). Every agent run records its token usage via :func:`record_spend`;
the tick loop checks the day's total against ``SH_DAILY_SPEND_CAP_CENTS`` with
:func:`check_spend_allowed` before running.

This module is the *write/read* side over the slice-2 spend repo
(:mod:`simple_harmonic.store.repos.spend`). The token-counting wrapper
(:func:`make_counting_llm`) lives in :mod:`simple_harmonic.llm.cascade` and is
re-exported here so callers following the TS import site (``@/server/spend``)
still find it.

FAIL-OPEN (load-bearing): :func:`check_spend_allowed` returns ``allowed=True`` on
ANY ledger READ error (a missing file, an IO hiccup). A missing migration or a
transient fault must not silently halt every team's agents; the runaway-cost
surface is already bounded by hibernate-on-idle and the per-agent tick timeout.
:func:`record_spend` likewise swallows every WRITE error.
"""

from __future__ import annotations

import contextlib
import math
import os
from dataclasses import dataclass
from datetime import UTC, datetime

from simple_harmonic.llm.cascade import (
    CountingLLM,
    UsageAccumulator,
    make_counting_llm,
)
from simple_harmonic.store.repos.spend import NewSpend
from simple_harmonic.store.repos.spend import spend as spend_repo

__all__ = [
    "DEFAULT_DAILY_CAP_CENTS",
    "CountingLLM",
    "SpendStatus",
    "UsageAccumulator",
    "check_spend_allowed",
    "cost_cents",
    "daily_cap_cents",
    "make_counting_llm",
    "record_spend",
    "spent_today_cents",
    "today_utc",
]

DEFAULT_DAILY_CAP_CENTS = 5000


@dataclass(frozen=True)
class _Rate:
    prefix: str
    in_cents: int
    out_cents: int


# Per-1M-token cost in US cents, by model-id prefix. Approximate published list
# prices; the fallback is deliberately expensive so an unknown model over-
# rather than under-counts.
_RATES: tuple[_Rate, ...] = (
    _Rate("claude-sonnet", 300, 1500),
    _Rate("claude-opus", 1500, 7500),
    _Rate("claude-haiku", 80, 400),
    _Rate("gpt-5", 125, 1000),
    _Rate("o4", 110, 440),
)
_FALLBACK_RATE = _Rate("", 1500, 7500)


def cost_cents(model: str, input_tokens: int, output_tokens: int) -> int:
    """Cost in (rounded-up) cents for a single call's token usage."""
    m = (model or "").lower()
    # OpenRouter ids are vendor-namespaced ("anthropic/claude-sonnet-4"); strip
    # the namespace so they hit the same rate rows as direct API ids.
    bare = m[m.index("/") + 1 :] if "/" in m else m
    rate = next((r for r in _RATES if bare.startswith(r.prefix)), _FALLBACK_RATE)
    cents = (input_tokens * rate.in_cents + output_tokens * rate.out_cents) / 1_000_000
    return math.ceil(cents)


def daily_cap_cents() -> int:
    """Daily ceiling in cents. Default 5000 (= $50). Read straight from
    ``SH_DAILY_SPEND_CAP_CENTS`` (mirrors the TS ``Number.parseInt`` parse: a
    non-numeric or non-positive value falls back to the default)."""
    raw = os.environ.get("SH_DAILY_SPEND_CAP_CENTS", "")
    try:
        v = int(raw, 10)
    except ValueError:
        return DEFAULT_DAILY_CAP_CENTS
    return v if v > 0 else DEFAULT_DAILY_CAP_CENTS


def today_utc(now: datetime | None = None) -> str:
    """UTC calendar day, YYYY-MM-DD. Defaults to ``datetime.now(UTC)``."""
    moment = now if now is not None else datetime.now(UTC)
    return moment.astimezone(UTC).date().isoformat()


async def spent_today_cents(now: datetime | None = None) -> float:
    return await spend_repo.sumForDay(today_utc(now))


@dataclass
class SpendStatus:
    allowed: bool
    spentCents: float
    capCents: int
    # True when the ledger could not be read (spentCents is unknown).
    unknown: bool = False


async def check_spend_allowed(now: datetime | None = None) -> SpendStatus:
    """Whether another tick is within today's budget.

    On a ledger READ error this deliberately fails OPEN — see the module
    docstring. The cap re-engages as soon as the ledger is readable again.
    """
    cap_cents = daily_cap_cents()
    try:
        spent = await spent_today_cents(now)
        return SpendStatus(allowed=spent < cap_cents, spentCents=spent, capCents=cap_cents)
    except Exception:
        return SpendStatus(allowed=True, spentCents=-1, capCents=cap_cents, unknown=True)


async def record_spend(
    now: datetime | None,
    *,
    model: str,
    input_tokens: int,
    output_tokens: int,
    team_id: str | None = None,
    agent_id: str | None = None,
) -> None:
    """Append one usage row. Best-effort: a ledger write failure never breaks a
    tick. Zero-usage rows are skipped."""
    if input_tokens <= 0 and output_tokens <= 0:
        return
    # best-effort: a ledger write failure never breaks a tick
    with contextlib.suppress(Exception):
        await spend_repo.insert(
            NewSpend(
                teamId=team_id,
                agentId=agent_id,
                model=model,
                inputTokens=input_tokens,
                outputTokens=output_tokens,
                costCents=cost_cents(model, input_tokens, output_tokens),
                day=today_utc(now),
            )
        )

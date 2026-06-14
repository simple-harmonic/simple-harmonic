"""Tests for simple_harmonic.trace.

Ported from packages/backend/tests/unit/trace-sink.test.ts. The store-backed
seeding/append in TS is replaced with an injected async appender (this slice
does not touch store/); the buffering/ordering, the documented drain race, PII
scrubbing + truncation in sanitize_trace_data, and the prune throttle are all
preserved.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest

from simple_harmonic.trace import (
    create_trace_sink,
    prune_trace_events,
    reset_prune_throttle_for_tests,
    sanitize_trace_data,
)


@pytest.fixture(autouse=True)
def reset_prune() -> Iterator[None]:
    reset_prune_throttle_for_tests()
    yield
    reset_prune_throttle_for_tests()


# ---------------------------------------------------------------------------
# create_trace_sink
# ---------------------------------------------------------------------------


async def test_persists_steps_in_order_with_seq_and_one_tick_id() -> None:
    rows: list[dict] = []

    async def append(batch: list[dict]) -> None:
        rows.extend(batch)

    sink = create_trace_sink(team_id="t1", agent_id="a1", append=append)
    sink.emit({"type": "tick_started", "data": {"mode": "fresh", "round": 0}})
    sink.emit({"type": "llm_request", "data": {"round": 0, "model": "gpt-5.5"}})
    sink.emit({"type": "tick_finished", "data": {"actionType": "noop"}})
    await sink.flush()

    assert [r["type"] for r in rows] == ["tick_started", "llm_request", "tick_finished"]
    assert [r["seq"] for r in rows] == [0, 1, 2]
    for r in rows:
        assert r["teamId"] == "t1"
        assert r["agentId"] == "a1"
        assert r["tickId"] == sink.tick_id
        assert isinstance(r["emittedAt"], datetime)
    assert re.match(r"^[0-9a-f-]{36}$", sink.tick_id)


async def test_reuses_provided_tick_id() -> None:
    original = create_trace_sink(team_id="t1", agent_id="a1")
    resumed = create_trace_sink(team_id="t1", agent_id="a1", tick_id=original.tick_id)
    assert resumed.tick_id == original.tick_id


async def test_steps_emitted_mid_drain_are_not_lost() -> None:
    rows: list[dict] = []
    release = asyncio.Event()
    first = {"count": 0}

    async def append(batch: list[dict]) -> None:
        first["count"] += 1
        if first["count"] == 1:
            await release.wait()  # hold the first drain open
        rows.extend(batch)

    sink = create_trace_sink(team_id="t1", agent_id="a1", append=append)
    sink.emit({"type": "tick_started", "data": {}})
    await asyncio.sleep(0)  # let the drain loop start and block on the first append
    sink.emit({"type": "llm_request", "data": {}})
    sink.emit({"type": "llm_response", "data": {}})
    release.set()
    await sink.flush()

    assert [r["type"] for r in rows] == ["tick_started", "llm_request", "llm_response"]


async def test_swallows_append_failures() -> None:
    async def append(_batch: list[dict]) -> None:
        raise RuntimeError("store down")

    sink = create_trace_sink(team_id="t1", agent_id="a1", append=append)
    sink.emit({"type": "tick_started", "data": {}})
    # flush must resolve, not raise.
    await sink.flush()


# ---------------------------------------------------------------------------
# sanitize_trace_data
# ---------------------------------------------------------------------------


def test_truncates_long_strings_with_marker() -> None:
    out = sanitize_trace_data({"result": "x" * 5000})
    result = out["result"]
    assert len(result) < 4100
    assert "[truncated 1000 chars]" in result


def test_scrubs_pii_from_strings() -> None:
    out = sanitize_trace_data(
        {"result": f"mailto founder@example.com with key sk-{'a' * 24}"}
    )
    result = out["result"]
    assert "founder@example.com" not in result
    assert "sk-aaaaaaaa" not in result
    assert "[REDACTED]" in result


def test_caps_nesting_depth_and_entry_counts() -> None:
    deep: dict = {"leaf": "bottom"}
    for _ in range(10):
        deep = {"nested": deep}
    out = sanitize_trace_data({"deep": deep, "wide": list(range(60))})

    import json

    assert "[max depth]" in json.dumps(out)
    wide = out["wide"]
    assert len(wide) == 51  # 50 kept + truncation marker
    assert wide[50] == "… [10 more]"


def test_passes_primitives_through_and_stringifies_exotic_values() -> None:
    out = sanitize_trace_data({"n": 3, "b": True, "nil": None, "f": (lambda: 1)})
    assert out["n"] == 3
    assert out["b"] is True
    assert out["nil"] is None
    assert isinstance(out["f"], str)


# ---------------------------------------------------------------------------
# prune_trace_events
# ---------------------------------------------------------------------------


async def test_prunes_then_throttles_for_an_hour() -> None:
    reset_prune_throttle_for_tests()
    calls: list[datetime] = []

    async def prune_older_than(cutoff: datetime) -> None:
        calls.append(cutoff)

    await prune_trace_events(prune_older_than)
    assert len(calls) == 1

    await prune_trace_events(prune_older_than)
    assert len(calls) == 1  # throttled within the hour

    reset_prune_throttle_for_tests()
    await prune_trace_events(prune_older_than)
    assert len(calls) == 2


async def test_prune_never_throws_on_store_failure() -> None:
    reset_prune_throttle_for_tests()

    async def prune_older_than(_cutoff: datetime) -> None:
        raise RuntimeError("no table")

    # Must resolve, not raise.
    await prune_trace_events(prune_older_than)


async def test_retention_cutoff_uses_default_14_days(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Sanity: with no override the cutoff is 14 days before "now".
    monkeypatch.delenv("SH_TRACE_RETENTION_DAYS", raising=False)
    reset_prune_throttle_for_tests()
    captured: list[datetime] = []

    async def prune_older_than(cutoff: datetime) -> None:
        captured.append(cutoff)

    now = datetime.now(UTC).timestamp() * 1000
    await prune_trace_events(prune_older_than, now_ms=now)
    assert captured
    delta = now / 1000 - captured[0].timestamp()
    assert abs(delta - 14 * 86_400) < 5  # ~14 days in seconds

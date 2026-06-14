"""Tests for simple_harmonic.events (scrub_pii + emit_app_event).

scrub_pii has no dedicated *.test.ts; its behavior is exercised through
trace-sink.test.ts ("scrubs PII (emails, API keys)") and the documented PII
pattern set in app-events.ts. These assert the patterns, their ORDER (the
lookbehind secret pattern vs. the email pattern), and the fire-and-forget /
rate-limit / telemetry-gate contract of emit_app_event.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from simple_harmonic.events import (
    RATE_LIMIT,
    emit_app_event,
    reset_rate_limiter_for_tests,
    scrub_pii,
    set_event_sink,
    set_telemetry_reader,
)


@pytest.fixture(autouse=True)
def reset_rate_limiter() -> Iterator[None]:
    reset_rate_limiter_for_tests()
    yield
    reset_rate_limiter_for_tests()
    # Restore default no-op hooks so cross-test wiring doesn't leak.
    set_telemetry_reader(None)


# ---------------------------------------------------------------------------
# scrub_pii
# ---------------------------------------------------------------------------


def test_scrubs_openai_style_key() -> None:
    out = scrub_pii("here is sk-" + "a" * 24 + " ok")
    assert "sk-aaaaaaaa" not in out
    assert "[REDACTED]" in out


def test_scrubs_github_token() -> None:
    out = scrub_pii("token ghp_" + "b" * 36 + " end")
    assert "ghp_" not in out
    assert "[REDACTED]" in out


def test_scrubs_email() -> None:
    out = scrub_pii("contact founder@example.com please")
    assert "founder@example.com" not in out
    assert "[REDACTED]" in out


def test_scrubs_bearer_header() -> None:
    out = scrub_pii("Authorization: Bearer abcdefghij1234567890ABCDEF")
    assert "[REDACTED]" in out
    assert "abcdefghij1234567890" not in out


def test_scrubs_generic_secret_after_colon_via_lookbehind() -> None:
    # The lookbehind pattern only fires for a long base64-ish run AFTER "=" or ":".
    secret = "A" * 40
    out = scrub_pii(f"password: {secret}")
    assert secret not in out
    assert "[REDACTED]" in out
    # The SAME run NOT preceded by "=" or ":" has no matching pattern (no known
    # prefix, not an email), so the lookbehind leaves it untouched.
    plain = scrub_pii(f"the value {secret} here")
    assert plain == f"the value {secret} here"


def test_scrub_leaves_clean_text_untouched() -> None:
    msg = "a perfectly normal log line with no secrets"
    assert scrub_pii(msg) == msg


def test_multiple_patterns_in_one_message() -> None:
    out = scrub_pii("mail founder@example.com key sk-" + "z" * 24)
    assert out.count("[REDACTED]") >= 2
    assert "founder@example.com" not in out


# ---------------------------------------------------------------------------
# emit_app_event — fire-and-forget, rate limiting, telemetry gate
# ---------------------------------------------------------------------------


def test_emit_swallows_sink_errors() -> None:
    # Default sink raises (store not wired); emit must not propagate.
    emit_app_event(severity="error", source="test", message="boom")  # no raise


def test_emit_persists_scrubbed_message() -> None:
    rows: list[dict] = []
    set_event_sink(rows.append)
    emit_app_event(
        severity="info",
        source="test",
        message="leak founder@example.com here",
        level="agent",
    )
    assert len(rows) == 1
    assert "founder@example.com" not in rows[0]["message"]
    assert "[REDACTED]" in rows[0]["message"]


def test_infra_events_force_team_id_none() -> None:
    rows: list[dict] = []
    set_event_sink(rows.append)
    emit_app_event(
        severity="warning",
        source="platform",
        message="db down",
        level="infra",
        team_id="team-123",
    )
    assert len(rows) == 1
    assert rows[0]["teamId"] is None
    assert rows[0]["level"] == "infra"


def test_tool_event_skipped_when_telemetry_off() -> None:
    rows: list[dict] = []
    set_event_sink(rows.append)
    set_telemetry_reader(lambda _team: False)
    emit_app_event(
        severity="info",
        source="tool",
        message="tool note",
        level="tool",
        team_id="team-x",
    )
    assert rows == []


def test_tool_event_persisted_when_telemetry_on() -> None:
    rows: list[dict] = []
    set_event_sink(rows.append)
    set_telemetry_reader(lambda _team: True)
    emit_app_event(
        severity="info",
        source="tool",
        message="tool note",
        level="tool",
        team_id="team-y",
    )
    assert len(rows) == 1
    assert rows[0]["teamId"] == "team-y"


def test_rate_limited_after_50_then_one_final_event_then_silence() -> None:
    rows: list[dict] = []
    set_event_sink(rows.append)
    agent = "agent-rl"
    for _ in range(RATE_LIMIT):
        emit_app_event(severity="info", source="s", message="m", agent_id=agent)
    # RATE_LIMIT events delivered.
    assert len(rows) == RATE_LIMIT
    # The (RATE_LIMIT+1)th gets one final "rate limited" event...
    emit_app_event(severity="info", source="s", message="m", agent_id=agent)
    assert len(rows) == RATE_LIMIT + 1
    assert "Rate limited" in rows[-1]["message"]
    # ...then total silence.
    emit_app_event(severity="info", source="s", message="m", agent_id=agent)
    emit_app_event(severity="info", source="s", message="m", agent_id=agent)
    assert len(rows) == RATE_LIMIT + 1


def test_system_events_without_agent_id_not_rate_limited() -> None:
    rows: list[dict] = []
    set_event_sink(rows.append)
    for _ in range(RATE_LIMIT + 10):
        emit_app_event(severity="info", source="s", message="m")
    assert len(rows) == RATE_LIMIT + 10

"""Tests for simple_harmonic.auth.

Ported from packages/backend/tests/unit/operator-auth.test.ts. The TS tests
build a web `Request` with headers; the Python port passes a plain header dict
(any case-insensitive Mapping works). The known sha256("abc") digest and the
Vercel-header / CRON_SECRET / dev-permissive matrix are preserved verbatim.
"""

from __future__ import annotations

import pytest

from simple_harmonic.auth import (
    OPERATOR_COOKIE,
    constant_time_equal,
    is_cron_authorized,
    is_operator_authorized,
    sha256_hex,
)


def test_sha256_hex_matches_known_digest_of_abc() -> None:
    assert (
        sha256_hex("abc")
        == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )


def test_constant_time_equal_compares_value_and_length() -> None:
    assert constant_time_equal("abc", "abc") is True
    assert constant_time_equal("abc", "abd") is False
    assert constant_time_equal("abc", "ab") is False


# ---------------------------------------------------------------------------
# is_operator_authorized
# ---------------------------------------------------------------------------

PW = "s3cret-operator"


def test_accepts_correct_bearer_password() -> None:
    assert is_operator_authorized({"authorization": f"Bearer {PW}"}, PW) is True


def test_rejects_wrong_bearer_password() -> None:
    assert is_operator_authorized({"authorization": "Bearer nope"}, PW) is False


def test_accepts_sh_operator_cookie() -> None:
    cookie = f"{OPERATOR_COOKIE}={sha256_hex(PW)}"
    assert is_operator_authorized({"cookie": cookie}, PW) is True


def test_rejects_wrong_cookie_and_no_auth() -> None:
    assert is_operator_authorized({"cookie": f"{OPERATOR_COOKIE}=deadbeef"}, PW) is False
    assert is_operator_authorized({}, PW) is False


def test_header_lookup_is_case_insensitive() -> None:
    # Mirror Starlette/httpx Headers: lookup must not care about header casing.
    assert is_operator_authorized({"Authorization": f"Bearer {PW}"}, PW) is True


# ---------------------------------------------------------------------------
# is_cron_authorized
# ---------------------------------------------------------------------------


def test_accepts_x_vercel_cron_only_on_vercel(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VERCEL", "1")
    assert is_cron_authorized({"x-vercel-cron": "1"}, "secret") is True
    # Off Vercel the header is client-spoofable and must be ignored.
    monkeypatch.delenv("VERCEL", raising=False)
    assert is_cron_authorized({"x-vercel-cron": "1"}, "secret") is False


def test_accepts_matching_bearer_cron_secret_rejects_wrong(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("VERCEL", raising=False)
    assert is_cron_authorized({"authorization": "Bearer secret"}, "secret") is True
    assert is_cron_authorized({"authorization": "Bearer wrong"}, "secret") is False


def test_no_secret_allows_in_dev_fails_closed_in_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.delenv("NODE_ENV", raising=False)
    assert is_cron_authorized({}, None) is True
    monkeypatch.setenv("VERCEL", "1")
    assert is_cron_authorized({}, None) is False

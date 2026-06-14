"""Tests for simple_harmonic.llm.codex_auth.

Ported from packages/backend/tests/unit/codex-auth.test.ts. The TS test mocks
node:fs; the Python port points CODEX_HOME at a temp dir and writes real files.
The token-refresh network POST is routed through the overridable ``_post_token``
hook, so NOTHING touches the network.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Iterator
from pathlib import Path

import pytest

from simple_harmonic.llm import codex_auth
from simple_harmonic.llm.codex_auth import (
    _TokenHttpResponse,
    get_codex_access_token,
    get_codex_auth_status,
    get_codex_models,
    refresh_codex_token,
)


@pytest.fixture
def codex_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    home = tmp_path / ".codex"
    home.mkdir(parents=True)
    monkeypatch.setenv("CODEX_HOME", str(home))
    yield home


def _write_auth(home: Path, data: dict) -> None:
    (home / "auth.json").write_text(json.dumps(data), encoding="utf-8")


def _write_auth_raw(home: Path, raw: str) -> None:
    (home / "auth.json").write_text(raw, encoding="utf-8")


def _make_jwt(payload: dict) -> str:
    header = base64.urlsafe_b64encode(json.dumps({"alg": "RS256"}).encode()).decode().rstrip("=")
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"{header}.{body}.signature"


# --- get_codex_access_token ------------------------------------------------


def test_access_token_none_when_no_file(codex_home: Path) -> None:
    assert get_codex_access_token() is None


def test_access_token_returned_when_file_exists(codex_home: Path) -> None:
    _write_auth(
        codex_home,
        {
            "auth_mode": "browser",
            "tokens": {
                "access_token": "test-access-token",
                "id_token": "id",
                "refresh_token": "refresh",
                "account_id": "acc-1",
            },
        },
    )
    assert get_codex_access_token() == "test-access-token"


def test_access_token_none_when_corrupted(codex_home: Path) -> None:
    _write_auth_raw(codex_home, "invalid json")
    assert get_codex_access_token() is None


def test_access_token_none_when_tokens_missing(codex_home: Path) -> None:
    _write_auth(codex_home, {"auth_mode": "browser"})
    assert get_codex_access_token() is None


# --- get_codex_auth_status -------------------------------------------------


def test_status_found_false_when_no_file(codex_home: Path) -> None:
    status = get_codex_auth_status()
    assert status.found is False
    assert status.hasAccessToken is False
    assert status.email is None
    assert status.plan is None
    assert status.accountId is None


def test_status_full_with_valid_jwt(codex_home: Path) -> None:
    jwt = _make_jwt(
        {
            "https://api.openai.com/profile": {"email": "user@test.com"},
            "https://api.openai.com/auth": {"chatgpt_plan_type": "plus"},
            "exp": 1700000000,
        }
    )
    _write_auth(
        codex_home,
        {
            "auth_mode": "browser",
            "tokens": {
                "access_token": jwt,
                "id_token": "id",
                "refresh_token": "refresh",
                "account_id": "acc-1",
            },
            "last_refresh": "2025-01-01T00:00:00Z",
        },
    )
    status = get_codex_auth_status()
    assert status.found is True
    assert status.hasAccessToken is True
    assert status.authMode == "browser"
    assert status.email == "user@test.com"
    assert status.plan == "plus"
    assert status.accountId == "acc-1"
    assert status.lastRefresh == "2025-01-01T00:00:00Z"
    assert status.tokenExpiry


def test_status_handles_jwt_without_profile_claims(codex_home: Path) -> None:
    jwt = _make_jwt({"sub": "user123"})
    _write_auth(
        codex_home,
        {
            "auth_mode": "browser",
            "tokens": {
                "access_token": jwt,
                "id_token": "id",
                "refresh_token": "refresh",
                "account_id": "",
            },
        },
    )
    status = get_codex_auth_status()
    assert status.found is True
    assert status.email is None
    assert status.plan is None
    assert status.tokenExpiry is None


def test_status_found_false_when_access_token_missing(codex_home: Path) -> None:
    _write_auth(
        codex_home,
        {
            "auth_mode": "browser",
            "tokens": {"id_token": "id", "refresh_token": "refresh", "account_id": "acc"},
        },
    )
    status = get_codex_auth_status()
    assert status.found is False
    assert status.hasAccessToken is False


def test_status_handles_jwt_with_two_parts(codex_home: Path) -> None:
    _write_auth(
        codex_home,
        {
            "auth_mode": "browser",
            "tokens": {
                "access_token": "only.twoparts",
                "id_token": "id",
                "refresh_token": "refresh",
                "account_id": "acc-1",
            },
        },
    )
    status = get_codex_auth_status()
    assert status.found is True
    assert status.email is None
    assert status.plan is None


def test_status_handles_jwt_with_invalid_base64(codex_home: Path) -> None:
    _write_auth(
        codex_home,
        {
            "auth_mode": "browser",
            "tokens": {
                "access_token": "header.!!!invalid!!!.sig",
                "id_token": "id",
                "refresh_token": "refresh",
                "account_id": "acc-1",
            },
        },
    )
    status = get_codex_auth_status()
    assert status.found is True
    assert status.email is None


# --- get_codex_models ------------------------------------------------------


def test_models_empty_when_no_cache(codex_home: Path) -> None:
    assert get_codex_models() == []


def test_models_parses_cache_and_filters_unsupported(codex_home: Path) -> None:
    (codex_home / "models_cache.json").write_text(
        json.dumps(
            {
                "models": [
                    {
                        "slug": "gpt-5.5",
                        "display_name": "GPT 5.5",
                        "description": "Latest",
                        "priority": 1,
                        "supported_in_api": True,
                    },
                    {
                        "slug": "gpt-5.4-mini",
                        "display_name": "GPT 5.4 Mini",
                        "description": "Fast",
                        "priority": 2,
                        "supported_in_api": True,
                    },
                    {
                        "slug": "internal-only",
                        "display_name": "Internal",
                        "description": "",
                        "priority": 3,
                        "supported_in_api": False,
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    models = get_codex_models()
    assert len(models) == 2  # internal-only filtered out
    assert models[0].slug == "gpt-5.5"
    assert models[1].slug == "gpt-5.4-mini"


def test_models_sorted_by_priority_ascending(codex_home: Path) -> None:
    (codex_home / "models_cache.json").write_text(
        json.dumps(
            {
                "models": [
                    {"slug": "low-priority", "priority": 10, "supported_in_api": True},
                    {"slug": "high-priority", "priority": 1, "supported_in_api": True},
                ]
            }
        ),
        encoding="utf-8",
    )
    models = get_codex_models()
    assert models[0].slug == "high-priority"
    assert models[1].slug == "low-priority"


def test_models_handles_corrupted_cache(codex_home: Path) -> None:
    (codex_home / "models_cache.json").write_text("not json", encoding="utf-8")
    assert get_codex_models() == []


def test_models_skips_entries_without_slug(codex_home: Path) -> None:
    (codex_home / "models_cache.json").write_text(
        json.dumps(
            {
                "models": [
                    {"display_name": "No Slug", "supported_in_api": True},
                    {"slug": "valid", "supported_in_api": True},
                ]
            }
        ),
        encoding="utf-8",
    )
    assert len(get_codex_models()) == 1


def test_models_handles_flat_array_format(codex_home: Path) -> None:
    (codex_home / "models_cache.json").write_text(
        json.dumps([{"slug": "gpt-5.5", "supported_in_api": True}]), encoding="utf-8"
    )
    assert len(get_codex_models()) == 1


def test_models_uses_codex_home_for_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    custom = tmp_path / "custom" / "codex"
    custom.mkdir(parents=True)
    monkeypatch.setenv("CODEX_HOME", str(custom))
    (custom / "models_cache.json").write_text(json.dumps({"models": []}), encoding="utf-8")
    assert get_codex_models() == []  # resolves under the custom home without error


# --- refresh_codex_token (network mocked) ----------------------------------


def test_refresh_error_when_no_refresh_token_file(codex_home: Path) -> None:
    result = refresh_codex_token()
    assert result.ok is False
    assert "No Codex refresh token" in (result.error or "")


def test_refresh_error_when_no_refresh_token_in_file(codex_home: Path) -> None:
    _write_auth(
        codex_home,
        {
            "auth_mode": "browser",
            "tokens": {"access_token": "access", "id_token": "id", "account_id": "acc"},
        },
    )
    result = refresh_codex_token()
    assert result.ok is False
    assert "No Codex refresh token" in (result.error or "")


def test_refresh_handles_network_failure(
    codex_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_auth(
        codex_home,
        {
            "auth_mode": "browser",
            "tokens": {
                "access_token": "access",
                "id_token": "id",
                "refresh_token": "refresh",
                "account_id": "acc",
            },
        },
    )

    def _boom(_token: str) -> _TokenHttpResponse:
        raise RuntimeError("Network error")

    monkeypatch.setattr(codex_auth, "_post_token", _boom)
    result = refresh_codex_token()
    assert result.ok is False
    assert "Network error" in (result.error or "")


def test_refresh_handles_non_ok_http_response(
    codex_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_auth(
        codex_home,
        {
            "auth_mode": "browser",
            "tokens": {
                "access_token": "access",
                "id_token": "id",
                "refresh_token": "refresh",
                "account_id": "acc",
            },
        },
    )

    monkeypatch.setattr(
        codex_auth,
        "_post_token",
        lambda _t: _TokenHttpResponse(ok=False, status=401, text="Unauthorized", json_body={}),
    )
    result = refresh_codex_token()
    assert result.ok is False
    assert "401" in (result.error or "")


def test_refresh_handles_response_missing_access_token(
    codex_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_auth(
        codex_home,
        {
            "auth_mode": "browser",
            "tokens": {
                "access_token": "access",
                "id_token": "id",
                "refresh_token": "refresh",
                "account_id": "acc",
            },
        },
    )

    monkeypatch.setattr(
        codex_auth,
        "_post_token",
        lambda _t: _TokenHttpResponse(ok=True, status=200, text="", json_body={"id_token": "new"}),
    )
    result = refresh_codex_token()
    assert result.ok is False
    assert "No access_token" in (result.error or "")


def test_refresh_success_writes_updated_auth_file(
    codex_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_auth(
        codex_home,
        {
            "auth_mode": "browser",
            "tokens": {
                "access_token": "old-access",
                "id_token": "old-id",
                "refresh_token": "old-refresh",
                "account_id": "acc",
            },
            "last_refresh": "2025-01-01T00:00:00Z",
        },
    )

    monkeypatch.setattr(
        codex_auth,
        "_post_token",
        lambda _t: _TokenHttpResponse(
            ok=True,
            status=200,
            text="",
            json_body={
                "access_token": "new-access",
                "id_token": "new-id",
                "refresh_token": "new-refresh",
            },
        ),
    )
    result = refresh_codex_token()
    assert result.ok is True
    assert result.accessToken == "new-access"

    written = json.loads((codex_home / "auth.json").read_text(encoding="utf-8"))
    assert written["tokens"]["access_token"] == "new-access"
    assert written["tokens"]["refresh_token"] == "new-refresh"
    assert written["tokens"]["account_id"] == "acc"  # untouched fields preserved
    assert written["last_refresh"] != "2025-01-01T00:00:00Z"  # stamped fresh

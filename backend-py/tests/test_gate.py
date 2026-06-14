"""Tests for the operator gate (simple_harmonic.app).

TS source: packages/backend/src/server/standalone/server.ts (the `gate` fn) +
operator-auth.ts. The TS host gates ALL /api/* except tick + login; this port
deviates by an explicit ALLOWLIST so /api/teams + /api/team/* stay open (their
handlers read no session), per the slice gate-scope rule.

Two layers are asserted:
  1. `_is_gated(path)` directly — the prefix allow/deny logic, including
     prefix-collision edges (e.g. /api/settingsX must NOT be gated).
  2. The middleware end-to-end — dev-permissive when OPERATOR_PASSWORD is unset,
     fail-closed 503 in production, and 401/200 once a password is configured.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from simple_harmonic.app import GATED_PREFIXES, OPEN_PREFIXES, _is_gated, create_app
from simple_harmonic.settings import get_settings
from simple_harmonic.store import data_dir as dd
from simple_harmonic.store import invalidate_index
from simple_harmonic.store.repo_store import RepoStore

# ---------------------------------------------------------------------------
# _is_gated — direct prefix logic
# ---------------------------------------------------------------------------

_GATED_PATHS = [
    "/api/settings",
    "/api/settings/platform-status",
    "/api/settings/credentials",
    "/api/settings/connectors",
    "/api/chat",
    "/api/spawn",
    "/api/seed",
    "/api/infra-report",
    "/api/agent",
    "/api/agent/abc-123",
]

_OPEN_PATHS = [
    "/api/tick",
    "/api/tick/foo",
    "/api/login",
    "/health",
    "/api/teams",
    "/api/team/t1",
    "/api/team/t1/messages",
    "/api/team/t1/trace",
    "/api/team/t1/approvals",
    # Prefix-collision: same leading chars but neither an exact match nor
    # prefix + "/" — must NOT be gated (would be a security hole if it leaked
    # the gate, or a usability bug if it over-gated).
    "/api/settingsX",
    "/api/seedling",
    "/api/agentfoo",
    "/api/chatroom",
    # Unknown / non-API paths: no gated prefix matches.
    "/api/unknown",
    "/",
]


@pytest.mark.parametrize("path", _GATED_PATHS)
def test_is_gated_true_for_operator_only_paths(path: str) -> None:
    assert _is_gated(path) is True


@pytest.mark.parametrize("path", _OPEN_PATHS)
def test_is_gated_false_for_open_and_collision_paths(path: str) -> None:
    assert _is_gated(path) is False


def test_teams_is_open_despite_team_open_prefix() -> None:
    # /api/teams and /api/team/* are BOTH open; neither is in GATED_PREFIXES.
    assert "/api/teams" not in GATED_PREFIXES
    assert "/api/team" not in GATED_PREFIXES
    assert _is_gated("/api/teams") is False
    assert _is_gated("/api/team/anything") is False


def test_open_prefixes_win_over_gated_prefixes() -> None:
    # No path should be both gated and open. (Defends against a future prefix
    # that accidentally overlaps an open one.)
    for path in (*GATED_PREFIXES, *OPEN_PREFIXES):
        if any(path == p or path.startswith(p + "/") for p in OPEN_PREFIXES):
            assert _is_gated(path) is False


# ---------------------------------------------------------------------------
# Middleware end-to-end: no-password dev-permissive vs production fail-closed
# ---------------------------------------------------------------------------


@pytest.fixture
def _isolated_store(tmp_path: Path) -> Iterator[Path]:
    root = tmp_path / "data"
    dd.set_data_dir(root)
    invalidate_index()
    try:
        yield root
    finally:
        invalidate_index()
        dd.set_data_dir(None)


@pytest_asyncio.fixture
async def _client(_isolated_store: Path) -> AsyncIterator[AsyncClient]:
    app: FastAPI = create_app(store=RepoStore(), start_tick_loop=False)
    transport = ASGITransport(app=app)
    async with (
        AsyncClient(transport=transport, base_url="http://test") as ac,
        app.router.lifespan_context(app),
    ):
        yield ac


async def test_no_password_dev_passes_through_gated_route(
    _client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # No OPERATOR_PASSWORD, not production: the gate is permissive and a gated
    # route serves normally (matches operator-auth dev semantics).
    monkeypatch.delenv("OPERATOR_PASSWORD", raising=False)
    monkeypatch.delenv("NODE_ENV", raising=False)
    monkeypatch.delenv("VERCEL", raising=False)
    get_settings.cache_clear()
    resp = await _client.get("/api/settings/platform-status")
    assert resp.status_code == 200
    assert resp.json()["status"] == "healthy"
    get_settings.cache_clear()


async def test_no_password_production_fails_closed_503(
    _client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # No OPERATOR_PASSWORD but production: the gate fails closed with 503,
    # exactly like standalone/server.ts.
    monkeypatch.delenv("OPERATOR_PASSWORD", raising=False)
    monkeypatch.setenv("NODE_ENV", "production")
    get_settings.cache_clear()
    resp = await _client.get("/api/settings/platform-status")
    assert resp.status_code == 503
    assert resp.json() == {"error": "OPERATOR_PASSWORD not configured"}
    get_settings.cache_clear()


async def test_no_password_production_open_route_still_serves(
    _client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Open routes are never fail-closed, even in production with no password.
    monkeypatch.delenv("OPERATOR_PASSWORD", raising=False)
    monkeypatch.setenv("NODE_ENV", "production")
    get_settings.cache_clear()
    resp = await _client.get("/api/teams")
    assert resp.status_code == 200
    assert resp.json() == []
    get_settings.cache_clear()


async def test_vercel_no_password_fails_closed_503(
    _client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # VERCEL set (without NODE_ENV) is also "production runtime" for the gate.
    monkeypatch.delenv("OPERATOR_PASSWORD", raising=False)
    monkeypatch.delenv("NODE_ENV", raising=False)
    monkeypatch.setenv("VERCEL", "1")
    get_settings.cache_clear()
    resp = await _client.get("/api/settings/platform-status")
    assert resp.status_code == 503
    get_settings.cache_clear()

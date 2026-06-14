"""Pytest fixtures.

Isolates the JSON store under a temp dir so tests never touch the real
.simple-harmonic/data/ tree, and builds the app over that store.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from simple_harmonic.app import create_app
from simple_harmonic.settings import get_settings
from simple_harmonic.store import data_dir as dd
from simple_harmonic.store import invalidate_index
from simple_harmonic.store.repo_store import RepoStore

# Shared operator password for gated-route tests. The gate reads it from
# Settings.operator_password (env OPERATOR_PASSWORD), and the bearer token /
# sh_operator cookie are derived from it.
OPERATOR_PASSWORD = "test-operator-pw"


@pytest.fixture
def data_dir(tmp_path: Path) -> Iterator[Path]:
    """Point the store at an isolated temp data dir for the duration of a test.

    The location-index cache is a process-global, so it is dropped around every
    test (the repo-backed store reads through it).
    """
    root = tmp_path / "data"
    dd.set_data_dir(root)
    invalidate_index()
    try:
        yield root
    finally:
        invalidate_index()
        dd.set_data_dir(None)


@pytest.fixture
def operator_password(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    """Configure OPERATOR_PASSWORD so the gate is active, and clear the cached
    Settings so the new env value is picked up. Cache is reset on teardown."""
    monkeypatch.setenv("OPERATOR_PASSWORD", OPERATOR_PASSWORD)
    get_settings.cache_clear()
    try:
        yield OPERATOR_PASSWORD
    finally:
        get_settings.cache_clear()


@pytest.fixture
def app(data_dir: Path) -> FastAPI:
    # Repoint the shared a2ax instance at the isolated data dir, and never start
    # the background tick loop in tests (it would self-drive run_tick).
    from simple_harmonic.a2ax_singleton import reset_a2ax_for_tests

    reset_a2ax_for_tests()
    return create_app(store=RepoStore(), start_tick_loop=False)


@pytest_asyncio.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    """httpx client over the in-process ASGI app — no sockets, fully offline."""
    transport = ASGITransport(app=app)
    # Enter the app's lifespan (store.ensure) alongside the httpx client.
    async with (
        AsyncClient(transport=transport, base_url="http://test") as ac,
        app.router.lifespan_context(app),
    ):
        yield ac

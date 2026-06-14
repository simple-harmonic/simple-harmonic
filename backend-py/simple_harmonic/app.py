"""FastAPI application factory.

TS source: packages/backend/src/server/server.ts (createBackendServer) +
           routes.ts + standalone/server.ts (the operator gate). The Python
host owns its own port/lifecycle via uvicorn.

Create the app with `create_app()`; the ASGI entry point is `app` below so
`uv run uvicorn simple_harmonic.app:app` works out of the box.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

from simple_harmonic import __version__
from simple_harmonic.auth import is_operator_authorized, is_production_runtime
from simple_harmonic.routes import core, health, login, settings, team, teams
from simple_harmonic.settings import get_settings
from simple_harmonic.store.base import Store
from simple_harmonic.store.repo_store import RepoStore
from simple_harmonic.wiring import wire_runtime

# ---------------------------------------------------------------------------
# Operator gate (gate-scope rule).
#
# The shared OPERATOR_PASSWORD gates the operator-only surface: settings/*,
# chat, spawn, seed, infra-report, agent/{id}. It explicitly SKIPS:
#   - /api/tick      (cron-gated separately via is_cron_authorized)
#   - /api/login     (public — the operator authenticates here)
#   - /health        (liveness probe)
#   - /api/teams and team/*  (the TS handlers read no session)
#
# Unlike the broad TS standalone/proxy gate (everything under /api/* minus tick
# + login), this port gates by an explicit ALLOWLIST of operator-only prefixes
# so teams stays open per the rule. New operator-only routes opt in by prefix.
# Enforcement is permissive in local dev when the password is unset and fails
# closed in production (matching operator-auth.ts semantics).
# ---------------------------------------------------------------------------

# Operator-only path prefixes (exact match or prefix + "/"). Order independent.
GATED_PREFIXES: tuple[str, ...] = (
    "/api/settings",
    "/api/chat",
    "/api/spawn",
    "/api/seed",
    "/api/infra-report",
    "/api/agent",
)

# Always-open paths, even if a future prefix would otherwise match.
OPEN_PREFIXES: tuple[str, ...] = (
    "/api/tick",
    "/api/login",
    "/health",
    "/api/teams",
    "/api/team",
)


def _matches(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + "/")


def _is_gated(path: str) -> bool:
    """A path is gated iff it matches a gated prefix and no open prefix.

    /api/teams must NOT be shadowed by the /api/team open prefix issue: both
    are listed open, and neither is in GATED_PREFIXES, so teams + team/* pass.
    """
    if any(_matches(path, p) for p in OPEN_PREFIXES):
        return False
    return any(_matches(path, p) for p in GATED_PREFIXES)


class OperatorGateMiddleware(BaseHTTPMiddleware):
    """Starlette middleware enforcing the operator gate for operator-only routes."""

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next) -> Response:
        path = request.url.path
        if not _is_gated(path):
            return await call_next(request)

        password = get_settings().operator_password
        if not password:
            # No operator password configured: fail closed in prod, open in dev.
            if is_production_runtime():
                return JSONResponse(
                    {"error": "OPERATOR_PASSWORD not configured"}, status_code=503
                )
            return await call_next(request)

        if is_operator_authorized(request.headers, password):
            return await call_next(request)
        return JSONResponse({"error": "unauthorized"}, status_code=401)


def create_app(store: Store | None = None, *, start_tick_loop: bool | None = None) -> FastAPI:
    """Build the FastAPI app.

    Pass a custom `store` for tests; defaults to the repo-backed store over the
    existing .simple-harmonic/data/ layout (the slice-2 store.repos, NOT the
    retired slice-1 JsonFileStore).

    The self-scheduling tick loop is started in the lifespan when
    ``start_tick_loop`` is True, or — when left None — per the standalone boot
    rules (``tick_loop_should_start``: SH_TICK_LOOP + prod/CRON_SECRET). Tests
    leave it off (they pass ``start_tick_loop=False`` or rely on the default,
    which never starts it under the test env).
    """
    resolved_store: Store = store or RepoStore()

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        # Wire the store-decoupled slice-4 hooks (event sink + telemetry reader)
        # onto the real repos, then create the data-dir skeleton so a fresh
        # checkout serves cleanly.
        wire_runtime()
        await resolved_store.ensure()

        # Lazily import the tick loop so importing the app stays cheap and
        # side-effect-light (the meta-agent/tools graph is only needed to tick).
        from simple_harmonic.tick import run_tick_loop, tick_loop_should_start

        should_start = (
            start_tick_loop if start_tick_loop is not None else tick_loop_should_start()
        )
        stop = asyncio.Event()
        task: asyncio.Task[None] | None = None
        if should_start:
            task = asyncio.create_task(run_tick_loop(stop))
            print("[simple-harmonic] Background tick loop started (10s interval)")

        try:
            yield
        finally:
            stop.set()
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task

    app = FastAPI(
        title="Simple Harmonic Backend (Python)",
        version=__version__,
        lifespan=lifespan,
    )
    app.state.store = resolved_store

    app.add_middleware(OperatorGateMiddleware)

    app.include_router(health.router)
    app.include_router(login.router)
    app.include_router(settings.router)
    app.include_router(teams.router)
    app.include_router(team.router)
    app.include_router(core.router)

    return app


# ASGI entry point for `uvicorn simple_harmonic.app:app`.
app = create_app()


def main() -> None:  # pragma: no cover - process entrypoint
    """Standalone backend entrypoint (TS: standalone/main.ts).

    Boots uvicorn over the repo-backed app; the lifespan starts the background
    tick loop per the boot rules. Port from SH_BACKEND_PORT / PORT (default
    3001).
    """
    import os

    import uvicorn

    port = int(os.environ.get("SH_BACKEND_PORT") or os.environ.get("PORT") or 3001)
    uvicorn.run("simple_harmonic.app:app", host="0.0.0.0", port=port)


if __name__ == "__main__":  # pragma: no cover
    main()

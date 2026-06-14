"""teams + tick endpoints.

TS source:
  packages/backend/src/server/api/teams.ts        -> GET /api/teams
  packages/backend/src/server/api/tick.ts         -> GET/POST /api/tick

GET /api/teams: no auth, returns Team[] NEWEST-first (the store returns
oldest-first; we reverse).
GET/POST /api/tick: cron-gated (the loop / Vercel cron authenticates); the GET
handler delegates to POST.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from simple_harmonic.auth import is_cron_authorized
from simple_harmonic.dependencies import get_store
from simple_harmonic.settings import get_settings
from simple_harmonic.store.base import Store
from simple_harmonic.store.types import Team
from simple_harmonic.tick import run_tick

router = APIRouter(tags=["teams"])


@router.get("/api/teams", response_model=list[Team])
async def list_teams(store: Annotated[Store, Depends(get_store)]) -> list[Team]:
    """All teams, NEWEST-first. No pagination/filter."""
    rows = await store.list_teams()
    rows.reverse()
    return rows


async def _run_tick_authorized(request: Request) -> Any:
    """Cron-gate the tick, then run the orchestrator. Shared by GET + POST."""
    cron_secret = get_settings().cron_secret or None
    if not is_cron_authorized(request.headers, cron_secret):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return await run_tick()


@router.get("/api/tick")
async def tick_get(request: Request) -> Any:
    """Vercel cron sends GET; the TS GET handler just delegates to POST."""
    return await _run_tick_authorized(request)


@router.post("/api/tick")
async def tick_post(request: Request) -> Any:
    """Normal run: { ok, agentsRan, timestamp }. Cron-gated."""
    return await _run_tick_authorized(request)

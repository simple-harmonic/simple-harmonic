"""Health endpoint (no TS equivalent — operational liveness probe)."""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from simple_harmonic import __version__

router = APIRouter()


class HealthResponse(BaseModel):
    status: str
    version: str


@router.get("/health", response_model=HealthResponse, tags=["meta"])
async def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__)

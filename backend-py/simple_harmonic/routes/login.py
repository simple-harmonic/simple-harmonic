"""Operator login endpoint.

TS source: packages/backend/src/server/api/login.ts

Exchanges the shared OPERATOR_PASSWORD for the ``sh_operator`` session cookie
(= sha256(password)). This route is PUBLIC — it is the one place the operator
authenticates, so it is listed in the gate's OPEN_PREFIXES (see
:mod:`simple_harmonic.app`) and does its own password check here.

Wire contract (byte-for-byte with login.ts):
  - 503 ``{"error": "OPERATOR_PASSWORD not configured"}`` when unset.
  - 401 ``{"error": "Invalid password"}`` on mismatch (constant-time compare).
  - 200 ``{"ok": true}`` + a Set-Cookie header on success:
      sh_operator=<sha256(pw)>; HttpOnly[; Secure]; SameSite=Lax; Path=/; Max-Age=2592000
    (Secure only in production, mirroring NODE_ENV === "production").
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from simple_harmonic.auth import (
    OPERATOR_COOKIE,
    constant_time_equal,
    is_production_runtime,
    sha256_hex,
)
from simple_harmonic.settings import get_settings

router = APIRouter(tags=["login"])

# 30 days, in seconds — matches login.ts ``60 * 60 * 24 * 30``.
_COOKIE_MAX_AGE = 60 * 60 * 24 * 30


@router.post("/api/login")
async def login(request: Request) -> Any:
    """Exchange OPERATOR_PASSWORD for the sh_operator cookie."""
    password = get_settings().operator_password
    if not password:
        return JSONResponse(
            {"error": "OPERATOR_PASSWORD not configured"}, status_code=503
        )

    body = await _read_json(request)
    submitted = body.get("password")
    submitted_str = submitted if isinstance(submitted, str) else ""

    if not constant_time_equal(submitted_str, password):
        return JSONResponse({"error": "Invalid password"}, status_code=401)

    secure = is_production_runtime()
    cookie = (
        f"{OPERATOR_COOKIE}={sha256_hex(password)}; HttpOnly"
        f"{'; Secure' if secure else ''}; SameSite=Lax; Path=/; Max-Age={_COOKIE_MAX_AGE}"
    )
    resp = JSONResponse({"ok": True})
    resp.headers["Set-Cookie"] = cookie
    return resp


async def _read_json(request: Request) -> dict[str, Any]:
    """Parse the JSON body, returning {} on any error (matches the TS
    ``req.json().catch(() => ({}))``)."""
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}

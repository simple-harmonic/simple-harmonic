"""Codex CLI auth: read the local Codex login, decode its token, refresh it.

TS source: packages/backend/src/server/codex-auth.ts

Reads ``$CODEX_HOME/auth.json`` (default ``~/.codex/auth.json``) written by the
``codex`` CLI's ChatGPT OAuth login, exposes the access token + a decoded
status, lists the cached models, and refreshes the token against the OpenAI
OAuth endpoint.

NETWORK (load-bearing): :func:`refresh_codex_token` performs an HTTPS POST. It
is routed through the overridable :data:`_post_token` hook so tests mock it and
NEVER touch the network. The default hook uses ``httpx`` synchronously.
"""

from __future__ import annotations

import base64
import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
TOKEN_URL = "https://auth.openai.com/oauth/token"


@dataclass
class CodexAuthStatus:
    found: bool
    authMode: str | None
    email: str | None
    plan: str | None
    accountId: str | None
    lastRefresh: str | None
    tokenExpiry: str | None
    hasAccessToken: bool


@dataclass
class CodexModel:
    slug: str
    displayName: str
    description: str
    priority: int
    supportedInApi: bool


@dataclass
class RefreshResult:
    ok: bool
    accessToken: str | None = None
    error: str | None = None


@dataclass
class _TokenHttpResponse:
    """The slice of an HTTP response :data:`_post_token` must return."""

    ok: bool
    status: int
    text: str
    json_body: dict[str, Any]


def _codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME") or (Path(os.environ.get("HOME") or "~") / ".codex"))


def _codex_auth_path() -> Path:
    return _codex_home() / "auth.json"


def _read_codex_auth() -> dict[str, Any] | None:
    """Read+parse ``auth.json``. Returns None on missing or corrupt file."""
    path = _codex_auth_path()
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return None


def _decode_jwt_payload(token: str) -> dict[str, Any] | None:
    """Decode a JWT's payload segment without verifying the signature. Returns
    None for anything that is not a 3-segment token with valid base64 JSON."""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        payload = parts[1] + "=" * (4 - (len(parts[1]) % 4))
        decoded = base64.urlsafe_b64decode(payload).decode("utf-8")
        return json.loads(decoded)
    except Exception:
        return None


def get_codex_auth_status() -> CodexAuthStatus:
    auth = _read_codex_auth()
    access_token = (auth or {}).get("tokens", {}).get("access_token") if auth else None
    if not auth or not access_token:
        return CodexAuthStatus(
            found=False,
            authMode=None,
            email=None,
            plan=None,
            accountId=None,
            lastRefresh=None,
            tokenExpiry=None,
            hasAccessToken=False,
        )

    jwt = _decode_jwt_payload(access_token) or {}
    profile = jwt.get("https://api.openai.com/profile") or {}
    auth_info = jwt.get("https://api.openai.com/auth") or {}
    exp = jwt.get("exp")

    token_expiry: str | None = None
    if isinstance(exp, int | float):
        token_expiry = (
            datetime.fromtimestamp(exp, UTC).strftime("%Y-%m-%dT%H:%M:%S.")
            + f"{datetime.fromtimestamp(exp, UTC).microsecond // 1000:03d}Z"
        )

    return CodexAuthStatus(
        found=True,
        authMode=auth.get("auth_mode") or None,
        email=(profile.get("email") if isinstance(profile, dict) else None) or None,
        plan=(auth_info.get("chatgpt_plan_type") if isinstance(auth_info, dict) else None) or None,
        accountId=auth.get("tokens", {}).get("account_id") or None,
        lastRefresh=auth.get("last_refresh") or None,
        tokenExpiry=token_expiry,
        hasAccessToken=True,
    )


def get_codex_access_token() -> str | None:
    auth = _read_codex_auth()
    if not auth:
        return None
    return auth.get("tokens", {}).get("access_token") or None


def get_codex_models() -> list[CodexModel]:
    """Parse ``$CODEX_HOME/models_cache.json``. Returns API-supported models
    sorted by priority ascending. Missing/corrupt cache -> []."""
    cache_path = _codex_home() / "models_cache.json"
    try:
        if not cache_path.exists():
            return []
        raw = json.loads(cache_path.read_text(encoding="utf-8"))
        rows = raw.get("models", raw) if isinstance(raw, dict) else raw
        models: list[CodexModel] = []
        for m in rows or []:
            if not isinstance(m, dict) or not m.get("slug"):
                continue
            priority = m.get("priority")
            models.append(
                CodexModel(
                    slug=m["slug"],
                    displayName=m.get("display_name") or m["slug"],
                    description=m.get("description") or "",
                    priority=priority if isinstance(priority, int) else 999,
                    supportedInApi=m.get("supported_in_api") is not False,
                )
            )
        return sorted(
            (m for m in models if m.supportedInApi),
            key=lambda m: m.priority,
        )
    except Exception:
        return []


# --- Token refresh ---------------------------------------------------------


def _default_post_token(refresh_token: str) -> _TokenHttpResponse:
    """Default network hook: POST the refresh grant to the OpenAI OAuth endpoint
    via httpx. Overridden in tests so nothing touches the network."""
    import httpx

    resp = httpx.post(
        TOKEN_URL,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CODEX_CLIENT_ID,
        },
        timeout=30.0,
    )
    body: dict[str, Any] = {}
    if resp.is_success:
        try:
            body = resp.json()
        except Exception:
            body = {}
    return _TokenHttpResponse(
        ok=resp.is_success, status=resp.status_code, text=resp.text, json_body=body
    )


# Override in tests. Takes the refresh token, returns a :class:`_TokenHttpResponse`.
_post_token: Callable[[str], _TokenHttpResponse] = _default_post_token


def refresh_codex_token() -> RefreshResult:
    """Refresh the Codex access token and write the updated ``auth.json`` so the
    Codex CLI stays in sync. Network errors and non-OK responses are returned as
    structured failures, never raised."""
    auth = _read_codex_auth()
    refresh_token = (auth or {}).get("tokens", {}).get("refresh_token") if auth else None
    if not auth or not refresh_token:
        return RefreshResult(ok=False, error="No Codex refresh token found")

    try:
        res = _post_token(refresh_token)

        if not res.ok:
            return RefreshResult(
                ok=False, error=f"Refresh failed ({res.status}): {res.text[:200]}"
            )

        data = res.json_body
        access_token = data.get("access_token")
        if not access_token:
            return RefreshResult(ok=False, error="No access_token in refresh response")

        tokens = dict(auth.get("tokens") or {})
        tokens["access_token"] = access_token
        tokens["id_token"] = data.get("id_token") or tokens.get("id_token")
        tokens["refresh_token"] = data.get("refresh_token") or tokens.get("refresh_token")
        updated = {
            **auth,
            "tokens": tokens,
            "last_refresh": datetime.now(UTC)
            .strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]
            + "Z",
        }
        _codex_auth_path().write_text(json.dumps(updated, indent=2) + "\n", encoding="utf-8")

        return RefreshResult(ok=True, accessToken=access_token)
    except Exception as err:
        return RefreshResult(ok=False, error=str(err) or "Refresh failed")

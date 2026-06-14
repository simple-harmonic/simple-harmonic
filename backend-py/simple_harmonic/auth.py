"""Operator / cron auth helpers.

TS source: packages/backend/src/server/operator-auth.ts

Single-operator model for v0: one shared OPERATOR_PASSWORD gates the app; one
CRON_SECRET gates the tick endpoint. Enforcement is permissive in local dev
when the secret is unset (so the dev server works out of the box) and fails
closed in production / on Vercel.

The TS module is "edge-safe" (Web Crypto + header parsing only). The Python
port has no such constraint, so it uses hashlib / hmac directly, but preserves
the exact wire contract: the cookie value is hex sha256(OPERATOR_PASSWORD),
comparisons are constant-time, and the cron header is trusted ONLY on Vercel.

Headers arrive as a case-insensitive Mapping (Starlette's request.headers and
httpx.Headers both satisfy this); helpers normalize lookups defensively.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from collections.abc import Mapping

OPERATOR_COOKIE = "sh_operator"


def is_production_runtime() -> bool:
    """True when an unset secret should fail closed (production / Vercel)."""
    return os.environ.get("NODE_ENV") == "production" or bool(os.environ.get("VERCEL"))


def sha256_hex(value: str) -> str:
    """SHA-256 hex digest (parity with the Web Crypto digest in TS)."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def constant_time_equal(a: str, b: str) -> bool:
    """Length-checked constant-time string comparison.

    hmac.compare_digest already short-circuits on length but does so in
    constant time per the stdlib contract; the explicit length guard mirrors
    the TS helper and keeps behavior identical for callers.
    """
    if len(a) != len(b):
        return False
    return hmac.compare_digest(a, b)


def _bearer_token(headers: Mapping[str, str]) -> str | None:
    h = _get_header(headers, "authorization") or ""
    return h[7:] if h.startswith("Bearer ") else None


def _get_header(headers: Mapping[str, str], name: str) -> str | None:
    """Case-insensitive header lookup that works for both Starlette and httpx
    Headers (already case-insensitive) and a plain dict."""
    try:
        value = headers.get(name)
    except TypeError:
        value = None
    if value is not None:
        return value
    lowered = name.lower()
    for key, val in headers.items():
        if key.lower() == lowered:
            return val
    return None


def _read_cookie(headers: Mapping[str, str], name: str) -> str | None:
    raw = _get_header(headers, "cookie") or ""
    for part in raw.split(";"):
        part = part.strip()
        eq = part.find("=")
        if eq > 0 and part[:eq] == name:
            return part[eq + 1 :]
    return None


def is_operator_authorized(headers: Mapping[str, str], password: str) -> bool:
    """Is the request an authorized operator? Accepts a Bearer OPERATOR_PASSWORD
    (for curl/scripts) or the sh_operator cookie (= sha256(password))."""
    tok = _bearer_token(headers)
    if tok and constant_time_equal(tok, password):
        return True
    cookie = _read_cookie(headers, OPERATOR_COOKIE)
    return bool(cookie and constant_time_equal(cookie, sha256_hex(password)))


def is_cron_authorized(headers: Mapping[str, str], cron_secret: str | None) -> bool:
    """Is the tick request authorized? Accepts the Vercel platform cron header
    (x-vercel-cron, trusted only when running on Vercel) or a Bearer
    CRON_SECRET. When CRON_SECRET is unset, allows in local dev and fails
    closed in production."""
    # Trust the platform cron header only when actually running on Vercel,
    # where the edge strips client-supplied copies. On any other host it would
    # be trivially spoofable.
    if os.environ.get("VERCEL") and _get_header(headers, "x-vercel-cron"):
        return True
    if cron_secret:
        tok = _bearer_token(headers)
        return bool(tok) and constant_time_equal(tok or "", cron_secret)
    return not is_production_runtime()

"""Proxy-aware, IPv4-pinned outbound fetch.

TS source: packages/backend/src/server/proxy-fetch.ts

Why not plain ``httpx.get``: some hosts advertise AAAA records that route to
unreachable IPv6 tunnels (e.g. Teredo 2001::/32). A default client tries
whichever address DNS returns first and can hang on the v6 attempt for 10s+.
``curl`` avoids this by falling back to v4 quickly. We pin ``family=4`` so
connections behave like curl.

Two paths:
  * direct  — no proxy configured: connect straight to the target. When a
    pre-validated public IP is supplied (the SSRF anti-rebinding pin), DNS
    resolution is overridden to that IP while the hostname is preserved for TLS
    SNI + cert verification, closing the rebinding TOCTOU.
  * proxy   — HTTPS_PROXY / HTTP_PROXY (any case) set, or the macOS system
    HTTPS proxy: tunnel through the proxy via httpx's proxy support. The proxy
    resolves the target host itself, so the IP pin is not applied (a corporate
    proxy is already a trust boundary).

The plan (proxy decision + pin + target) is computed by :func:`build_plan`, a
pure function the tests assert on directly — no socket required.
"""

from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import httpx

FETCH_TIMEOUT_S = 20.0
DEFAULT_READ_CAP = 128 * 1024


@dataclass
class PinnedAddress:
    """A pre-validated public IP to pin the connection to (anti-rebinding)."""

    ip: str
    family: int  # 4 or 6


@dataclass
class ProxyFetchPlan:
    """The resolved connection decision for a fetch. Pure data so tests can
    assert on it without opening a socket."""

    url: str
    method: str
    hostname: str
    port: int
    proxy_url: str | None
    pin: PinnedAddress | None
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes | None = None


# Cached macOS system-proxy lookup. ``...`` means "not yet computed" so a
# legitimate None (no proxy) is still cached. Mirrors the TS module-level cache.
_cached_system_proxy: str | None | object = ...


def _get_system_proxy_mac() -> str | None:
    """Read the macOS system HTTPS proxy via ``scutil --proxy``. Cached for the
    process lifetime. Returns None on non-macOS or when no proxy is configured.
    Used as a fallback when HTTPS_PROXY isn't exported to this process."""
    global _cached_system_proxy
    if _cached_system_proxy is not ...:
        return _cached_system_proxy  # type: ignore[return-value]
    _cached_system_proxy = None
    if sys.platform != "darwin":
        return None
    try:
        out = subprocess.run(
            ["scutil", "--proxy"],
            capture_output=True,
            text=True,
            timeout=1.0,
        ).stdout
    except Exception:
        return None
    if not _re_search(r"HTTPSEnable\s*:\s*1", out):
        return None
    host_match = _re_search(r"HTTPSProxy\s*:\s*(\S+)", out)
    port_match = _re_search(r"HTTPSPort\s*:\s*(\d+)", out)
    if host_match and port_match:
        _cached_system_proxy = f"http://{host_match}:{port_match}"
        return _cached_system_proxy  # type: ignore[return-value]
    return None


def _re_search(pattern: str, text: str) -> str | None:
    import re

    m = re.search(pattern, text)
    if not m:
        return None
    return m.group(1) if m.groups() else m.group(0)


def _resolve_proxy_url() -> str | None:
    """HTTPS_PROXY > HTTP_PROXY > https_proxy > http_proxy > macOS system proxy."""
    return (
        os.environ.get("HTTPS_PROXY")
        or os.environ.get("HTTP_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("http_proxy")
        or _get_system_proxy_mac()
    )


def build_plan(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | str | None = None,
    pin: PinnedAddress | None = None,
) -> ProxyFetchPlan:
    """Resolve the connection decision for a fetch without performing any I/O.

    Pins ``family=4`` by default (the curl-like v4 pin) by synthesizing a pin
    from the supplied address; when no pin is given the direct path still binds
    to IPv4 via the transport. When a proxy is configured the pin is dropped
    (the proxy is the trust boundary and resolves the host itself)."""
    target = urlsplit(url)
    hostname = target.hostname or ""
    port = target.port or 443

    body_bytes: bytes | None
    if body is None:
        body_bytes = None
    elif isinstance(body, str):
        body_bytes = body.encode("utf-8")
    else:
        body_bytes = body

    proxy_url = _resolve_proxy_url()
    effective_pin = None if proxy_url else pin

    return ProxyFetchPlan(
        url=url,
        method=method.upper(),
        hostname=hostname,
        port=port,
        proxy_url=proxy_url,
        pin=effective_pin,
        headers=dict(headers or {}),
        body=body_bytes,
    )


class _PinnedTransport(httpx.AsyncHTTPTransport):
    """Direct-path transport that dials a pre-validated public IP while keeping
    the original hostname for TLS SNI + certificate verification.

    This is the Python equivalent of the TS ``pinnedLookup`` (proxy-fetch.ts):
    only DNS resolution is overridden — the connection targets ``pin.ip`` — but
    the request URL host, the ``Host`` header, and the TLS ``server_hostname``
    (passed via httpcore's ``sni_hostname`` extension) all stay the real host.
    Rewriting the URL to the bare IP instead (the naive approach) would make
    SNI/cert verification target the IP and fail for every real HTTPS host, so
    that is deliberately NOT done here. This closes the DNS-rebinding TOCTOU
    without weakening cert checks."""

    def __init__(self, pin: PinnedAddress, **kwargs: object) -> None:
        super().__init__(**kwargs)  # type: ignore[arg-type]
        self._pin = pin

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        import httpcore

        real_host = request.url.host
        # Preserve SNI + cert verification against the real hostname even though
        # the socket connects to the pinned IP. httpcore falls back to the
        # connection host for server_hostname only when this is unset, so set it
        # explicitly to the real host.
        request.extensions = {**request.extensions, "sni_hostname": real_host}
        req = httpcore.Request(
            method=request.method,
            url=httpcore.URL(
                scheme=request.url.raw_scheme,
                host=self._pin.ip.encode("ascii"),  # dial the pinned IP
                port=request.url.port,
                target=request.url.raw_path,
            ),
            headers=request.headers.raw,  # carries the real Host header
            content=request.stream,  # type: ignore[arg-type]
            extensions=request.extensions,
        )
        import httpx._transports.default as _default

        with _default.map_httpcore_exceptions():
            resp = await self._pool.handle_async_request(req)
        return httpx.Response(
            status_code=resp.status,
            headers=resp.headers,
            stream=_default.AsyncResponseStream(resp.stream),  # type: ignore[arg-type]
            extensions=resp.extensions,
        )


def _build_client(plan: ProxyFetchPlan) -> httpx.AsyncClient:
    """Construct the httpx client for a plan. Seam: tests patch this to inject a
    :class:`httpx.MockTransport` so no real socket is opened.

    Direct path: when a public IP pin is present, route the connection to that
    IP via :class:`_PinnedTransport` while keeping the real hostname for TLS SNI
    + cert verification. With no pin (or a v4 pin) bind an IPv4 local address —
    the curl-like v4 pin that mirrors the TS ``family: pin?.family ?? 4`` and
    dodges hanging v6/Teredo tunnels. A v6 pin must NOT force a v4 local bind.
    Proxy path routes through the configured proxy (which resolves the host
    itself)."""
    timeout = httpx.Timeout(FETCH_TIMEOUT_S)
    if plan.proxy_url:
        return httpx.AsyncClient(proxy=plan.proxy_url, timeout=timeout, verify=True)

    # v4 local bind for the no-pin and v4-pin cases; let a v6 pin bind v6.
    local_address = None if (plan.pin and plan.pin.family == 6) else "0.0.0.0"
    if plan.pin:
        transport: httpx.AsyncBaseTransport = _PinnedTransport(
            plan.pin, retries=0, local_address=local_address
        )
    else:
        transport = httpx.AsyncHTTPTransport(retries=0, local_address=local_address)
    return httpx.AsyncClient(transport=transport, timeout=timeout, verify=True)


async def proxy_fetch(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | str | None = None,
    pin: PinnedAddress | None = None,
) -> httpx.Response:
    """Proxy-aware fetch. Honors HTTP(S)_PROXY via httpx's proxy support; falls
    back to a direct IPv4-pinned request otherwise. Bounded by a ~20s timeout.

    When a pin is present (the direct path), the connection dials the pinned IP
    while the request URL keeps the real hostname so the Host header and TLS
    SNI/cert verification still target the real host (see :class:`_PinnedTransport`).

    Returns a STREAMING :class:`httpx.Response` whose body has NOT been read:
    headers + status are available immediately, and the body is consumed lazily
    by :func:`read_capped`, which can stop the download early once the byte cap
    is hit (the TS streaming cap defeats a malicious server that would otherwise
    stream an unbounded body into memory). The client is attached to the response
    and torn down when the response is closed (read_capped closes it)."""
    plan = build_plan(url, method=method, headers=headers, body=body, pin=pin)

    client = _build_client(plan)
    request = client.build_request(
        plan.method,
        plan.url,
        headers=plan.headers,
        content=plan.body,
    )
    try:
        response = await client.send(request, stream=True)
    except BaseException:
        await client.aclose()
        raise
    # Close the client when the response is closed so the connection + transport
    # are released after read_capped (or the caller) finishes with the body.
    response._pinned_client = client  # type: ignore[attr-defined]
    return response


async def read_capped(response: httpx.Response, max_bytes: int = DEFAULT_READ_CAP) -> str:
    """Read a response body as UTF-8 text, keeping at most ``max_bytes`` and
    stopping the stream early once the cap is hit (the streaming byte cap). The
    underlying connection + client are always released, even on early stop."""
    chunks: list[bytes] = []
    kept = 0
    try:
        async for chunk in response.aiter_bytes():
            remaining = max_bytes - kept
            if remaining > 0:
                piece = chunk[:remaining]
                chunks.append(piece)
                kept += len(piece)
            if kept >= max_bytes:
                break
    finally:
        await response.aclose()
        client = getattr(response, "_pinned_client", None)
        if client is not None:
            await client.aclose()
    return b"".join(chunks).decode("utf-8", errors="replace")

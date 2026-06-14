"""Single SSRF egress policy.

TS source: packages/backend/src/server/tools/url-guard.ts

Every agent-driven outbound fetch (http_fetch, github_api, custom API skills)
goes through :func:`assert_public_and_resolve` BEFORE any request is sent — and
crucially, before a connector bearer token is attached.

A hostname-string check alone is not enough: a domain whose A-record points at
169.254.169.254 (cloud metadata) or 127.0.0.1 would sail through. Here we
resolve DNS first, reject if ANY returned address is private (covers a mixed
public+private rebind set), and return a PINNED public IP so the connection
can't be re-resolved to a private host at connect time (the DNS-rebinding
TOCTOU). The hostname is preserved for TLS SNI + cert checks; only DNS
resolution is overridden (see proxy_fetch.py).
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit


def strip_ipv6_brackets(host: str) -> str:
    """``[::1]`` -> ``::1``."""
    return host[1:-1] if host.startswith("[") and host.endswith("]") else host


def _ip_version(host: str) -> int:
    """0 if ``host`` is not an IP literal, else 4 or 6 (mirrors node:net isIP)."""
    try:
        return ipaddress.ip_address(host).version
    except ValueError:
        return 0


def is_private_ipv4(ip: str) -> bool:
    """True for the full private/loopback/link-local/metadata/benchmark/reserved
    IPv4 set. TEST-PINNED — a missing range is an SSRF hole.

    Ranges (mirroring url-guard.ts):
      0.0.0.0/8, 10/8, 127/8, CGNAT 100.64.0.0/10 (100.64-100.127),
      link-local/metadata 169.254/16, 172.16-31, 192.168/16,
      benchmark 198.18.0.0/15, and everything multicast/reserved (>= 224).
    """
    parts = ip.split(".")
    try:
        a = int(parts[0])
        b = int(parts[1])
    except (IndexError, ValueError):
        return False
    return (
        a == 0
        or a == 10
        or a == 127
        or (a == 100 and 64 <= b <= 127)
        or (a == 169 and b == 254)
        or (a == 172 and 16 <= b <= 31)
        or (a == 192 and b == 168)
        or (a == 198 and (b == 18 or b == 19))
        or a >= 224
    )


def is_private_ipv6(ip: str) -> bool:
    """True for IPv6 loopback (``::1``), unspecified (``::``), ULA (fc00::/7 =
    fc/fd prefixes), link-local (fe80::/10), and IPv4-mapped (``::ffff:``) whose
    embedded v4 is private."""
    normalized = ip.lower()
    if normalized in ("::1", "::"):
        return True
    if normalized.startswith("fc") or normalized.startswith("fd"):
        return True
    if normalized.startswith("fe80"):
        return True
    if normalized.startswith("::ffff:"):
        return is_private_ipv4(normalized[len("::ffff:") :])
    return False


def is_private_ip(host: str) -> bool:
    """True if ``host`` is an IP literal in a private range. Returns False for a
    non-literal (a DNS name) — the caller must resolve DNS first."""
    v = _ip_version(host)
    if v == 4:
        return is_private_ipv4(host)
    if v == 6:
        return is_private_ipv6(host)
    return False


@dataclass
class PinnedTarget:
    """A validated URL plus the pre-resolved public IP to pin the connection to.
    ``url`` is a parsed :class:`urllib.parse.SplitResult`; ``hostname`` exposes
    the SNI/cert hostname directly for convenience."""

    url: object
    pinnedIp: str
    family: int  # 4 or 6

    @property
    def hostname(self) -> str:
        return self.url.hostname or ""  # type: ignore[union-attr]


# DNS resolver seam. Returns a list of (address, family) where family is 4 or 6.
# Overridable in tests so the SSRF logic can be exercised fully offline without
# touching real DNS.
async def _resolve_all(host: str) -> list[tuple[str, int]]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    out: list[tuple[str, int]] = []
    for family, _type, _proto, _canon, sockaddr in infos:
        address = sockaddr[0]
        fam = 6 if family == socket.AF_INET6 else 4
        out.append((address, fam))
    return out


async def assert_public_and_resolve(raw_url: str) -> PinnedTarget:
    """Validate a URL for outbound agent use and return a pinned public IP.
    Rejects non-https, embedded credentials, localhost, IP literals in private
    ranges, and any DNS name that resolves to (or includes) a private address.
    """
    url = urlsplit(raw_url)
    if url.scheme != "https":
        raise ValueError("Only https:// URLs are allowed")
    if url.username or url.password:
        raise ValueError("Credentials in URLs are not allowed")

    raw_host = (url.hostname or "").lower().rstrip(".")
    host = strip_ipv6_brackets(raw_host)
    if host == "localhost" or host.endswith(".localhost"):
        raise ValueError("Localhost URLs are not allowed")

    # IP literal: validate and pin directly (no DNS).
    literal_version = _ip_version(host)
    if literal_version:
        if is_private_ip(host):
            raise ValueError("Private-network URLs are not allowed")
        return PinnedTarget(url=url, pinnedIp=host, family=6 if literal_version == 6 else 4)

    # DNS name: resolve ALL addresses and reject if any is private, so a mixed
    # public+private record set can't sneak a private target past us.
    try:
        addrs = await _resolve_all(host)
    except Exception as exc:
        raise ValueError(f"DNS resolution failed for {host}") from exc
    if not addrs:
        raise ValueError(f"No DNS records for {host}")
    for address, _family in addrs:
        if is_private_ip(address):
            raise ValueError("Host resolves to a private-network address")

    # Prefer a public IPv4 (matches the curl-like v4 pin proxy_fetch relies on
    # to avoid v6 tunnel hangs); fall back to the first public address.
    chosen = next((a for a in addrs if a[1] == 4), addrs[0])
    return PinnedTarget(url=url, pinnedIp=chosen[0], family=6 if chosen[1] == 6 else 4)

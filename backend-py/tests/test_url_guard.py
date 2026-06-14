"""SSRF egress policy tests.

TS source: packages/backend/tests/unit/security/url-guard.test.ts

Every private-IP range is pinned here — a missing range would be an SSRF hole.
DNS is mocked (the ``_resolve_all`` seam) so the policy runs fully offline.
"""

from __future__ import annotations

import pytest

from simple_harmonic.tools import url_guard
from simple_harmonic.tools.url_guard import assert_public_and_resolve, is_private_ip

# --- is_private_ip: the full pinned range set ------------------------------

PRIVATE_IPS = [
    # loopback / unspecified
    "0.0.0.0",
    "127.0.0.1",
    "127.1.2.3",
    # RFC1918
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    # CGNAT 100.64.0.0/10
    "100.64.0.1",
    "100.127.255.255",
    # link-local / cloud metadata
    "169.254.169.254",
    "169.254.0.1",
    # benchmark 198.18.0.0/15
    "198.18.0.1",
    "198.19.255.255",
    # multicast / reserved (>= 224)
    "224.0.0.1",
    "239.0.0.1",
    "255.255.255.255",
    # IPv6 equivalents
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
]

PUBLIC_IPS = [
    "1.1.1.1",
    "8.8.8.8",
    "104.16.0.1",
    "172.15.0.1",  # just below the 172.16-31 private block
    "172.32.0.1",  # just above
    "100.63.255.255",  # just below CGNAT
    "100.128.0.1",  # just above CGNAT
    "198.17.255.255",  # just below benchmark
    "198.20.0.1",  # just above benchmark
    "223.255.255.255",  # just below multicast
    "2606:4700::1111",
]


@pytest.mark.parametrize("ip", PRIVATE_IPS)
def test_private_ip_ranges_flagged(ip: str) -> None:
    assert is_private_ip(ip) is True


@pytest.mark.parametrize("ip", PUBLIC_IPS)
def test_public_ip_ranges_pass(ip: str) -> None:
    assert is_private_ip(ip) is False


def test_non_ip_literal_returns_false() -> None:
    # A DNS name is not an IP literal — caller must resolve first.
    assert is_private_ip("example.com") is False


# --- assert_public_and_resolve ---------------------------------------------


@pytest.fixture
def mock_dns(monkeypatch: pytest.MonkeyPatch):
    """Patch the DNS seam. Yields a setter; default raises (no records)."""
    state: dict[str, object] = {"result": []}

    async def fake_resolve(host: str) -> list[tuple[str, int]]:
        state["called"] = True
        result = state["result"]
        if isinstance(result, Exception):
            raise result
        return result  # type: ignore[return-value]

    monkeypatch.setattr(url_guard, "_resolve_all", fake_resolve)
    return state


async def test_rejects_non_https(mock_dns) -> None:
    with pytest.raises(ValueError):
        await assert_public_and_resolve("http://example.com")


async def test_rejects_embedded_credentials(mock_dns) -> None:
    with pytest.raises(ValueError):
        await assert_public_and_resolve("https://u:p@example.com")


async def test_rejects_localhost(mock_dns) -> None:
    with pytest.raises(ValueError):
        await assert_public_and_resolve("https://localhost/x")
    with pytest.raises(ValueError):
        await assert_public_and_resolve("https://foo.localhost/x")


async def test_rejects_private_ip_literals_without_dns(mock_dns) -> None:
    with pytest.raises(ValueError):
        await assert_public_and_resolve("https://169.254.169.254/latest/meta-data")
    with pytest.raises(ValueError):
        await assert_public_and_resolve("https://127.0.0.1/")
    # No DNS lookup happened for an IP literal.
    assert "called" not in mock_dns


async def test_pins_public_ip_literal_directly(mock_dns) -> None:
    r = await assert_public_and_resolve("https://1.1.1.1/")
    assert r.pinnedIp == "1.1.1.1"
    assert r.family == 4
    assert "called" not in mock_dns


async def test_rejects_domain_resolving_to_private(mock_dns) -> None:
    mock_dns["result"] = [("169.254.169.254", 4)]
    with pytest.raises(ValueError, match="private"):
        await assert_public_and_resolve("https://evil.example.com/")


async def test_rejects_mixed_public_private_record_set(mock_dns) -> None:
    mock_dns["result"] = [("1.2.3.4", 4), ("10.0.0.5", 4)]
    with pytest.raises(ValueError, match="private"):
        await assert_public_and_resolve("https://mixed.example.com/")


async def test_resolves_and_pins_public_domain_preferring_v4(mock_dns) -> None:
    mock_dns["result"] = [("2606:4700::1111", 6), ("104.16.0.1", 4)]
    r = await assert_public_and_resolve("https://cdn.example.com/path?q=1")
    assert r.pinnedIp == "104.16.0.1"
    assert r.family == 4
    assert r.hostname == "cdn.example.com"


async def test_rejects_when_dns_returns_no_records(mock_dns) -> None:
    mock_dns["result"] = []
    with pytest.raises(ValueError):
        await assert_public_and_resolve("https://empty.example.com/")


async def test_rejects_when_dns_resolution_fails(mock_dns) -> None:
    mock_dns["result"] = OSError("nope")
    with pytest.raises(ValueError, match="DNS resolution failed"):
        await assert_public_and_resolve("https://broken.example.com/")

"""Network tool tests: http_fetch / github_api with the SSRF order pinned.

TS source: packages/backend/tests/unit/server-tools.test.ts (http_fetch / github_api)

The load-bearing property: :func:`assert_public_and_resolve` runs and PASSES
before any connector bearer token is attached or ``proxy_fetch`` is called, and
the resolved address is pinned. A private/metadata/localhost URL is rejected
BEFORE the network layer is touched — proxy_fetch is patched to a spy that
raises if it is ever hit on a rejected URL.

Fully offline: DNS is the ``_resolve_all`` seam (mocked to a fixed public IP),
and the network layer is the ``proxy_fetch`` reference imported by the tool
module (patched per test). No socket, no real DNS.
"""

from __future__ import annotations

import httpx
import pytest

import simple_harmonic.tools.network as network_mod
from simple_harmonic.tools import url_guard
from simple_harmonic.tools.network import (
    GitHubApiArgs,
    HttpFetchArgs,
    github_api_def,
    github_api_impl,
    http_fetch_def,
    http_fetch_impl,
)
from simple_harmonic.tools.types import ToolRunContext

PUBLIC_IP = "93.184.216.34"


def ctx() -> ToolRunContext:
    return ToolRunContext(teamId="t1", agentId="a1", agentName="agent", peers=[])


@pytest.fixture
def public_dns(monkeypatch: pytest.MonkeyPatch):
    """Resolve every hostname to one fixed PUBLIC IPv4 (offline DNS seam)."""

    async def fake_resolve(_host: str):
        return [(PUBLIC_IP, 4)]

    monkeypatch.setattr(url_guard, "_resolve_all", fake_resolve)
    return monkeypatch


def _mock_proxy_fetch(monkeypatch: pytest.MonkeyPatch, response: httpx.Response, calls: dict):
    async def fake(url, *, method="GET", headers=None, body=None, pin=None):
        calls["count"] += 1
        calls["url"] = url
        calls["method"] = method
        calls["headers"] = headers or {}
        calls["pin"] = pin
        return response

    monkeypatch.setattr(network_mod, "proxy_fetch", fake)


def _spy_never_called(monkeypatch: pytest.MonkeyPatch, calls: dict):
    async def boom(*_a, **_k):
        calls["count"] += 1
        raise AssertionError("proxy_fetch must not be called for a rejected URL")

    monkeypatch.setattr(network_mod, "proxy_fetch", boom)


# --- definitions ------------------------------------------------------------


def test_definitions() -> None:
    assert http_fetch_def.risk == "safe"
    assert http_fetch_def.category == "network"
    assert github_api_def.risk == "destructive"


# --- http_fetch -------------------------------------------------------------


async def test_http_fetch_gets_body_and_pins_resolved_ip(public_dns) -> None:
    calls = {"count": 0}
    _mock_proxy_fetch(public_dns, httpx.Response(200, text="hello body"), calls)
    res = await http_fetch_impl(HttpFetchArgs(url="https://example.com"), ctx())
    assert res.success is True
    assert res.result == "hello body"
    assert calls["method"] == "GET"
    # The resolved public IP was pinned (anti-rebinding).
    assert calls["pin"] is not None
    assert calls["pin"].ip == PUBLIC_IP


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com",  # non-https
        "https://localhost:3000",
        "https://127.0.0.1",
        "https://169.254.169.254/latest/meta-data",  # cloud metadata
        "https://192.168.1.10",
        "https://10.0.0.1",
    ],
)
async def test_http_fetch_rejects_private_before_fetch(
    public_dns, url: str
) -> None:
    calls = {"count": 0}
    _spy_never_called(public_dns, calls)
    res = await http_fetch_impl(HttpFetchArgs(url=url), ctx())
    assert res.success is False
    assert calls["count"] == 0  # rejected before the network layer


async def test_http_fetch_reports_non_2xx(public_dns) -> None:
    calls = {"count": 0}
    _mock_proxy_fetch(public_dns, httpx.Response(404, text="nope"), calls)
    res = await http_fetch_impl(HttpFetchArgs(url="https://example.com/x"), ctx())
    assert res.success is False
    assert "404" in res.result


# --- github_api -------------------------------------------------------------


async def test_github_api_get_allowed_without_kill_switch(
    public_dns, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SH_ENABLE_TOOLS", "")
    calls = {"count": 0}
    _mock_proxy_fetch(public_dns, httpx.Response(200, text='{"ok":true}'), calls)
    res = await github_api_impl(GitHubApiArgs(method="GET", path="/repos/o/r"), ctx())
    assert res.success is True
    assert calls["url"] == "https://api.github.com/repos/o/r"
    assert calls["method"] == "GET"


async def test_github_api_write_blocked_before_token_and_fetch(
    public_dns, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Kill switch OFF + a token present: the write must be refused and the token
    # must never reach the network (proxy_fetch is the spy that raises).
    monkeypatch.setenv("SH_ENABLE_TOOLS", "")
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_secret")
    calls = {"count": 0}
    _spy_never_called(public_dns, calls)
    res = await github_api_impl(
        GitHubApiArgs(method="POST", path="/repos/o/r/issues", body={"title": "x"}), ctx()
    )
    assert res.success is False
    assert "disabled" in res.result
    assert calls["count"] == 0


async def test_github_api_metadata_url_never_attaches_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A github_api path is fixed to api.github.com, but verify the SSRF guard
    # itself blocks a host that resolves to a metadata IP BEFORE the bearer
    # token is attached: resolve api.github.com to a private IP and confirm the
    # write is blocked at the guard, token never sent.
    monkeypatch.setenv("SH_ENABLE_TOOLS", "1")
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_secret")

    async def resolve_private(_host: str):
        return [("169.254.169.254", 4)]

    monkeypatch.setattr(url_guard, "_resolve_all", resolve_private)
    calls = {"count": 0}
    _spy_never_called(monkeypatch, calls)

    res = await github_api_impl(
        GitHubApiArgs(method="POST", path="/repos/o/r/issues", body={"title": "x"}), ctx()
    )
    assert res.success is False
    assert calls["count"] == 0
    assert "ghp_secret" not in res.result

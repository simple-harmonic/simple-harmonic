"""Proxy-aware, IPv4-pinned fetch tests.

TS source: packages/backend/tests/unit/proxy-fetch.test.ts

Fully offline: the httpx transport is replaced with a MockTransport (no socket),
and the macOS ``scutil`` call + proxy env vars are controlled via monkeypatch.
The IPv4 pin and proxy-decision logic live in the pure ``build_plan``, which is
asserted directly.
"""

from __future__ import annotations

import httpx
import pytest

from simple_harmonic import proxy_fetch as pf
from simple_harmonic.proxy_fetch import PinnedAddress, build_plan, proxy_fetch, read_capped


@pytest.fixture(autouse=True)
def clean_proxy_env(monkeypatch: pytest.MonkeyPatch):
    """No proxy env vars and a reset macOS-proxy cache by default. Tests opt in
    to proxy/darwin behavior explicitly."""
    for var in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"):
        monkeypatch.delenv(var, raising=False)
    # Force the macOS system-proxy lookup to a clean "no proxy" each test.
    monkeypatch.setattr(pf, "_cached_system_proxy", None)
    return monkeypatch


def _mock_client(monkeypatch: pytest.MonkeyPatch, handler, *, capture: dict | None = None):
    """Patch ``_build_client`` to return an AsyncClient backed by MockTransport.
    ``capture`` (if given) records the proxy kwarg the real builder would use."""
    real_build = pf._build_client

    def fake_build(plan):
        if capture is not None:
            capture["proxy_url"] = plan.proxy_url
            capture["pin"] = plan.pin
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(pf, "_build_client", fake_build)
    return real_build


# --- build_plan: the IPv4 pin + proxy decision -----------------------------


def test_build_plan_direct_keeps_pin_and_targets_v4() -> None:
    plan = build_plan(
        "https://api.example.com:8443/v1/chat?model=gpt",
        pin=PinnedAddress(ip="93.184.216.34", family=4),
    )
    assert plan.proxy_url is None
    assert plan.pin == PinnedAddress(ip="93.184.216.34", family=4)
    assert plan.hostname == "api.example.com"
    assert plan.port == 8443
    assert plan.method == "GET"


def test_build_plan_defaults_port_443() -> None:
    plan = build_plan("https://example.com/path")
    assert plan.port == 443


def test_build_plan_drops_pin_when_proxy_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.local:8080")
    plan = build_plan("https://example.com/", pin=PinnedAddress(ip="1.2.3.4", family=4))
    assert plan.proxy_url == "http://proxy.local:8080"
    # Proxy resolves the host itself; the IP pin is not applied.
    assert plan.pin is None


def test_build_plan_encodes_body() -> None:
    plan = build_plan("https://example.com/", method="post", body={"a": 1}.__repr__())
    assert plan.method == "POST"
    assert plan.body is not None


# --- proxy env-var precedence ----------------------------------------------


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        (
            {
                "HTTPS_PROXY": "http://https-proxy:1111",
                "HTTP_PROXY": "http://http-proxy:2222",
                "https_proxy": "http://lower-https:3333",
                "http_proxy": "http://lower-http:4444",
            },
            "http://https-proxy:1111",
        ),
        ({"HTTP_PROXY": "http://http-proxy:2222"}, "http://http-proxy:2222"),
        ({"https_proxy": "http://lower-https:3333"}, "http://lower-https:3333"),
        ({"http_proxy": "http://lower-http:4444"}, "http://lower-http:4444"),
    ],
)
def test_proxy_env_precedence(
    monkeypatch: pytest.MonkeyPatch, env: dict[str, str], expected: str
) -> None:
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    assert build_plan("https://example.com/").proxy_url == expected


# --- macOS system proxy fallback -------------------------------------------


def test_system_proxy_used_on_darwin(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pf, "_cached_system_proxy", ...)
    monkeypatch.setattr(pf.sys, "platform", "darwin")

    class _Done:
        stdout = (
            "<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : 7890\n"
            "  HTTPSProxy : 127.0.0.1\n}\n"
        )

    monkeypatch.setattr(pf.subprocess, "run", lambda *a, **k: _Done())
    assert build_plan("https://example.com/").proxy_url == "http://127.0.0.1:7890"


def test_system_proxy_caches_scutil(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pf, "_cached_system_proxy", ...)
    monkeypatch.setattr(pf.sys, "platform", "darwin")
    calls = {"n": 0}

    class _Done:
        stdout = "HTTPSEnable : 1\nHTTPSPort : 7890\nHTTPSProxy : 127.0.0.1\n"

    def fake_run(*_a, **_k):
        calls["n"] += 1
        return _Done()

    monkeypatch.setattr(pf.subprocess, "run", fake_run)
    build_plan("https://example.com/a")
    build_plan("https://example.com/b")
    assert calls["n"] == 1


def test_system_proxy_skipped_when_https_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pf, "_cached_system_proxy", ...)
    monkeypatch.setattr(pf.sys, "platform", "darwin")

    class _Done:
        stdout = "<dictionary> {\n  HTTPSEnable : 0\n}\n"

    monkeypatch.setattr(pf.subprocess, "run", lambda *a, **k: _Done())
    assert build_plan("https://example.com/").proxy_url is None


def test_system_proxy_skipped_on_non_darwin(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pf, "_cached_system_proxy", ...)
    monkeypatch.setattr(pf.sys, "platform", "linux")
    assert build_plan("https://example.com/").proxy_url is None


def test_system_proxy_falls_back_when_scutil_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pf, "_cached_system_proxy", ...)
    monkeypatch.setattr(pf.sys, "platform", "darwin")

    def boom(*_a, **_k):
        raise FileNotFoundError("scutil not found")

    monkeypatch.setattr(pf.subprocess, "run", boom)
    assert build_plan("https://example.com/").proxy_url is None


# --- proxy_fetch over a mocked transport (no socket) -----------------------


async def test_direct_get_keeps_real_host_in_url(monkeypatch: pytest.MonkeyPatch) -> None:
    # At the request layer the URL must keep the REAL hostname (not the pinned
    # IP): the IP override happens at the transport/connection layer so TLS SNI +
    # cert verification still target the real host. See _PinnedTransport.
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["host"] = request.headers.get("host")
        return httpx.Response(200, text="hello")

    _mock_client(monkeypatch, handler)
    res = await proxy_fetch(
        "https://example.com/v1?x=1", pin=PinnedAddress(ip="93.184.216.34", family=4)
    )
    assert res.status_code == 200
    assert res.text == "hello"
    # The URL host and Host header are the real hostname — the bare IP must NOT
    # appear in the request URL (that would break SNI/cert verification).
    assert "93.184.216.34" not in str(seen["url"])
    assert "example.com" in str(seen["url"])
    assert seen["host"] == "example.com"


async def test_pinned_transport_dials_ip_but_keeps_sni_and_host(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # DISCRIMINATING: the connection must dial the pinned IP while TLS SNI
    # (server_hostname) + the Host header stay the REAL hostname. This is the
    # anti-rebinding pin done the curl/pinnedLookup way: override DNS only, never
    # the cert-verification target. A naive URL rewrite would set SNI to the IP.
    import httpcore

    captured: dict[str, object] = {}

    class _FakePool:
        async def handle_async_request(self, req: httpcore.Request) -> httpcore.Response:
            captured["dial_host"] = req.url.host  # the TCP connect target
            captured["sni"] = req.extensions.get("sni_hostname")
            for k, v in req.headers:
                if k.lower() == b"host":
                    captured["host_header"] = v.decode()
            return httpcore.Response(200, headers=[], content=b"ok")

    transport = pf._PinnedTransport(PinnedAddress(ip="93.184.216.34", family=4), retries=0)
    transport._pool = _FakePool()  # type: ignore[assignment]
    req = httpx.Request("GET", "https://api.example.com/v1?x=1")
    resp = await transport.handle_async_request(req)
    assert resp.status_code == 200
    # Connection dials the pinned IP...
    assert captured["dial_host"] == b"93.184.216.34"
    # ...but SNI + cert verification + Host routing all target the real host.
    assert captured["sni"] == "api.example.com"
    assert captured["host_header"] == "api.example.com"


async def test_direct_get_without_pin_uses_hostname(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(204)

    _mock_client(monkeypatch, handler)
    res = await proxy_fetch("https://example.com/path")
    assert res.status_code == 204
    assert "example.com" in str(seen["url"])


async def test_post_sends_body(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["content"] = request.content
        return httpx.Response(201, text="{}")

    _mock_client(monkeypatch, handler)
    res = await proxy_fetch(
        "https://example.com/v1",
        method="POST",
        headers={"Content-Type": "application/json"},
        body='{"prompt":"hi"}',
    )
    assert res.status_code == 201
    assert seen["method"] == "POST"
    assert seen["content"] == b'{"prompt":"hi"}'


async def test_proxy_decision_recorded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.local:8080")
    capture: dict[str, object] = {}

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="ok")

    _mock_client(monkeypatch, handler, capture=capture)
    await proxy_fetch("https://api.example.com/x", pin=PinnedAddress(ip="1.2.3.4", family=4))
    # Proxy path: proxy_url set, pin dropped (proxy is the trust boundary).
    assert capture["proxy_url"] == "http://proxy.local:8080"
    assert capture["pin"] is None


async def test_read_capped_truncates(monkeypatch: pytest.MonkeyPatch) -> None:
    big = "x" * 5000

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=big)

    _mock_client(monkeypatch, handler)
    res = await proxy_fetch("https://example.com/")
    text = await read_capped(res, max_bytes=1000)
    assert len(text) == 1000


async def test_read_capped_stops_streaming_early(monkeypatch: pytest.MonkeyPatch) -> None:
    # DISCRIMINATING: a malicious/large server streams many chunks; read_capped
    # must stop pulling from the stream once the byte cap is hit, NOT buffer the
    # whole body first (the TS streaming-cap DoS protection). We count bytes the
    # stream actually yielded and assert it is far less than the full payload.
    pulled = {"chunks": 0}

    class _CountingStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            for _ in range(1000):  # would be ~1000 * 1KB = ~1MB if fully drained
                pulled["chunks"] += 1
                yield b"x" * 1024

        async def aclose(self) -> None:
            return None

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=_CountingStream())

    _mock_client(monkeypatch, handler)
    res = await proxy_fetch("https://example.com/")
    text = await read_capped(res, max_bytes=2048)
    assert len(text) == 2048
    # Stopped after ~2-3 chunks, never drained all 1000.
    assert pulled["chunks"] <= 5


async def test_request_error_propagates(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    _mock_client(monkeypatch, handler)
    with pytest.raises(httpx.ConnectError):
        await proxy_fetch("https://example.com/")

"""Network tools: http_fetch (safe, GET-only) and github_api (read safe /
write destructive).

TS source: packages/backend/src/server/tools/network.ts

http_fetch is read-only by construction: only GET, capped response, so it is
not gated by the destructive kill switch. github_api permits GET without the
switch; any mutating method requires :func:`tools_enabled` AND a GITHUB_TOKEN.

SSRF ordering is load-bearing: :func:`assert_public_and_resolve` runs and PASSES
before any connector bearer token is attached or :func:`proxy_fetch` is called,
and the resolved address is pinned to prevent TOCTOU rebinding.
"""

from __future__ import annotations

from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator

from simple_harmonic.connectors import resolve_connector
from simple_harmonic.proxy_fetch import PinnedAddress, proxy_fetch, read_capped
from simple_harmonic.tools.registry import ToolDefinition
from simple_harmonic.tools.sandbox import tools_enabled
from simple_harmonic.tools.types import ToolExecResult, ToolResult, ToolRunContext
from simple_harmonic.tools.url_guard import assert_public_and_resolve

MAX_BODY_BYTES = 128 * 1024

GitHubMethod = Literal["GET", "POST", "PATCH", "PUT", "DELETE"]


# --- http_fetch -------------------------------------------------------------


class HttpFetchArgs(BaseModel):
    url: str = Field(description="Absolute public HTTPS URL to GET")

    @field_validator("url")
    @classmethod
    def _must_be_url(cls, v: str) -> str:
        parsed = urlsplit(v)
        if not parsed.scheme or not parsed.netloc:
            raise ValueError("must be an absolute URL")
        return v


http_fetch_def = ToolDefinition(
    name="http_fetch",
    description=(
        "HTTPS GET a public URL and return the response body as text (truncated if "
        "large). Read-only: only GET is supported; localhost and private-network "
        "targets are rejected."
    ),
    category="network",
    risk="safe",
    schema=HttpFetchArgs,
)


async def http_fetch_impl(args: HttpFetchArgs, _ctx: ToolRunContext) -> ToolExecResult:
    try:
        checked = await assert_public_and_resolve(args.url)
        res = await proxy_fetch(
            checked.url.geturl(),
            method="GET",
            pin=PinnedAddress(ip=checked.pinnedIp, family=checked.family),
        )
        text = await read_capped(res, MAX_BODY_BYTES)
        ok = res.is_success
        return ToolExecResult(
            toolName="http_fetch",
            success=ok,
            result=text if ok else f"HTTP {res.status_code} {res.reason_phrase}: {text[:2000]}",
            action=ToolResult(
                actionType="http_fetched",
                payload={
                    "url": checked.url.geturl(),
                    "status": res.status_code,
                    "bytes": len(text.encode("utf-8")),
                    "output": text[:2_000],
                },
            ),
        )
    except Exception as err:
        return ToolExecResult(
            toolName="http_fetch",
            success=False,
            result=f"http_fetch failed for {args.url}: {err}",
        )


# --- github_api -------------------------------------------------------------


class GitHubApiArgs(BaseModel):
    method: GitHubMethod = Field(
        description="HTTP method. Non-GET methods are destructive and gated."
    )
    path: str = Field(
        description="GitHub API path, e.g. '/repos/owner/repo/issues'. Leading slash required."
    )
    body: dict[str, object] | None = Field(
        default=None, description="JSON body for POST/PATCH/PUT requests"
    )


github_api_def = ToolDefinition(
    name="github_api",
    description=(
        "Call the GitHub REST API. GET is read-only; POST/PATCH/PUT/DELETE mutate and "
        "require the destructive-tools switch plus a GITHUB_TOKEN. Provide an API path "
        "like '/repos/owner/repo/issues'."
    ),
    category="network",
    risk="destructive",
    is_destructive=lambda args: args.method != "GET",
    schema=GitHubApiArgs,
)


async def github_api_impl(args: GitHubApiArgs, _ctx: ToolRunContext) -> ToolExecResult:
    is_write = args.method != "GET"

    if is_write and not tools_enabled():
        return ToolExecResult(
            toolName="github_api",
            success=False,
            result=(
                "Mutating github_api calls are disabled. They require SH_ENABLE_TOOLS "
                "until the approval flow is enabled. GET requests are always allowed."
            ),
        )

    token = resolve_connector("GITHUB_TOKEN")
    if is_write and not token:
        return ToolExecResult(
            toolName="github_api",
            success=False,
            result=(
                "GITHUB_TOKEN is not configured. Set it in .simple-harmonic/secrets.json "
                "or as an env var."
            ),
        )

    if not args.path.startswith("/"):
        return ToolExecResult(
            toolName="github_api",
            success=False,
            result=f"path must start with '/', got \"{args.path}\"",
        )

    try:
        headers: dict[str, str] = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "simple-harmonic-agent",
        }
        gh_url = f"https://api.github.com{args.path}"
        # SSRF guard BEFORE attaching the bearer token: pin the resolved IP and
        # only then add Authorization + send.
        checked = await assert_public_and_resolve(gh_url)
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if args.body is not None:
            headers["Content-Type"] = "application/json"

        body = None
        if args.body is not None:
            import json

            body = json.dumps(args.body)

        res = await proxy_fetch(
            gh_url,
            method=args.method,
            headers=headers,
            body=body,
            pin=PinnedAddress(ip=checked.pinnedIp, family=checked.family),
        )
        text = await read_capped(res, MAX_BODY_BYTES)
        ok = res.is_success
        return ToolExecResult(
            toolName="github_api",
            success=ok,
            result=text
            if ok
            else f"GitHub {res.status_code} {res.reason_phrase}: {text[:2000]}",
            action=ToolResult(
                actionType="github_api_called",
                payload={
                    "method": args.method,
                    "path": args.path,
                    "status": res.status_code,
                    "output": text[:2_000],
                },
            ),
        )
    except Exception as err:
        return ToolExecResult(
            toolName="github_api",
            success=False,
            result=f"github_api failed for {args.method} {args.path}: {err}",
        )

"""API tool runtime: turns a custom-tool config into a registry-compatible
ToolDefinition + ToolImpl pair.

TS source: packages/backend/src/server/tools/api-tool-runtime.ts

Each custom API tool becomes a named tool agents can call. It makes
authenticated HTTP requests against the configured base URL, using a connector
for auth. Methods are restricted to the allowedMethods set.

SSRF ordering is load-bearing: :func:`assert_public_and_resolve` runs and PASSES
before the connector bearer token is attached or :func:`proxy_fetch` is called,
and the resolved address is pinned to prevent TOCTOU rebinding.
"""

from __future__ import annotations

import json
from typing import Annotated, Literal
from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel, Field, create_model

from simple_harmonic.connectors import resolve_connector
from simple_harmonic.proxy_fetch import PinnedAddress, proxy_fetch, read_capped
from simple_harmonic.store.types import ApiToolConfig
from simple_harmonic.tools.registry import ToolDefinition, ToolImpl
from simple_harmonic.tools.types import ToolExecResult, ToolResult, ToolRunContext
from simple_harmonic.tools.url_guard import assert_public_and_resolve

MAX_BODY_BYTES = 128 * 1024


def _build_args_model(name: str, config: ApiToolConfig) -> type[BaseModel]:
    methods = config.allowedMethods or ["GET"]
    method_type = Literal[tuple(methods)]  # type: ignore[valid-type]
    return create_model(
        f"{name}_Args",
        method=(
            method_type,
            Field(description=f"HTTP method. Allowed: {', '.join(methods)}"),
        ),
        path=(
            str,
            Field(
                description=(
                    f"API path (appended to {config.baseUrl}{config.pathPrefix or ''}). "
                    "Include leading slash."
                )
            ),
        ),
        body=(
            Annotated[dict[str, object] | None, Field(default=None)],
            Field(description="JSON body for POST/PATCH/PUT requests"),
        ),
        query=(
            Annotated[dict[str, str] | None, Field(default=None)],
            Field(description="Query parameters as key-value pairs"),
        ),
    )


def build_api_tool_def(name: str, description: str, config: ApiToolConfig) -> ToolDefinition:
    return ToolDefinition(
        name=name,
        description=description,
        category="network",
        risk="destructive",
        is_destructive=lambda args: getattr(args, "method", None) != "GET",
        schema=_build_args_model(name, config),
    )


def build_api_tool_impl(tool_name: str, config: ApiToolConfig) -> ToolImpl:
    async def impl(args: BaseModel, _ctx: ToolRunContext) -> ToolExecResult:
        method: str = args.method  # type: ignore[attr-defined]
        path: str = args.path  # type: ignore[attr-defined]
        body = args.body  # type: ignore[attr-defined]
        query = args.query  # type: ignore[attr-defined]

        # Resolve auth connector.
        auth_value: str | None = None
        if config.connectorKey:
            auth_value = resolve_connector(config.connectorKey)
            if not auth_value and method != "GET":
                return ToolExecResult(
                    toolName=tool_name,
                    success=False,
                    result=(
                        f'Connector "{config.connectorKey}" is not configured. Set it in '
                        ".simple-harmonic/secrets.json or as an env var."
                    ),
                )

        # Build URL.
        prefix = config.pathPrefix or ""
        full_path = path if path.startswith("/") else f"/{path}"
        url = f"{config.baseUrl}{prefix}{full_path}"
        if query:
            from urllib.parse import urlencode

            split = urlsplit(url)
            existing = split.query
            extra = urlencode(query)
            new_query = f"{existing}&{extra}" if existing else extra
            url = urlunsplit(split._replace(query=new_query))

        # SSRF guard BEFORE attaching the connector secret: a skill whose baseUrl
        # resolves to an internal/metadata host must fail here so the bearer token
        # is never sent off-box.
        try:
            checked = await assert_public_and_resolve(url)
            pin = PinnedAddress(ip=checked.pinnedIp, family=checked.family)
        except Exception as err:
            return ToolExecResult(
                toolName=tool_name,
                success=False,
                result=f"{tool_name} blocked: {err}",
            )

        # Build headers.
        headers: dict[str, str] = {"User-Agent": "simple-harmonic-agent"}
        if config.defaultHeaders:
            headers.update(config.defaultHeaders)
        if auth_value:
            header_name = config.authHeader or "Authorization"
            auth_prefix = "Bearer" if config.authPrefix is None else config.authPrefix
            headers[header_name] = f"{auth_prefix} {auth_value}" if auth_prefix else auth_value
        if body is not None:
            headers["Content-Type"] = "application/json"

        try:
            res = await proxy_fetch(
                url,
                method=method,
                headers=headers,
                body=json.dumps(body) if body is not None else None,
                pin=pin,
            )
            text = await read_capped(res, MAX_BODY_BYTES)
            ok = res.is_success
            return ToolExecResult(
                toolName=tool_name,
                success=ok,
                result=text
                if ok
                else f"HTTP {res.status_code} {res.reason_phrase}: {text[:2000]}",
                action=ToolResult(
                    actionType="api_tool_called",
                    payload={
                        "tool": tool_name,
                        "method": method,
                        "path": full_path,
                        "status": res.status_code,
                        "output": text[:2_000],
                    },
                ),
            )
        except Exception as err:
            return ToolExecResult(
                toolName=tool_name,
                success=False,
                result=f"{tool_name} failed: {err}",
            )

    return impl

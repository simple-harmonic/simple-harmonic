"""Tool registry tests.

TS source: packages/backend/tests/unit/registry.test.ts

Covers: schema_to_parameters strips $schema/$defs; register raises on duplicate;
has/get; list_for_agent + allowlist filtering; get_openai_defs shape;
is_destructive (unknown -> True fail-safe, arg-aware classifier); execute never
raises (unknown tool + ValidationError -> structured error string).
"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import BaseModel, Field

from simple_harmonic.tools.default_tools import create_default_registry
from simple_harmonic.tools.registry import (
    ToolDefinition,
    ToolRegistry,
    schema_to_parameters,
)
from simple_harmonic.tools.types import PeerAgent, ToolExecResult, ToolRunContext


class EchoArgs(BaseModel):
    msg: str = Field(description="a message")
    times: int | None = None


class NestedInner(BaseModel):
    x: int


class NestedArgs(BaseModel):
    name: str
    inner: NestedInner | None = None


def make_ctx() -> ToolRunContext:
    class _Bus:
        def __init__(self) -> None:
            self.direct: list[tuple[str, str, str, str]] = []
            self.broadcasts: list[tuple[str, str, str]] = []

        async def send_direct(self, team_id: str, sender: str, to: str, content: str) -> None:
            self.direct.append((team_id, sender, to, content))

        async def broadcast(self, team_id: str, sender: str, content: str) -> None:
            self.broadcasts.append((team_id, sender, content))

    return ToolRunContext(
        teamId="team-1",
        agentId="agent-1",
        agentName="test-agent",
        peers=[
            PeerAgent(id="agent-2", name="content-scheduler", role="Manages content"),
            PeerAgent(id="agent-3", name="ops-monitor", role="Monitors operations"),
        ],
        a2ax=_Bus(),
    )


# --- schema_to_parameters --------------------------------------------------


def test_schema_to_parameters_object_with_descriptions_and_required() -> None:
    params = schema_to_parameters(EchoArgs)
    assert params["type"] == "object"
    assert params["properties"]["msg"]["description"] == "a message"
    assert params["required"] == ["msg"]


def test_schema_to_parameters_strips_schema_meta_key() -> None:
    params = schema_to_parameters(EchoArgs)
    assert "$schema" not in params


def test_schema_to_parameters_inlines_defs() -> None:
    params = schema_to_parameters(NestedArgs)
    assert "$defs" not in params
    # No dangling $ref anywhere in the tree.
    assert "$ref" not in repr(params)


# --- register / has / get --------------------------------------------------


def _safe_impl(name: str):
    async def impl(args: Any, _ctx: ToolRunContext) -> ToolExecResult:
        return ToolExecResult(toolName=name, success=True, result=getattr(args, "msg", ""))

    return impl


def test_register_and_report_via_has_get() -> None:
    r = ToolRegistry()
    r.register(
        ToolDefinition(
            name="echo", description="echoes", category="internal", risk="safe", schema=EchoArgs
        ),
        _safe_impl("echo"),
    )
    assert r.has("echo") is True
    assert r.get("echo").name == "echo"
    assert r.get("echo").risk == "safe"


def test_register_raises_on_duplicate() -> None:
    r = ToolRegistry()
    definition = ToolDefinition(
        name="echo", description="echoes", category="internal", risk="safe", schema=EchoArgs
    )
    r.register(definition, _safe_impl("echo"))
    with pytest.raises(ValueError, match="already registered"):
        r.register(definition, _safe_impl("echo"))


def test_has_get_unknown() -> None:
    r = ToolRegistry()
    assert r.has("nope") is False
    assert r.get("nope") is None


# --- listing + OpenAI defs -------------------------------------------------


def _loaded() -> ToolRegistry:
    r = ToolRegistry()
    r.register(
        ToolDefinition(
            name="a", description="tool a", category="internal", risk="safe", schema=EchoArgs
        ),
        _safe_impl("a"),
    )
    r.register(
        ToolDefinition(
            name="b",
            description="tool b",
            category="filesystem",
            risk="destructive",
            schema=EchoArgs,
        ),
        _safe_impl("b"),
    )
    return r


def test_list_all_when_no_allowlist() -> None:
    assert sorted(d.name for d in _loaded().list_for_agent()) == ["a", "b"]


def test_list_filters_to_allowlist() -> None:
    assert [d.name for d in _loaded().list_for_agent(["a"])] == ["a"]


def test_list_ignores_unknown_allowlist_names() -> None:
    assert [d.name for d in _loaded().list_for_agent(["a", "ghost"])] == ["a"]


def test_get_openai_defs_shape_allowlist_filtered() -> None:
    defs = _loaded().get_openai_defs(["b"])
    assert len(defs) == 1
    assert defs[0]["type"] == "function"
    assert defs[0]["function"]["name"] == "b"
    assert defs[0]["function"]["description"] == "tool b"
    assert defs[0]["function"]["parameters"]["type"] == "object"


# --- is_destructive --------------------------------------------------------


def test_is_destructive_risk_label() -> None:
    r = _loaded()
    assert r.is_destructive("a") is False
    assert r.is_destructive("b") is True


def test_is_destructive_unknown_is_fail_safe_true() -> None:
    assert ToolRegistry().is_destructive("ghost") is True


def test_is_destructive_arg_aware_classifier() -> None:
    class MethodArgs(BaseModel):
        method: str

    r = ToolRegistry()
    r.register(
        ToolDefinition(
            name="api",
            description="x",
            category="network",
            risk="destructive",
            schema=MethodArgs,
            is_destructive=lambda a: a.method != "GET",
        ),
        _safe_impl("api"),
    )
    assert r.is_destructive("api", {"method": "POST"}) is True
    assert r.is_destructive("api", {"method": "GET"}) is False
    # Invalid args -> fail safe (True).
    assert r.is_destructive("api", {"bogus": 1}) is True
    assert r.is_destructive("api") is True


# --- execute (validation + dispatch) ---------------------------------------


def _with_echo() -> ToolRegistry:
    r = ToolRegistry()

    async def impl(args: EchoArgs, _ctx: ToolRunContext) -> ToolExecResult:
        return ToolExecResult(toolName="echo", success=True, result=f"got: {args.msg}")

    r.register(
        ToolDefinition(
            name="echo", description="echoes", category="internal", risk="safe", schema=EchoArgs
        ),
        impl,
    )
    return r


async def test_execute_validates_then_calls_impl() -> None:
    res = await _with_echo().execute("echo", {"msg": "hi"}, make_ctx())
    assert res.success is True
    assert res.result == "got: hi"


async def test_execute_unknown_tool_does_not_raise() -> None:
    res = await _with_echo().execute("ghost", {}, make_ctx())
    assert res.success is False
    assert "Unknown tool: ghost" in res.result


async def test_execute_validation_error_names_bad_field() -> None:
    # A dict for a str field is unambiguously invalid (pydantic won't coerce it).
    res = await _with_echo().execute("echo", {"msg": {"nested": 1}}, make_ctx())
    assert res.success is False
    assert "Invalid arguments for echo" in res.result
    assert "msg" in res.result


async def test_execute_missing_required_field() -> None:
    res = await _with_echo().execute("echo", {}, make_ctx())
    assert res.success is False
    assert "Invalid arguments for echo" in res.result


async def test_execute_does_not_call_impl_when_validation_fails() -> None:
    called = {"n": 0}
    r = ToolRegistry()

    async def impl(_args: EchoArgs, _ctx: ToolRunContext) -> ToolExecResult:
        called["n"] += 1
        return ToolExecResult(toolName="echo", success=True, result="")

    r.register(
        ToolDefinition(
            name="echo", description="x", category="internal", risk="safe", schema=EchoArgs
        ),
        impl,
    )
    await r.execute("echo", {"msg": {"bad": 1}}, make_ctx())
    assert called["n"] == 0


# --- create_default_registry (internal tools) ------------------------------


def test_default_registry_has_three_safe_internal_tools() -> None:
    r = create_default_registry()
    defs = r.list_for_agent()
    assert sorted(d.name for d in defs) == ["broadcast", "report_action", "send_message"]
    assert all(d.risk == "safe" for d in defs)
    assert all(d.category == "internal" for d in defs)


async def test_send_message_routes_to_named_peer() -> None:
    r = create_default_registry()
    ctx = make_ctx()
    res = await r.execute(
        "send_message", {"to_agent": "content-scheduler", "content": "hello"}, ctx
    )
    assert res.success is True
    assert ctx.a2ax.direct == [("team-1", "agent-1", "agent-2", "hello")]
    assert res.action.actionType == "message_sent"


async def test_send_message_unknown_peer_does_not_call_bus() -> None:
    r = create_default_registry()
    ctx = make_ctx()
    res = await r.execute("send_message", {"to_agent": "ghost", "content": "hi"}, ctx)
    assert res.success is False
    assert "ghost" in res.result
    assert ctx.a2ax.direct == []


async def test_broadcast_reports_peer_count() -> None:
    r = create_default_registry()
    ctx = make_ctx()
    res = await r.execute("broadcast", {"content": "all hands"}, ctx)
    assert res.success is True
    assert ctx.a2ax.broadcasts == [("team-1", "agent-1", "all hands")]
    assert res.action.payload == {"content": "all hands", "peerCount": 2}


async def test_report_action_merges_details() -> None:
    r = create_default_registry()
    res = await r.execute(
        "report_action",
        {"action_type": "scan", "summary": "done", "details": {"count": 3}},
        make_ctx(),
    )
    assert res.success is True
    assert res.action.actionType == "scan"
    assert res.action.payload == {"summary": "done", "count": 3}


async def test_report_action_without_details() -> None:
    r = create_default_registry()
    res = await r.execute(
        "report_action", {"action_type": "ping", "summary": "ok"}, make_ctx()
    )
    assert res.success is True
    assert res.action.payload == {"summary": "ok"}

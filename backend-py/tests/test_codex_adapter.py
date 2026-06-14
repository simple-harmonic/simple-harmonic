"""Codex adapter tests — exec one-shot path + app-server JSON-RPC bridge + harness.

Ports:
  packages/backend/tests/unit/codex-adapter.test.ts      (exec path)
  packages/backend/tests/unit/codex-app-server.test.ts   (JSON-RPC client)
  packages/backend/tests/unit/codex-harness.test.ts       (engine-mode harness)

Everything is OFFLINE:
  - exec path mocks ``asyncio.create_subprocess_exec`` (no real ``codex`` process);
  - app-server path is driven by a fake in-memory transport (scripted JSON-RPC lines);
  - the harness is fed a fake CodexAppServerClient that scripts a turn.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any

import pytest

from simple_harmonic.meta_agent import codex_adapter as ca
from simple_harmonic.meta_agent.codex_adapter import (
    CodexAppServerClient,
    CodexAppServerError,
    JsonRpcTransport,
    ThreadHandlers,
    create_codex_client,
    create_codex_exec_client,
    default_server_request_result,
    extract_json_object,
    run_codex_agent_tick,
)
from simple_harmonic.meta_agent.types import (
    AgentConfig,
    CodexThreadSuspension,
    ResumeState,
    ToolDecision,
    TraceStep,
    is_codex_thread_suspension,
)
from simple_harmonic.tools.types import PeerAgent, ToolExecResult, ToolResult

# asyncio_mode = "auto" (pyproject) runs ``async def`` tests without a marker.


# ===========================================================================
# Exec one-shot path
# ===========================================================================


@dataclass
class _FakeProc:
    """A stand-in for an asyncio subprocess. Records the stdin payload it was
    fed via ``communicate`` and returns scripted stdout/stderr + returncode."""

    stdout_text: str = ""
    stderr_text: str = ""
    returncode: int | None = 0
    fed_stdin: bytes | None = None
    terminated: bool = False

    async def communicate(self, payload: bytes | None = None) -> tuple[bytes, bytes]:
        self.fed_stdin = payload
        return (self.stdout_text.encode(), self.stderr_text.encode())

    def terminate(self) -> None:
        self.terminated = True


def _patch_exec(
    monkeypatch: pytest.MonkeyPatch, proc: _FakeProc
) -> dict[str, Any]:
    """Patch ``asyncio.create_subprocess_exec`` to return ``proc``; capture argv/env."""
    captured: dict[str, Any] = {}

    async def fake_exec(*args: Any, **kwargs: Any) -> _FakeProc:
        captured["args"] = args
        captured["env"] = kwargs.get("env")
        return proc

    monkeypatch.setattr(ca.asyncio, "create_subprocess_exec", fake_exec)
    return captured


def _agent_message(text: str) -> str:
    return json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": text}})


async def test_create_codex_client_is_llm_client_shaped() -> None:
    client = create_codex_client("gpt-5.5")
    assert client.chat is not None
    assert client.chat.completions is not None
    assert callable(client.chat.completions.create)


async def test_returns_text_response_for_plain_text(monkeypatch: pytest.MonkeyPatch) -> None:
    proc = _FakeProc(stdout_text=_agent_message("Hello from codex"))
    _patch_exec(monkeypatch, proc)

    client = create_codex_exec_client()
    res = await client.chat.completions.create(
        {
            "model": "gpt-5.5",
            "messages": [
                {"role": "system", "content": "Be helpful"},
                {"role": "user", "content": "Hi"},
            ],
        }
    )

    assert len(res.choices) == 1
    assert res.choices[0].message.content == "Hello from codex"
    assert res.choices[0].finish_reason == "stop"
    # The prompt was piped via stdin (the trailing "-" argv entry).
    assert proc.fed_stdin is not None and b"Be helpful" in proc.fed_stdin


async def test_returns_no_response_when_output_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_exec(monkeypatch, _FakeProc(stdout_text=""))
    client = create_codex_exec_client()
    res = await client.chat.completions.create(
        {"model": "gpt-5.5", "messages": [{"role": "user", "content": "Hi"}]}
    )
    assert res.choices[0].message.content == "No response from agent."


async def test_parses_tool_calls_from_structured_json(monkeypatch: pytest.MonkeyPatch) -> None:
    inner = json.dumps(
        {
            "content": None,
            "tool_calls": [
                {"name": "report_action", "arguments": {"action_type": "test", "summary": "done"}}
            ],
        }
    )
    _patch_exec(monkeypatch, _FakeProc(stdout_text=_agent_message(inner)))

    client = create_codex_exec_client()
    res = await client.chat.completions.create(
        {
            "model": "gpt-5.5",
            "messages": [{"role": "user", "content": "Do something"}],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "report_action",
                        "description": "Report an action",
                        "parameters": {"type": "object", "properties": {}},
                    },
                }
            ],
        }
    )

    tool_calls = res.choices[0].message.tool_calls
    assert tool_calls is not None and len(tool_calls) == 1
    assert tool_calls[0].function.name == "report_action"
    assert json.loads(tool_calls[0].function.arguments) == {
        "action_type": "test",
        "summary": "done",
    }
    assert res.choices[0].finish_reason == "tool_calls"


async def test_handles_exec_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    # Non-zero exit code AND no stdout -> RuntimeError("codex exec failed: ...").
    _patch_exec(monkeypatch, _FakeProc(stdout_text="", stderr_text="codex not found", returncode=1))
    client = create_codex_exec_client()
    with pytest.raises(RuntimeError, match="codex exec failed"):
        await client.chat.completions.create(
            {"model": "gpt-5.5", "messages": [{"role": "user", "content": "Hi"}]}
        )


async def test_handles_markdown_fenced_response(monkeypatch: pytest.MonkeyPatch) -> None:
    text = '```json\n{"content": "fenced response"}\n```'
    _patch_exec(monkeypatch, _FakeProc(stdout_text=_agent_message(text)))
    client = create_codex_exec_client()
    res = await client.chat.completions.create(
        {
            "model": "gpt-5.5",
            "messages": [{"role": "user", "content": "Hi"}],
            "tools": [{"type": "function", "function": {"name": "test", "parameters": {}}}],
        }
    )
    assert res.choices[0].message.content == "fenced response"


async def test_non_json_text_is_plain_content_when_tools_provided(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_exec(monkeypatch, _FakeProc(stdout_text=_agent_message("Just plain text, not JSON")))
    client = create_codex_exec_client()
    res = await client.chat.completions.create(
        {
            "model": "gpt-5.5",
            "messages": [{"role": "user", "content": "Hi"}],
            "tools": [{"type": "function", "function": {"name": "test", "parameters": {}}}],
        }
    )
    assert res.choices[0].message.content == "Just plain text, not JSON"
    assert res.choices[0].message.tool_calls is None


async def test_last_agent_message_wins_despite_error_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    jsonl = "\n".join(
        [
            json.dumps({"type": "error", "error": {"message": "Rate limit exceeded"}}),
            _agent_message("Recovered response"),
        ]
    )
    _patch_exec(monkeypatch, _FakeProc(stdout_text=jsonl))
    client = create_codex_exec_client()
    res = await client.chat.completions.create(
        {"model": "gpt-5.5", "messages": [{"role": "user", "content": "Hi"}]}
    )
    assert res.choices[0].message.content == "Recovered response"


async def test_skips_non_json_and_non_agent_message_lines(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    jsonl = "\n".join(
        [
            "not json",
            "",
            json.dumps(
                {"type": "item.completed", "item": {"type": "shell_command", "command": "ls"}}
            ),
            _agent_message("valid"),
        ]
    )
    _patch_exec(monkeypatch, _FakeProc(stdout_text=jsonl))
    client = create_codex_exec_client()
    res = await client.chat.completions.create(
        {"model": "gpt-5.5", "messages": [{"role": "user", "content": "Hi"}]}
    )
    assert res.choices[0].message.content == "valid"


async def test_json_content_no_tool_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    inner = json.dumps({"content": "Structured text, no tools"})
    _patch_exec(monkeypatch, _FakeProc(stdout_text=_agent_message(inner)))
    client = create_codex_exec_client()
    res = await client.chat.completions.create(
        {
            "model": "gpt-5.5",
            "messages": [{"role": "user", "content": "Hi"}],
            "tools": [{"type": "function", "function": {"name": "test", "parameters": {}}}],
        }
    )
    assert res.choices[0].message.content == "Structured text, no tools"
    assert res.choices[0].message.tool_calls is None
    assert res.choices[0].finish_reason == "stop"


async def test_hallucinated_tool_name_is_dropped(monkeypatch: pytest.MonkeyPatch) -> None:
    inner = json.dumps(
        {"content": "fallback", "tool_calls": [{"name": "not_offered", "arguments": {}}]}
    )
    _patch_exec(monkeypatch, _FakeProc(stdout_text=_agent_message(inner)))
    client = create_codex_exec_client()
    res = await client.chat.completions.create(
        {
            "model": "gpt-5.5",
            "messages": [{"role": "user", "content": "Hi"}],
            "tools": [
                {"type": "function", "function": {"name": "report_action", "parameters": {}}}
            ],
        }
    )
    # All calls filtered out -> falls through to content, no tool_calls.
    assert res.choices[0].message.content == "fallback"
    assert res.choices[0].message.tool_calls is None


async def test_exec_argv_carries_model_and_pipes_via_stdin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    proc = _FakeProc(stdout_text=_agent_message("ok"))
    captured = _patch_exec(monkeypatch, proc)
    client = create_codex_exec_client()
    await client.chat.completions.create(
        {"model": "gpt-5.5", "messages": [{"role": "user", "content": "Hi"}]}
    )
    # ("codex", "exec", "--json", ..., '-c', 'model="gpt-5.5"', ..., "-")
    args = captured["args"]
    assert args[0] == "codex"
    assert 'model="gpt-5.5"' in args
    assert args[-1] == "-"
    # coding_env must not leak arbitrary secrets (only CODEX_HOME/OPENAI_API_KEY allowed).
    env = captured["env"]
    assert "ANTHROPIC_API_KEY" not in env
    assert "GITHUB_TOKEN" not in env


async def test_exec_aborts_when_signal_already_set(monkeypatch: pytest.MonkeyPatch) -> None:
    # Signal set before the call -> CancelledError, subprocess never spawned.
    spawned = {"count": 0}

    async def fake_exec(*args: Any, **kwargs: Any) -> _FakeProc:
        spawned["count"] += 1
        return _FakeProc(stdout_text=_agent_message("nope"))

    monkeypatch.setattr(ca.asyncio, "create_subprocess_exec", fake_exec)

    from simple_harmonic.llm.client import CompletionOptions

    signal = asyncio.Event()
    signal.set()
    client = create_codex_exec_client()
    with pytest.raises(asyncio.CancelledError):
        await client.chat.completions.create(
            {"model": "gpt-5.5", "messages": [{"role": "user", "content": "Hi"}]},
            CompletionOptions(signal=signal),
        )
    assert spawned["count"] == 0


def test_extract_json_object_brace_scans_past_prose() -> None:
    assert extract_json_object('prose {"a": 1} trailing') == '{"a": 1}'
    assert extract_json_object('text {"a": "}"} more') == '{"a": "}"}'  # brace inside string
    assert extract_json_object("no object here") is None


# ===========================================================================
# App-server JSON-RPC client
# ===========================================================================


class _FakeTransport:
    """In-memory JSON-RPC transport: records framed sends, lets the test feed
    server lines / close events. Mirrors the vitest ``makeFake`` helper."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self._line_cb: Any = lambda line: None
        self._close_cb: Any = lambda reason: None
        self.closed = False

    def as_transport(self) -> JsonRpcTransport:
        return JsonRpcTransport(
            send=lambda line: self.sent.append(json.loads(line)),
            on_line=self._set_line_cb,
            on_close=self._set_close_cb,
            close=self._close,
        )

    def _set_line_cb(self, cb: Any) -> None:
        self._line_cb = cb

    def _set_close_cb(self, cb: Any) -> None:
        self._close_cb = cb

    def _close(self) -> None:
        self.closed = True

    def receive(self, obj: dict[str, Any]) -> None:
        self._line_cb(json.dumps(obj))

    def receive_raw(self, line: str) -> None:
        self._line_cb(line)

    def server_close(self, reason: str) -> None:
        self._close_cb(reason)

    def by_method(self, method: str) -> list[dict[str, Any]]:
        return [m for m in self.sent if m.get("method") == method]


async def _settle() -> None:
    """Let queued async handlers (server-request coroutines) run."""
    await asyncio.sleep(0)
    await asyncio.sleep(0)


async def test_correlates_requests_and_responses_by_id() -> None:
    fake = _FakeTransport()
    client = CodexAppServerClient(fake.as_transport())

    fut = client.request("model/list", {})
    req = fake.sent[0]
    assert req["method"] == "model/list"
    assert req["jsonrpc"] == "2.0"

    fake.receive({"id": req["id"], "result": {"models": ["gpt-5.5"]}})
    assert await fut == {"models": ["gpt-5.5"]}


async def test_rejects_with_error_on_error_response() -> None:
    fake = _FakeTransport()
    client = CodexAppServerClient(fake.as_transport())
    fut = client.request("thread/start", {})
    fake.receive({"id": fake.sent[0]["id"], "error": {"code": -32600, "message": "bad params"}})
    with pytest.raises(CodexAppServerError, match=r"thread/start failed: bad params"):
        await fut


async def test_initialize_sends_capability_then_initialized() -> None:
    fake = _FakeTransport()
    client = CodexAppServerClient(fake.as_transport())
    fut = client.initialize({"name": "sh", "title": "SH", "version": "1.0"})
    init = fake.sent[0]
    assert init["method"] == "initialize"
    assert init["params"]["capabilities"] == {"experimentalApi": True, "requestAttestation": False}
    fake.receive({"id": init["id"], "result": {"codexHome": "/x"}})
    await fut
    assert len(fake.by_method("initialized")) == 1


async def test_routes_server_request_to_thread_handler_and_replies() -> None:
    fake = _FakeTransport()
    client = CodexAppServerClient(fake.as_transport())
    seen: list[tuple[str, dict[str, Any]]] = []

    async def on_request(method: str, params: dict[str, Any]) -> Any:
        seen.append((method, params))
        return {"success": True, "contentItems": []}

    client.register_thread("thr_1", ThreadHandlers(on_request=on_request))
    fake.receive(
        {
            "id": 7,
            "method": "item/tool/call",
            "params": {
                "threadId": "thr_1",
                "callId": "c1",
                "tool": "send_message",
                "arguments": {"a": 1},
            },
        }
    )
    await _settle()

    assert seen and seen[0][0] == "item/tool/call" and seen[0][1]["tool"] == "send_message"
    reply = next(m for m in fake.sent if m.get("id") == 7)
    assert reply["result"] == {"success": True, "contentItems": []}


async def test_unrouted_server_requests_get_safe_declines() -> None:
    fake = _FakeTransport()
    CodexAppServerClient(fake.as_transport())
    fake.receive({"id": 1, "method": "item/tool/call", "params": {"threadId": "ghost"}})
    fake.receive(
        {
            "id": 2,
            "method": "item/commandExecution/requestApproval",
            "params": {"threadId": "ghost"},
        }
    )
    fake.receive(
        {"id": 3, "method": "mcpServer/elicitation/request", "params": {"threadId": "ghost"}}
    )
    await _settle()

    assert next(m for m in fake.sent if m.get("id") == 1)["result"]["success"] is False
    assert next(m for m in fake.sent if m.get("id") == 2)["result"]["decision"] == "decline"
    assert next(m for m in fake.sent if m.get("id") == 3)["result"]["action"] == "decline"


async def test_throwing_handler_becomes_rpc_error() -> None:
    fake = _FakeTransport()
    client = CodexAppServerClient(fake.as_transport())

    def on_request(method: str, params: dict[str, Any]) -> Any:
        raise RuntimeError("handler exploded")

    client.register_thread("thr_1", ThreadHandlers(on_request=on_request))
    fake.receive({"id": 9, "method": "item/tool/call", "params": {"threadId": "thr_1"}})
    await _settle()

    reply = next(m for m in fake.sent if m.get("id") == 9)
    assert reply["error"]["message"] == "handler exploded"


async def test_routes_notifications_by_thread_and_ignores_malformed() -> None:
    fake = _FakeTransport()
    client = CodexAppServerClient(fake.as_transport())
    seen: list[tuple[str, dict[str, Any]]] = []
    client.register_thread(
        "thr_1", ThreadHandlers(on_notification=lambda m, p: seen.append((m, p)))
    )

    fake.receive(
        {
            "method": "turn/completed",
            "params": {"threadId": "thr_1", "turn": {"status": "completed"}},
        }
    )
    fake.receive({"method": "turn/completed", "params": {"threadId": "other"}})
    fake.receive_raw("not json at all")

    assert len(seen) == 1
    assert seen[0][0] == "turn/completed" and seen[0][1]["threadId"] == "thr_1"


async def test_stops_routing_after_unregister() -> None:
    fake = _FakeTransport()
    client = CodexAppServerClient(fake.as_transport())
    seen: list[Any] = []
    client.register_thread("thr_1", ThreadHandlers(on_notification=lambda m, p: seen.append(m)))
    client.unregister_thread("thr_1")
    fake.receive({"method": "item/completed", "params": {"threadId": "thr_1"}})
    assert seen == []


async def test_rejects_in_flight_on_close() -> None:
    fake = _FakeTransport()
    client = CodexAppServerClient(fake.as_transport())
    fut = client.request("turn/start", {"threadId": "t"})
    fake.server_close("exited (code=1)")
    with pytest.raises(CodexAppServerError, match="connection closed"):
        await fut
    assert client.is_closed is True
    with pytest.raises(CodexAppServerError, match="exited"):
        await client.request("turn/start", {})


async def test_times_out_requests_without_response() -> None:
    fake = _FakeTransport()
    client = CodexAppServerClient(fake.as_transport())
    fut = client.request("turn/start", {}, timeout_s=0.02)
    with pytest.raises(CodexAppServerError, match="no response within"):
        await fut


def test_default_server_request_result_shapes() -> None:
    assert default_server_request_result("item/tool/call")["success"] is False
    assert default_server_request_result("item/fileChange/requestApproval") == {
        "decision": "decline"
    }
    assert default_server_request_result("execCommandApproval") == {"decision": "decline"}


# ===========================================================================
# Engine-mode harness
# ===========================================================================


class _FakeRegistry:
    """Minimal registry double for the harness: one safe ``report_action`` tool."""

    def __init__(self, *, is_destructive_for: set[str] | None = None) -> None:
        self.execute_calls: list[tuple[str, Any, Any]] = []
        self._destructive = is_destructive_for or set()

    async def execute(self, name: str, raw: Any, ctx: Any) -> ToolExecResult:
        self.execute_calls.append((name, raw, ctx))
        return ToolExecResult(
            toolName=name,
            success=True,
            result="Action logged: scan",
            action=ToolResult(actionType="scan", payload={"summary": "scanned"}),
        )

    def get_openai_defs(self, allowed: Any = None) -> list[dict[str, Any]]:
        return [
            {
                "type": "function",
                "function": {
                    "name": "report_action",
                    "description": "Log an action",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ]

    def list_for_agent(self, allowed: Any = None) -> list[Any]:
        return [{"name": "report_action", "description": "Log an action"}]

    def is_destructive(self, name: str, raw: Any = None) -> bool:
        return name in self._destructive


@dataclass
class _ScriptedToolCall:
    callId: str
    tool: str
    arguments: Any


class _FakeHarnessClient:
    """Scripts a codex turn: after turn/start, drives a sequence of item/tool/call
    requests (awaiting each reply), then token-usage + final-message notifications,
    then turn/completed. Records every request the harness sends.

    Faithful Python analogue of the vitest ``makeFakeClient`` harness double.
    """

    def __init__(
        self,
        *,
        thread_id: str = "thr_1",
        tool_calls: list[_ScriptedToolCall] | None = None,
        final_message: str | None = None,
        token_usages: list[dict[str, int]] | None = None,
        complete_status: str = "completed",
        hang: bool = False,
    ) -> None:
        self.thread_id = thread_id
        self.script_tool_calls = tool_calls or []
        self.final_message = final_message
        self.token_usages = token_usages or []
        self.complete_status = complete_status
        self.hang = hang

        self.is_closed = False
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.tool_responses: list[Any] = []
        self._handlers: ThreadHandlers | None = None
        self._interrupted = False
        self.unregistered = False

    def register_thread(self, thread_id: str, handlers: ThreadHandlers) -> None:
        assert thread_id == self.thread_id
        self._handlers = handlers

    def unregister_thread(self, thread_id: str) -> None:
        self.unregistered = True

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:  # pragma: no cover
        pass

    def _notify(self, method: str, params: dict[str, Any]) -> None:
        if self._handlers and self._handlers.on_notification:
            self._handlers.on_notification(method, {"threadId": self.thread_id, **params})

    async def _drive_turn(self) -> None:
        for tc in self.script_tool_calls:
            assert self._handlers and self._handlers.on_request
            resp = self._handlers.on_request(
                "item/tool/call",
                {
                    "threadId": self.thread_id,
                    "turnId": "turn_1",
                    "callId": tc.callId,
                    "tool": tc.tool,
                    "arguments": tc.arguments,
                },
            )
            if asyncio.iscoroutine(resp):
                resp = await resp
            self.tool_responses.append(resp)
            if self._interrupted:
                break
        # Real codex keeps the turn open after a tool response; yield so the
        # harness's post-response interrupt (park path) lands first.
        await asyncio.sleep(0.01)
        for u in self.token_usages:
            self._notify("thread/tokenUsage/updated", {"tokenUsage": {"last": u, "total": u}})
        if self.final_message is not None and not self._interrupted:
            self._notify(
                "item/completed",
                {"item": {"type": "agentMessage", "text": self.final_message}},
            )
        if not self.hang:
            self._notify(
                "turn/completed",
                {
                    "turn": {
                        "id": "turn_1",
                        "status": "interrupted" if self._interrupted else self.complete_status,
                        "error": None,
                    }
                },
            )

    def request(
        self, method: str, params: dict[str, Any], *, timeout_s: float | None = None
    ) -> Any:
        self.calls.append((method, params))
        loop = asyncio.get_event_loop()
        fut: asyncio.Future[Any] = loop.create_future()
        if method in ("thread/start", "thread/resume"):
            fut.set_result({"thread": {"id": self.thread_id}})
        elif method == "turn/start":
            loop.call_soon(lambda: asyncio.ensure_future(self._drive_turn()))
            fut.set_result({"turn": {"id": "turn_1", "status": "inProgress"}})
        elif method == "turn/interrupt":
            self._interrupted = True

            def fire() -> None:
                self._notify(
                    "turn/completed",
                    {"turn": {"id": "turn_1", "status": "interrupted", "error": None}},
                )

            loop.call_soon(fire)
            fut.set_result({})
        else:
            fut.set_result({})
        return fut

    def by_method(self, method: str) -> list[dict[str, Any]]:
        return [params for (m, params) in self.calls if m == method]


def _collect() -> tuple[list[TraceStep], Any]:
    steps: list[TraceStep] = []
    return steps, lambda s: steps.append(s)


def _harness_config(client: Any, **overrides: Any) -> Any:
    """Build an AgentConfig and tack on the harness-only ``client`` / ``cwd`` attrs
    (the harness reads them via getattr; AgentConfig itself doesn't declare them)."""

    @dataclass
    class _HarnessConfig(AgentConfig):
        client: Any = None
        cwd: str | None = None

    base: dict[str, Any] = dict(
        name="Scout",
        archetype="researcher",
        tools=["report_action"],
        initialPrompt="You research things.",
        teamId="team-1",
        agentId="agent-1",
        peers=[],
        a2ax=None,
        toolRegistry=_FakeRegistry(),
        client=client,
    )
    base.update(overrides)
    return _HarnessConfig(**base)


async def test_harness_registers_dynamic_tools_and_runs_safe_call() -> None:
    fake = _FakeHarnessClient(
        tool_calls=[_ScriptedToolCall("c1", "report_action", {"summary": "hi"})],
        final_message="Done.",
        token_usages=[
            {"inputTokens": 100, "outputTokens": 10},
            {"inputTokens": 120, "outputTokens": 5},
        ],
    )
    registry = _FakeRegistry()
    steps, trace = _collect()
    config = _harness_config(fake, toolRegistry=registry, trace=trace)

    result = await run_codex_agent_tick(config)

    start = fake.by_method("thread/start")[0]
    assert start["sandbox"] == "read-only"
    assert start["approvalPolicy"] == "never"
    assert start["ephemeral"] is False
    assert start["dynamicTools"][0]["name"] == "report_action"
    assert "inputSchema" in start["dynamicTools"][0]
    assert "You research things." in str(start["developerInstructions"])

    assert registry.execute_calls and registry.execute_calls[0][0] == "report_action"
    assert registry.execute_calls[0][1] == {"summary": "hi"}
    assert fake.tool_responses[0] == {
        "success": True,
        "contentItems": [{"type": "inputText", "text": "Action logged: scan"}],
    }

    assert result.actionType == "scan"
    assert result.usage == {"inputTokens": 220, "outputTokens": 15}
    assert [s.type for s in steps] == [
        "tick_started",
        "llm_request",
        "tool_started",
        "tool_finished",
        "llm_response",
        "tick_finished",
    ]


async def test_harness_parks_on_destructive_call() -> None:
    fake = _FakeHarnessClient(
        tool_calls=[_ScriptedToolCall("c9", "write_file", {"path": "x", "content": "y"})]
    )
    registry = _FakeRegistry(is_destructive_for={"write_file"})
    steps, trace = _collect()
    config = _harness_config(fake, toolRegistry=registry, trace=trace)

    result = await run_codex_agent_tick(config)

    assert result.actionType == "suspended"
    assert result.suspension is not None
    assert is_codex_thread_suspension(result.suspension) is True
    assert result.suspension.threadId == "thr_1"
    assert result.suspension.pending[0].id == "c9"
    assert result.suspension.pending[0].name == "write_file"
    assert json.loads(result.suspension.pending[0].arguments) == {"path": "x", "content": "y"}

    assert registry.execute_calls == []  # never executed
    assert fake.tool_responses[0]["success"] is False
    assert "requires human approval" in json.dumps(fake.tool_responses[0])
    assert len(fake.by_method("turn/interrupt")) == 1
    assert "approval_requested" in [s.type for s in steps]
    assert "tick_finished" not in [s.type for s in steps]


async def test_harness_resume_executes_approved_call() -> None:
    fake = _FakeHarnessClient(thread_id="thr_9", final_message="Continuing.")
    registry = _FakeRegistry()
    steps, trace = _collect()
    suspension = CodexThreadSuspension(
        threadId="thr_9",
        pending=[__pending("c9", "write_file", json.dumps({"path": "x"}))],
        actions=[],
    )
    config = _harness_config(
        fake,
        toolRegistry=registry,
        trace=trace,
        resume=ResumeState(suspension=suspension, decisions=[ToolDecision(id="c9", approved=True)]),
    )

    result = await run_codex_agent_tick(config)

    assert fake.by_method("thread/resume")[0]["threadId"] == "thr_9"
    assert fake.by_method("thread/start") == []
    assert registry.execute_calls and registry.execute_calls[0][0] == "write_file"
    assert registry.execute_calls[0][1] == {"path": "x"}
    turn_input = fake.by_method("turn/start")[0]["input"][0]["text"]
    assert "APPROVED. Tool result:" in turn_input
    assert "decision_applied" in [s.type for s in steps]
    assert result.actionType == "scan"


async def test_harness_resume_rejection_never_executes() -> None:
    fake = _FakeHarnessClient(thread_id="thr_9", final_message="Understood.")
    registry = _FakeRegistry()
    suspension = CodexThreadSuspension(
        threadId="thr_9",
        pending=[__pending("c9", "write_file", "{}")],
        actions=[],
    )
    config = _harness_config(
        fake,
        toolRegistry=registry,
        resume=ResumeState(
            suspension=suspension,
            decisions=[ToolDecision(id="c9", approved=False, note="too risky")],
        ),
    )

    result = await run_codex_agent_tick(config)

    assert registry.execute_calls == []
    turn_input = fake.by_method("turn/start")[0]["input"][0]["text"]
    assert "REJECTED — too risky" in turn_input
    assert result.actionType == "agent_thought"
    assert result.payload["thought"] == "Understood."


async def test_harness_text_only_turn_is_agent_thought() -> None:
    fake = _FakeHarnessClient(final_message="Nothing to do.")
    config = _harness_config(fake)
    result = await run_codex_agent_tick(config)
    assert result.actionType == "agent_thought"
    assert result.payload["thought"] == "Nothing to do."


async def test_harness_raises_when_turn_fails() -> None:
    fake = _FakeHarnessClient(complete_status="failed")
    config = _harness_config(fake)
    with pytest.raises(RuntimeError, match="codex turn failed"):
        await run_codex_agent_tick(config)
    assert fake.unregistered is True


async def test_harness_aborts_on_signal() -> None:
    fake = _FakeHarnessClient(hang=True)
    signal = asyncio.Event()
    config = _harness_config(fake, signal=signal)

    task = asyncio.ensure_future(run_codex_agent_tick(config))
    await asyncio.sleep(0.01)
    signal.set()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(fake.by_method("turn/interrupt")) >= 1
    assert fake.unregistered is True


async def test_harness_validates_output_contract() -> None:
    fake = _FakeHarnessClient(
        tool_calls=[_ScriptedToolCall("c1", "report_action", {})],
        final_message="Done.",
    )
    config = _harness_config(
        fake,
        outputContract={
            "type": "object",
            "properties": {"missing": {"type": "string"}},
            "required": ["missing"],
        },
    )
    result = await run_codex_agent_tick(config)
    assert result.validation is not None
    assert result.validation.valid is False


# Small helper to build a PendingToolCall without importing it at the top in a way
# that shadows the harness's own import.
def __pending(id_: str, name: str, arguments: str) -> Any:
    from simple_harmonic.meta_agent.types import PendingToolCall

    return PendingToolCall(id=id_, name=name, arguments=arguments)


# Silence unused-import lints for fixtures referenced only via dataclass fields.
_ = (PeerAgent, field)

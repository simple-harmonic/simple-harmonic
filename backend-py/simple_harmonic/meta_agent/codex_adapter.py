"""Codex adapter — drive the Codex model via the ``codex app-server`` engine.

TS source:
  - packages/backend/src/lib/meta-agent/codex-app-server.ts   (JSON-RPC transport)
  - packages/backend/src/lib/meta-agent/codex-harness.ts      (engine-mode harness)

``codex app-server`` owns the agent loop; every SH tool is a *dynamic tool* on the
codex thread. When the model picks one, codex blocks on an ``item/tool/call``
request that we answer via the slice-6 tool registry. A destructive call parks the
turn and returns a :class:`CodexThreadSuspension`. The tick route selects this
engine-mode entry point (:func:`run_codex_agent_tick`) directly when the api-key
source is ``codex`` — codex is NOT a cascade ``LLMClient`` candidate.

Cancellation: ``AgentConfig.signal`` is an ``asyncio.Event`` (set == aborted), the
Python mapping of the TS ``AbortSignal``; an abort interrupts the turn
(``turn/interrupt``) and raises.

OFFLINE: no network and no real ``codex`` process in tests — the app-server path is
driven by a fake in-memory transport (scripted JSON-RPC lines).
"""
# ruff: noqa: E501 - inline JSON-RPC payload literals mirror the codex app-server
# protocol shapes and read better unwrapped; do not rewrap those lines.

from __future__ import annotations

import asyncio
import contextlib
import json
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from simple_harmonic.llm.client import (
    Choice,
    ChoiceMessage,
    CompletionOptions,
    LLMClient,
    LLMResponse,
    ToolCall,
    ToolCallFunction,
    Usage,
    make_client,
)

DEFAULT_CODEX_MODEL = "gpt-5.5"


def _terminate(proc: Any) -> None:
    with contextlib.suppress(ProcessLookupError):  # process already gone
        proc.terminate()


# ===========================================================================
# App-server JSON-RPC client (codex-app-server.ts)
# ===========================================================================

DEFAULT_REQUEST_TIMEOUT_S = 30.0


class CodexAppServerError(Exception):
    """RPC failure: a request errored, timed out, or the connection closed."""

    def __init__(self, method: str, code: int | None, message: str) -> None:
        super().__init__(f"codex app-server {method} failed: {message}")
        self.method = method
        self.code = code


@dataclass
class JsonRpcTransport:
    """Minimal transport so tests can drive the client without a subprocess.

    ``send`` writes one framed line; the client registers line/close callbacks via
    :meth:`on_line` / :meth:`on_close`; ``close`` tears the transport down.
    """

    send: Callable[[str], None]
    on_line: Callable[[Callable[[str], None]], None]
    on_close: Callable[[Callable[[str], None]], None]
    close: Callable[[], None]


@dataclass
class ThreadHandlers:
    """Per-thread routing for server-initiated traffic.

    ``on_request`` answers a server->client request (its return value becomes the
    RPC result; raising produces an RPC error). ``on_notification`` receives a
    server->client notification scoped to this thread.
    """

    on_request: Callable[[str, dict[str, Any]], Awaitable[Any] | Any] | None = None
    on_notification: Callable[[str, dict[str, Any]], None] | None = None


def default_server_request_result(method: str) -> dict[str, Any]:
    """Fail-closed defaults for unrouted server->client requests.

    Verbatim port of TS ``defaultServerRequestResult``."""
    if method == "item/tool/call":
        return {
            "success": False,
            "contentItems": [
                {"type": "inputText", "text": "Tool unavailable: no handler registered."}
            ],
        }
    if method == "mcpServer/elicitation/request":
        return {"action": "decline", "content": None, "_meta": None}
    # item/commandExecution/requestApproval, item/fileChange/requestApproval,
    # item/permissions/requestApproval, execCommandApproval, applyPatchApproval
    return {"decision": "decline"}


@dataclass
class _PendingRequest:
    future: asyncio.Future[Any]
    method: str
    timer: asyncio.TimerHandle


def _as_record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


class CodexAppServerClient:
    """JSON-RPC 2.0 over newline-delimited stdio.

    Faithful port of the TS ``CodexAppServerClient``: correlates request/response
    by id, routes server-initiated requests/notifications to per-thread handlers
    (by ``params.threadId``), answers unrouted server requests with fail-closed
    defaults, and rejects in-flight requests when the connection closes.

    Requests/notifications cross the wire as framed JSON lines via the injected
    :class:`JsonRpcTransport`. ``request`` returns an awaitable resolving to the
    RPC result; timeouts and errors raise :class:`CodexAppServerError`.
    """

    def __init__(self, transport: JsonRpcTransport) -> None:
        self._transport = transport
        self._next_id = 1
        self._pending: dict[int, _PendingRequest] = {}
        self._thread_handlers: dict[str, ThreadHandlers] = {}
        self._closed = False
        self._close_reason = "not closed"
        # Strong refs to fire-and-forget server-request handler tasks so they
        # aren't GC'd mid-flight (asyncio holds only weak refs).
        self._bg_tasks: set[asyncio.Task[Any]] = set()
        transport.on_line(self._handle_line)
        transport.on_close(self._handle_close)

    @property
    def is_closed(self) -> bool:
        return self._closed

    def initialize(self, client_info: dict[str, str]) -> asyncio.Future[Any]:
        """Handshake. Must be called once before any thread/turn request.

        Sends ``initialize`` with the ``experimentalApi`` capability (which
        unlocks ``thread/start.dynamicTools`` — verified against codex-cli 0.139)
        then the ``initialized`` notification once the response resolves.

        Returns a future (not a bare coroutine) so the ``initialize`` request is
        put on the wire SYNCHRONOUSLY when called — matching the TS adapter,
        where an ``async`` body runs up to its first ``await`` eagerly. Callers
        still ``await`` the result as usual."""
        req = self.request(
            "initialize",
            {
                "clientInfo": client_info,
                "capabilities": {"experimentalApi": True, "requestAttestation": False},
            },
        )
        out: asyncio.Future[Any] = asyncio.get_event_loop().create_future()

        def _on_done(done: asyncio.Future[Any]) -> None:
            if done.cancelled():
                out.cancel()
                return
            exc = done.exception()
            if exc is not None:
                out.set_exception(exc)
                return
            self.notify("initialized")
            out.set_result(done.result())

        req.add_done_callback(_on_done)
        return out

    def request(
        self, method: str, params: dict[str, Any], *, timeout_s: float | None = None
    ) -> asyncio.Future[Any]:
        loop = asyncio.get_event_loop()
        future: asyncio.Future[Any] = loop.create_future()
        if self._closed:
            future.set_exception(CodexAppServerError(method, None, self._close_reason))
            return future

        request_id = self._next_id
        self._next_id += 1
        timeout = DEFAULT_REQUEST_TIMEOUT_S if timeout_s is None else timeout_s

        def on_timeout() -> None:
            pending = self._pending.pop(request_id, None)
            if pending is not None and not pending.future.done():
                pending.future.set_exception(
                    CodexAppServerError(method, None, f"no response within {timeout}s")
                )

        timer = loop.call_later(timeout, on_timeout)
        self._pending[request_id] = _PendingRequest(future=future, method=method, timer=timer)
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        return future

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        if self._closed:
            return
        msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params:
            msg["params"] = params
        self._send(msg)

    def register_thread(self, thread_id: str, handlers: ThreadHandlers) -> None:
        self._thread_handlers[thread_id] = handlers

    def unregister_thread(self, thread_id: str) -> None:
        self._thread_handlers.pop(thread_id, None)

    def close(self) -> None:
        self._handle_close("closed by client")
        self._transport.close()

    # -- internals ----------------------------------------------------------

    def _send(self, obj: dict[str, Any]) -> None:
        try:
            self._transport.send(json.dumps(obj) + "\n")
        except Exception as err:
            self._handle_close(str(err))

    def _handle_close(self, reason: str) -> None:
        if self._closed:
            return
        self._closed = True
        self._close_reason = reason
        for pending in self._pending.values():
            pending.timer.cancel()
            if not pending.future.done():
                pending.future.set_exception(
                    CodexAppServerError(pending.method, None, f"connection closed: {reason}")
                )
        self._pending.clear()
        self._thread_handlers.clear()

    def _handle_line(self, line: str) -> None:
        trimmed = line.strip()
        if not trimmed:
            return
        try:
            msg = json.loads(trimmed)
        except (ValueError, TypeError):
            return  # stray non-JSON output (logs); ignore
        if not isinstance(msg, dict):
            return

        msg_id = msg.get("id")
        has_id = msg_id is not None
        method = msg.get("method") if isinstance(msg.get("method"), str) else None

        if has_id and method:
            task = asyncio.ensure_future(
                self._handle_server_request(msg_id, method, _as_record(msg.get("params")))
            )
            self._bg_tasks.add(task)
            task.add_done_callback(self._bg_tasks.discard)
            return
        if has_id:
            pending = self._pending.pop(msg_id, None)
            if pending is None:
                return
            pending.timer.cancel()
            if pending.future.done():
                return
            if "error" in msg and msg["error"] is not None:
                err = _as_record(msg["error"])
                pending.future.set_exception(
                    CodexAppServerError(
                        pending.method, err.get("code"), err.get("message") or "unknown error"
                    )
                )
            else:
                pending.future.set_result(msg.get("result"))
            return
        if method:
            params = _as_record(msg.get("params"))
            thread_id = params.get("threadId") if isinstance(params.get("threadId"), str) else None
            handlers = self._thread_handlers.get(thread_id) if thread_id else None
            if handlers is not None and handlers.on_notification is not None:
                # A buggy handler must not break us.
                with contextlib.suppress(Exception):
                    handlers.on_notification(method, params)

    async def _handle_server_request(
        self, msg_id: Any, method: str, params: dict[str, Any]
    ) -> None:
        thread_id = params.get("threadId") if isinstance(params.get("threadId"), str) else None
        handlers = self._thread_handlers.get(thread_id) if thread_id else None

        if handlers is not None and handlers.on_request is not None:
            try:
                result = handlers.on_request(method, params)
                if asyncio.iscoroutine(result):
                    result = await result
                self._send({"jsonrpc": "2.0", "id": msg_id, "result": result or {}})
            except Exception as err:
                self._send(
                    {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32000, "message": str(err)}}
                )
            return

        # No handler for this thread: answer with the safest possible default.
        self._send(
            {"jsonrpc": "2.0", "id": msg_id, "result": default_server_request_result(method)}
        )


# ===========================================================================
# Subprocess transport + isolated CODEX_HOME (codex-app-server.ts)
# ===========================================================================


def ensure_isolated_codex_home(base_dir: str) -> str:
    """Prepare an isolated CODEX_HOME so agent threads don't inherit the user's
    personal MCP servers/plugins/skills/hooks from ``~/.codex``.

    Auth is copied in (refreshed copies stay local, so agent token refreshes
    can't rotate the user's interactive CLI session). Verbatim port of TS
    ``ensureIsolatedCodexHome``."""
    import shutil
    from pathlib import Path

    home = Path(base_dir) / "codex-home"
    home.mkdir(parents=True, exist_ok=True)
    auth_target = home / "auth.json"
    if not auth_target.exists():
        user_home = os.environ.get("CODEX_HOME") or str(Path.home() / ".codex")
        user_auth = Path(user_home) / "auth.json"
        if user_auth.exists():
            shutil.copyfile(user_auth, auth_target)
    config_path = home / "config.toml"
    if not config_path.exists():
        config_path.write_text(
            "# Simple Harmonic isolated codex home (no user MCP servers/plugins)\n"
        )
    return str(home)


async def spawn_codex_app_server(
    *, codex_home: str | None = None, command: str = "codex"
) -> CodexAppServerClient:
    """Spawn ``codex app-server`` and wrap its stdio as a :class:`CodexAppServerClient`.

    Reads stdout line-by-line via an asyncio reader task (the Python mapping of
    node's ``readline`` interface) and forwards each line to the client. SIGTERMs
    the child on close. Faithful port of TS ``spawnCodexAppServer``."""
    env = {**os.environ, "RUST_LOG": os.environ.get("RUST_LOG", "error")}
    if codex_home:
        env["CODEX_HOME"] = codex_home

    proc = await asyncio.create_subprocess_exec(
        command,
        "app-server",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )

    line_cbs: list[Callable[[str], None]] = []
    close_cbs: list[Callable[[str], None]] = []
    stderr_tail = {"text": ""}

    async def pump_stdout() -> None:
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode(errors="replace").rstrip("\n")
            for cb in line_cbs:
                cb(line)
        code = await proc.wait()
        why = f"exited (code={code}) {stderr_tail['text'][-300:]}".strip()
        for cb in close_cbs:
            cb(why)

    async def pump_stderr() -> None:
        assert proc.stderr is not None
        async for raw in proc.stderr:
            stderr_tail["text"] = (stderr_tail["text"] + raw.decode(errors="replace"))[-2000:]

    def send(line: str) -> None:
        if proc.stdin is None or proc.stdin.is_closing():
            raise RuntimeError("codex app-server stdin not writable")
        proc.stdin.write(line.encode())

    def close() -> None:
        _terminate(proc)

    transport = JsonRpcTransport(
        send=send,
        on_line=line_cbs.append,
        on_close=close_cbs.append,
        close=close,
    )
    client = CodexAppServerClient(transport)
    # Keep strong refs to the stdio pump tasks on the client so they live as long
    # as the client does (asyncio holds only weak refs to bare tasks).
    client._pumps = [  # type: ignore[attr-defined]
        asyncio.ensure_future(pump_stdout()),
        asyncio.ensure_future(pump_stderr()),
    ]
    return client


# ===========================================================================
# Engine-mode harness (codex-harness.ts)
# ===========================================================================

# Imported lazily inside the harness to avoid a slice-7 import cycle
# (runner imports types; harness reuses runner's prompt builders + summarize).


# Hard backstop so a wedged turn can't outlive a forgotten abort signal.
TURN_HARD_CAP_S = 600.0


@dataclass
class CodexHarnessResult:
    """Result of one engine-mode tick.

    ``suspension`` is present iff the tick parked for human approval. ``usage`` is
    the real token usage summed from ``thread/tokenUsage/updated`` notifications.
    """

    actionType: str
    payload: dict[str, Any]
    usage: dict[str, int]
    suspension: Any | None = None  # CodexThreadSuspension
    validation: Any | None = None  # ValidationResult


@dataclass
class _IncomingToolCall:
    callId: str
    tool: str
    arguments: Any


@dataclass
class _TurnOutcome:
    status: str
    finalText: str
    parked: Any | None = None  # PendingToolCall
    error: str | None = None


def _parse_args(raw: str) -> Any:
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return raw


async def run_codex_agent_tick(config: Any) -> CodexHarnessResult:
    """Run one tick in engine mode: codex owns the loop, SH owns the tools.

    ``config`` is a :class:`~simple_harmonic.meta_agent.types.AgentConfig` (the
    harness reuses the same prompt-config surface) extended with ``cwd`` /
    ``client`` (the injected :class:`CodexAppServerClient`, supplied by tests).

    Faithful port of TS ``runCodexAgentTick``: registers SH tools as dynamic
    tools on the thread, executes safe calls inline via the slice-6 registry,
    parks the turn on the first destructive call (returning a
    :class:`~simple_harmonic.meta_agent.types.CodexThreadSuspension`), and on
    resume applies human decisions with our own hands before reporting outcomes
    in the resumed turn's input.
    """
    from simple_harmonic.meta_agent.contract import validate_contract
    from simple_harmonic.meta_agent.runner import (
        _default_registry,
        build_system_prompt,
        build_tick_prompt,
        summarize,
        tool_allowlist,
    )
    from simple_harmonic.meta_agent.types import CodexThreadSuspension, PendingToolCall
    from simple_harmonic.tools.types import ToolRunContext

    registry = getattr(config, "toolRegistry", None) or _default_registry
    allowed_tools = tool_allowlist(config.tools)
    tool_defs = registry.get_openai_defs(allowed_tools)
    tool_descriptions = registry.list_for_agent(allowed_tools)
    is_destructive = config.isDestructive or registry.is_destructive
    client: CodexAppServerClient = getattr(config, "client", None) or await _get_shared_codex_client()
    model = config.model or DEFAULT_CODEX_MODEL
    cwd = getattr(config, "cwd", None) or os.getcwd()

    tool_ctx = ToolRunContext(
        teamId=config.teamId,
        agentId=config.agentId,
        agentName=config.name,
        peers=config.peers,
        a2ax=config.a2ax,
    )

    import time

    tick_started_at = time.monotonic()
    actions: list[Any] = []
    usage = {"inputTokens": 0, "outputTokens": 0}

    def emit(type_: str, data: dict[str, Any]) -> None:
        sink = config.trace
        if sink is None:
            return
        try:
            from simple_harmonic.meta_agent.types import TraceStep

            sink(TraceStep(type=type_, data=data))  # type: ignore[arg-type]
        except Exception:
            pass

    emit(
        "tick_started",
        {
            "mode": "resume" if config.resume else "fresh",
            "round": 0,
            "runtime": "codex-app-server",
        },
    )

    # --- Establish the thread -------------------------------------------------
    if config.resume is not None:
        suspension = config.resume.suspension
        decisions = config.resume.decisions
        thread_id = suspension.threadId
        actions.extend(suspension.actions)

        await client.request(
            "thread/resume",
            {
                "threadId": thread_id,
                "model": model,
                "cwd": cwd,
                "sandbox": "read-only",
                "approvalPolicy": "never",
            },
        )

        decision_by_id = {d.id: d for d in decisions}
        outcomes: list[str] = []
        for call in suspension.pending:
            decision = decision_by_id.get(call.id)
            approved = bool(decision.approved) if decision is not None else False
            applied: dict[str, Any] = {
                "toolCallId": call.id,
                "tool": call.name,
                "approved": approved,
            }
            if decision is not None and decision.note:
                applied["note"] = decision.note
            emit("decision_applied", applied)
            if approved:
                outcome = await _execute_tool_traced(
                    call.name, _parse_args(call.arguments), call.id, registry, tool_ctx, actions, emit
                )
                outcomes.append(f"- {call.name}: APPROVED. Tool result: {outcome}")
            else:
                note = decision.note if decision is not None and decision.note else "The user rejected this action."
                outcomes.append(f"- {call.name}: REJECTED — {note} Do not retry it.")
        turn_input = (
            f"[Approval outcomes]\n{chr(10).join(outcomes)}\n\n"
            "Continue your work based on these outcomes. If any of your tools are "
            "unavailable after this resume, summarize what happened and finish."
        )
    else:
        started = await client.request(
            "thread/start",
            {
                "model": model,
                "cwd": cwd,
                "ephemeral": False,
                "sandbox": "read-only",
                "approvalPolicy": "never",
                "developerInstructions": build_system_prompt(config, tool_descriptions),
                "dynamicTools": [
                    {
                        "name": d["function"]["name"],
                        "description": d["function"].get("description") or "",
                        "inputSchema": d["function"].get("parameters")
                        or {"type": "object", "properties": {}},
                    }
                    for d in tool_defs
                ],
            },
        )
        thread = started.get("thread") if isinstance(started, dict) else None
        thread_id = (thread or {}).get("id") or (
            started.get("threadId") if isinstance(started, dict) else None
        )
        if not thread_id:
            raise RuntimeError("codex app-server thread/start returned no thread id")
        turn_input = build_tick_prompt(config)

    # --- Run one turn ---------------------------------------------------------
    async def handle_tool_call(call: _IncomingToolCall) -> dict[str, Any]:
        args = call.arguments
        if is_destructive(call.tool, args):
            return {
                "park": PendingToolCall(
                    id=call.callId, name=call.tool, arguments=json.dumps(args or {})
                )
            }
        result_text = await _execute_tool_traced(
            call.tool, args, call.callId, registry, tool_ctx, actions, emit
        )
        return {"resultText": result_text}

    outcome = await _run_turn(
        client=client,
        thread_id=thread_id,
        input_text=turn_input,
        model=model,
        signal=config.signal,
        emit=emit,
        usage=usage,
        handle_tool_call=handle_tool_call,
    )

    if outcome.parked is not None:
        emit(
            "approval_requested",
            {
                "round": 0,
                "pending": [
                    {
                        "toolCallId": outcome.parked.id,
                        "tool": outcome.parked.name,
                        "args": _parse_args(outcome.parked.arguments),
                    }
                ],
                "deferredSafeCount": 0,
            },
        )
        return CodexHarnessResult(
            actionType="suspended",
            payload={
                "agent": config.name,
                "pending": [{"id": outcome.parked.id, "name": outcome.parked.name}],
            },
            suspension=CodexThreadSuspension(
                threadId=thread_id,
                pending=[outcome.parked],
                actions=actions,
            ),
            usage=usage,
        )

    if outcome.error:
        raise RuntimeError(f"codex turn failed: {outcome.error}")

    # Text-only turn with no actions mirrors the runner's agent_thought shape.
    if not actions:
        result = CodexHarnessResult(
            actionType="agent_thought",
            payload={"agent": config.name, "thought": outcome.finalText or "no output"},
            usage=usage,
        )
    else:
        summary = summarize(config.name, actions)
        result = CodexHarnessResult(
            actionType=summary.actionType, payload=summary.payload, usage=usage
        )

    if config.outputContract:
        result.validation = validate_contract(result.payload, config.outputContract)

    finish_data: dict[str, Any] = {
        "actionType": result.actionType,
        "actionCount": len(actions),
        "durationMs": int((time.monotonic() - tick_started_at) * 1000),
    }
    if result.validation is not None:
        finish_data["validation"] = {
            "valid": result.validation.valid,
            "issues": [i.model_dump() for i in result.validation.issues],
        }
    emit("tick_finished", finish_data)
    return result


async def _run_turn(
    *,
    client: CodexAppServerClient,
    thread_id: str,
    input_text: str,
    model: str,
    signal: asyncio.Event | None,
    emit: Callable[[str, dict[str, Any]], None],
    usage: dict[str, int],
    handle_tool_call: Callable[[_IncomingToolCall], Awaitable[dict[str, Any]]],
) -> _TurnOutcome:
    """Pump turn events until completion, park, abort, or hard cap.

    Faithful port of TS ``runTurn``: registers the thread handler, starts the
    turn, and resolves on ``turn/completed`` (or park/error). On abort or hard
    cap, interrupts the turn and raises. Always unregisters the thread on exit.
    """
    loop = asyncio.get_event_loop()
    done: asyncio.Future[_TurnOutcome] = loop.create_future()
    state: dict[str, Any] = {"turnId": None, "parked": None, "finalText": "", "turnError": None}

    def interrupt() -> None:
        if state["turnId"] is None:
            return
        fut = client.request(
            "turn/interrupt", {"threadId": thread_id, "turnId": state["turnId"]}, timeout_s=10.0
        )
        fut.add_done_callback(lambda f: f.exception())  # swallow

    def finish(outcome: _TurnOutcome) -> None:
        if done.done():
            return
        cleanup()
        done.set_result(outcome)

    def fail(err: Exception) -> None:
        if done.done():
            return
        cleanup()
        done.set_exception(err)

    def cleanup() -> None:
        hard_cap.cancel()
        if signal_task is not None:
            signal_task.cancel()
        client.unregister_thread(thread_id)

    def on_hard_cap() -> None:
        interrupt()
        fail(RuntimeError(f"codex turn exceeded the {TURN_HARD_CAP_S}s hard cap"))

    hard_cap = loop.call_later(TURN_HARD_CAP_S, on_hard_cap)

    def on_abort_fired() -> None:
        interrupt()
        fail(asyncio.CancelledError("codex turn aborted"))

    signal_task: asyncio.Future[Any] | None = None
    if signal is not None:
        if signal.is_set():
            on_abort_fired()
            return await done
        signal_task = asyncio.ensure_future(signal.wait())
        signal_task.add_done_callback(
            lambda f: None if f.cancelled() else on_abort_fired()
        )

    async def on_request(method: str, params: dict[str, Any]) -> Any:
        if method != "item/tool/call":
            return default_server_request_result(method)
        call = _IncomingToolCall(
            callId=str(params.get("callId") or ""),
            tool=str(params.get("tool") or ""),
            arguments=params.get("arguments"),
        )
        handled = await handle_tool_call(call)
        if "park" in handled:
            state["parked"] = handled["park"]
            # Reply first so codex never hangs, then interrupt on a later tick so
            # the response hits the wire before the interrupt request.
            loop.call_soon(interrupt)
            return {
                "success": False,
                "contentItems": [
                    {
                        "type": "inputText",
                        "text": (
                            "This action requires human approval. The turn is pausing now; "
                            "you will receive the decision when the conversation resumes. "
                            "Do not retry the action."
                        ),
                    }
                ],
            }
        return {
            "success": True,
            "contentItems": [{"type": "inputText", "text": handled["resultText"]}],
        }

    def on_notification(method: str, params: dict[str, Any]) -> None:
        if method == "thread/tokenUsage/updated":
            token_usage = params.get("tokenUsage")
            last = token_usage.get("last") if isinstance(token_usage, dict) else None
            if isinstance(last, dict):
                usage["inputTokens"] += last.get("inputTokens") or 0
                usage["outputTokens"] += last.get("outputTokens") or 0
            return
        if method == "item/completed":
            item = params.get("item")
            if not isinstance(item, dict):
                return
            if item.get("type") == "agentMessage" and isinstance(item.get("text"), str) and item["text"]:
                state["finalText"] = item["text"]
                emit("llm_response", {"round": 0, "thought": item["text"], "toolCalls": [], "finishReason": "stop"})
            if item.get("type") == "reasoning":
                summary_blocks = item.get("summary") or []
                text = "\n".join(
                    b.get("text") or "" for b in summary_blocks if isinstance(b, dict)
                ).strip()
                if text:
                    emit("llm_response", {"round": 0, "thought": text, "toolCalls": [], "finishReason": "reasoning"})
            return
        if method == "error":
            state["turnError"] = str(params.get("message") or "unknown codex error")
            return
        if method == "turn/completed":
            turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
            status = turn.get("status") or "unknown"
            err = turn.get("error")
            if isinstance(err, dict) and err.get("message"):
                state["turnError"] = err["message"]
            if state["parked"] is not None:
                finish(_TurnOutcome(status=status, finalText=state["finalText"], parked=state["parked"]))
            elif status == "completed":
                finish(_TurnOutcome(status=status, finalText=state["finalText"], error=state["turnError"]))
            else:
                finish(
                    _TurnOutcome(
                        status=status,
                        finalText=state["finalText"],
                        error=state["turnError"]
                        or ("turn interrupted" if status == "interrupted" else f"turn {status}"),
                    )
                )

    client.register_thread(thread_id, ThreadHandlers(on_request=on_request, on_notification=on_notification))

    emit("llm_request", {"round": 0, "model": model, "runtime": "codex-app-server"})
    start_fut = client.request(
        "turn/start",
        {"threadId": thread_id, "input": [{"type": "text", "text": input_text, "text_elements": []}]},
    )

    def on_start(f: asyncio.Future[Any]) -> None:
        exc = f.exception() if not f.cancelled() else None
        if exc is not None:
            fail(exc if isinstance(exc, Exception) else RuntimeError(str(exc)))
            return
        res = f.result()
        turn = res.get("turn") if isinstance(res, dict) else None
        if isinstance(turn, dict):
            state["turnId"] = turn.get("id")

    start_fut.add_done_callback(on_start)

    return await done


async def _execute_tool_traced(
    tool: str,
    tool_args: Any,
    call_id: str,
    registry: Any,
    tool_ctx: Any,
    actions: list[Any],
    emit: Callable[[str, dict[str, Any]], None],
) -> str:
    """Execute one tool via the registry, emitting tool_started/tool_finished and
    pushing any logged action. Never raises: a failure comes back as an
    ``Error: ...`` string (matching the TS harness)."""
    import time

    emit("tool_started", {"round": 0, "toolCallId": call_id, "tool": tool, "args": tool_args or {}})
    started_at = time.monotonic()
    try:
        result = await registry.execute(tool, tool_args or {}, tool_ctx)
        if result.action:
            actions.append(result.action)
        emit(
            "tool_finished",
            {
                "round": 0,
                "toolCallId": call_id,
                "tool": tool,
                "result": result.result,
                "durationMs": int((time.monotonic() - started_at) * 1000),
            },
        )
        return result.result
    except Exception as err:
        message = str(err)
        emit(
            "tool_finished",
            {
                "round": 0,
                "toolCallId": call_id,
                "tool": tool,
                "error": message,
                "durationMs": int((time.monotonic() - started_at) * 1000),
            },
        )
        return f'Error: tool "{tool}" failed: {message}'


# ---------------------------------------------------------------------------
# Shared app-server client (one subprocess per Python process)
# ---------------------------------------------------------------------------

_shared_client_holder: dict[str, Any] = {"client": None, "starting": None}


async def _get_shared_codex_client() -> CodexAppServerClient:
    existing = _shared_client_holder["client"]
    if existing is not None and not existing.is_closed:
        return existing
    starting = _shared_client_holder["starting"]
    if starting is not None:
        return await starting

    async def start() -> CodexAppServerClient:
        home = ensure_isolated_codex_home(os.path.join(os.getcwd(), ".simple-harmonic"))
        client = await spawn_codex_app_server(codex_home=home)
        await client.initialize(
            {"name": "simple-harmonic", "title": "Simple Harmonic", "version": "0.1.0"}
        )
        _shared_client_holder["client"] = client
        return client

    fut = asyncio.ensure_future(start())
    _shared_client_holder["starting"] = fut
    try:
        return await fut
    finally:
        _shared_client_holder["starting"] = None


def reset_shared_codex_client_for_tests() -> None:
    """Test hook: close and forget the shared app-server client."""
    client = _shared_client_holder["client"]
    if client is not None:
        client.close()
    _shared_client_holder["client"] = None
    _shared_client_holder["starting"] = None


# ===========================================================================
# App-server as a cascade LLMClient (one turn per `create` call)
# ===========================================================================


def _format_codex_messages(messages: list[dict[str, Any]]) -> tuple[str, str]:
    """Split OpenAI-style messages into (developer_instructions, turn_input).

    System messages become the thread's developerInstructions; user/assistant/tool
    messages become the turn input (the conversation, replayed as text). Tools
    travel structurally in dynamicTools — never in this text.
    """
    system_parts: list[str] = []
    convo_parts: list[str] = []
    for m in messages:
        role = m.get("role")
        content = str(m.get("content") or "")
        if role == "system":
            system_parts.append(content)
        elif role == "user":
            convo_parts.append(f"[User]\n{content}")
        elif role == "assistant":
            convo_parts.append(f"[Assistant]\n{content}")
        elif role == "tool":
            convo_parts.append(f"[Tool Result]\n{content}")
    return "\n\n".join(system_parts), "\n\n".join(convo_parts)


def _tools_to_dynamic_specs(tools: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """OpenAI function-tool defs -> codex DynamicToolSpec (name/description/inputSchema)."""
    specs: list[dict[str, Any]] = []
    for t in tools or []:
        fn = t.get("function") or {}
        specs.append(
            {
                "name": fn.get("name"),
                "description": fn.get("description") or "",
                "inputSchema": fn.get("parameters") or {"type": "object", "properties": {}},
            }
        )
    return specs


def create_codex_app_server_client(model: str = DEFAULT_CODEX_MODEL) -> LLMClient:
    """Adapt the codex app-server engine to the cascade :class:`LLMClient` contract.

    Each ``create(params, options)`` call runs ONE app-server turn: system messages
    become developerInstructions, the rest become the turn input, and ``tools``
    become structured ``dynamicTools``. The turn returns either the model's text or
    the FIRST tool call it makes — which is parked (replied to + the turn
    interrupted) and surfaced as ``tool_calls`` so the SH runner/cascade drives the
    loop, exactly like a normal function-calling model. Stateless per call: the
    conversation lives in ``params.messages`` and is replayed each turn (the codex
    thread is not carried across calls — the LLMClient contract has no session id).
    """

    async def create(
        params: dict[str, Any], options: CompletionOptions | None = None
    ) -> LLMResponse:
        from simple_harmonic.meta_agent.types import PendingToolCall  # lazy: import cycle

        messages = params.get("messages") or []
        tools = params.get("tools")
        request_model = str(params.get("model") or model)
        signal = options.signal if options is not None else None

        developer_instructions, turn_input = _format_codex_messages(messages)
        dynamic_tools = _tools_to_dynamic_specs(tools)

        client = await _get_shared_codex_client()
        started = await client.request(
            "thread/start",
            {
                "model": request_model,
                "cwd": os.getcwd(),
                "ephemeral": True,
                "sandbox": "read-only",
                "approvalPolicy": "never",
                "developerInstructions": developer_instructions,
                "dynamicTools": dynamic_tools,
            },
        )
        thread = started.get("thread") if isinstance(started, dict) else None
        thread_id = (thread or {}).get("id") or (
            started.get("threadId") if isinstance(started, dict) else None
        )
        if not thread_id:
            raise RuntimeError("codex app-server thread/start returned no thread id")

        captured: dict[str, _IncomingToolCall | None] = {"call": None}

        async def handle_tool_call(call: _IncomingToolCall) -> dict[str, Any]:
            # Surface the first tool call to the caller instead of executing it:
            # park (so _run_turn replies + interrupts the turn).
            captured["call"] = call
            return {
                "park": PendingToolCall(
                    id=call.callId, name=call.tool, arguments=json.dumps(call.arguments or {})
                )
            }

        usage = {"inputTokens": 0, "outputTokens": 0}
        outcome = await _run_turn(
            client=client,
            thread_id=str(thread_id),
            input_text=turn_input,
            model=request_model,
            signal=signal,
            emit=lambda _event, _payload: None,
            usage=usage,
            handle_tool_call=handle_tool_call,
        )

        usage_block = Usage(input_tokens=usage["inputTokens"], output_tokens=usage["outputTokens"])
        call = captured["call"]
        if call is not None:
            return LLMResponse(
                choices=[
                    Choice(
                        message=ChoiceMessage(
                            content=None,
                            tool_calls=[
                                ToolCall(
                                    id=call.callId,
                                    function=ToolCallFunction(
                                        name=call.tool, arguments=json.dumps(call.arguments or {})
                                    ),
                                )
                            ],
                        ),
                        finish_reason="tool_calls",
                    )
                ],
                model=request_model,
                usage=usage_block,
            )
        return LLMResponse(
            choices=[
                Choice(
                    message=ChoiceMessage(content=outcome.finalText or "", tool_calls=None),
                    finish_reason="stop",
                )
            ],
            model=request_model,
            usage=usage_block,
        )

    return make_client(create)



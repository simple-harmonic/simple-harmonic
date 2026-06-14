"""Codex adapter — two ways to drive the Codex CLI as a model backend.

TS source:
  - packages/backend/src/lib/meta-agent/codex-adapter.ts     (exec one-shot path)
  - packages/backend/src/lib/meta-agent/codex-app-server.ts   (JSON-RPC transport)
  - packages/backend/src/lib/meta-agent/codex-harness.ts      (engine-mode harness)

Two runtimes, picked by the ``SH_CODEX_RUNTIME`` env var (mirroring the TS tick
route's ``apiKeySource === "codex" && process.env.SH_CODEX_RUNTIME !== "exec"``):

* ``exec`` — the simple one-shot path. ``codex exec --json`` is invoked once per
  round; the agent loop lives in SH's runner. Tools are encoded in the prompt and
  the model is asked to emit a JSON object. This path produces an
  :class:`~simple_harmonic.llm.client.LLMClient`, so it plugs into
  :data:`simple_harmonic.llm.candidates.codex_client_factory` as a cascade
  candidate. **This is the default the cascade uses; it is the priority path.**

* app-server (engine mode) — ``codex app-server`` owns the agent loop; every SH
  tool is a *dynamic tool* on the codex thread. When the model picks one, codex
  blocks on an ``item/tool/call`` request that we answer via the slice-6 tool
  registry. The approval gate moves into the hands: a destructive call parks the
  turn and returns a :class:`CodexThreadSuspension`. This is a separate tick
  entry point (:func:`run_codex_agent_tick`), NOT a cascade ``LLMClient`` — the
  tick route selects it directly when the codex runtime is engine mode.

Cancellation model
-------------------
``AgentConfig.signal`` / ``CompletionOptions.signal`` is an ``asyncio.Event``
(set == aborted), the Python mapping of the TS ``AbortSignal``:
  * exec path: the abort kills the ``codex exec`` subprocess (SIGTERM) and raises;
  * app-server path: the abort interrupts the turn (``turn/interrupt``) and raises.

OFFLINE: no network, and no real ``codex`` process in tests — the exec path mocks
``asyncio.create_subprocess_exec`` and the app-server path is driven by a fake
in-memory transport (scripted JSON-RPC lines).
"""
# ruff: noqa: E501 - the agent-facing codex prompt scaffold below is a verbatim
# port of the TS prompt text and must match it closely; do not rewrap those lines.

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
    make_client,
)
from simple_harmonic.tools.sandbox import coding_env

DEFAULT_CODEX_MODEL = "gpt-5.5"
# The TS exec adapter caps the run at 120s and the buffer at 1 MiB.
EXEC_TIMEOUT_S = 120.0


# ===========================================================================
# Exec one-shot path (codex-adapter.ts)
# ===========================================================================


def _build_codex_prompt(
    messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None
) -> str:
    """Format OpenAI-style messages + tools into a single prompt for ``codex exec``.

    ``codex exec`` has no custom-tool support, so tool definitions are encoded in
    the prompt and the model is instructed to emit a structured JSON object.
    Verbatim port of TS ``buildCodexPrompt``.
    """
    parts: list[str] = []

    # System messages
    for m in messages:
        if m.get("role") == "system":
            parts.append(str(m.get("content") or ""))

    # Tool definitions
    if tools:
        parts.append("\n## Available Tools\n")
        parts.append(
            'You MUST respond with a JSON object. If you want to use a tool, set '
            '"tool_calls" to an array of calls. If you just want to respond with text, '
            'set "content" to your message.\n'
        )
        parts.append("Response format:")
        parts.append("```json")
        parts.append(
            json.dumps(
                {
                    "content": "your text response (or null if using tools)",
                    "tool_calls": [
                        {
                            "name": "tool_name",
                            "arguments": {"key": "value"},
                        }
                    ],
                },
                indent=2,
            )
        )
        parts.append("```\n")
        parts.append("Available tools:")
        for t in tools:
            fn = t.get("function", {})
            parts.append(f"- **{fn.get('name')}**: {fn.get('description') or ''}")
            if fn.get("parameters"):
                parts.append(f"  Parameters: {json.dumps(fn.get('parameters'))}")
        parts.append("")

    # User/assistant/tool messages
    for m in messages:
        role = m.get("role")
        if role == "system":
            continue
        if role == "user":
            parts.append(f"\n[User]\n{m.get('content') or ''}")
        elif role == "assistant":
            parts.append(f"\n[Assistant]\n{m.get('content') or ''}")
        elif role == "tool":
            parts.append(f"\n[Tool Result]\n{m.get('content') or ''}")

    parts.append(
        "\n\nRespond with ONLY a valid JSON object. No markdown fences, no extra text."
    )

    return "\n".join(parts)


def _parse_codex_output(jsonl_output: str) -> str:
    """Parse the JSONL output from ``codex exec`` and return the last agent message.

    Verbatim port of TS ``parseCodexOutput``: scans each line, keeps the text of
    the last ``item.completed`` / ``agent_message`` event, ignores non-JSON lines,
    and tolerates ``error`` events.
    """
    last_text = ""
    for line in jsonl_output.strip().split("\n"):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            continue  # skip non-JSON lines
        if (
            event.get("type") == "item.completed"
            and isinstance(event.get("item"), dict)
            and event["item"].get("type") == "agent_message"
            and event["item"].get("text")
        ):
            last_text = event["item"]["text"]
        # error events are logged-but-tolerated in TS; we just keep scanning.
    return last_text


def extract_json_object(text: str) -> str | None:
    """Extract the most likely JSON object from free-text model output.

    Verbatim port of TS ``extractJsonObject``:
      1. a ```json fenced block (or any ``` fence) whose inner content starts ``{``;
      2. otherwise the first BALANCED top-level ``{...}`` found by brace scanning,
         skipping braces inside strings (tolerates leading/trailing prose).
    Returns the candidate JSON string, or ``None`` if nothing object-like exists.
    """
    import re

    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        inner = fence.group(1).strip()
        if inner.startswith("{"):
            return inner

    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


@dataclass
class _StructuredResponse:
    content: str | None
    tool_calls: list[dict[str, Any]] | None = None


def _parse_structured_response(text: str, allowed_tools: set[str]) -> _StructuredResponse:
    """Try to parse the agent text as structured JSON with tool calls.

    Verbatim port of TS ``parseStructuredResponse``: ``allowed_tools`` gates the
    calls (a hallucinated/unoffered tool name is dropped). When ``tool_calls`` is
    present but all are filtered out, falls through to content so the turn isn't
    silently empty. Tool call ids are index-based (``call_0``, ...) for
    determinism, matching the runner's per-round id matching.
    """
    json_str = extract_json_object(text)
    if json_str is None:
        return _StructuredResponse(content=text)

    try:
        parsed = json.loads(json_str)
    except (ValueError, TypeError):
        return _StructuredResponse(content=text)
    if not isinstance(parsed, dict):
        return _StructuredResponse(content=text)

    raw_calls = parsed.get("tool_calls")
    parsed_content = parsed.get("content")
    if isinstance(raw_calls, list):
        calls: list[dict[str, Any]] = []
        for i, tc in enumerate(raw_calls):
            if not isinstance(tc, dict):
                continue
            name = tc.get("name")
            if not isinstance(name, str) or name not in allowed_tools:
                continue
            calls.append(
                {
                    "id": f"call_{i}",
                    "function": {
                        "name": name,
                        "arguments": json.dumps(tc.get("arguments") or {}),
                    },
                }
            )
        if calls:
            return _StructuredResponse(
                content=parsed_content if parsed_content is not None else None,
                tool_calls=calls,
            )
        # tool_calls present but all filtered out: fall through to content.
        return _StructuredResponse(
            content=parsed_content if parsed_content is not None else text
        )
    return _StructuredResponse(content=parsed_content if parsed_content is not None else text)


def _codex_exec_args(model: str) -> list[str]:
    """The ``codex exec`` argv. Verbatim port of TS ``runCodexExec``'s ``args``.

    The prompt is piped via stdin (the trailing ``"-"``), so no temp file or shell
    escaping is needed — Python feeds it through the subprocess stdin pipe."""
    return [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-rules",
        "-c",
        f'model="{model}"',
        "-c",
        'model_reasoning_effort="low"',
        "-c",
        'sandbox="read-only"',
        "-",
    ]


async def _run_codex_exec(prompt: str, model: str, signal: asyncio.Event | None) -> str:
    """Run ``codex exec`` once, feeding ``prompt`` on stdin, return stdout (JSONL).

    Faithful port of TS ``runCodexExec``: aborts (SIGTERM) when the signal fires
    or is already set; surfaces a ``RuntimeError('codex exec failed: ...')`` when
    the process errors AND produced no stdout. Uses ``coding_env`` so no secrets
    leak into the codex subprocess (codex auth is file-based under HOME)."""
    if signal is not None and signal.is_set():
        raise asyncio.CancelledError("codex exec aborted before start")

    proc = await asyncio.create_subprocess_exec(
        "codex",
        *_codex_exec_args(model),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=coding_env(["CODEX_HOME", "OPENAI_API_KEY"]),
    )

    comm = asyncio.ensure_future(proc.communicate(prompt.encode()))
    waiters: set[asyncio.Future[Any]] = {comm}
    signal_task: asyncio.Future[Any] | None = None
    if signal is not None:
        signal_task = asyncio.ensure_future(signal.wait())
        waiters.add(signal_task)

    try:
        done, _ = await asyncio.wait(
            waiters, timeout=EXEC_TIMEOUT_S, return_when=asyncio.FIRST_COMPLETED
        )
        if signal_task is not None and signal_task in done:
            _terminate(proc)
            comm.cancel()
            raise asyncio.CancelledError("codex exec aborted")
        if comm not in done:
            # Timeout: kill and fail like the TS adapter's exec timeout.
            _terminate(proc)
            comm.cancel()
            raise RuntimeError(f"codex exec failed: timed out after {EXEC_TIMEOUT_S}s")

        stdout_b, stderr_b = comm.result()
        stdout = stdout_b.decode() if stdout_b else ""
        if proc.returncode not in (0, None) and not stdout:
            stderr = stderr_b.decode() if stderr_b else f"exit code {proc.returncode}"
            raise RuntimeError(f"codex exec failed: {stderr}")
        return stdout
    finally:
        if signal_task is not None:
            signal_task.cancel()


def _terminate(proc: Any) -> None:
    with contextlib.suppress(ProcessLookupError):  # process already gone
        proc.terminate()


def create_codex_exec_client(*, model: str = DEFAULT_CODEX_MODEL) -> LLMClient:
    """Create an :class:`LLMClient` backed by ``codex exec`` (the one-shot path).

    Verbatim port of TS ``createCodexClient``. Plugs into
    :data:`simple_harmonic.llm.candidates.codex_client_factory`."""

    async def create(
        params: dict[str, Any], options: CompletionOptions | None = None
    ) -> LLMResponse:
        messages = params.get("messages") or []
        tools = params.get("tools")
        request_model = str(params.get("model") or model)
        signal = options.signal if options is not None else None

        prompt = _build_codex_prompt(messages, tools)
        output = await _run_codex_exec(prompt, request_model, signal)
        text = _parse_codex_output(output)

        if not text:
            return LLMResponse(
                choices=[
                    Choice(
                        message=ChoiceMessage(content="No response from agent.", tool_calls=None),
                        finish_reason="stop",
                    )
                ]
            )

        if tools:
            allowed = {t.get("function", {}).get("name") for t in tools}
            allowed.discard(None)
            parsed = _parse_structured_response(text, allowed)
            tool_calls = (
                [
                    ToolCall(
                        id=c["id"],
                        function=ToolCallFunction(
                            name=c["function"]["name"],
                            arguments=c["function"]["arguments"],
                        ),
                    )
                    for c in parsed.tool_calls
                ]
                if parsed.tool_calls
                else None
            )
            return LLMResponse(
                choices=[
                    Choice(
                        message=ChoiceMessage(content=parsed.content, tool_calls=tool_calls),
                        finish_reason="tool_calls" if parsed.tool_calls else "stop",
                    )
                ]
            )

        return LLMResponse(
            choices=[
                Choice(
                    message=ChoiceMessage(content=text, tool_calls=None),
                    finish_reason="stop",
                )
            ]
        )

    return make_client(create)


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
# Runtime selector + cascade factory (wired into candidates.codex_client_factory)
# ===========================================================================


def codex_runtime() -> str:
    """The active codex runtime: ``"exec"`` if ``SH_CODEX_RUNTIME=exec``, else
    ``"app-server"`` (engine mode). Mirrors the TS tick-route gate."""
    return "exec" if os.environ.get("SH_CODEX_RUNTIME") == "exec" else "app-server"


def create_codex_client(model: str = DEFAULT_CODEX_MODEL) -> LLMClient:
    """The codex cascade candidate's :class:`LLMClient`.

    This is what :data:`simple_harmonic.llm.candidates.codex_client_factory` is
    pointed at: the exec one-shot adapter (text-in/text-out per round, with the SH
    runner owning the loop). Engine mode does NOT flow through the cascade — the
    tick route calls :func:`run_codex_agent_tick` directly when the runtime is
    app-server — so the cascade candidate is always the exec client regardless of
    ``SH_CODEX_RUNTIME``.
    """
    return create_codex_exec_client(model=model)

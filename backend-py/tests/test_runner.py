"""Agent runner tests — the orchestration engine core.

Ports:
  packages/backend/tests/unit/runner.test.ts        (multi-round tool-use loop)
  packages/backend/tests/unit/runner-resume.test.ts (round-atomic suspend + resume guard)
  packages/backend/tests/unit/runner-trace.test.ts  (play-by-play trace)

Everything is OFFLINE: a FAKE LLMClient returns scripted tool_calls / content; no
network, no real codex/anthropic calls.
"""

from __future__ import annotations

from dataclasses import dataclass, field
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
from simple_harmonic.meta_agent.runner import run_agent, tool_allowlist
from simple_harmonic.meta_agent.types import (
    AgentConfig,
    AgentSuspension,
    PendingToolCall,
    ResumeState,
    ToolDecision,
    TraceStep,
)
from simple_harmonic.tools.types import PeerAgent, ToolExecResult, ToolResult

# asyncio_mode = "auto" (pyproject) runs ``async def`` tests without a marker.


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


@dataclass
class _ScriptedResponse:
    content: str | None = None
    tool_calls: list[tuple[str, str, str]] | None = None  # (id, name, arguments)
    finish_reason: str | None = None


@dataclass
class _RecordingLLM:
    """A fake LLMClient that replays scripted responses and records every call's
    params. Mirrors the vitest ``makeLLM`` helper."""

    responses: list[_ScriptedResponse]
    calls: list[dict[str, Any]] = field(default_factory=list)
    index: int = 0

    def client(self) -> LLMClient:
        async def create(
            params: dict[str, Any], options: CompletionOptions | None = None
        ) -> LLMResponse:
            self.calls.append(params)
            res = (
                self.responses[self.index]
                if self.index < len(self.responses)
                else self.responses[-1]
            )
            self.index += 1
            tool_calls = None
            if res.tool_calls:
                tool_calls = [
                    ToolCall(id=i, function=ToolCallFunction(name=n, arguments=a))
                    for (i, n, a) in res.tool_calls
                ]
            finish = res.finish_reason or ("tool_calls" if res.tool_calls else "stop")
            return LLMResponse(
                choices=[
                    Choice(
                        message=ChoiceMessage(content=res.content, tool_calls=tool_calls),
                        finish_reason=finish,
                    )
                ]
            )

        return make_client(create)


@dataclass
class _FakeA2AX:
    """Records send_direct / broadcast calls (the a2ax bus surface a tool uses)."""

    sent_direct: list[tuple[str, str, str, str]] = field(default_factory=list)
    broadcasts: list[tuple[str, str, str]] = field(default_factory=list)

    async def send_direct(self, team_id: str, sender: str, to: str, content: str) -> None:
        self.sent_direct.append((team_id, sender, to, content))

    async def broadcast(self, team_id: str, sender: str, content: str) -> None:
        self.broadcasts.append((team_id, sender, content))


_Built = tuple[AgentConfig, _RecordingLLM, _FakeA2AX]


def _config(scripted: list[_ScriptedResponse], **overrides: Any) -> _Built:
    llm = _RecordingLLM(responses=scripted)
    a2ax = overrides.pop("a2ax", None) or _FakeA2AX()
    cfg = AgentConfig(
        name="test-agent",
        archetype="ops-monitor",
        tools=["send_message", "broadcast", "report_action"],
        initialPrompt="You are a test agent.",
        teamId="team-1",
        agentId="agent-1",
        peers=[PeerAgent(id="agent-2", name="content-scheduler", role="Manages content")],
        a2ax=a2ax,
        llm=llm.client(),
    )
    for k, v in overrides.items():
        setattr(cfg, k, v)
    return cfg, llm, a2ax


def _tool_call(id_: str, name: str, args: str) -> tuple[str, str, str]:
    return (id_, name, args)


def _tool_msg(messages: list[dict[str, Any]], tool_call_id: str) -> dict[str, Any]:
    """The ``role=="tool"`` message for a given tool_call_id (asserts presence)."""
    return next(
        m for m in messages if m.get("role") == "tool" and m.get("tool_call_id") == tool_call_id
    )


# ---------------------------------------------------------------------------
# run_agent — multi-round tool-use loop
# ---------------------------------------------------------------------------


async def test_returns_agent_thought_text_only() -> None:
    cfg, _llm, _a2ax = _config([_ScriptedResponse(content="I have nothing to do right now.")])
    result = await run_agent(cfg)
    assert result.actionType == "agent_thought"
    assert result.payload["agent"] == "test-agent"
    assert result.payload["thought"] == "I have nothing to do right now."


async def test_agent_thought_fallback_when_content_none() -> None:
    cfg, _llm, _a2ax = _config([_ScriptedResponse(content=None)])
    result = await run_agent(cfg)
    assert result.actionType == "agent_thought"
    assert result.payload["thought"] == "no output"


async def test_single_tool_call_returns_action() -> None:
    cfg, _llm, _a2ax = _config(
        [
            _ScriptedResponse(
                tool_calls=[
                    _tool_call(
                        "call_1",
                        "report_action",
                        '{"action_type": "check", "summary": "all good"}',
                    )
                ],
                finish_reason="tool_calls",
            ),
            _ScriptedResponse(content="Done.", finish_reason="stop"),
        ]
    )
    result = await run_agent(cfg)
    assert result.actionType == "check"
    assert result.payload["agent"] == "test-agent"
    assert result.payload["summary"] == "all good"


async def test_offers_and_executes_tools_from_injected_registry() -> None:
    from pydantic import BaseModel

    from simple_harmonic.tools.registry import ToolDefinition, ToolRegistry

    class ReadFileArgs(BaseModel):
        path: str

    executed: list[tuple[str, dict[str, Any]]] = []

    async def _read_impl(args: ReadFileArgs, ctx: Any) -> ToolExecResult:
        executed.append(("read_file", {"path": args.path}))
        return ToolExecResult(
            toolName="read_file",
            success=True,
            result="file contents",
            action=ToolResult(actionType="file_read", payload={"path": args.path}),
        )

    registry = ToolRegistry()
    registry.register(
        ToolDefinition(
            name="read_file",
            description="Read a file",
            category="filesystem",
            risk="safe",
            schema=ReadFileArgs,
        ),
        _read_impl,
    )

    cfg, _llm, _a2ax = _config(
        [
            _ScriptedResponse(
                tool_calls=[_tool_call("call_read", "read_file", '{"path": "notes.txt"}')],
                finish_reason="tool_calls",
            ),
            _ScriptedResponse(content="Done.", finish_reason="stop"),
        ],
        tools=["read_file"],
        toolRegistry=registry,
    )
    result = await run_agent(cfg)
    assert executed == [("read_file", {"path": "notes.txt"})]
    assert result.actionType == "file_read"


async def test_send_message_tool_calls_a2ax() -> None:
    cfg, _llm, a2ax = _config(
        [
            _ScriptedResponse(
                tool_calls=[
                    _tool_call(
                        "call_1",
                        "send_message",
                        '{"to_agent": "content-scheduler", "content": "sync up?"}',
                    )
                ],
                finish_reason="tool_calls",
            ),
            _ScriptedResponse(content="Sent.", finish_reason="stop"),
        ]
    )
    result = await run_agent(cfg)
    assert a2ax.sent_direct == [("team-1", "agent-1", "agent-2", "sync up?")]
    assert result.actionType == "message_sent"


async def test_broadcast_tool() -> None:
    cfg, _llm, a2ax = _config(
        [
            _ScriptedResponse(
                tool_calls=[_tool_call("call_1", "broadcast", '{"content": "alert everyone"}')],
                finish_reason="tool_calls",
            ),
            _ScriptedResponse(content="Broadcasted.", finish_reason="stop"),
        ]
    )
    result = await run_agent(cfg)
    assert a2ax.broadcasts == [("team-1", "agent-1", "alert everyone")]
    assert result.actionType == "broadcast_sent"


async def test_multi_action_when_multiple_tools_one_round() -> None:
    cfg, _llm, _a2ax = _config(
        [
            _ScriptedResponse(
                tool_calls=[
                    _tool_call(
                        "call_1",
                        "report_action",
                        '{"action_type": "scan", "summary": "scanned"}',
                    ),
                    _tool_call("call_2", "broadcast", '{"content": "update"}'),
                ],
                finish_reason="tool_calls",
            ),
            _ScriptedResponse(content="All done.", finish_reason="stop"),
        ]
    )
    result = await run_agent(cfg)
    assert result.actionType == "multi_action"
    assert len(result.payload["actions"]) == 2


async def test_agent_thought_when_tool_fails_then_text_followup() -> None:
    cfg, _llm, _a2ax = _config(
        [
            _ScriptedResponse(
                tool_calls=[
                    _tool_call(
                        "call_1", "send_message", '{"to_agent": "nonexistent", "content": "hi"}'
                    )
                ],
                finish_reason="tool_calls",
            ),
            _ScriptedResponse(content="Oh well.", finish_reason="stop"),
        ],
        peers=[],
    )
    result = await run_agent(cfg)
    assert result.actionType == "agent_thought"
    assert result.payload["thought"] == "Oh well."


async def test_noop_when_rounds_exhaust_with_no_actions() -> None:
    # All 3 rounds produce tool calls to unknown agents; no actions logged.
    cfg, _llm, _a2ax = _config(
        [
            _ScriptedResponse(
                tool_calls=[
                    _tool_call("call_1", "send_message", '{"to_agent": "nobody", "content": "hi"}')
                ],
                finish_reason="tool_calls",
            )
        ],
        peers=[],
    )
    result = await run_agent(cfg)
    assert result.actionType == "noop"
    assert result.payload["agent"] == "test-agent"


async def test_feeds_parse_error_back_for_malformed_json() -> None:
    cfg, llm, a2ax = _config(
        [
            _ScriptedResponse(
                tool_calls=[_tool_call("call_bad", "broadcast", "{not valid json")],
                finish_reason="tool_calls",
            ),
            _ScriptedResponse(
                tool_calls=[_tool_call("call_good", "broadcast", '{"content": "recovered"}')],
                finish_reason="tool_calls",
            ),
            _ScriptedResponse(content="Done.", finish_reason="stop"),
        ]
    )
    result = await run_agent(cfg)
    # The malformed call never reached the broadcast sender with empty args.
    assert a2ax.broadcasts == [("team-1", "agent-1", "recovered")]
    # Round 2's message list carries a tool result for the failed call.
    err = _tool_msg(llm.calls[1]["messages"], "call_bad")
    assert "not valid JSON".lower() in str(err["content"]).lower()
    assert result.actionType == "broadcast_sent"


async def test_respects_max_tool_rounds() -> None:
    cfg, llm, _a2ax = _config(
        [
            _ScriptedResponse(
                tool_calls=[
                    _tool_call(
                        "call_1", "report_action", '{"action_type": "loop", "summary": "again"}'
                    )
                ],
                finish_reason="tool_calls",
            )
        ]
    )
    await run_agent(cfg)
    assert len(llm.calls) == 3  # MAX_TOOL_ROUNDS


async def test_includes_a2ax_context_in_tick_prompt() -> None:
    cfg, llm, _a2ax = _config(
        [_ScriptedResponse(content="Noted.")],
        a2axContext="[DM from content-scheduler]: Need help with drafts",
    )
    await run_agent(cfg)
    user_msg = next(m for m in llm.calls[0]["messages"] if m["role"] == "user")
    assert "Need help with drafts" in user_msg["content"]
    assert "Respond to any messages" in user_msg["content"]


async def test_includes_no_new_messages_when_no_context() -> None:
    cfg, llm, _a2ax = _config([_ScriptedResponse(content="Idle.")])
    await run_agent(cfg)
    user_msg = next(m for m in llm.calls[0]["messages"] if m["role"] == "user")
    assert "No new messages" in user_msg["content"]


async def test_system_prompt_has_peer_list() -> None:
    cfg, llm, _a2ax = _config([_ScriptedResponse(content="OK.")])
    await run_agent(cfg)
    sys_msg = next(m for m in llm.calls[0]["messages"] if m["role"] == "system")
    assert "content-scheduler" in sys_msg["content"]
    assert "Manages content" in sys_msg["content"]
    assert "test-agent" in sys_msg["content"]
    assert "ops-monitor" in sys_msg["content"]


async def test_no_other_agents_when_peers_empty() -> None:
    cfg, llm, _a2ax = _config([_ScriptedResponse(content="Alone.")], peers=[])
    await run_agent(cfg)
    sys_msg = next(m for m in llm.calls[0]["messages"] if m["role"] == "system")
    assert "No other agents" in sys_msg["content"]


async def test_passes_model_override() -> None:
    cfg, llm, _a2ax = _config([_ScriptedResponse(content="OK.")], model="gpt-5.5")
    await run_agent(cfg)
    assert llm.calls[0]["model"] == "gpt-5.5"


async def test_defaults_to_o4_mini() -> None:
    cfg, llm, _a2ax = _config([_ScriptedResponse(content="OK.")], model=None)
    await run_agent(cfg)
    assert llm.calls[0]["model"] == "o4-mini"


async def test_breaks_loop_on_stop_finish_reason() -> None:
    cfg, llm, _a2ax = _config(
        [
            _ScriptedResponse(
                tool_calls=[
                    _tool_call(
                        "call_1", "report_action", '{"action_type": "done", "summary": "finished"}'
                    )
                ],
                finish_reason="stop",
            )
        ]
    )
    await run_agent(cfg)
    assert len(llm.calls) == 1


# ---------------------------------------------------------------------------
# tool_allowlist (FALLBACK_TOOL_NAMES force-add)
# ---------------------------------------------------------------------------


def test_tool_allowlist_force_adds_fallbacks() -> None:
    assert tool_allowlist([]) == ["send_message", "broadcast", "report_action"]


def test_tool_allowlist_dedupes_and_order_stable() -> None:
    assert tool_allowlist(["read_file", "send_message"]) == [
        "send_message",
        "broadcast",
        "report_action",
        "read_file",
    ]


async def test_fallback_tools_offered_even_if_config_omits_them() -> None:
    # An agent configured with only read_file still gets the fallback tools in
    # the allowlist passed to the registry's get_openai_defs.
    from simple_harmonic.tools.default_tools import create_default_registry

    seen: list[list[str] | None] = []
    real = create_default_registry()
    orig = real.get_openai_defs

    def _spy(allowed: list[str] | None = None) -> Any:
        seen.append(allowed)
        return orig(allowed)

    real.get_openai_defs = _spy  # type: ignore[method-assign]
    cfg, _llm, _a2ax = _config(
        [_ScriptedResponse(content="OK.")], tools=["read_file"], toolRegistry=real
    )
    await run_agent(cfg)
    assert seen[0] == ["send_message", "broadcast", "report_action", "read_file"]


# ---------------------------------------------------------------------------
# Suspend on destructive tool (round-atomic)
# ---------------------------------------------------------------------------


def _destructive_cfg(scripted: list[_ScriptedResponse], **overrides: Any) -> _Built:
    overrides.setdefault(
        "isDestructive",
        lambda name, _args=None: name in ("write_file", "run_command"),
    )
    cfg, llm, a2ax = _config(scripted, **overrides)
    cfg.tools = []
    return cfg, llm, a2ax


async def test_suspends_instead_of_executing_destructive() -> None:
    cfg, _llm, a2ax = _destructive_cfg(
        [
            _ScriptedResponse(
                tool_calls=[
                    _tool_call("call_w", "write_file", '{"path": "x.txt", "content": "hi"}')
                ],
                finish_reason="tool_calls",
            )
        ]
    )
    result = await run_agent(cfg)
    assert result.actionType == "suspended"
    assert result.suspension is not None
    assert result.suspension.pending == [
        PendingToolCall(
            id="call_w", name="write_file", arguments='{"path": "x.txt", "content": "hi"}'
        )
    ]
    assert a2ax.sent_direct == []
    assert result.suspension.actions == []


async def test_runs_safe_inline_then_suspends_later_round() -> None:
    cfg, _llm, a2ax = _destructive_cfg(
        [
            _ScriptedResponse(
                tool_calls=[_tool_call("c1", "broadcast", '{"content": "hello"}')],
                finish_reason="tool_calls",
            ),
            _ScriptedResponse(
                tool_calls=[_tool_call("c2", "write_file", '{"path": "y.txt", "content": "z"}')],
                finish_reason="tool_calls",
            ),
        ]
    )
    result = await run_agent(cfg)
    assert a2ax.broadcasts == [("team-1", "agent-1", "hello")]
    assert result.actionType == "suspended"
    assert result.suspension is not None
    assert len(result.suspension.actions) == 1
    assert result.suspension.actions[0].actionType == "broadcast_sent"
    assert result.suspension.round == 1


async def test_defers_safe_calls_from_mixed_batch() -> None:
    cfg, _llm, a2ax = _destructive_cfg(
        [
            _ScriptedResponse(
                tool_calls=[
                    _tool_call("safe_1", "broadcast", '{"content": "heads up"}'),
                    _tool_call("danger_1", "write_file", '{"path": "x.txt", "content": "hi"}'),
                ],
                finish_reason="tool_calls",
            )
        ]
    )
    suspended = await run_agent(cfg)
    assert suspended.actionType == "suspended"
    assert a2ax.broadcasts == []  # the safe call did NOT execute (round-atomic)
    assert suspended.suspension is not None
    assert [c.id for c in suspended.suspension.pending] == ["danger_1"]
    assert [c.id for c in (suspended.suspension.deferredSafe or [])] == ["safe_1"]

    # Resume: the deferred safe call now executes.
    resume_cfg, _llm2, _a2ax2 = _destructive_cfg(
        [_ScriptedResponse(content="done", finish_reason="stop")],
        a2ax=a2ax,
    )
    resume_cfg.resume = ResumeState(
        suspension=suspended.suspension,
        decisions=[ToolDecision(id="danger_1", approved=True)],
    )
    resumed = await run_agent(resume_cfg)
    assert a2ax.broadcasts == [("team-1", "agent-1", "heads up")]
    assert resumed.actionType == "broadcast_sent"


async def test_round_atomic_safe_destructive_safe_runs_in_order_on_resume() -> None:
    # A single batch [safe, destructive, safe]: the ENTIRE round suspends before
    # ANYTHING runs, and on resume the three calls execute in the ORIGINAL
    # assistant-turn order (safe_a -> danger -> safe_b), not pending-then-deferred
    # storage order. This discriminates _ordered_resume_calls walking the
    # assistant turn vs. naively concatenating pending + deferredSafe.
    cfg, _llm, a2ax = _destructive_cfg(
        [
            _ScriptedResponse(
                tool_calls=[
                    _tool_call("safe_a", "broadcast", '{"content": "first"}'),
                    _tool_call("danger", "write_file", '{"path": "x.txt", "content": "hi"}'),
                    _tool_call(
                        "safe_b", "report_action", '{"action_type": "scan", "summary": "ok"}'
                    ),
                ],
                finish_reason="tool_calls",
            )
        ]
    )
    suspended = await run_agent(cfg)
    # Round-atomic: NOTHING in the batch ran before the suspension.
    assert suspended.actionType == "suspended"
    assert a2ax.broadcasts == []
    assert suspended.suspension is not None
    assert suspended.suspension.actions == []
    # Only the destructive call is pending; BOTH safe calls are deferred.
    assert [c.id for c in suspended.suspension.pending] == ["danger"]
    assert [c.id for c in (suspended.suspension.deferredSafe or [])] == ["safe_a", "safe_b"]

    # Resume with the destructive call approved, reusing the same a2ax bus so we
    # can prove safe_a's broadcast fires exactly once on resume.
    resume_cfg, _llm2, _a2ax2 = _destructive_cfg(
        [_ScriptedResponse(content="done", finish_reason="stop")],
        a2ax=a2ax,
    )
    resume_cfg.resume = ResumeState(
        suspension=suspended.suspension,
        decisions=[ToolDecision(id="danger", approved=True)],
    )
    resumed = await run_agent(resume_cfg)
    # The single broadcast (safe_a) executed exactly once.
    assert a2ax.broadcasts == [("team-1", "agent-1", "first")]

    # The conversation handed to the (single) post-resume LLM turn carries tool
    # results for all three calls, in the ORIGINAL order they were issued.
    sent_messages = _llm2.calls[0]["messages"]
    tool_result_ids = [
        m.get("tool_call_id") for m in sent_messages if m.get("role") == "tool"
    ]
    assert tool_result_ids == ["safe_a", "danger", "safe_b"]
    # Both safe calls logged an action (broadcast_sent + scan); write_file is not
    # a registered tool so it logs none. Two actions -> multi_action, and they
    # appear in issue order.
    assert resumed.actionType == "multi_action"
    assert [a["type"] for a in resumed.payload["actions"]] == ["broadcast_sent", "scan"]


async def test_does_not_suspend_without_classifier() -> None:
    # Without isDestructive, every tool runs inline (registry default classifier
    # would mark write_file unknown=destructive, so to exercise pre-T2 behavior
    # we pass a classifier that vouches for everything as safe).
    cfg, _llm, _a2ax = _config(
        [
            _ScriptedResponse(
                tool_calls=[
                    _tool_call("c1", "report_action", '{"action_type": "t", "summary": "s"}')
                ],
                finish_reason="tool_calls",
            ),
            _ScriptedResponse(content="done"),
        ],
        isDestructive=lambda _name, _args=None: False,
    )
    result = await run_agent(cfg)
    assert result.actionType != "suspended"
    assert result.suspension is None


# ---------------------------------------------------------------------------
# Resume after decision (the resume mechanics + fail-safe rejection)
# ---------------------------------------------------------------------------


def _suspension_fixture() -> AgentSuspension:
    return AgentSuspension(
        messages=[
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "tick"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_w",
                        "type": "function",
                        "function": {
                            "name": "write_file",
                            "arguments": '{"path": "x.txt", "content": "hi"}',
                        },
                    }
                ],
            },
        ],
        pending=[
            PendingToolCall(
                id="call_w", name="write_file", arguments='{"path": "x.txt", "content": "hi"}'
            )
        ],
        actions=[],
        round=0,
    )


async def test_resume_executes_tool_on_approval_then_completes() -> None:
    cfg, llm, _a2ax = _destructive_cfg(
        [_ScriptedResponse(content="all done", finish_reason="stop")]
    )
    cfg.resume = ResumeState(
        suspension=_suspension_fixture(),
        decisions=[ToolDecision(id="call_w", approved=True)],
    )
    result = await run_agent(cfg)
    # The LLM was called once more after applying the decision.
    assert len(llm.calls) == 1
    tool_msg = _tool_msg(llm.calls[0]["messages"], "call_w")
    assert tool_msg is not None
    assert result.actionType != "suspended"


async def test_resume_feeds_rejection_note() -> None:
    cfg, llm, _a2ax = _destructive_cfg(
        [_ScriptedResponse(content="ok, skipping", finish_reason="stop")]
    )
    cfg.resume = ResumeState(
        suspension=_suspension_fixture(),
        decisions=[ToolDecision(id="call_w", approved=False, note="too risky")],
    )
    result = await run_agent(cfg)
    tool_msg = _tool_msg(llm.calls[0]["messages"], "call_w")
    assert "not approved" in str(tool_msg["content"])
    assert "too risky" in str(tool_msg["content"])
    assert result.actionType != "suspended"


async def test_resume_missing_decision_is_rejection_fail_safe() -> None:
    cfg, llm, _a2ax = _destructive_cfg([_ScriptedResponse(content="ok", finish_reason="stop")])
    cfg.resume = ResumeState(suspension=_suspension_fixture(), decisions=[])
    await run_agent(cfg)
    tool_msg = _tool_msg(llm.calls[0]["messages"], "call_w")
    assert "not approved" in str(tool_msg["content"])


async def test_resume_can_suspend_again() -> None:
    cfg, _llm, _a2ax = _destructive_cfg(
        [
            _ScriptedResponse(
                tool_calls=[
                    _tool_call("call_2", "run_command", '{"command": "git", "args": ["push"]}')
                ],
                finish_reason="tool_calls",
            )
        ]
    )
    cfg.resume = ResumeState(
        suspension=_suspension_fixture(),
        decisions=[ToolDecision(id="call_w", approved=True)],
    )
    result = await run_agent(cfg)
    assert result.actionType == "suspended"
    assert result.suspension is not None
    assert result.suspension.pending[0].name == "run_command"


def test_suspension_round_trips_through_json() -> None:
    s = _suspension_fixture()
    dumped = s.model_dump(mode="json", by_alias=True)
    rebuilt = AgentSuspension.model_validate(dumped)
    assert rebuilt == s


# ---------------------------------------------------------------------------
# Play-by-play trace
# ---------------------------------------------------------------------------


def _collect() -> tuple[list[TraceStep], Any]:
    steps: list[TraceStep] = []
    return steps, steps.append


def _types(steps: list[TraceStep]) -> list[str]:
    return [s.type for s in steps]


async def test_trace_thought_only_sequence() -> None:
    steps, sink = _collect()
    cfg, _llm, _a2ax = _config([_ScriptedResponse(content="Nothing to do.")], trace=sink)
    await run_agent(cfg)
    assert _types(steps) == ["tick_started", "llm_request", "llm_response", "tick_finished"]
    assert steps[0].data["mode"] == "fresh"
    assert steps[1].data["model"] == "o4-mini"
    assert steps[1].data["round"] == 0
    assert steps[2].data["thought"] == "Nothing to do."
    assert isinstance(steps[2].data["durationMs"], int)
    assert steps[3].data["actionType"] == "agent_thought"
    assert steps[3].data["actionCount"] == 0


async def test_trace_tool_started_finished_around_each_call() -> None:
    steps, sink = _collect()
    cfg, _llm, _a2ax = _config(
        [
            _ScriptedResponse(
                tool_calls=[
                    _tool_call(
                        "call_1", "report_action", '{"action_type": "check", "summary": "all good"}'
                    )
                ],
                finish_reason="tool_calls",
            ),
            _ScriptedResponse(content="Done.", finish_reason="stop"),
        ],
        trace=sink,
    )
    result = await run_agent(cfg)
    assert result.actionType == "check"
    assert _types(steps) == [
        "tick_started",
        "llm_request",
        "llm_response",
        "tool_started",
        "tool_finished",
        "llm_request",
        "llm_response",
        "tick_finished",
    ]
    assert steps[3].data["tool"] == "report_action"
    assert steps[3].data["toolCallId"] == "call_1"
    assert steps[3].data["args"] == {"action_type": "check", "summary": "all good"}
    assert isinstance(steps[4].data["result"], str)
    assert steps[2].data["toolCalls"] == [{"toolCallId": "call_1", "tool": "report_action"}]
    assert steps[7].data["actionType"] == "check"
    assert steps[7].data["actionCount"] == 1


async def test_trace_parse_error_is_tool_finished_result() -> None:
    steps, sink = _collect()
    cfg, _llm, _a2ax = _config(
        [
            _ScriptedResponse(
                tool_calls=[_tool_call("call_bad", "broadcast", "{not valid json")],
                finish_reason="tool_calls",
            ),
            _ScriptedResponse(content="Oh well.", finish_reason="stop"),
        ],
        trace=sink,
    )
    await run_agent(cfg)
    finished = next(s for s in steps if s.type == "tool_finished")
    assert "not valid JSON".lower() in str(finished.data["result"]).lower()


async def test_trace_approval_requested_on_suspend() -> None:
    steps, sink = _collect()
    cfg, _llm, _a2ax = _config(
        [
            _ScriptedResponse(
                tool_calls=[
                    _tool_call("call_d", "broadcast", '{"content": "risky"}'),
                    _tool_call(
                        "call_s", "report_action", '{"action_type": "scan", "summary": "ok"}'
                    ),
                ],
                finish_reason="tool_calls",
            )
        ],
        isDestructive=lambda name, _args=None: name == "broadcast",
        trace=sink,
    )
    result = await run_agent(cfg)
    assert result.actionType == "suspended"
    assert _types(steps) == ["tick_started", "llm_request", "llm_response", "approval_requested"]
    approval = steps[3].data
    assert approval["pending"] == [
        {"toolCallId": "call_d", "tool": "broadcast", "args": {"content": "risky"}}
    ]
    assert approval["deferredSafeCount"] == 1
    assert "tool_started" not in _types(steps)


async def test_trace_decision_applied_and_deferred_safe_on_resume() -> None:
    steps, sink = _collect()
    suspension = AgentSuspension(
        messages=[
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "tick"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_d",
                        "type": "function",
                        "function": {"name": "broadcast", "arguments": '{"content": "risky"}'},
                    },
                    {
                        "id": "call_s",
                        "type": "function",
                        "function": {
                            "name": "report_action",
                            "arguments": '{"action_type": "scan", "summary": "ok"}',
                        },
                    },
                ],
            },
        ],
        pending=[PendingToolCall(id="call_d", name="broadcast", arguments='{"content": "risky"}')],
        deferredSafe=[
            PendingToolCall(
                id="call_s",
                name="report_action",
                arguments='{"action_type": "scan", "summary": "ok"}',
            )
        ],
        actions=[],
        round=0,
    )
    cfg, _llm, _a2ax = _config(
        [_ScriptedResponse(content="Understood.", finish_reason="stop")],
        isDestructive=lambda name, _args=None: name == "broadcast",
        trace=sink,
    )
    cfg.resume = ResumeState(
        suspension=suspension,
        decisions=[ToolDecision(id="call_d", approved=False, note="too risky")],
    )
    result = await run_agent(cfg)
    assert result.actionType == "scan"
    assert _types(steps) == [
        "tick_started",
        "decision_applied",
        "tool_started",
        "tool_finished",
        "llm_request",
        "llm_response",
        "tick_finished",
    ]
    assert steps[0].data["mode"] == "resume"
    assert steps[1].data == {
        "toolCallId": "call_d",
        "tool": "broadcast",
        "approved": False,
        "note": "too risky",
    }
    assert steps[2].data["tool"] == "report_action"


async def test_trace_approved_destructive_execution_on_resume() -> None:
    steps, sink = _collect()
    suspension = AgentSuspension(
        messages=[
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "tick"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_d",
                        "type": "function",
                        "function": {"name": "broadcast", "arguments": '{"content": "go"}'},
                    }
                ],
            },
        ],
        pending=[PendingToolCall(id="call_d", name="broadcast", arguments='{"content": "go"}')],
        actions=[],
        round=0,
    )
    cfg, _llm, a2ax = _config(
        [_ScriptedResponse(content="Sent.", finish_reason="stop")],
        isDestructive=lambda name, _args=None: name == "broadcast",
        trace=sink,
    )
    cfg.resume = ResumeState(
        suspension=suspension, decisions=[ToolDecision(id="call_d", approved=True)]
    )
    result = await run_agent(cfg)
    assert result.actionType == "broadcast_sent"
    assert a2ax.broadcasts == [("team-1", "agent-1", "go")]
    assert _types(steps) == [
        "tick_started",
        "decision_applied",
        "tool_started",
        "tool_finished",
        "llm_request",
        "llm_response",
        "tick_finished",
    ]
    assert steps[1].data["approved"] is True
    assert steps[2].data["tool"] == "broadcast"


async def test_trace_throwing_sink_never_breaks_tick() -> None:
    def _boom(_step: TraceStep) -> None:
        raise RuntimeError("sink exploded")

    cfg, _llm, _a2ax = _config([_ScriptedResponse(content="Still fine.")], trace=_boom)
    result = await run_agent(cfg)
    assert result.actionType == "agent_thought"
    assert result.payload["thought"] == "Still fine."


async def test_no_sink_smoke() -> None:
    cfg, _llm, _a2ax = _config([_ScriptedResponse(content="Quiet.")])
    result = await run_agent(cfg)
    assert result.actionType == "agent_thought"

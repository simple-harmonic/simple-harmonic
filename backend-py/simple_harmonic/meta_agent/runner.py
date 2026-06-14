"""Agent runner — the orchestration engine core.

TS source: packages/backend/src/lib/meta-agent/runner.ts

Calls the LLM with tools, executes tool calls via the slice-6 tool registry, and
suspends for human approval before destructive tools.

Resumable conversation model (D17)
-----------------------------------
A tick is a multi-round tool-use loop. When the LLM asks to run a tool the runner
classifies it via ``is_destructive``. Safe tools run inline. The first
destructive call ends the tick early: the runner SUSPENDS, returning the full
serialized conversation plus the pending destructive call(s). Nothing destructive
has run.

  tick 1:  [run safe tools...] -> hit destructive tool -> SUSPEND
             persist `suspension` (messages so far + pending calls)
  (human approves/rejects in the UI; tick route stores the verdicts)
  tick N:  run_agent(config with resume={state, decisions})
             approved -> execute the tool, feed result to the LLM
             rejected -> feed a rejection note to the LLM
             continue the loop (may suspend again, or complete)

ROUND-ATOMIC suspend
--------------------
The runner suspends the ENTIRE round on the FIRST destructive tool batch BEFORE
executing anything that round, so a round is never half-run: the LLM issued the
calls as one batch. Safe calls from that same batch are DEFERRED (carried in
``suspension.deferredSafe``) and run after resume so every call still gets a
tool result.

Cancellation
------------
``config.signal`` is an ``asyncio.Event`` (set == aborted), the Python mapping of
the TS ``AbortSignal``. It is threaded into the LLM ``create`` call via
:class:`~simple_harmonic.llm.client.CompletionOptions`. The cascade bails when
the signal is already set.
"""
# ruff: noqa: E501 - the agent-facing prompt constants below are verbatim ports
# of the TS prompt text and must match byte-for-byte; do not rewrap them.

from __future__ import annotations

import contextlib
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from simple_harmonic.llm.client import CompletionOptions
from simple_harmonic.meta_agent.contract import validate_contract
from simple_harmonic.meta_agent.types import (
    AgentConfig,
    AgentPromptConfig,
    AgentRunResult,
    AgentSuspension,
    PendingToolCall,
    TraceEventType,
    TraceStep,
)
from simple_harmonic.tools.default_tools import create_default_registry
from simple_harmonic.tools.registry import ToolRegistry
from simple_harmonic.tools.types import ToolResult, ToolRunContext

# Force-added to every agent's allowlist by ``tool_allowlist`` so an agent can
# always talk to its peers and report actions, even if its config omits them.
FALLBACK_TOOL_NAMES = ["send_message", "broadcast", "report_action"]

MAX_TOOL_ROUNDS = 3
DEFAULT_MODEL = "o4-mini"

_default_registry = create_default_registry()


# Agents with any of these tools get the engineering context injected. No
# hardcoded archetype list: if you have code tools, you get code guidance.
ENGINEERING_TOOLS = {"read_file", "write_file", "run_command", "coding_task"}

ENGINEERING_CONTEXT = """
You have access to a project codebase via your tools. Guidelines:
- Use read_file to understand code before modifying it.
- Use run_command with git status/diff/log to understand repo state.
- For complex, multi-step work (implement a feature, investigate a bug, run and fix tests), use coding_task to delegate to the Codex agent. Write a clear, specific task prompt.
- For simple, single-file changes, use write_file directly.
- Destructive actions (write_file, coding_task, git commit/push, etc.) require human approval. You will be paused and the human will approve or reject.
- Be surgical: small, focused changes. Don't rewrite files unnecessarily.
- Report your findings and actions clearly so the team can follow your work.
- Browse .simple-harmonic/skills/ for custom API tools and .simple-harmonic/connectors/ for configured credentials."""


def tool_allowlist(tools: list[str]) -> list[str]:
    """The agent's tool allowlist with the fallback tools force-added.

    Shared with the codex app-server harness. Order-stable, deduped: the
    fallback tools come first, then the agent's own tools (any duplicate of a
    fallback tool is dropped).
    """
    seen: set[str] = set()
    out: list[str] = []
    for name in [*FALLBACK_TOOL_NAMES, *tools]:
        if name not in seen:
            seen.add(name)
            out.append(name)
    return out


@dataclass
class _RunToolOutcome:
    """Result of running (or failing to parse) one tool call. ``content`` is the
    text fed back to the LLM as the tool message content."""

    content: str


def _parse_tool_args(raw: str) -> Any:
    """Parse a tool call's JSON args; return ``None`` on malformed JSON (the
    classifier and trace use this; the executor reports the error explicitly)."""
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return None


def _to_pending_tool_call(tc: Any) -> PendingToolCall:
    """Coerce an LLM ``ToolCall`` (slice-5 model) into a wire PendingToolCall."""
    return PendingToolCall(id=tc.id, name=tc.function.name, arguments=tc.function.arguments)


def _tool_message(tool_call_id: str, content: str) -> dict[str, Any]:
    return {"role": "tool", "tool_call_id": tool_call_id, "content": content}


async def _run_tool_call(
    call: PendingToolCall,
    ctx: ToolRunContext,
    actions: list[ToolResult],
    registry: ToolRegistry,
) -> _RunToolOutcome:
    """Parse a pending call's JSON args and execute it, pushing any logged action
    into ``actions``. Malformed JSON is RETURNED as an error string (not raised)
    so the LLM can self-correct (D10)."""
    try:
        args = json.loads(call.arguments)
    except (ValueError, TypeError) as err:
        return _RunToolOutcome(
            content=(
                f'Error: tool "{call.name}" arguments were not valid JSON ({err}). '
                "Retry the call with properly formatted JSON arguments."
            )
        )

    result = await registry.execute(call.name, args, ctx)
    if result.action:
        actions.append(result.action)
    return _RunToolOutcome(content=result.result)


def _ordered_resume_calls(
    suspension: AgentSuspension,
) -> list[tuple[PendingToolCall, bool]]:
    """Reconstruct call order on resume: ``(call, needs_approval)`` in the order
    the assistant turn issued them, so every tool_call gets a result.

    Walks the LAST assistant message that carries ``tool_calls`` and matches each
    id to a pending (needs approval) or deferred-safe (no approval) call. Any
    pending/deferred call not found on that turn is appended at the end (defensive).
    """
    pending_by_id = {c.id: c for c in suspension.pending}
    safe_by_id = {c.id: c for c in (suspension.deferredSafe or [])}
    ordered: list[tuple[PendingToolCall, bool]] = []
    seen: set[str] = set()

    assistant: dict[str, Any] | None = None
    for msg in reversed(suspension.messages):
        if isinstance(msg.get("tool_calls"), list):
            assistant = msg
            break
    tool_calls = (assistant or {}).get("tool_calls") or []

    for tc in tool_calls:
        tc_id = tc.get("id")
        pending = pending_by_id.get(tc_id)
        if pending is not None:
            ordered.append((pending, True))
            seen.add(tc_id)
            continue
        safe = safe_by_id.get(tc_id)
        if safe is not None:
            ordered.append((safe, False))
            seen.add(tc_id)

    for call in suspension.pending:
        if call.id not in seen:
            ordered.append((call, True))
    for call in suspension.deferredSafe or []:
        if call.id not in seen:
            ordered.append((call, False))

    return ordered


def summarize(agent_name: str, actions: list[ToolResult]) -> AgentRunResult:
    """Collapse accumulated actions into the tick's return value.

    Shared with the codex app-server harness. Zero actions -> noop; one action ->
    that action's type/payload; many -> a ``multi_action`` envelope.
    """
    if not actions:
        return AgentRunResult(actionType="noop", payload={"agent": agent_name})
    if len(actions) == 1:
        return AgentRunResult(
            actionType=actions[0].actionType,
            payload={"agent": agent_name, **actions[0].payload},
        )
    return AgentRunResult(
        actionType="multi_action",
        payload={
            "agent": agent_name,
            "actions": [{"type": a.actionType, **a.payload} for a in actions],
        },
    )


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------


def build_system_prompt(
    config: AgentPromptConfig, tools: list[Any]
) -> str:
    """Build the system prompt. ``tools`` is a list of objects/mappings with
    ``name`` and ``description`` (the registry's ``list_for_agent`` definitions).

    Shared with the codex app-server harness, which injects this as the thread's
    developerInstructions instead of an OpenAI system message.
    """
    peer_list = "\n".join(f"- {p.name} ({p.role})" for p in config.peers)
    tool_list = "\n".join(f"- {_attr(t, 'name')}: {_attr(t, 'description')}" for t in tools)

    is_engineering = any(t in ENGINEERING_TOOLS for t in config.tools)

    return f"""{config.initialPrompt}

You are "{config.name}", a {config.archetype} agent in a team.

Your peers:
{peer_list or "No other agents in this team."}

You have these tools available:
{tool_list or "- No tools are currently enabled for this agent."}
{ENGINEERING_CONTEXT if is_engineering else ""}
Coordinate with your peers when it makes sense. Share relevant findings, ask for help, delegate when appropriate. Be concise in messages.

Improvement levels (how to respond to issues you discover):
- agent: your own errors, prompt issues, scheduling problems. Fix these yourself.
- team: team composition, missing agents, coordination gaps. Report to your lead or broadcast to the team.
- tool: a tool is broken, missing a capability, or misconfigured. Report it clearly via broadcast, then work around it. Do not attempt to fix tool code.
- infra: platform, database, deploy, or framework issues. You will never see infra events. If you suspect an infra problem (e.g. all tools timing out, DB unreachable), broadcast a description to the team. The founder handles infra.

When reporting issues, be specific: what broke, what you tried, what the error said. Vague reports waste everyone's time."""


def _attr(obj: Any, name: str) -> Any:
    """Read ``name`` off a dataclass/object or a mapping (defs may be either)."""
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def build_tick_prompt(config: AgentPromptConfig) -> str:
    """Build the per-tick user prompt. Shared with the codex app-server harness
    (turn/start input text)."""
    prompt = "A new tick has fired. Do your job based on your role and system prompt."

    if config.teamGoal:
        prompt += f"\n\n## Team goal:\n{config.teamGoal}\nAlign your work toward this objective."

    if config.recentHistory:
        prompt += (
            "\n\n## Your recent actions (for continuity, don't repeat work already done):\n"
            f"{config.recentHistory}"
        )

    if config.recentValidations:
        prompt += f"\n\n## Recent output validation results:\n{config.recentValidations}"
        prompt += "\nFix any failing validations. Your output must match the expected contract."

    if config.outputContract:
        prompt += (
            "\n\n## Output contract (your deliverable must match this structure):\n"
            f"{json.dumps(config.outputContract, indent=2)}"
        )
        prompt += "\nUse report_action with a payload matching this schema."

    if config.a2axContext:
        prompt += f"\n\n{config.a2axContext}"
        prompt += "\n\nRespond to any messages that need a reply, then do your regular work."
    else:
        prompt += "\n\nNo new messages from other agents."

    if config.appHealthContext:
        prompt += (
            "\n\n## Recent app events (errors and warnings in this system):\n"
            f"{config.appHealthContext}"
        )
        prompt += """
Respond based on the event level:
- [agent] errors in your area: investigate and fix.
- [team] coordination issues: discuss with peers or escalate to lead.
- [tool] tool failures: acknowledge, work around, do not attempt to fix the tool itself.
- "Platform status: DEGRADED/MAINTENANCE": reduce non-essential work, do not retry failed operations.
- "N known tool issue(s) (under review)": the founder is aware. Do not investigate further.
Use observe_app with a level filter to dig deeper into specific categories."""

    return prompt


# ---------------------------------------------------------------------------
# The runner
# ---------------------------------------------------------------------------


async def run_agent(config: AgentConfig) -> AgentRunResult:
    """Run one agent tick: the multi-round tool-use loop with round-atomic
    suspend/resume. See module docstring for the model."""
    registry = config.toolRegistry or _default_registry
    allowed_tools = tool_allowlist(config.tools)
    tool_defs = registry.get_openai_defs(allowed_tools)
    tool_descriptions = registry.list_for_agent(allowed_tools)
    is_destructive = config.isDestructive or registry.is_destructive

    tool_ctx = ToolRunContext(
        teamId=config.teamId,
        agentId=config.agentId,
        agentName=config.name,
        peers=config.peers,
        a2ax=config.a2ax,
    )

    actions: list[ToolResult] = []
    tick_started_at = time.monotonic()

    def emit(type_: TraceEventType, data: dict[str, Any]) -> None:
        sink = config.trace
        if sink is None:
            return
        # A buggy sink must never break a tick.
        with contextlib.suppress(Exception):
            sink(TraceStep(type=type_, data=data))

    async def traced_tool_call(call: PendingToolCall, round_: int) -> _RunToolOutcome:
        emit(
            "tool_started",
            {
                "round": round_,
                "toolCallId": call.id,
                "tool": call.name,
                "args": _parse_tool_args(call.arguments)
                if _parse_tool_args(call.arguments) is not None
                else call.arguments,
            },
        )
        started_at = time.monotonic()
        try:
            outcome = await _run_tool_call(call, tool_ctx, actions, registry)
            emit(
                "tool_finished",
                {
                    "round": round_,
                    "toolCallId": call.id,
                    "tool": call.name,
                    "result": outcome.content,
                    "durationMs": _elapsed_ms(started_at),
                },
            )
            return outcome
        except Exception as err:
            emit(
                "tool_finished",
                {
                    "round": round_,
                    "toolCallId": call.id,
                    "tool": call.name,
                    "error": str(err),
                    "durationMs": _elapsed_ms(started_at),
                },
            )
            raise

    def finish(result: AgentRunResult) -> AgentRunResult:
        data: dict[str, Any] = {
            "actionType": result.actionType,
            "actionCount": len(actions),
            "durationMs": _elapsed_ms(tick_started_at),
        }
        if result.validation is not None:
            data["validation"] = {
                "valid": result.validation.valid,
                "issues": [i.model_dump() for i in result.validation.issues],
            }
        emit("tick_finished", data)
        return result

    options = CompletionOptions(signal=config.signal)
    model = config.model or DEFAULT_MODEL

    # --- Initialize or restore conversation state ----------------------------
    emit(
        "tick_started",
        {
            "mode": "resume" if config.resume else "fresh",
            "round": config.resume.suspension.round if config.resume else 0,
        },
    )

    messages: list[dict[str, Any]]
    start_round = 0

    if config.resume is not None:
        suspension = config.resume.suspension
        decisions = config.resume.decisions
        messages = suspension.messages
        actions.extend(suspension.actions)
        start_round = suspension.round + 1

        decision_by_id = {d.id: d for d in decisions}
        for call, needs_approval in _ordered_resume_calls(suspension):
            if needs_approval:
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
                    exec_result = await traced_tool_call(call, suspension.round)
                    messages.append(_tool_message(call.id, exec_result.content))
                else:
                    note = (
                        decision.note
                        if decision is not None and decision.note
                        else "The user rejected this action."
                    )
                    messages.append(
                        _tool_message(
                            call.id,
                            f"Action not approved: {note} Do not retry it; "
                            "continue with other work or stop.",
                        )
                    )
            else:
                exec_result = await traced_tool_call(call, suspension.round)
                messages.append(_tool_message(call.id, exec_result.content))
        # Fall through into the loop for another LLM turn.
    else:
        messages = [
            {"role": "system", "content": build_system_prompt(config, tool_descriptions)},
            {"role": "user", "content": build_tick_prompt(config)},
        ]

    # --- Multi-round tool-use loop -------------------------------------------
    for round_ in range(start_round, MAX_TOOL_ROUNDS):
        emit("llm_request", {"round": round_, "model": model, "messageCount": len(messages)})
        llm_started_at = time.monotonic()
        assert config.llm is not None
        response = await config.llm.chat.completions.create(
            {"model": model, "messages": messages, "tools": tool_defs},
            options,
        )

        if not response.choices:
            break
        choice = response.choices[0]
        msg = choice.message
        tool_calls = msg.tool_calls or []

        emit(
            "llm_response",
            {
                "round": round_,
                "thought": msg.content,
                "toolCalls": [
                    {"toolCallId": tc.id, "tool": tc.function.name} for tc in tool_calls
                ],
                "finishReason": choice.finish_reason,
                "durationMs": _elapsed_ms(llm_started_at),
            },
        )

        # LLM returned text only (no tool calls): we're done this tick.
        if not tool_calls:
            if not actions:
                return finish(
                    AgentRunResult(
                        actionType="agent_thought",
                        payload={"agent": config.name, "thought": msg.content or "no output"},
                    )
                )
            break

        # Record the assistant turn (with its tool calls) before executing.
        messages.append(
            {
                "role": "assistant",
                "content": msg.content,
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                    }
                    for tc in tool_calls
                ],
            }
        )

        # ROUND-ATOMIC suspend: any destructive calls? If so, suspend the whole
        # tick BEFORE executing anything in this round.
        calls = [_to_pending_tool_call(tc) for tc in tool_calls]
        destructive = [
            c for c in calls if is_destructive(c.name, _parse_tool_args(c.arguments))
        ]
        if destructive:
            destructive_ids = {c.id for c in destructive}
            emit(
                "approval_requested",
                {
                    "round": round_,
                    "pending": [
                        {
                            "toolCallId": c.id,
                            "tool": c.name,
                            "args": _parse_tool_args(c.arguments)
                            if _parse_tool_args(c.arguments) is not None
                            else c.arguments,
                        }
                        for c in destructive
                    ],
                    "deferredSafeCount": len(calls) - len(destructive),
                },
            )
            return AgentRunResult(
                actionType="suspended",
                payload={
                    "agent": config.name,
                    "pending": [{"id": c.id, "name": c.name} for c in destructive],
                },
                suspension=AgentSuspension(
                    messages=messages,
                    pending=destructive,
                    deferredSafe=[c for c in calls if c.id not in destructive_ids],
                    actions=actions,
                    # Resume continues from THIS round.
                    round=round_,
                ),
            )

        # No destructive calls this round: execute them all inline.
        for call in calls:
            exec_result = await traced_tool_call(call, round_)
            messages.append(_tool_message(call.id, exec_result.content))

        if choice.finish_reason == "stop":
            break

    result = summarize(config.name, actions)

    if config.outputContract:
        result.validation = validate_contract(result.payload, config.outputContract)

    return finish(result)


def _elapsed_ms(started_at: float) -> int:
    return int((time.monotonic() - started_at) * 1000)


# Type alias for callers that want to reference the LLM create coroutine shape.
_CreateFn = Callable[[dict[str, Any], CompletionOptions | None], Awaitable[Any]]

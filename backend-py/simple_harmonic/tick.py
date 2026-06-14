"""Tick orchestrator — the self-scheduling agent loop.

TS source:
  packages/backend/src/server/api/tick.ts        (run_tick orchestrator)
  packages/backend/src/server/standalone/main.ts (the 10s self-POST tick loop)

``run_tick`` walks every active team SEQUENTIALLY and, per team, runs each due
agent through the orchestration core: the pure ``approve_agent_tick`` gate ->
the atomic ``agents.claim`` (no two overlapping ticks for one agent) ->
``run_agent`` (or resume) wrapped in an asyncio wall-clock timeout ->
``increment_tick_count``, releasing the claim. Parked agents (awaiting approval)
are resumed first, only once every pending approval is decided.

Load-bearing behaviors (ported faithfully — see the slice spec):

1. ``try_resume_agent`` RESUME GUARD: an agent parked awaiting approval HOLDS
   (neither resumes nor rejects) while approval rows are MISSING or any pending
   approval is still undecided. It resumes only once every pending approval has a
   decision; a DENIED approval aborts that specific tool call but still resumes
   the rest (the runner applies the verdicts).
2. ``agents.claim`` is atomic under the slice-2 store lock, so two overlapping
   ticks for the same agent cannot both run it.
3. Teams are processed sequentially (``await`` per team); per due agent the gate
   -> claim -> timed run -> ``increment_tick_count`` flow runs, and a timed-out
   run does not burn the whole budget (the cascade aborts on the signal).
4. Spend cap: ``check_spend_allowed`` is checked before running and FAILS OPEN on
   a ledger read error; spend is recorded after. A transient ledger fault never
   blocks the tick.
5. The 10s self-scheduling loop is an asyncio background task started in the
   FastAPI lifespan, guarded by ``SH_TICK_LOOP`` and the prod/CRON_SECRET rules
   (``is_cron_authorized``) — never started unconditionally in tests.

Everything runs OFFLINE in tests: ``run_agent`` and the LLM cascade are mocked,
so no network call is made.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from simple_harmonic.a2ax_singleton import get_a2ax
from simple_harmonic.config import get_api_key_source
from simple_harmonic.events import emit_app_event
from simple_harmonic.llm.spend import check_spend_allowed, make_counting_llm, record_spend
from simple_harmonic.meta_agent import (
    AgentConfig,
    AgentRunResult,
    ResumeState,
    ToolDecision,
    approve_agent_tick,
    run_agent,
)
from simple_harmonic.meta_agent.types import AgentSuspension
from simple_harmonic.store.repos import (
    NewAction,
    NewApproval,
    actionLog,
    agents,
    approvals,
    teams,
)
from simple_harmonic.store.types import Agent, PendingApproval, Team
from simple_harmonic.tools.index import create_app_registry_with_custom_tools
from simple_harmonic.tools.observe import format_events_for_prompt, query_app_events
from simple_harmonic.tools.types import PeerAgent
from simple_harmonic.trace import (
    PersistentTraceSink,
    create_trace_sink,
    prune_trace_events,
)

# Skip ticks for teams with no recent user activity to control costs.
HIBERNATE_THRESHOLD_MS = 5 * 60 * 1000

# Default per-agent wall-clock budget for a single tick (T5/D14). A hung LLM call
# or slow tool can't pin an agent inFlight forever or stall the tick response. On
# timeout the agent is errored and rescheduled like any other failure. Override
# with SH_AGENT_TIMEOUT_MS. Default 120s matches the LLM client timeout.
_DEFAULT_AGENT_TIMEOUT_MS = 120_000

# How many recent actions to feed back as working memory per tick.
HISTORY_LIMIT = 10
VALIDATION_HISTORY_LIMIT = 5

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)

# Reset agents stuck in-flight from a previous crash, once per process.
_did_reset_in_flight = False

# Strong references to fire-and-forget background tasks (prune, broadcast). The
# event loop only holds weak refs, so without this they could be GC'd mid-flight.
_background_tasks: set[asyncio.Task[Any]] = set()


def _fire_and_forget(coro: Awaitable[Any]) -> None:
    """Schedule a fire-and-forget coroutine, retaining a strong reference."""
    task = asyncio.ensure_future(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


def reset_in_flight_guard_for_tests() -> None:
    """Test hook: re-arm the once-per-process inFlight reset."""
    global _did_reset_in_flight
    _did_reset_in_flight = False


def _agent_timeout_ms() -> int:
    """Per-agent tick budget in ms (SH_AGENT_TIMEOUT_MS; default 120s).

    Mirrors the TS ``Number.parseInt`` parse: non-numeric / non-positive falls
    back to the default.
    """
    raw = os.environ.get("SH_AGENT_TIMEOUT_MS", "")
    try:
        v = int(raw, 10)
    except ValueError:
        return _DEFAULT_AGENT_TIMEOUT_MS
    return v if v > 0 else _DEFAULT_AGENT_TIMEOUT_MS


# ---------------------------------------------------------------------------
# Timeout
# ---------------------------------------------------------------------------


class AgentTimeoutError(Exception):
    """A tick run exceeded its wall-clock budget."""

    def __init__(self, label: str, ms: int) -> None:
        super().__init__(f"{label} exceeded the {ms}ms tick budget")


async def with_timeout(
    run: Callable[[asyncio.Event], Awaitable[Any]],
    ms: int,
    label: str,
) -> Any:
    """Race a run against a wall-clock budget.

    ``run`` receives an ``asyncio.Event`` cancellation token (the Python mapping
    of the TS ``AbortSignal``): on timeout the event is set so provider adapters
    that thread it through ``CompletionOptions.signal`` stop doing work, and an
    :class:`AgentTimeoutError` is raised. The pending run task is cancelled so a
    timed-out race never keeps the loop alive.
    """
    signal = asyncio.Event()
    task: asyncio.Task[Any] = asyncio.ensure_future(run(signal))
    try:
        return await asyncio.wait_for(task, timeout=ms / 1000)
    except TimeoutError as err:
        signal.set()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
        raise AgentTimeoutError(label, ms) from err


# ---------------------------------------------------------------------------
# Working-memory prompt context
# ---------------------------------------------------------------------------


def _summarize_payload(action_type: str, payload: dict[str, Any]) -> str:
    if action_type == "awaiting_approval":
        tool = payload.get("toolName") or payload.get("tool") or "unknown"
        return f"requested approval for {tool}"
    if payload.get("tool") and payload.get("args") is not None:
        args = payload["args"]
        args_str = json.dumps(args) if isinstance(args, (dict, list)) else str(args)
        truncated = f"{args_str[:117]}..." if len(args_str) > 120 else args_str
        return f"{payload['tool']}({truncated})"
    if payload.get("summary"):
        return str(payload["summary"])[:150]
    if payload.get("message"):
        return str(payload["message"])[:150]
    blob = json.dumps(payload)
    return f"{blob[:147]}..." if len(blob) > 150 else blob


async def _fetch_recent_history(agent_id: str) -> str | None:
    rows = await actionLog.recentByAgent(agent_id, HISTORY_LIMIT)
    if not rows:
        return None
    lines = []
    for r in reversed(rows):
        ts = r.executedAt.isoformat()[11:19]
        lines.append(f"[{ts}] {r.actionType}: {_summarize_payload(r.actionType, r.payload)}")
    return "\n".join(lines)


async def _fetch_recent_validations(agent_id: str) -> str | None:
    rows = await actionLog.recentByAgent(agent_id, VALIDATION_HISTORY_LIMIT * 2)
    validations: list[str] = []
    for r in reversed(rows):
        v = r.payload.get("validation")
        if not isinstance(v, dict):
            continue
        ts = r.executedAt.isoformat()[11:19]
        if v.get("valid"):
            validations.append(f"[{ts}] PASS")
        else:
            issues = v.get("issues") or []
            issue_str = "; ".join(
                f"{i.get('path')}: {i.get('message')}" for i in issues if isinstance(i, dict)
            )
            validations.append(f"[{ts}] FAIL: {issue_str}")
        if len(validations) >= VALIDATION_HISTORY_LIMIT:
            break
    return "\n".join(validations) if validations else None


def _format_platform_status_for_prompt(status: str, message: str | None) -> str | None:
    """TS app-events.formatPlatformStatusForPrompt. None when healthy."""
    if status == "healthy":
        return None
    label = "DEGRADED" if status == "degraded" else "MAINTENANCE"
    msg = f": {message}" if message else ""
    return (
        f"Platform status: {label}{msg}. Reduce non-essential work and "
        "avoid retrying failed operations."
    )


async def _get_platform_status_row() -> tuple[str, str | None]:
    """Stored platform status, or the healthy default (TS getPlatformStatus)."""
    from simple_harmonic.store.repos import platformStatus

    try:
        ps = await platformStatus.get()
        if ps is not None:
            return ps.status, ps.message
    except Exception:
        pass
    return "healthy", None


def _build_peers(all_agents: list[Agent], self_id: str) -> list[PeerAgent]:
    return [
        PeerAgent(id=a.id, name=a.name, role=a.role) for a in all_agents if a.id != self_id
    ]


# ---------------------------------------------------------------------------
# Trace tick-id extraction (resume continues the same play-by-play thread)
# ---------------------------------------------------------------------------


def _extract_trace_tick_id(conversation_state: Any) -> str | None:
    if not isinstance(conversation_state, dict):
        return None
    tid = conversation_state.get("traceTickId")
    return tid if isinstance(tid, str) and _UUID_RE.match(tid) else None


# ---------------------------------------------------------------------------
# run_tick orchestrator
# ---------------------------------------------------------------------------


async def run_tick(now: datetime | None = None) -> dict[str, Any]:
    """Run one tick pass across every active team. Returns the route body.

    Mirrors TS ``api/tick.ts`` POST: resets stuck inFlight once per process,
    filters hibernated teams, checks the daily spend cap (fail-open), then per
    team resumes parked agents and runs due agents, incrementing the team's tick
    count. Returns ``{ ok, agentsRan, timestamp }`` (or a spend-cap skip body).
    """
    global _did_reset_in_flight
    moment = now if now is not None else datetime.now(UTC)

    # Retention sweep for play-by-play traces; internally throttled to hourly.
    from simple_harmonic.store.repos import traceEvents

    _fire_and_forget(_safe_prune(traceEvents.pruneOlderThan))

    if not _did_reset_in_flight:
        _did_reset_in_flight = True
        try:
            await agents.resetAllInFlight()
        except Exception:
            _did_reset_in_flight = False

    all_active = await teams.listUnpaused()

    # Filter out hibernated teams: no user heartbeat in the last 5 minutes.
    active_teams = [
        t
        for t in all_active
        if t.lastUserActiveAt is not None
        and (moment - t.lastUserActiveAt) < timedelta(milliseconds=HIBERNATE_THRESHOLD_MS)
    ]

    total_ran = 0
    a2ax = get_a2ax()
    timeout_ms = _agent_timeout_ms()
    # Codex is engine-mode only: when the source is codex, drive run_codex_agent_tick.
    use_codex_harness = get_api_key_source() == "codex"

    # LLM cascade: resolved LAZILY, at most once per tick, the first time an
    # agent actually runs (TS resolves at the top of POST, but the JS OpenAI SDK
    # tolerates a key-less client at construction; the Python SDK raises at
    # construction, so a tick over an empty / all-idle store must not build one).
    # A provider error falls through to the next provider and logs a warning app
    # event. Tests mock run_agent, so the resolved client is never called offline.
    llm_holder = _LazyLLM()

    # Daily spend cap. FAILS OPEN on a ledger read error (see spend.py).
    spend = await check_spend_allowed(moment)
    if spend.unknown:
        emit_app_event(
            severity="warning",
            source="tick",
            message="Spend ledger unreadable; proceeding without the cap this tick",
        )
    elif not spend.allowed:
        emit_app_event(
            severity="error",
            source="tick",
            message=(
                f"Daily spend cap reached: {spend.spentCents}c >= "
                f"{spend.capCents}c; skipping tick"
            ),
        )
        return {
            "ok": True,
            "agentsRan": 0,
            "skipped": "spend_cap",
            "spentCents": spend.spentCents,
            "capCents": spend.capCents,
            "timestamp": moment.isoformat(),
        }

    for team in active_teams:
        registry = create_app_registry_with_custom_tools()
        all_agents = await agents.byTeam(team.id)

        # Auto-recover errored agents: reset to running so they retry next tick.
        for a in all_agents:
            if a.status == "errored":
                await agents.update(a.id, {"status": "running", "inFlight": False})
                a.status = "running"
                a.inFlight = False

        # --- Resume pass: agents parked awaiting approval --------------------
        parked = [a for a in all_agents if a.status == "awaiting_approval"]
        for agent in parked:
            ran = await _safe_run(
                _try_resume_agent,
                _RunArgs(
                    team=team,
                    agent=agent,
                    all_agents=all_agents,
                    a2ax=a2ax,
                    now=moment,
                    timeout_ms=timeout_ms,
                    registry=registry,
                    use_codex_harness=use_codex_harness,
                    llm_holder=llm_holder,
                ),
            )
            if ran:
                total_ran += 1

        # --- Fresh pass: due agents ------------------------------------------
        # approve_agent_tick blocks "awaiting_approval", so parked agents never
        # enter here.
        due_agents = [a for a in all_agents if approve_agent_tick(team, a, moment).allowed]
        for agent in due_agents:
            ran = await _safe_run(
                _run_fresh_agent,
                _RunArgs(
                    team=team,
                    agent=agent,
                    all_agents=all_agents,
                    a2ax=a2ax,
                    now=moment,
                    timeout_ms=timeout_ms,
                    registry=registry,
                    use_codex_harness=use_codex_harness,
                    llm_holder=llm_holder,
                ),
            )
            if ran:
                total_ran += 1

        await teams.incrementTickCount(team.id)

    return {"ok": True, "agentsRan": total_ran, "timestamp": moment.isoformat()}


async def _safe_prune(prune_older_than: Callable[[datetime], Awaitable[None]]) -> None:
    with contextlib.suppress(Exception):
        await prune_trace_events(prune_older_than)


async def _safe_run(
    fn: Callable[[_RunArgs], Awaitable[bool]], args: _RunArgs
) -> bool:
    """Run one agent pass, swallowing failures (mirrors Promise.allSettled).

    The per-agent functions already error + reschedule the agent on failure;
    this guard ensures one agent's unexpected exception never aborts the team
    loop. Returns whether the agent ran.
    """
    try:
        return await fn(args)
    except Exception:
        return False


@dataclass
class _RunArgs:
    team: Team
    agent: Agent
    all_agents: list[Agent]
    a2ax: Any
    now: datetime
    timeout_ms: int
    registry: Any
    use_codex_harness: bool
    # Lazily resolves the cascade client + primary model on first agent run.
    llm_holder: _LazyLLM | None = None


# ---------------------------------------------------------------------------
# Fresh run
# ---------------------------------------------------------------------------


async def _run_fresh_agent(args: _RunArgs) -> bool:
    """Run a fresh tick for a due agent, time-bounded.

    Returns True if it ran (even if it then suspended), False only on
    failure/timeout. Failures (including timeout) error the agent and advance
    nextRunAt so the tick can't tight-loop.
    """
    team, agent = args.team, args.agent

    claimed = await agents.claim(agent.id, "running")
    if not claimed:
        return False

    trace = create_trace_sink(team_id=team.id, agent_id=agent.id, append=_make_trace_appender())
    try:
        contract = agent.outputContract
        ctx = await args.a2ax.get_agent_context(team.id, agent.id)
        recent_history = await _fetch_recent_history(agent.id)
        recent_validations = (
            await _fetch_recent_validations(agent.id) if contract else None
        )
        recent_events = await query_app_events(
            team_id=team.id,
            since=args.now - timedelta(milliseconds=3_600_000),
            limit=10,
            include_infra=False,
        )
        status, message = await _get_platform_status_row()

        health_parts = [
            p
            for p in (
                format_events_for_prompt(recent_events),
                _format_platform_status_for_prompt(status, message),
            )
            if p
        ]
        app_health_context = "\n\n".join(health_parts) if health_parts else None

        llm, model_override = _holder(args).resolve()
        usage = make_counting_llm(llm, model_override or "unknown")

        async def run(signal: asyncio.Event) -> AgentRunResult:
            return await run_agent(
                AgentConfig(
                    name=agent.name,
                    archetype=agent.archetype,
                    tools=list(agent.tools),
                    initialPrompt=agent.initialPrompt,
                    a2axContext=ctx.formatted or None,
                    recentHistory=recent_history,
                    teamGoal=team.goal,
                    outputContract=contract,
                    recentValidations=recent_validations,
                    appHealthContext=app_health_context,
                    teamId=team.id,
                    agentId=agent.id,
                    peers=_build_peers(args.all_agents, agent.id),
                    a2ax=args.a2ax,
                    model=model_override,
                    toolRegistry=args.registry,
                    isDestructive=args.registry.is_destructive,
                    trace=trace.emit,
                    llm=usage.llm,
                    signal=signal,
                )
            )

        result = await with_timeout(run, args.timeout_ms, f"agent {agent.name}")

        await args.a2ax.mark_context_read(agent.id, ctx.messageIds)
        await _handle_run_result(agent, result, args.now, trace.tick_id)
        await record_spend(
            args.now,
            model=usage.usage.model,
            input_tokens=usage.usage.inputTokens,
            output_tokens=usage.usage.outputTokens,
            team_id=team.id,
            agent_id=agent.id,
        )
        return True
    except Exception as err:
        await _fail_agent(agent, args.now, err, "tick", args.a2ax, team.id, trace)
        return False
    finally:
        await trace.flush()


# ---------------------------------------------------------------------------
# Resume (the load-bearing trichotomy)
# ---------------------------------------------------------------------------


async def _try_resume_agent(args: _RunArgs) -> bool:
    """Resume an agent parked awaiting approval, IF all pending approvals are
    resolved. Returns True iff the agent actually resumed (ran).

    HOLD vs RESUME vs DENY (see module docstring + the slice spec):
      * HOLD  — return False without running and without rejecting while the
        approval rows are MISSING (incomplete parking write) OR any pending
        approval is still undecided.
      * RESUME — once every pending approval has a decision, resume run_agent
        with the verdicts.
      * DENY  — a denied approval aborts that specific tool call (the runner does
        not execute it) but the rest of the round still resumes.
    """
    team, agent = args.team, args.agent

    suspension_raw = agent.conversationState
    if not suspension_raw:
        # Defensive: parked with no state. Clear both sides so stale approval
        # cards cannot linger or contaminate a later suspension.
        await approvals.clearForAgent(agent.id)
        await agents.update(
            agent.id,
            {"status": "running", "inFlight": False, "conversationState": None},
        )
        return False

    pending_calls = _suspension_pending(suspension_raw)
    rows = await approvals.byAgent(agent.id)
    expected_ids = {p["id"] for p in pending_calls}
    decision_rows = [r for r in rows if r.toolCallId in expected_ids]

    # Missing approval rows means the parking write was incomplete. HOLD rather
    # than implicitly treating the missing human decision as a rejection.
    if len(decision_rows) < len(pending_calls):
        return False
    still_pending = [r for r in decision_rows if r.status == "pending"]
    if still_pending:
        return False

    row_by_tool_call_id: dict[str, PendingApproval] = {r.toolCallId: r for r in decision_rows}
    decisions: list[ToolDecision] = []
    for p in pending_calls:
        row = row_by_tool_call_id.get(p["id"])
        decisions.append(
            ToolDecision(
                id=p["id"],
                approved=(row is not None and row.status == "approved"),
                note=(row.decisionNote if row is not None else None),
            )
        )

    claimed = await agents.claim(agent.id, "awaiting_approval")
    if not claimed:
        return False

    trace = create_trace_sink(
        team_id=team.id,
        agent_id=agent.id,
        tick_id=_extract_trace_tick_id(agent.conversationState),
        append=_make_trace_appender(),
    )
    try:
        recent_history = await _fetch_recent_history(agent.id)

        # Both parked shapes carry ``pending``; only the legacy runner suspension
        # carries a message transcript. The codex app-server resume path is not
        # ported to Python yet (the codex harness runs the exec adapter), so a
        # parked tick always resumes through the runner.
        suspension = AgentSuspension.model_validate(suspension_raw)

        llm, model_override = _holder(args).resolve()
        usage = make_counting_llm(llm, model_override or "unknown")

        async def run(signal: asyncio.Event) -> AgentRunResult:
            return await run_agent(
                AgentConfig(
                    name=agent.name,
                    archetype=agent.archetype,
                    tools=list(agent.tools),
                    initialPrompt=agent.initialPrompt,
                    recentHistory=recent_history,
                    teamId=team.id,
                    agentId=agent.id,
                    peers=_build_peers(args.all_agents, agent.id),
                    a2ax=args.a2ax,
                    model=model_override,
                    toolRegistry=args.registry,
                    isDestructive=args.registry.is_destructive,
                    trace=trace.emit,
                    llm=usage.llm,
                    signal=signal,
                    resume=ResumeState(suspension=suspension, decisions=decisions),
                )
            )

        result = await with_timeout(run, args.timeout_ms, f"agent {agent.name} (resume)")

        # Consume the resolved approvals so they don't block a future suspension.
        await approvals.clearForAgent(agent.id)
        await _handle_run_result(agent, result, args.now, trace.tick_id)
        await record_spend(
            args.now,
            model=usage.usage.model,
            input_tokens=usage.usage.inputTokens,
            output_tokens=usage.usage.outputTokens,
            team_id=team.id,
            agent_id=agent.id,
        )
        return True
    except Exception as err:
        await approvals.clearForAgent(agent.id)
        await _fail_agent(agent, args.now, err, "resume", args.a2ax, team.id, trace)
        return False
    finally:
        await trace.flush()


def _suspension_pending(suspension_raw: Any) -> list[dict[str, Any]]:
    """The parked suspension's pending tool calls (id/name/arguments dicts).

    Reads from the opaque persisted ``conversationState`` mapping; tolerant of
    both the runner ``AgentSuspension`` and the codex-thread shapes (both carry
    ``pending``).
    """
    if isinstance(suspension_raw, dict):
        pending = suspension_raw.get("pending")
        if isinstance(pending, list):
            return [p for p in pending if isinstance(p, dict) and "id" in p]
    return []


# ---------------------------------------------------------------------------
# LLM resolution (offline tests mock run_agent, so the client is never called)
# ---------------------------------------------------------------------------


class _LazyLLM:
    """Memoizes the cascade client + primary model, resolved on first use.

    Resolution is deferred until an agent actually runs: the Python OpenAI SDK
    raises at client construction with no key, so a tick over an empty / all-idle
    store (no due or parked agents) must never build a client. Resolved at most
    once per tick. Tests mock ``run_agent`` so the resolved client is never
    invoked offline; tests that DO run an agent monkeypatch ``_resolve_tick_llm``.
    """

    def __init__(self) -> None:
        self._resolved: tuple[Any, str | None] | None = None

    def resolve(self) -> tuple[Any, str | None]:
        if self._resolved is None:
            self._resolved = _resolve_tick_llm()
        return self._resolved


def _holder(args: _RunArgs) -> _LazyLLM:
    return args.llm_holder if args.llm_holder is not None else _LazyLLM()


def _resolve_tick_llm() -> tuple[Any, str | None]:
    """Resolve the cascade client + primary model for this tick.

    Returns ``(llm, model_override)``. A warning app event is emitted on each
    cascade fallback (matches the TS ``onFallback`` hook). With no provider
    configured this constructs a key-less OpenAI candidate, which raises here —
    the tick already only calls this once an agent is genuinely due.
    """
    from simple_harmonic.llm.candidates import resolve_llm
    from simple_harmonic.llm.cascade import CascadeOptions, FallbackInfo

    def on_fallback(info: FallbackInfo) -> None:
        reason = str(info.error)[:200]
        if info.next is not None:
            message = (
                f"LLM {info.provider}/{info.model} failed ({reason}); "
                f"falling back to {info.next.provider}/{info.next.model}"
            )
        else:
            message = f"LLM {info.provider}/{info.model} failed ({reason}); cascade exhausted"
        emit_app_event(severity="warning", source="tick", message=message)

    resolved = resolve_llm(cascade_opts=CascadeOptions(on_fallback=on_fallback))
    return resolved.llm, resolved.model


# ---------------------------------------------------------------------------
# Result application + failure handling
# ---------------------------------------------------------------------------


def _make_trace_appender() -> Callable[[list[dict[str, Any]]], Awaitable[None]]:
    """The store-backed trace batch appender (telemetry; never breaks a tick)."""
    from simple_harmonic.store.repos import NewTraceEvent, traceEvents

    async def append(batch: list[dict[str, Any]]) -> None:
        rows = [
            NewTraceEvent(
                teamId=r["teamId"],
                agentId=r["agentId"],
                tickId=r["tickId"],
                seq=r["seq"],
                type=r["type"],
                data=r.get("data") or {},
                emittedAt=r["emittedAt"],
            )
            for r in batch
        ]
        await traceEvents.append(rows)

    return append


async def _handle_run_result(
    agent: Agent,
    result: AgentRunResult,
    now: datetime,
    trace_tick_id: str | None,
) -> None:
    """Apply a run result to the store.

    Suspended -> park the agent (awaiting_approval, conversation state saved,
    approval rows created) WITHOUT advancing nextRunAt. Otherwise log the action
    and return the agent to running with a fresh nextRunAt.
    """
    if result.suspension is not None:
        s = result.suspension
        conversation_state = s.model_dump(by_alias=True)
        if trace_tick_id:
            conversation_state["traceTickId"] = trace_tick_id
        await agents.update(
            agent.id,
            {
                "inFlight": False,
                "status": "awaiting_approval",
                "conversationState": conversation_state,
            },
        )

        if s.pending:
            await approvals.insertMany(
                agent.id,
                [
                    NewApproval(
                        teamId=agent.teamId,
                        toolCallId=p.id,
                        toolName=p.name,
                        toolArguments=p.arguments,
                    )
                    for p in s.pending
                ],
            )

        await actionLog.insert(
            agent.id,
            NewAction(actionType="awaiting_approval", payload=result.payload),
        )
        return

    payload = dict(result.payload)
    if result.validation is not None:
        payload["validation"] = {
            "valid": result.validation.valid,
            "issues": [i.model_dump() for i in result.validation.issues],
        }

    await actionLog.insert(
        agent.id, NewAction(actionType=result.actionType, payload=payload)
    )
    await agents.update(
        agent.id,
        {
            "inFlight": False,
            "status": "running",
            "conversationState": None,
            "nextRunAt": now + timedelta(seconds=agent.scheduleSeconds),
        },
    )


async def _fail_agent(
    agent: Agent,
    now: datetime,
    err: BaseException,
    phase: str,
    a2ax: Any,
    team_id: str,
    trace: PersistentTraceSink | None,
) -> None:
    """Common failure handling: log, error the agent, advance nextRunAt, clear
    state. Double-writes to app_events AND broadcasts via a2ax so peers see the
    failure on their next tick."""
    msg = str(err)
    print(f"[tick] {phase} of {agent.name} failed: {msg}")

    if trace is not None:
        with contextlib.suppress(Exception):
            trace.emit({"type": "tick_failed", "data": {"phase": phase, "error": msg}})

    emit_app_event(
        severity="error",
        level="agent",
        source="tick-resume" if phase == "resume" else "tick",
        message=f"Agent {agent.name} failed: {msg}",
        team_id=agent.teamId,
        agent_id=agent.id,
        metadata={"phase": phase, "errorMessage": msg},
    )

    # Real-time alert: broadcast to the team (fire-and-forget; never blocks
    # error recovery).
    with contextlib.suppress(Exception):
        _fire_and_forget(
            _safe_broadcast(
                a2ax,
                team_id,
                agent.id,
                f"[SYSTEM] Agent {agent.name} errored during {phase}: {msg}",
            )
        )

    await agents.update(
        agent.id,
        {
            "inFlight": False,
            "status": "errored",
            "conversationState": None,
            "nextRunAt": now + timedelta(seconds=agent.scheduleSeconds),
        },
    )


async def _safe_broadcast(a2ax: Any, team_id: str, agent_id: str, content: str) -> None:
    with contextlib.suppress(Exception):
        await a2ax.broadcast(
            team_id,
            agent_id,
            content,
            payload={"systemAlert": True, "severity": "error"},
        )


# ---------------------------------------------------------------------------
# Self-scheduling tick loop (standalone/main.ts)
# ---------------------------------------------------------------------------

_TICK_INTERVAL_MS = 10_000


def tick_loop_should_start() -> bool:
    """Whether the background tick loop should run (TS main.ts boot rules).

    Disabled when SH_TICK_LOOP=0. In production without CRON_SECRET the tick
    endpoint fails closed, so the loop would 401 against its own server; refuse
    to start (the operator sets CRON_SECRET, or SH_TICK_LOOP=0 + an external
    cron). Otherwise start.
    """
    if os.environ.get("SH_TICK_LOOP") == "0":
        return False
    from simple_harmonic.auth import is_production_runtime

    if is_production_runtime() and not os.environ.get("CRON_SECRET"):
        print(
            "[simple-harmonic] Tick loop NOT started: production requires "
            "CRON_SECRET (the loop authenticates with it). Set CRON_SECRET, or "
            "set SH_TICK_LOOP=0 and POST /api/tick from an external cron."
        )
        return False
    return True


async def run_tick_loop(
    stop: asyncio.Event,
    interval_ms: int = _TICK_INTERVAL_MS,
) -> None:
    """Background task: drive ``run_tick`` every ``interval_ms`` until ``stop``.

    The TS version self-POSTs ``/api/tick`` over HTTP every 10s; in-process the
    loop calls ``run_tick`` directly (the cron auth is already satisfied by the
    boot-time ``tick_loop_should_start`` gate, exactly as the TS loop attaches
    the CRON_SECRET bearer to its own request). A failing tick logs and the loop
    continues — one bad pass never tears the loop down.
    """
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval_ms / 1000)
            return  # stop was set during the wait
        except TimeoutError:
            pass
        if stop.is_set():
            return
        try:
            await run_tick()
        except Exception as err:
            print(f"[tick] failed: {err}")

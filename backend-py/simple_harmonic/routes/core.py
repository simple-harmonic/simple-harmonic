"""Top-level (non-team) endpoints (slice 8).

TS source: packages/backend/src/server/api/*.ts

  chat.ts          -> POST /api/chat            (SSE planner stream; gated)
  spawn.ts         -> POST /api/spawn           (run the planner spawn; gated)
  seed.ts          -> POST /api/seed            (seed demo data; gated)
  infra-report.ts  -> GET + POST /api/infra-report (founder report; gated)
  agent/[id].ts    -> PATCH /api/agent/{id}     (update an agent row; gated)

login.ts (POST /api/login) is PUBLIC and lives in :mod:`simple_harmonic.routes.login`
(already registered), so it is NOT re-defined here.

Gate: every route in this module except none is operator-only; the gate is applied
as allowlist middleware in :mod:`simple_harmonic.app` (GATED_PREFIXES covers
/api/chat, /api/spawn, /api/seed, /api/infra-report, /api/agent). The handlers do
NO per-handler auth — they assume the gate already passed.

Serialization fidelity: like :mod:`simple_harmonic.routes.team`, datetimes that cross
the wire are rendered through the store's ``json_default`` (millisecond-precision
ISO-8601 ``Z``) so the bytes match the TS ``Date#toISOString()`` / ``JSON.stringify``
output exactly. The chat SSE frames use ``JSON.stringify``-compact separators to match
chat.ts byte-for-byte.

OFFLINE: the planner (``planner_stream``) is the only LLM-touching seam in this
module; it is referenced through this module so tests monkeypatch
``core.planner_stream`` with a scripted token source and never touch the network.
None of these handlers run an agent (the tick loop owns ``run_agent``).
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from simple_harmonic.a2ax.task import CreateTaskInput
from simple_harmonic.a2ax_singleton import get_a2ax
from simple_harmonic.config import get_api_key_source, get_config
from simple_harmonic.events import emit_app_event
from simple_harmonic.meta_agent import (
    ModifyAgentResult,
    PlannerDeps,
    PlannerMessage,
    PlannerResult,
    planner_stream,
)
from simple_harmonic.meta_agent.identity import COFOUNDER_AGENT_ID, USER_AGENT_ID
from simple_harmonic.meta_agent.planner import PlannerConfig
from simple_harmonic.store.repos import NewAgent, NewTeam, agents, appEvents, teams
from simple_harmonic.store.repos.app_events import AppEventQuery
from simple_harmonic.store.serialize import json_default

router = APIRouter(tags=["core"])


# ---------------------------------------------------------------------------
# JSON response: render datetimes the way TS Response.json does (ms + Z).
# ---------------------------------------------------------------------------


class _CoreJSONResponse(JSONResponse):
    """JSONResponse whose datetimes serialize to millisecond-precision ISO-8601 Z,
    matching ``JSON.stringify`` / ``Date#toISOString`` byte-for-byte (the store rows
    returned by PATCH /api/agent/{id} carry datetimes)."""

    def render(self, content: Any) -> bytes:
        return json.dumps(
            content,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            default=json_default,
        ).encode("utf-8")


def _json(content: Any, status_code: int = 200) -> _CoreJSONResponse:
    return _CoreJSONResponse(content, status_code=status_code)


async def _read_json(request: Request) -> Any:
    """Parse the JSON body; raise nothing — returns ``None`` on a malformed body.

    The TS handlers vary in how they read the body:
      * chat/spawn do ``await request.json()`` with no catch (a malformed body is a
        500 there); we mirror by returning ``None`` and letting the field guards 400.
      * infra-report does ``.catch(() => null)``.
    Returning ``None`` on error covers both: the per-handler guards already treat a
    missing/non-object body as "no fields".
    """
    try:
        return await request.json()
    except Exception:
        return None


# ===========================================================================
# Planner deps (TS: server/planner-deps.ts buildPlannerDeps)
# ===========================================================================


def build_planner_deps() -> PlannerDeps:
    """Resolve the planner's dependencies from the server modules.

    Mirrors TS ``buildPlannerDeps``: keeps the planner core free of server imports.
    The codex token/account lookups are resolved here (the planner only uses them
    on the codex path). OFFLINE in tests: ``planner_stream`` is monkeypatched, so
    these deps are never consumed against the network.
    """
    from simple_harmonic.llm import codex_auth
    from simple_harmonic.proxy_fetch import proxy_fetch

    cfg = get_config()
    return PlannerDeps(
        config=PlannerConfig(
            model=cfg.model,
            openaiApiKey=cfg.openaiApiKey or None,
            openaiBaseUrl=cfg.openaiBaseUrl or None,
        ),
        api_key_source=get_api_key_source(),
        codex_access_token=codex_auth.get_codex_access_token(),
        codex_account_id=codex_auth.get_codex_auth_status().accountId or "",
        fetch_impl=proxy_fetch,
    )


# ===========================================================================
# chat.ts — POST /api/chat (SSE planner stream)
# ===========================================================================

# Chat SSE frames use JSON.stringify-compact separators to match chat.ts bytes.
_COMPACT = (",", ":")

_CHAT_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
}


def _chat_frame(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, separators=_COMPACT, default=json_default)}\n\n"


async def _apply_modify_agent(result: ModifyAgentResult) -> dict[str, Any]:
    """Apply a planner modify_agent tool call to the store (TS applyModifyAgent)."""
    all_teams = await teams.all()
    team = next((t for t in all_teams if t.name == result.team_name), None)
    if team is None:
        return {"ok": False, "error": f'Team "{result.team_name}" not found'}

    team_agents = await agents.byTeam(team.id)
    agent = next((a for a in team_agents if a.name == result.agent_name), None)
    if agent is None:
        return {
            "ok": False,
            "error": (
                f'Agent "{result.agent_name}" not found in team "{result.team_name}"'
            ),
        }

    u = result.updates
    update: dict[str, Any] = {}
    if u.tools is not None:
        update["tools"] = u.tools
    if u.initial_prompt is not None:
        update["initialPrompt"] = u.initial_prompt
    if u.schedule_seconds is not None:
        update["scheduleSeconds"] = u.schedule_seconds
    if u.role is not None:
        update["role"] = u.role
    if u.status is not None:
        update["status"] = u.status
    if u.output_contract is not None:
        update["outputContract"] = u.output_contract

    if not update:
        return {"ok": False, "error": "No updates provided"}

    await agents.update(agent.id, update)
    return {"ok": True}


@router.post("/api/chat")
async def chat(request: Request) -> Any:
    """Stream the planner turn as text/event-stream.

    Each token is enqueued as a ``{"type":"token","text":...}`` frame; the terminal
    result is one of spawn / modify_agent / request_credential / done (or error).
    """
    body = await _read_json(request)
    messages_raw = body.get("messages") if isinstance(body, dict) else None

    if not messages_raw or not isinstance(messages_raw, list) or len(messages_raw) == 0:
        return _json({"error": "messages required"}, status_code=400)

    messages: Sequence[PlannerMessage] = [
        PlannerMessage.model_validate(m) for m in messages_raw
    ]

    async def gen() -> AsyncIterator[str]:
        # Tokens are produced by the planner's on_token callback (sync), which runs
        # inside planner_stream's await; we buffer them onto an asyncio.Queue so the
        # generator can interleave token frames with the awaited stream.
        queue: asyncio.Queue[str] = asyncio.Queue()

        def on_token(token: str) -> None:
            queue.put_nowait(_chat_frame({"type": "token", "text": token}))

        deps = build_planner_deps()
        stream_task: asyncio.Task[PlannerResult] = asyncio.ensure_future(
            planner_stream(messages, on_token, deps)
        )

        # Drain token frames as they arrive until the planner stream resolves.
        while True:
            get_task = asyncio.ensure_future(queue.get())
            done, _pending = await asyncio.wait(
                {get_task, stream_task}, return_when=asyncio.FIRST_COMPLETED
            )
            if get_task in done:
                yield get_task.result()
                continue
            # The planner stream finished. Cancel the pending queue.get and flush
            # any tokens enqueued in the same loop turn.
            get_task.cancel()
            while not queue.empty():
                yield queue.get_nowait()
            break

        try:
            result = stream_task.result()
        except Exception as err:
            message = str(err) or "Unknown error"
            emit_app_event(
                severity="error",
                level="infra",
                source="api",
                message=f"Chat API error: {message}",
            )
            yield _chat_frame({"type": "error", "message": message})
            return

        if result.type == "spawn":
            r = result.result
            yield _chat_frame(
                {
                    "type": "spawn",
                    "agents": [a.model_dump(by_alias=True) for a in r.agents],
                    "teamName": r.team_name,
                    "parentTeam": r.parent_team if r.parent_team is not None else None,
                    "cofounderName": (
                        r.cofounder_name if r.cofounder_name is not None else None
                    ),
                    "content": result.content,
                }
            )
        elif result.type == "modify_agent":
            r = result.result
            applied = await _apply_modify_agent(r)
            yield _chat_frame(
                {
                    "type": "modify_agent",
                    "agentName": r.agent_name,
                    "teamName": r.team_name,
                    "updates": r.updates.model_dump(by_alias=True, exclude_none=True),
                    "applied": applied,
                    "content": result.content,
                }
            )
        elif result.type == "request_credential":
            r = result.result
            yield _chat_frame(
                {
                    "type": "request_credential",
                    "key": r.key,
                    "label": r.label,
                    "reason": r.reason,
                    "helpUrl": r.help_url if r.help_url is not None else None,
                    "content": result.content,
                }
            )
        else:
            yield _chat_frame({"type": "done", "content": result.content})

    return StreamingResponse(
        gen(), media_type="text/event-stream", headers=_CHAT_SSE_HEADERS
    )


# ===========================================================================
# spawn.ts — POST /api/spawn
# ===========================================================================

HARMON_TOOLS = [
    "read_file",
    "write_file",
    "action_history",
    "set_team_goal",
    "modify_team",
    "spawn_sub_team",
    "modify_agent",
    "send_message",
    "broadcast",
    "report_action",
]

HARMON_PROMPT = """You are Harmon, the AI cofounder and team lead. You run on a tick like every other agent, but your job is management, not execution.

Each tick, you:
1. Review the team's recent action history (use action_history with scope 'team').
2. Check validation results: which agents are passing their output contracts and which are failing.
3. Identify problems: agents stuck in loops, persistent validation failures, idle agents, missing capabilities.
4. Take action:
   - modify_agent: adjust prompts, tools, schedules, output contracts, or delete/move agents.
   - spawn_sub_team: create new sub-teams when the workload needs organizing.
   - modify_team: rename, set goals, pause/resume, or dissolve teams.
   - set_team_goal: update objectives for any team in your sub-tree.
5. Report a summary of what you observed and what you changed via report_action.

Be surgical. Don't change things that are working. Focus on what's broken or underperforming. If everything looks healthy, report that and move on.

You can also broadcast to the team when coordination is needed, or send_message to specific agents with guidance."""  # noqa: E501


@router.post("/api/spawn")
async def spawn(request: Request) -> Any:
    """Spawn a team of agents (root or sub-team). Auto-adds Harmon on root teams."""
    body = await _read_json(request)
    if not isinstance(body, dict):
        return _json({"error": "agents required"}, status_code=400)

    agent_list = body.get("agents")
    if not agent_list or not isinstance(agent_list, list) or len(agent_list) == 0:
        return _json({"error": "agents required"}, status_code=400)

    team_name = body.get("teamName")
    parent_team = body.get("parentTeam")
    parent_team_id = body.get("parentTeamId")
    cofounder_name = body.get("cofounderName")
    goal = body.get("goal")
    no_harmon = body.get("noHarmon")

    # Resolve parent team: by ID or by name.
    resolved_parent_id: str | None = parent_team_id if isinstance(parent_team_id, str) else None
    if not resolved_parent_id and parent_team:
        all_teams = await teams.all()
        parent = next((t for t in all_teams if t.name == parent_team), None)
        if parent is None:
            return _json(
                {"error": f'Parent team "{parent_team}" not found'}, status_code=400
            )
        resolved_parent_id = parent.id

    resolved_team_name = (
        (team_name.strip() if isinstance(team_name, str) else "")
        or "-".join(str(a.get("archetype", "")) for a in agent_list)[:50]
    )

    is_root_team = not resolved_parent_id
    resolved_cofounder_name = (
        (cofounder_name.strip() if isinstance(cofounder_name, str) else "") or "Harmon"
    )

    team = await teams.insert(
        NewTeam(
            name=resolved_team_name,
            parentTeamId=resolved_parent_id,
            cofounderName=resolved_cofounder_name,
            goal=(goal.strip() if isinstance(goal, str) and goal.strip() else None),
        )
    )

    now = datetime.now(UTC)
    agent_rows: list[NewAgent] = [
        NewAgent(
            name=a["name"],
            role=a["role"],
            archetype=a["archetype"],
            tools=a["tools"],
            scheduleSeconds=a["schedule_seconds"],
            initialPrompt=a["initial_prompt"],
            nextRunAt=now
            + timedelta(seconds=a["schedule_seconds"])
            + timedelta(milliseconds=i * 2000),
        )
        for i, a in enumerate(agent_list)
    ]

    # Auto-spawn Harmon as a tick-based agent on root teams.
    if is_root_team and no_harmon is not True:
        agent_rows.append(
            NewAgent(
                name=resolved_cofounder_name.lower().replace(" ", "-"),
                role=(
                    "AI cofounder and team lead. Reviews agent performance, adjusts "
                    "team structure, sets goals."
                ),
                archetype="meta-agent",
                tools=HARMON_TOOLS,
                scheduleSeconds=3600,
                initialPrompt=HARMON_PROMPT,
                nextRunAt=now
                + timedelta(milliseconds=3600_000)
                + timedelta(milliseconds=len(agent_list) * 2000),
            )
        )

    await agents.insertMany(team.id, agent_rows)

    return _json({"teamId": team.id, "parentTeamId": resolved_parent_id})


# ===========================================================================
# seed.ts — POST /api/seed
# ===========================================================================

_SEED_TEAM_NAME = "Simple Harmonic v0.0 Launch"
_SEED_META_PROMPT = (
    "You are the AI cofounder for Simple Harmonic, an AI cofounder and team product "
    "for founders. The company goal: ship Simple Harmonic v0.0 by June 1 2026, hit "
    "1.5k GitHub stars by month 6, begin MRR at month 6. Your agents handle content, "
    "dev ops, market research, and community. Coordinate them. Be direct and opinionated."
)

_SEED_AGENT_DEFS = [
    {
        "name": "Scout",
        "role": "Market Research",
        "archetype": "researcher",
        "tools": ["send_message", "broadcast", "report_action"],
        "scheduleSeconds": 30,
        "initialPrompt": (
            "You are Scout, the market research agent for Simple Harmonic. Track "
            "competitors in the AI agent / AI cofounder space (Lindy, Induced, "
            "MultiOn, Relevance AI, Crew AI). Monitor Product Hunt, Hacker News, and "
            "indie hacker communities for sentiment on AI agent products. Report "
            "findings to the team. Be concise and data-driven."
        ),
    },
    {
        "name": "Relay",
        "role": "Content & Distribution",
        "archetype": "writer",
        "tools": ["send_message", "broadcast", "report_action"],
        "scheduleSeconds": 45,
        "initialPrompt": (
            "You are Relay, the content and distribution agent for Simple Harmonic. "
            "Draft launch copy, README updates, tweet threads, and Hacker News posts "
            "for Simple Harmonic v0.0. Coordinate with Scout for market data and with "
            "Chisel for feature status. Your tone: builder-to-builder, no fluff, no "
            "consultant-speak."
        ),
    },
    {
        "name": "Chisel",
        "role": "Dev Ops & Shipping",
        "archetype": "executor",
        "tools": ["send_message", "broadcast", "report_action"],
        "scheduleSeconds": 20,
        "initialPrompt": (
            "You are Chisel, the dev ops and shipping agent for Simple Harmonic. "
            "Track build status, CI results, open issues, and deployment readiness "
            "for Simple Harmonic v0.0. Report blockers immediately. Coordinate with "
            "other agents when their work affects the codebase or release timeline."
        ),
    },
    {
        "name": "Pulse",
        "role": "Community & Feedback",
        "archetype": "community",
        "tools": ["send_message", "broadcast", "report_action"],
        "scheduleSeconds": 40,
        "initialPrompt": (
            "You are Pulse, the community and feedback agent for Simple Harmonic. "
            "Monitor GitHub issues, discussions, and early user feedback. Triage bug "
            "reports and feature requests. Flag urgent issues to Chisel. Share user "
            "sentiment trends with Scout and Relay so they can adjust positioning."
        ),
    },
]


@router.post("/api/seed")
async def seed() -> Any:
    """Seed the demo team + agents + a2ax conversations/tasks (TS seed.ts).

    Returns ``{teamId, agents, messageCount, taskCount}`` (409 if it already exists).
    The inter-message ``setTimeout`` delays in the TS source only exist to keep
    chronological ordering; the file-store transport assigns monotonically
    increasing timestamps per insert, so the delays are dropped here.
    """
    a2ax = get_a2ax()

    existing = next((t for t in await teams.all() if t.name == _SEED_TEAM_NAME), None)
    if existing is not None:
        return _json(
            {"error": "Mock team already exists", "teamId": existing.id},
            status_code=409,
        )

    team = await teams.insert(
        NewTeam(
            name=_SEED_TEAM_NAME,
            metaAgentPrompt=_SEED_META_PROMPT,
            cofounderName="Harmon",
            paused=True,
            tickCount=12,
        )
    )

    now = datetime.now(UTC)
    inserted_agents = await agents.insertMany(
        team.id,
        [
            NewAgent(
                name=a["name"],
                role=a["role"],
                archetype=a["archetype"],
                tools=a["tools"],
                scheduleSeconds=a["scheduleSeconds"],
                initialPrompt=a["initialPrompt"],
                nextRunAt=now + timedelta(seconds=a["scheduleSeconds"]),
            )
            for a in _SEED_AGENT_DEFS
        ],
    )
    inserted = [{"id": a.id, "name": a.name} for a in inserted_agents]
    m = {a.name: a.id for a in inserted_agents}

    async def direct(
        from_id: str, to_id: str, content: str, urgent: bool | None = None
    ) -> None:
        await a2ax.send_direct(team.id, from_id, to_id, content, urgent=urgent)

    # --- Thread 1: Scout -> Relay (competitor intel) ---
    await direct(
        m["Scout"],
        m["Relay"],
        "Found 3 direct competitors launching this month: Lindy just shipped their "
        "agent marketplace, Crew AI hit 40k GitHub stars with their new Flows "
        "feature, and MultiOn pivoted to enterprise. None of them target solo "
        "founders specifically. That's our wedge.",
    )
    await direct(
        m["Relay"],
        m["Scout"],
        "Good intel. The solo founder angle is strong. Can you pull pricing data on "
        "all three? I want to position our README against their enterprise-first pitch.",
    )
    await direct(
        m["Scout"],
        m["Relay"],
        "Lindy: $49/mo starter, $199/mo pro. Crew AI: open source core, enterprise "
        "tier unlisted. MultiOn: $99/mo flat. We're free and open source. That's the "
        "headline.",
    )

    # --- Thread 2: Chisel -> Relay (launch readiness) ---
    await direct(
        m["Chisel"],
        m["Relay"],
        "Build status: core agent runner done, meta-agent planner done, team view "
        "done, messaging view done. Remaining: SSE narration polish, onboarding flow "
        "cleanup, and the settings page. We're at ~80% for v0.0.",
    )
    await direct(
        m["Relay"],
        m["Chisel"],
        "80% is good. When do you estimate the README demo GIF can be recorded? I "
        "need that before I draft the HN launch post.",
    )
    await direct(
        m["Chisel"],
        m["Relay"],
        "Targeting Thursday. The graph view with live agent execution is the money "
        "shot. I'll have SSE narration wired up by Wednesday so the sidebar shows "
        "real-time actions.",
    )

    # --- Thread 3: Pulse -> Chisel (bug report) ---
    await direct(
        m["Pulse"],
        m["Chisel"],
        "Early tester reported the team view crashes when an agent errors out "
        "mid-tick. The status dot stays green even though the agent is in errored "
        "state. Might be a stale state issue in use-team.ts.",
        urgent=True,
    )
    await direct(
        m["Chisel"],
        m["Pulse"],
        "Confirmed. The polling interval doesn't refetch agent status after an "
        "error. I'll fix the useTeam hook to re-poll on error state transitions. "
        "Should be a one-liner.",
    )

    # --- Thread 4: Scout -> Chisel (feature gap) ---
    await direct(
        m["Scout"],
        m["Chisel"],
        "Crew AI's Flows let users wire agents visually with drag-and-drop. Our graph "
        "view is read-only. Should we add drag-to-connect for v0.0 or defer?",
    )
    await direct(
        m["Chisel"],
        m["Scout"],
        "Defer. The meta-agent handles wiring. Visual editing is a v0.1 feature. Our "
        "differentiator isn't the graph UI, it's the cofounder persona and "
        "opinionated coordination. Let's not chase Crew AI's features.",
    )

    # --- Thread 5: Broadcast from Scout ---
    await a2ax.broadcast(
        team.id,
        m["Scout"],
        "Weekly market pulse: AI agent space is heating up. 12 new products launched "
        "on Product Hunt this week in the 'AI agents' category. Most target "
        "enterprise teams. Solo founder tools remain underserved. Our timing is good.",
    )

    # --- Thread 6: Pulse -> Relay (user feedback) ---
    await direct(
        m["Pulse"],
        m["Relay"],
        "Three early testers gave feedback on the onboarding chat. Consensus: the "
        "meta-agent's pushback tone is great. One quote: 'Finally an AI that tells me "
        "my idea has too many agents instead of just saying yes.' That's usable for "
        "launch copy.",
    )
    await direct(
        m["Relay"],
        m["Pulse"],
        "Perfect. I'll weave that into the README hero section. 'An AI cofounder that "
        "pushes back.' Keep collecting those quotes.",
    )

    # --- Thread 7: Broadcast from Chisel (deploy update) ---
    await a2ax.broadcast(
        team.id,
        m["Chisel"],
        "Deploy update: staging environment is live on Vercel. All 6 a2ax tables "
        "migrated. Agent runner hitting OpenAI-compatible endpoint. No errors in last "
        "50 ticks. Ready for wider testing.",
    )

    # --- Thread 8: Pulse -> Scout (community signal) ---
    await direct(
        m["Pulse"],
        m["Scout"],
        "Spotted a trending HN thread: 'I replaced my virtual assistant with AI "
        "agents.' 340 points, 180 comments. Sentiment is mixed but the solo founder "
        "comments are overwhelmingly positive. Worth analyzing for our positioning doc.",
    )
    await direct(
        m["Scout"],
        m["Pulse"],
        "Already tracking it. Key insight from the comments: people want agents that "
        "coordinate, not just individual chatbots. That's exactly our thesis. I'll "
        "write up a brief for Relay.",
    )

    # --- Cofounder <-> agent management threads ---
    await direct(
        COFOUNDER_AGENT_ID,
        m["Scout"],
        "Scout, focus this week on the AI cofounder positioning angle. I want a "
        "one-page write-up by Friday: who's adjacent, who's a direct threat, and "
        "where the gap is for solo founders specifically.",
    )
    await direct(
        m["Scout"],
        COFOUNDER_AGENT_ID,
        "Acknowledged. Already have Lindy, Crew AI, MultiOn, Induced, and Relevance "
        "AI in the comparison set. Adding pricing and persona breakdown. Draft Friday "
        "EOD.",
    )
    await direct(
        COFOUNDER_AGENT_ID,
        m["Scout"],
        "Good. One more: add a section on what each competitor does NOT do. That's "
        "where our wedge lives.",
    )

    await direct(
        COFOUNDER_AGENT_ID,
        m["Relay"],
        "Relay, the Show HN post is the single most important launch asset. I want to "
        "review it before it goes live. Draft by Wednesday so we have time to iterate.",
    )
    await direct(
        m["Relay"],
        COFOUNDER_AGENT_ID,
        "On it. Should I lead with the demo GIF or the thesis sentence? I'd argue GIF "
        "first, thesis as caption.",
    )
    await direct(
        COFOUNDER_AGENT_ID,
        m["Relay"],
        "GIF first. HN scans visually. Thesis as the first comment from you (the OP), "
        "not the post body.",
    )

    await direct(
        COFOUNDER_AGENT_ID,
        m["Chisel"],
        "Chisel, status check. Are we still on track for June 1? Be honest. If we're "
        "going to slip, I'd rather cut scope than miss the date.",
        urgent=True,
    )
    await direct(
        m["Chisel"],
        COFOUNDER_AGENT_ID,
        "On track. SSE narration and onboarding polish are the only remaining v0.0 "
        "items. Both fit in this week. Settings page is done.",
    )
    await direct(
        COFOUNDER_AGENT_ID,
        m["Chisel"],
        "Good. Tag a release candidate by Thursday so Relay can record the demo GIF "
        "against stable code.",
    )

    await direct(
        COFOUNDER_AGENT_ID,
        m["Pulse"],
        "Pulse, I need a daily standup from you this week: top user pain, top feature "
        "request, top sentiment shift. Keep it to three bullets.",
    )
    await direct(
        m["Pulse"],
        COFOUNDER_AGENT_ID,
        "Today's: (1) Pain — onboarding chat feels long if you already know what you "
        "want; (2) Request — keyboard shortcut to pause team; (3) Sentiment — strong "
        "positive on the pushback voice, two users quoted it directly.",
    )

    # --- Human user -> cofounder/agents (human in the loop) ---
    await direct(
        USER_AGENT_ID,
        COFOUNDER_AGENT_ID,
        "I'm worried about the HN launch post. Make sure Relay doesn't bury the lede. "
        "The one-liner has to land in the first sentence.",
    )
    await direct(
        COFOUNDER_AGENT_ID,
        USER_AGENT_ID,
        "Already on it. I told Relay GIF first, thesis as the OP's first comment. I'll "
        "review the draft Wednesday before it ships.",
    )
    await direct(
        USER_AGENT_ID,
        COFOUNDER_AGENT_ID,
        "Good. Also: if Chisel slips, cut the SSE narration polish before cutting the "
        "demo GIF. The GIF is non-negotiable.",
    )

    await direct(
        USER_AGENT_ID,
        m["Scout"],
        "Scout, one quick steer: in the competitor write-up, lead with the gap "
        "section. That's the headline, not the pricing table.",
    )
    await direct(
        m["Scout"],
        USER_AGENT_ID,
        "Got it. Restructuring now. Gap analysis up top, pricing as supporting "
        "evidence below.",
    )

    # --- Tasks ---
    await a2ax.create_task(
        CreateTaskInput(
            teamId=team.id,
            requestorId=m["Relay"],
            assigneeId=m["Scout"],
            title="Competitor pricing comparison table",
            description=(
                "Pull pricing data for Lindy, Crew AI, and MultiOn. Format as a "
                "markdown table with tiers, price points, and what's included. Need "
                "this for the README positioning section."
            ),
        )
    )

    task2 = (
        await a2ax.create_task(
            CreateTaskInput(
                teamId=team.id,
                requestorId=m["Chisel"],
                assigneeId=m["Pulse"],
                title="Triage GitHub issues for v0.0 release",
                description=(
                    "Review all open GitHub issues. Label as v0.0-blocker, "
                    "v0.1-backlog, or wontfix. Flag any security-related issues to me "
                    "immediately."
                ),
            )
        )
    )["task"]
    await a2ax.update_task_state(
        task2.id, m["Pulse"], "accepted", "On it. Will have the triage done within the hour."
    )

    task3 = (
        await a2ax.create_task(
            CreateTaskInput(
                teamId=team.id,
                requestorId=m["Scout"],
                assigneeId=m["Relay"],
                title="Draft HN launch post",
                description=(
                    "Write a Show HN post for Simple Harmonic v0.0 launch. Keep it "
                    "builder-to-builder, no marketing fluff. Include: what it does, "
                    "why we built it, link to GitHub, and a 30-second demo GIF "
                    "placeholder."
                ),
            )
        )
    )["task"]
    await a2ax.update_task_state(task3.id, m["Relay"], "accepted")
    await a2ax.update_task_state(
        task3.id,
        m["Relay"],
        "working",
        "First draft in progress. Will share for review before posting.",
    )

    task4 = (
        await a2ax.create_task(
            CreateTaskInput(
                teamId=team.id,
                requestorId=m["Pulse"],
                assigneeId=m["Chisel"],
                title="Fix agent status dot not updating on error",
                description=(
                    "The team view status dot stays green when an agent errors out "
                    "mid-tick. The useTeam hook polling doesn't pick up error state "
                    "transitions. Reproduce: force an agent error and watch the graph "
                    "view."
                ),
            )
        )
    )["task"]
    await a2ax.update_task_state(task4.id, m["Chisel"], "accepted")
    await a2ax.update_task_state(
        task4.id,
        m["Chisel"],
        "working",
        "Found the bug. Polling interval skips status field in the diff check.",
    )

    task5 = (
        await a2ax.create_task(
            CreateTaskInput(
                teamId=team.id,
                requestorId=m["Chisel"],
                assigneeId=m["Relay"],
                title="Update README with setup instructions",
                description=(
                    "Add local development setup section: prerequisites (Node 20+, "
                    "Postgres), env vars (.env.local template), and npm run dev. Keep "
                    "it minimal."
                ),
            )
        )
    )["task"]
    await a2ax.update_task_state(task5.id, m["Relay"], "accepted")
    await a2ax.update_task_state(task5.id, m["Relay"], "working")
    await a2ax.update_task_state(
        task5.id,
        m["Relay"],
        "completed",
        "README updated with setup section. Kept it to 12 lines. PR is up.",
    )

    await a2ax.create_task(
        CreateTaskInput(
            teamId=team.id,
            requestorId=m["Scout"],
            assigneeId=m["Pulse"],
            title="Monitor early adopter sentiment",
            description=(
                "Set up monitoring for mentions of Simple Harmonic on HN, Reddit "
                "r/SideProject, and Indie Hackers. Report daily summary of sentiment "
                "and feature requests."
            ),
        )
    )

    # --- Cofounder-assigned tasks (direction from the cofounder to agents) ---
    cof_task1 = (
        await a2ax.create_task(
            CreateTaskInput(
                teamId=team.id,
                requestorId=COFOUNDER_AGENT_ID,
                assigneeId=m["Relay"],
                title="Show HN launch post — final draft for review",
                description=(
                    "Lead with the demo GIF, thesis as your first comment. 200 words "
                    "max for the post body. I want to read it before it goes live."
                ),
            )
        )
    )["task"]
    await a2ax.update_task_state(cof_task1.id, m["Relay"], "accepted")
    await a2ax.update_task_state(
        cof_task1.id,
        m["Relay"],
        "working",
        "Draft v1 in progress. Will share by Wednesday EOD.",
    )

    await a2ax.create_task(
        CreateTaskInput(
            teamId=team.id,
            requestorId=COFOUNDER_AGENT_ID,
            assigneeId=m["Scout"],
            title="Competitor gap analysis — what they DON'T do",
            description=(
                "Add a 'gap' column to the competitor comparison. For each (Lindy, "
                "Crew AI, MultiOn, Induced, Relevance), list what they explicitly do "
                "not address for solo founders. That's our wedge."
            ),
        )
    )

    await a2ax.create_task(
        CreateTaskInput(
            teamId=team.id,
            requestorId=COFOUNDER_AGENT_ID,
            assigneeId=m["Chisel"],
            title="Tag v0.0 release candidate by Thursday",
            description=(
                "Cut a stable RC tag once SSE narration and onboarding polish land. "
                "Relay needs it for the demo GIF recording."
            ),
        )
    )

    return _json(
        {
            "teamId": team.id,
            "agents": inserted,
            "messageCount": 27,
            "taskCount": 9,
        }
    )


# ===========================================================================
# infra-report.ts — GET + POST /api/infra-report
# ===========================================================================

_MAX_UNACKNOWLEDGED = 100


@router.get("/api/infra-report")
async def infra_report_get() -> Any:
    """Founder-only: unacknowledged infra + tool events, newest-first, capped at 100."""
    try:
        infra_events = await appEvents.query(
            AppEventQuery(
                level="infra",
                includeInfra=True,
                unacknowledgedOnly=True,
                limit=_MAX_UNACKNOWLEDGED,
            )
        )
        tool_events = await appEvents.query(
            AppEventQuery(
                level="tool",
                includeInfra=False,
                unacknowledgedOnly=True,
                limit=_MAX_UNACKNOWLEDGED,
            )
        )

        merged = [*infra_events, *tool_events]
        merged.sort(key=lambda e: e.createdAt, reverse=True)
        merged = merged[:_MAX_UNACKNOWLEDGED]

        return _json(
            {
                "events": [
                    {
                        "id": e.id,
                        "level": e.level,
                        "severity": e.severity,
                        "source": e.source,
                        "message": e.message,
                        "metadata": e.metadata,
                        "agentId": e.agentId,
                        "teamId": e.teamId,
                        "createdAt": e.createdAt,
                    }
                    for e in merged
                ],
                "total": len(merged),
                "infraCount": len(infra_events),
                "toolCount": len(tool_events),
            }
        )
    except Exception as err:
        return _json({"error": str(err) or "Unknown error"}, status_code=500)


@router.post("/api/infra-report")
async def infra_report_post(request: Request) -> Any:
    """Acknowledge (dismiss) events. Body: ``{ eventIds: string[] }``."""
    body = await _read_json(request)
    event_ids = body.get("eventIds") if isinstance(body, dict) else None

    if (
        not isinstance(body, dict)
        or not isinstance(event_ids, list)
        or len(event_ids) == 0
    ):
        return _json({"error": "eventIds array required"}, status_code=400)

    try:
        acknowledged = await appEvents.acknowledge(event_ids)
        return _json({"ok": True, "acknowledged": acknowledged})
    except Exception as err:
        return _json({"error": str(err) or "Unknown error"}, status_code=500)


# ===========================================================================
# agent/[id].ts — PATCH /api/agent/{id}
# ===========================================================================

_PUBLIC_STATUSES = {"running", "paused", "errored"}
_AGENT_ALLOWED_FIELDS = (
    "name",
    "role",
    "archetype",
    "tools",
    "scheduleSeconds",
    "initialPrompt",
    "status",
)


@router.patch("/api/agent/{id}")
async def patch_agent(id: str, request: Request) -> Any:
    """Update an agent row (allowlisted fields). Supports the ``wake`` action."""
    body = await _read_json(request)
    if not isinstance(body, dict):
        body = {}

    if "status" in body and str(body.get("status")) not in _PUBLIC_STATUSES:
        return _json({"error": "invalid status"}, status_code=400)

    updates: dict[str, Any] = {}
    for key in _AGENT_ALLOWED_FIELDS:
        if key in body:
            updates[key] = body[key]

    # Special action: wake — schedule the agent to run on the next tick. Resets
    # nextRunAt to now, and if currently paused, marks it running.
    if body.get("wake") is True:
        updates["nextRunAt"] = datetime.now(UTC)
        if "status" not in updates:
            updates["status"] = "running"

    if not updates:
        return _json({"error": "no valid fields"}, status_code=400)

    current = await agents.byId(id)
    if current is None:
        return _json({"error": "not found"}, status_code=404)

    if current.status == "awaiting_approval" and (
        body.get("wake") is True or "status" in updates
    ):
        return _json(
            {
                "error": (
                    "agent is awaiting approval; resolve or reject the pending action "
                    "first"
                )
            },
            status_code=409,
        )

    updated = await agents.update(id, updates)
    if updated is None:
        return _json({"error": "not found"}, status_code=404)

    return _json(updated.model_dump(by_alias=True))

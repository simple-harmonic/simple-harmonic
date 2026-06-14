"""team/[id]/* endpoints (slice 8).

TS source: packages/backend/src/server/api/team/id/*.ts

  index.ts         -> GET + PATCH /api/team/{id}
  agent-hub.ts     -> GET /api/team/{id}/agent-hub
  approvals.ts     -> GET + POST /api/team/{id}/approvals
  conversations.ts -> GET /api/team/{id}/conversations
  heartbeat.ts     -> POST /api/team/{id}/heartbeat
  messages.ts      -> GET + POST /api/team/{id}/messages (a2ax; POST 201)
  narration.ts     -> GET /api/team/{id}/narration  (SSE text/event-stream)
  pause.ts         -> POST /api/team/{id}/pause
  tasks.ts         -> GET /api/team/{id}/tasks
  trace.ts         -> GET /api/team/{id}/trace  (SSE text/event-stream)

All of /api/team/* is OPEN (no operator gate) — it is listed in the gate's
OPEN_PREFIXES, mirroring the TS handlers that read no session.

Serialization fidelity: the TS handlers serialize datetimes via
``Date.prototype.toISOString()`` (millisecond precision, trailing ``Z``). Pydantic's
default JSON encoder emits MICROSECOND precision, so every datetime that crosses
the wire here is rendered through the store's ``json_default`` (= ``_to_iso_z``),
byte-for-byte with the TS JSON. The :class:`_TeamJSONResponse` below applies that
encoder to the whole body, so model rows passed through ``model_dump(by_alias=True)``
keep their datetimes as ``datetime`` objects and serialize identically to TS.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from simple_harmonic.a2ax_singleton import get_a2ax

# Identity sentinels (cofounder + human participants) — shared module.
from simple_harmonic.meta_agent.identity import (
    COFOUNDER_AGENT_ID,
    COFOUNDER_POV,
    USER_AGENT_ID,
    USER_DISPLAY_NAME,
    USER_POV,
    resolve_cofounder_name,
)
from simple_harmonic.store.repos import TraceQuery, actionLog, agents, approvals, teams, traceEvents
from simple_harmonic.store.serialize import _to_iso_z, json_default

router = APIRouter(tags=["team"])

# ---------------------------------------------------------------------------
# JSON response that renders datetimes the way TS Response.json does (ms + Z).
# ---------------------------------------------------------------------------


class _TeamJSONResponse(JSONResponse):
    """JSONResponse whose datetimes serialize to millisecond-precision ISO-8601 Z,
    matching JS ``JSON.stringify`` / ``Date#toISOString`` byte-for-byte."""

    def render(self, content: Any) -> bytes:
        return json.dumps(
            content,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            default=json_default,
        ).encode("utf-8")


def _json(content: Any, status_code: int = 200) -> _TeamJSONResponse:
    return _TeamJSONResponse(content, status_code=status_code)


async def _read_json(request: Request) -> dict[str, Any]:
    """Parse the JSON body; {} on any error (matches the TS req.json() usage where
    a malformed body is tolerated where the handler guards on missing fields)."""
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


# ===========================================================================
# index.ts — GET + PATCH /api/team/{id}
# ===========================================================================


def _sub_tree_ids(root_id: str, all_teams: list[Any]) -> set[str]:
    """TS getSubTreeIds: BFS/DFS over the parent map, inclusive of root."""
    child_map: dict[str, list[str]] = {}
    for t in all_teams:
        if t.parentTeamId:
            child_map.setdefault(t.parentTeamId, []).append(t.id)
    result: set[str] = set()
    stack = [root_id]
    while stack:
        current = stack.pop()
        result.add(current)
        stack.extend(child_map.get(current, []))
    return result


@router.get("/api/team/{id}")
async def get_team(id: str) -> Any:
    team = await teams.byId(id)
    if team is None:
        return _json({"error": "not found"}, status_code=404)

    team_agents = await agents.byTeam(id)

    all_teams = await teams.all()
    sub_tree_ids = _sub_tree_ids(id, all_teams)
    sub_tree_ids.discard(id)

    child_teams: list[Any] = []
    child_agents: list[Any] = []
    if len(sub_tree_ids) > 0:
        child_teams = [t for t in all_teams if t.id in sub_tree_ids]
        child_agents = await agents.byTeams(sub_tree_ids)

    return _json(
        {
            "team": team.model_dump(by_alias=True),
            "agents": [a.model_dump(by_alias=True) for a in team_agents],
            "childTeams": [t.model_dump(by_alias=True) for t in child_teams],
            "childAgents": [a.model_dump(by_alias=True) for a in child_agents],
        }
    )


@router.patch("/api/team/{id}")
async def patch_team(id: str, request: Request) -> Any:
    body = await _read_json(request)

    allowed = ("name", "metaAgentPrompt", "cofounderName")
    updates: dict[str, Any] = {key: body[key] for key in allowed if key in body}

    if len(updates) == 0:
        return _json({"error": "no valid fields"}, status_code=400)

    updated = await teams.update(id, updates)
    if updated is None:
        return _json({"error": "not found"}, status_code=404)

    return _json(updated.model_dump(by_alias=True))


# ===========================================================================
# agent-hub.ts — GET /api/team/{id}/agent-hub?agentId=xxx
# ===========================================================================


@router.get("/api/team/{id}/agent-hub")
async def agent_hub(id: str, request: Request) -> Any:
    team_id = id
    agent_id = request.query_params.get("agentId")
    if not agent_id:
        return _json({"error": "agentId query param required"}, status_code=400)

    a2ax = get_a2ax()

    agent_rows, team_row, action_rows, message_rows = await asyncio.gather(
        agents.byTeam(team_id),
        teams.byId(team_id),
        actionLog.recentByAgent(agent_id, 100),
        a2ax.list_messages(team_id, 200),
    )

    data_agents = [
        {
            "id": a.id,
            "name": a.name,
            "role": a.role,
            "status": a.status,
            "schedule_seconds": a.scheduleSeconds,
            # Datetime kept raw; _json renders it ms-Z (TS: nextRunAt.toISOString()).
            "next_run_at": a.nextRunAt if a.nextRunAt else None,
            "in_flight": a.inFlight,
        }
        for a in agent_rows
    ]
    cofounder_name_raw = team_row.cofounderName if team_row else None
    data_actions = [
        {
            "id": r.id,
            "action_type": r.actionType,
            "payload": r.payload,
            "executed_at": r.executedAt,
        }
        for r in action_rows
    ]
    data_messages = [
        {
            "id": m.id,
            "channel_type": m.channelType,
            "channel_id": m.channelId,
            "from_agent_id": m.fromAgentId,
            "kind": m.kind,
            "content": m.content,
            "created_at": m.createdAt,
        }
        for m in message_rows
    ]

    cofounder_name = resolve_cofounder_name(cofounder_name_raw)
    name_map: dict[str, str] = {a["id"]: a["name"] for a in data_agents}
    name_map[COFOUNDER_AGENT_ID] = cofounder_name
    name_map[USER_AGENT_ID] = USER_DISPLAY_NAME

    is_cofounder = agent_id == COFOUNDER_AGENT_ID
    is_user = agent_id == USER_AGENT_ID
    agent = (
        None
        if is_cofounder or is_user
        else next((a for a in data_agents if a["id"] == agent_id), None)
    )
    if not is_cofounder and not is_user and agent is None:
        return _json({"error": "agent not found"}, status_code=404)

    received_messages = [
        m
        for m in data_messages
        if m["from_agent_id"] != agent_id
        and (m["channel_type"] == "broadcast" or agent_id in m["channel_id"])
    ]

    sent_messages = (
        [m for m in data_messages if m["from_agent_id"] == agent_id]
        if (is_cofounder or is_user)
        else []
    )

    timeline: list[dict[str, Any]] = []
    for a in data_actions:
        timeline.append(
            {
                "type": "action",
                "id": a["id"],
                "actionType": a["action_type"],
                "payload": a["payload"],
                # executed_at is a datetime; rendered ms-Z on the wire.
                "timestamp": a["executed_at"],
            }
        )
    for m in received_messages:
        timeline.append(
            {
                "type": "received",
                "id": m["id"],
                "fromName": name_map.get(m["from_agent_id"], m["from_agent_id"]),
                "content": m["content"],
                "kind": m["kind"],
                "channelType": m["channel_type"],
                "timestamp": m["created_at"],
            }
        )
    for m in sent_messages:
        peers = [pid for pid in m["channel_id"].split(":") if pid != agent_id]
        to_name = ", ".join(name_map.get(pid, pid) for pid in peers) or m["channel_type"]
        timeline.append(
            {
                "type": "sent",
                "id": f"sent-{m['id']}",
                "toName": to_name,
                "content": m["content"],
                "kind": m["kind"],
                "channelType": m["channel_type"],
                "timestamp": m["created_at"],
            }
        )

    # Sort by timestamp ascending. The TS sort compares getTime() of the ISO
    # strings; here the values are datetimes, which order identically.
    timeline.sort(key=lambda e: _ts_key(e["timestamp"]))

    if is_user:
        agent_name = USER_DISPLAY_NAME
        agent_role = "Founder"
        agent_status: Any = "running"
        agent_schedule: Any = 0
        next_run_at: Any = None
        in_flight: Any = False
    elif is_cofounder:
        agent_name = cofounder_name
        agent_role = "AI Cofounder"
        agent_status = "running"
        agent_schedule = 0
        next_run_at = None
        in_flight = False
    else:
        assert agent is not None
        agent_name = agent["name"]
        agent_role = agent["role"]
        agent_status = agent["status"]
        agent_schedule = agent["schedule_seconds"]
        next_run_at = agent["next_run_at"]
        in_flight = agent["in_flight"]

    return _json(
        {
            "agentId": agent_id,
            "agentName": agent_name,
            "agentRole": agent_role,
            "agentStatus": agent_status,
            "agentSchedule": agent_schedule,
            "nextRunAt": next_run_at,
            "inFlight": in_flight,
            "timeline": timeline,
        }
    )


def _ts_key(value: Any) -> datetime:
    """Sort key for a timeline timestamp (datetime, or ISO string for next_run_at
    which is already a string)."""
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value)


# ===========================================================================
# approvals.ts — GET + POST /api/team/{id}/approvals
# ===========================================================================


@router.get("/api/team/{id}/approvals")
async def list_approvals(id: str) -> Any:
    rows = await approvals.pendingForTeam(id)
    return _json(
        {
            "approvals": [
                {
                    "id": r.id,
                    "agentId": r.agentId,
                    "toolName": r.toolName,
                    "toolArguments": r.toolArguments,
                    "createdAt": r.createdAt,
                }
                for r in rows
            ]
        }
    )


@router.post("/api/team/{id}/approvals")
async def resolve_approval(id: str, request: Request) -> Any:
    body = await _read_json(request)
    approval_id = body.get("approvalId")
    decision = body.get("decision")
    note = body.get("note")

    if not approval_id or (decision != "approved" and decision != "rejected"):
        return _json(
            {"error": "approvalId and decision ('approved'|'rejected') are required"},
            status_code=400,
        )

    decided_at = datetime.now(UTC)
    result = await approvals.resolve(id, approval_id, decision, note if note is not None else None)
    if not result.ok:
        if result.reason == "not_found":
            return _json({"error": "approval not found"}, status_code=404)
        return _json({"error": "approval already resolved"}, status_code=409)

    # Touch the agent so the resume pass re-checks it promptly; status stays put
    # (the tick owns the parked -> running transition).
    await agents.update(result.agentId, {"inFlight": False})
    await teams.update(id, {"lastUserActiveAt": decided_at})

    return _json({"ok": True, "decision": decision})


# ===========================================================================
# conversations.ts — GET /api/team/{id}/conversations?agentId=xxx
# ===========================================================================


@router.get("/api/team/{id}/conversations")
async def conversations(id: str, request: Request) -> Any:
    team_id = id
    agent_id = request.query_params.get("agentId")
    if not agent_id:
        return _json({"error": "agentId query param required"}, status_code=400)

    a2ax = get_a2ax()

    agent_rows, team_row = await asyncio.gather(
        agents.byTeam(team_id), teams.byId(team_id)
    )
    cofounder_name = resolve_cofounder_name(team_row.cofounderName if team_row else None)
    name_map: dict[str, str] = {a.id: a.name for a in agent_rows}
    name_map[COFOUNDER_AGENT_ID] = cofounder_name
    name_map[USER_AGENT_ID] = USER_DISPLAY_NAME

    is_team_overview = agent_id == "team"
    participant_id = (
        COFOUNDER_AGENT_ID
        if agent_id == COFOUNDER_POV
        else USER_AGENT_ID
        if agent_id == USER_POV
        else agent_id
    )

    all_messages = await a2ax.list_messages(team_id, 1000)

    if is_team_overview:
        messages = all_messages
    else:
        messages = [
            m
            for m in all_messages
            if (
                m.channelType == "broadcast"
                or m.fromAgentId == participant_id
                or (m.channelType == "direct" and participant_id in m.channelId)
                or (m.channelType == "group" and participant_id in m.channelId)
                or (m.channelType == "task" and participant_id in m.channelId)
            )
        ]

    task_rows = await a2ax.list_tasks(team_id)
    task_title_map = {f"task:{t.id}": t.title for t in task_rows}

    threads: dict[str, dict[str, Any]] = {}
    for m in messages:
        if m.channelId not in threads:
            peer_agent_id: str | None = None
            peer_agent_name: str | None = None

            if m.channelType == "direct":
                parts = m.channelId.split(":")
                id1 = parts[1] if len(parts) > 1 else None
                id2 = parts[2] if len(parts) > 2 else None
                if is_team_overview:
                    name1 = name_map.get(id1 or "", id1)
                    name2 = name_map.get(id2 or "", id2)
                    peer_agent_name = f"{name1} ↔ {name2}"
                else:
                    peer_agent_id = id2 if id1 == participant_id else id1
                    peer_agent_name = (
                        name_map.get(peer_agent_id, peer_agent_id)
                        if peer_agent_id
                        else None
                    )
            elif m.channelType == "broadcast":
                peer_agent_name = "Team Broadcast"
            elif m.channelType == "group":
                peer_agent_name = "Group Chat"
            elif m.channelType == "task":
                peer_agent_name = task_title_map.get(m.channelId, m.channelId)

            threads[m.channelId] = {
                "channelId": m.channelId,
                "channelType": m.channelType,
                "peerAgentId": peer_agent_id,
                "peerAgentName": peer_agent_name,
                "messages": [],
            }

        threads[m.channelId]["messages"].append(
            {
                "id": m.id,
                "fromAgentId": m.fromAgentId,
                "fromAgentName": name_map.get(m.fromAgentId, m.fromAgentId),
                "content": m.content,
                "kind": m.kind,
                "status": m.status,
                "urgent": m.urgent if m.urgent is not None else False,
                "createdAt": _to_iso_z(m.createdAt),
                "isSelf": (not is_team_overview) and m.fromAgentId == participant_id,
            }
        )

    def _last_created_at(thread: dict[str, Any]) -> str:
        msgs = thread["messages"]
        return msgs[-1]["createdAt"] if msgs else ""

    sorted_threads = sorted(
        threads.values(), key=_last_created_at, reverse=True
    )

    display_name = (
        "Team Overview"
        if is_team_overview
        else name_map.get(participant_id, participant_id)
    )

    return _json(
        {
            "agentId": agent_id,
            "agentName": display_name,
            "threads": sorted_threads,
        }
    )


# ===========================================================================
# heartbeat.ts — POST /api/team/{id}/heartbeat
# ===========================================================================


@router.post("/api/team/{id}/heartbeat")
async def heartbeat(id: str) -> Any:
    await teams.update(id, {"lastUserActiveAt": datetime.now(UTC)})
    return _json({"ok": True})


# ===========================================================================
# messages.ts — GET + POST /api/team/{id}/messages
# ===========================================================================


@router.get("/api/team/{id}/messages")
async def list_messages(id: str, request: Request) -> Any:
    team_id = id
    agent_id = request.query_params.get("agentId")
    if not agent_id:
        return _json({"error": "agentId query param required"}, status_code=400)

    a2ax = get_a2ax()
    ctx = await a2ax.get_agent_context(team_id, agent_id)

    agent_rows = await agents.byTeam(team_id)
    name_map = {a.id: a.name for a in agent_rows}

    enriched: list[dict[str, Any]] = []
    for m in ctx.messages:
        row: dict[str, Any] = {
            "id": m.id,
            "channelType": m.channelType,
            "channelId": m.channelId,
            "fromAgentId": m.fromAgentId,
            "fromAgentName": name_map.get(m.fromAgentId, m.fromAgentId),
            "kind": m.kind,
            "content": m.content,
            "status": m.status,
            "urgent": m.urgent,
            "createdAt": _to_iso_z(m.createdAt),
        }
        # TS passes `m.urgent` raw; when undefined JSON.stringify omits the key.
        # Mirror that: drop a None urgent rather than emitting `null`.
        if m.urgent is None:
            del row["urgent"]
        enriched.append(row)
    return _json(enriched)


@router.post("/api/team/{id}/messages")
async def send_message(id: str, request: Request) -> Any:
    team_id = id
    body = await _read_json(request)

    raw_from = body.get("fromAgentId")
    raw_to = body.get("toAgentId")
    content = body.get("content")
    channel_type = body.get("channelType")
    channel_id = body.get("channelId")

    if not raw_from or not content:
        return _json({"error": "fromAgentId and content required"}, status_code=400)

    def translate_pov(value: str | None) -> str | None:
        if value == COFOUNDER_POV:
            return COFOUNDER_AGENT_ID
        if value == USER_POV:
            return USER_AGENT_ID
        return value

    from_agent_id = translate_pov(raw_from)
    assert from_agent_id is not None  # guarded by the raw_from check above
    to_agent_id = translate_pov(raw_to)

    a2ax = get_a2ax()

    if channel_type == "broadcast":
        msg = await a2ax.broadcast(team_id, from_agent_id, content)
    elif channel_type == "group":
        if not channel_id:
            return _json(
                {"error": "channelId required for group messages"}, status_code=400
            )
        msg = await a2ax.send_to_group(team_id, channel_id, from_agent_id, content)
    else:
        if not to_agent_id:
            return _json(
                {"error": "toAgentId required for direct messages"}, status_code=400
            )
        msg = await a2ax.send_direct(team_id, from_agent_id, to_agent_id, content)

    # TS returns the raw a2ax msg object: unset optionals (parts/artifacts/payload/
    # replyTo/urgent) are `undefined` and JSON.stringify OMITS them. expiresAt is
    # always set on these paths (= _expiry()), so exclude_none drops exactly the
    # undefined-in-TS keys and keeps the byte-for-byte shape.
    return _json(msg.model_dump(by_alias=True, exclude_none=True), status_code=201)


# ===========================================================================
# pause.ts — POST /api/team/{id}/pause
# ===========================================================================


@router.post("/api/team/{id}/pause")
async def pause_team(id: str) -> Any:
    team = await teams.byId(id)
    if team is None:
        return _json({"error": "not found"}, status_code=404)

    new_paused = not team.paused
    await teams.update(id, {"paused": new_paused})
    return _json({"paused": new_paused})


# ===========================================================================
# tasks.ts — GET /api/team/{id}/tasks?agentId=xxx
# ===========================================================================


@router.get("/api/team/{id}/tasks")
async def list_tasks(id: str, request: Request) -> Any:
    team_id = id
    agent_id = request.query_params.get("agentId")
    if not agent_id:
        return _json({"error": "agentId query param required"}, status_code=400)

    a2ax = get_a2ax()

    agent_rows = await agents.byTeam(team_id)
    name_map: dict[str, str] = {a.id: a.name for a in agent_rows}
    team_row = await teams.byId(team_id)
    name_map[COFOUNDER_AGENT_ID] = resolve_cofounder_name(
        team_row.cofounderName if team_row else None
    )
    name_map[USER_AGENT_ID] = USER_DISPLAY_NAME

    is_team_overview = agent_id == "team"
    participant_id = (
        COFOUNDER_AGENT_ID
        if agent_id == COFOUNDER_POV
        else USER_AGENT_ID
        if agent_id == USER_POV
        else agent_id
    )

    raw_tasks = await a2ax.list_tasks(
        team_id, None if is_team_overview else participant_id
    )
    raw_tasks = sorted(raw_tasks, key=lambda t: t.updatedAt)[:200]

    enriched = [
        {
            "id": t.id,
            "title": t.title,
            "description": t.description,
            "state": t.state,
            "requestorId": t.requestorId,
            "requestorName": name_map.get(t.requestorId, t.requestorId),
            "assigneeId": t.assigneeId,
            "assigneeName": name_map.get(t.assigneeId, t.assigneeId),
            "createdAt": _to_iso_z(t.createdAt),
            "updatedAt": _to_iso_z(t.updatedAt),
        }
        for t in raw_tasks
    ]
    return _json(enriched)


# ===========================================================================
# narration.ts — GET /api/team/{id}/narration (SSE)
# ===========================================================================

_SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}

# Live-poll tunables. Module-level so tests can shrink the interval and bound the
# number of update passes to make the SSE generator promptly finite. In prod they
# default to the TS values (3s narration / 2s trace) and unbounded updates.
NARRATION_POLL_S: float = 3.0
TRACE_POLL_S: float = 2.0
# None = poll forever (prod). An int caps the number of update passes (tests).
MAX_UPDATE_PASSES: int | None = None


def _sse(data: dict[str, Any]) -> str:
    return f"data: {json.dumps(data, default=json_default)}\n\n"


@router.get("/api/team/{id}/narration")
async def narration(id: str) -> Any:
    team_id = id

    team_agents = await agents.byTeam(team_id)
    agent_ids = [a.id for a in team_agents]

    # Edge case: no agents yet — a single history event, then close.
    if len(agent_ids) == 0:
        return StreamingResponse(
            iter([_sse({"type": "history", "entries": []})]),
            media_type="text/event-stream",
            headers=_SSE_HEADERS,
        )

    async def gen() -> AsyncIterator[str]:
        last_seen: datetime | None = None

        # 1. History: last 50, oldest-first.
        history = await actionLog.byAgents(agent_ids, limit=50)
        ordered_history = list(reversed(history))
        if ordered_history:
            last_seen = ordered_history[-1].executedAt
        yield _sse(
            {
                "type": "history",
                "entries": [e.model_dump(by_alias=True) for e in ordered_history],
            }
        )

        # 2. Live updates: poll for entries newer than last_seen.
        passes = 0
        while MAX_UPDATE_PASSES is None or passes < MAX_UPDATE_PASSES:
            await asyncio.sleep(NARRATION_POLL_S)
            passes += 1
            latest = await actionLog.byAgents(agent_ids, limit=20, since=last_seen)
            if not latest:
                continue
            last_seen = latest[0].executedAt
            yield _sse(
                {
                    "type": "update",
                    "entries": [e.model_dump(by_alias=True) for e in reversed(latest)],
                }
            )

    return StreamingResponse(
        gen(), media_type="text/event-stream", headers=_SSE_HEADERS
    )


# ===========================================================================
# trace.ts — GET /api/team/{id}/trace (SSE)
# ===========================================================================

_TRACE_HISTORY_LIMIT = 200
_TRACE_UPDATE_LIMIT = 200
_SENT_IDS_CAP = 1000


@router.get("/api/team/{id}/trace")
async def trace(id: str, request: Request) -> Any:
    team_id = id
    agent_id = request.query_params.get("agentId")
    tick_id = request.query_params.get("tickId")

    async def gen() -> AsyncIterator[str]:
        last_seen: datetime | None = None
        sent_ids: set[str] = set()
        sent_order: list[str] = []

        def remember(eid: str) -> None:
            sent_ids.add(eid)
            sent_order.append(eid)
            while len(sent_order) > _SENT_IDS_CAP:
                oldest = sent_order.pop(0)
                sent_ids.discard(oldest)

        # 1. History: newest HISTORY_LIMIT, reversed to chronological.
        history = await traceEvents.query(
            TraceQuery(
                teamId=team_id,
                agentId=agent_id,
                tickId=tick_id,
                order="desc",
                limit=_TRACE_HISTORY_LIMIT,
            )
        )
        ordered = list(reversed(history))
        for e in ordered:
            remember(e.id)
        if ordered:
            last_seen = ordered[-1].emittedAt
        yield _sse(
            {
                "type": "history",
                "entries": [e.model_dump(by_alias=True) for e in ordered],
            }
        )

        # 2. Live updates: poll for steps at/after last_seen, dedupe by id.
        passes = 0
        while MAX_UPDATE_PASSES is None or passes < MAX_UPDATE_PASSES:
            await asyncio.sleep(TRACE_POLL_S)
            passes += 1
            latest = await traceEvents.query(
                TraceQuery(
                    teamId=team_id,
                    agentId=agent_id,
                    tickId=tick_id,
                    since=last_seen,
                    order="asc",
                    limit=_TRACE_UPDATE_LIMIT,
                )
            )
            fresh = [e for e in latest if e.id not in sent_ids]
            if not fresh:
                continue
            for e in fresh:
                remember(e.id)
            last_seen = fresh[-1].emittedAt
            yield _sse(
                {
                    "type": "update",
                    "entries": [e.model_dump(by_alias=True) for e in fresh],
                }
            )

    return StreamingResponse(
        gen(), media_type="text/event-stream", headers=_SSE_HEADERS
    )

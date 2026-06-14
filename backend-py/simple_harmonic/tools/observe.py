"""observe_app tool -- lets agents query the app's health events.

TS source: packages/backend/src/server/tools/observe.ts
  (+ queryAppEvents / formatEventsForPrompt from server/app-events.ts)

Agents can see recent errors, warnings, and info events at agent/team/tool
levels. Infra-level events are NEVER returned (founder-only).

This is the active-query complement to the passive health-context injection in
the tick prompt. Use it when an agent wants to investigate a specific error or
check if a fix resolved an issue.

``query_app_events`` / ``format_events_for_prompt`` are ported here (the TS tool
imports them from ``app-events``) rather than into the slice-4 ``events`` module
— that module is the store-decoupled emit side and must not gain a store
dependency. They delegate to the store's ``appEvents`` repo.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from pydantic import BaseModel, Field

from simple_harmonic.store.repos import AppEventQuery, appEvents
from simple_harmonic.store.types import AppEvent
from simple_harmonic.tools.registry import ToolDefinition
from simple_harmonic.tools.types import ToolExecResult, ToolResult, ToolRunContext

TOOL_EXPIRY_MS = 24 * 3_600_000


async def query_app_events(
    *,
    team_id: str | None = None,
    severity: str | None = None,
    level: str | None = None,
    source: str | None = None,
    since: datetime | None = None,
    limit: int = 20,
    include_infra: bool = False,
) -> list[AppEvent]:
    """Query recent app events. By default EXCLUDES infra-level events (agents
    should never see them)."""
    return await appEvents.query(
        AppEventQuery(
            teamId=team_id,
            severity=severity,  # type: ignore[arg-type]
            level=level,  # type: ignore[arg-type]
            source=source,
            since=since,
            limit=limit,
            includeInfra=include_infra,
        )
    )


def format_events_for_prompt(events: list[AppEvent]) -> str | None:
    """Format events for injection into an agent's prompt. Filters out infra
    events (never reach agents). Tool events older than 24h are summarized."""
    if not events:
        return None

    now = datetime.now(UTC)
    lines: list[str] = []
    expired_tool_count = 0

    for e in events:
        if e.level == "infra":
            continue
        if e.level == "tool" and (now - e.createdAt) > timedelta(milliseconds=TOOL_EXPIRY_MS):
            expired_tool_count += 1
            continue
        ts = e.createdAt.isoformat()[11:19]
        sev = "ERROR" if e.severity == "error" else "WARN" if e.severity == "warning" else "INFO"
        lvl = f" [{e.level}]" if e.level else ""
        agent = f" (agent {e.agentId[:8]})" if e.agentId else ""
        lines.append(f"[{ts}] {sev}{lvl} [{e.source}]{agent}: {e.message}")

    if expired_tool_count > 0:
        lines.append(f"{expired_tool_count} known tool issue(s) (under review)")

    return "\n".join(lines) if lines else None


class ObserveAppArgs(BaseModel):
    severity: str | None = Field(
        default=None, description="Filter by severity (info/warning/error). Omit for all."
    )
    level: str | None = Field(
        default=None,
        description=(
            "Filter by level: agent (single agent issues), team (coordination issues), "
            "tool (tool bugs/limitations). Infrastructure events are not available "
            "through this tool."
        ),
    )
    source: str | None = Field(
        default=None,
        description="Filter by source (e.g. 'tick', 'tool', 'api', 'test'). Omit for all sources.",
    )
    hours: float | None = Field(
        default=None, description="How many hours back to look. Default 1 hour, max 24."
    )
    limit: int | None = Field(
        default=None, description="Max events to return. Default 20, max 50."
    )


observe_app_def = ToolDefinition(
    name="observe_app",
    description=(
        "Query recent app health events (errors, warnings, status updates) at agent, "
        "team, or tool level. Use this to investigate issues, check if a fix resolved an "
        "error, or understand what's happening in the system. Returns events newest-first. "
        "Infrastructure-level events are not accessible through this tool."
    ),
    category="internal",
    risk="safe",
    schema=ObserveAppArgs,
)


async def observe_app_impl(args: ObserveAppArgs, ctx: ToolRunContext) -> ToolExecResult:
    hours = min(args.hours if args.hours is not None else 1, 24)
    limit = min(args.limit if args.limit is not None else 20, 50)
    since = datetime.now(UTC) - timedelta(hours=hours)

    try:
        events = await query_app_events(
            team_id=ctx.teamId,
            severity=args.severity,
            level=args.level,
            source=args.source,
            since=since,
            limit=limit,
            include_infra=False,  # never show infra to agents
        )

        if not events:
            suffix = ""
            if args.severity:
                suffix += f" with severity={args.severity}"
            if args.level:
                suffix += f" at level={args.level}"
            if args.source:
                suffix += f" from source={args.source}"
            return ToolExecResult(
                toolName="observe_app",
                success=True,
                result=f"No events found in the last {_hours_label(hours)}{suffix}.",
            )

        formatted = format_events_for_prompt(events)
        return ToolExecResult(
            toolName="observe_app",
            success=True,
            result=f"{len(events)} event(s) in the last {_hours_label(hours)}:\n\n{formatted}",
            action=ToolResult(
                actionType="app_observed",
                payload={
                    "eventCount": len(events),
                    "hours": hours,
                    "filters": {
                        "severity": args.severity,
                        "level": args.level,
                        "source": args.source,
                    },
                },
            ),
        )
    except Exception as err:
        return ToolExecResult(
            toolName="observe_app",
            success=False,
            result=f"observe_app failed: {err}",
        )


def _hours_label(hours: float) -> str:
    """Render the hours window the way the TS template literal does (it just
    interpolates the number followed by ' hour(s)')."""
    n = int(hours) if float(hours).is_integer() else hours
    return f"{n} hour(s)"

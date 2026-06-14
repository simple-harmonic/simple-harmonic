"""action_history tool: query the action log for agents and teams.

TS source: packages/backend/src/server/tools/action-history.ts

Lets any agent (especially leads and Harmon) review what other agents have
done, including output-contract validation pass/fail results. This is the read
side of the self-improving loop: agents observe outcomes, then use modify_agent
to adjust prompts/tools/contracts.
"""

from __future__ import annotations

import asyncio
import json
from typing import Literal

from pydantic import BaseModel, Field

from simple_harmonic.store.repos import actionLog, agents, teams
from simple_harmonic.team_tree import get_sub_tree_ids
from simple_harmonic.tools.registry import ToolDefinition
from simple_harmonic.tools.types import ToolExecResult, ToolRunContext

ActionHistoryScope = Literal["agent", "team", "self"]


class ActionHistoryArgs(BaseModel):
    scope: ActionHistoryScope = Field(
        description=(
            "'self' = your own history, 'agent' = a specific agent by name, "
            "'team' = all agents in a team (and its sub-teams)."
        )
    )
    agent_name: str | None = Field(
        default=None, description="Agent name. Required when scope is 'agent'."
    )
    team_name: str | None = Field(
        default=None,
        description=(
            "Team name. Required when scope is 'team'. Defaults to your own team for 'self'."
        ),
    )
    limit: int | None = Field(
        default=None, description="Max entries to return. Default 20, max 50."
    )
    validation_only: bool | None = Field(
        default=None, description="If true, only return entries that have validation results."
    )


action_history_def = ToolDefinition(
    name="action_history",
    description=(
        "Query recent actions and validation results for an agent or team. "
        "Use 'self' to review your own history, 'agent' to check a specific agent, "
        "or 'team' to see all activity in a team and its sub-teams. "
        "Returns action types, summaries, and output contract validation (pass/fail "
        "with issues)."
    ),
    category="internal",
    risk="safe",
    schema=ActionHistoryArgs,
)


def _summarize(action_type: str, payload: dict[str, object]) -> str:
    if payload.get("summary"):
        return str(payload["summary"])[:120]
    if payload.get("conclusion"):
        return str(payload["conclusion"])[:120]
    if payload.get("message"):
        return str(payload["message"])[:120]
    if payload.get("tool") and payload.get("args") is not None:
        return f"{payload['tool']}({json.dumps(payload['args'])[:80]})"
    raw = json.dumps(payload)
    return raw[:117] + "..." if len(raw) > 120 else raw


async def action_history_impl(args: ActionHistoryArgs, ctx: ToolRunContext) -> ToolExecResult:
    try:
        limit = min(args.limit if args.limit is not None else 20, 50)

        if args.scope == "self":
            target_agent_ids = [ctx.agentId]
        elif args.scope == "agent":
            if not args.agent_name:
                return ToolExecResult(
                    toolName="action_history",
                    success=False,
                    result="scope 'agent' requires agent_name.",
                )
            agent = next(
                (a for a in await agents.all() if a.name == args.agent_name), None
            )
            if agent is None:
                return ToolExecResult(
                    toolName="action_history",
                    success=False,
                    result=f'Agent "{args.agent_name}" not found.',
                )
            target_agent_ids = [agent.id]
        else:
            # team scope: all agents in the team sub-tree
            team_id = ctx.teamId
            if args.team_name:
                team = next(
                    (t for t in await teams.all() if t.name == args.team_name), None
                )
                if team is None:
                    return ToolExecResult(
                        toolName="action_history",
                        success=False,
                        result=f'Team "{args.team_name}" not found.',
                    )
                team_id = team.id
            sub_tree_ids = await get_sub_tree_ids(team_id)
            team_agents = await agents.byTeams(sub_tree_ids)
            target_agent_ids = [a.id for a in team_agents]
            if not target_agent_ids:
                return ToolExecResult(
                    toolName="action_history",
                    success=True,
                    result="No agents found in this team.",
                )

        rows = await actionLog.byAgents(target_agent_ids, limit=limit * 2)

        # Resolve agent names.
        agent_rows = [
            a for a in await asyncio.gather(*(agents.byId(i) for i in target_agent_ids))
            if a is not None
        ]
        name_by_id = {a.id: a.name for a in agent_rows}

        entries: list[dict[str, object]] = []
        for r in rows:
            validation = r.payload.get("validation") if isinstance(r.payload, dict) else None
            entries.append(
                {
                    "agent": name_by_id.get(r.agentId, r.agentId),
                    "actionType": r.actionType,
                    "timestamp": r.executedAt.isoformat(),
                    "summary": _summarize(r.actionType, r.payload),
                    "validation": (
                        {
                            "valid": validation.get("valid", True),
                            "issues": validation.get("issues", []),
                        }
                        if isinstance(validation, dict)
                        else None
                    ),
                }
            )

        if args.validation_only:
            entries = [e for e in entries if e["validation"] is not None]

        entries = entries[:limit]

        if not entries:
            return ToolExecResult(
                toolName="action_history",
                success=True,
                result=(
                    "No entries with validation results found."
                    if args.validation_only
                    else "No action history found."
                ),
            )

        lines: list[str] = []
        for e in entries:
            ts = str(e["timestamp"])[11:19]
            line = f"[{ts}] {e['agent']} · {e['actionType']}: {e['summary']}"
            validation = e["validation"]
            if isinstance(validation, dict):
                if validation["valid"]:
                    line += " [PASS]"
                else:
                    issues = "; ".join(
                        f"{i.get('path')}: {i.get('message')}"
                        for i in validation["issues"]
                        if isinstance(i, dict)
                    )
                    line += f" [FAIL: {issues}]"
            lines.append(line)

        return ToolExecResult(
            toolName="action_history",
            success=True,
            result=f"{len(entries)} entries:\n" + "\n".join(lines),
        )
    except Exception as err:
        return ToolExecResult(
            toolName="action_history",
            success=False,
            result=f"action_history failed: {err}",
        )

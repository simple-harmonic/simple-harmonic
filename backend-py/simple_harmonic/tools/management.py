"""Management tools for lead agents and Harmon.

TS source: packages/backend/src/server/tools/management.ts

  set_team_goal: shorthand for setting a team's goal
  modify_team:   rename, set goal, pause/resume, or delete teams
  spawn_sub_team: create a sub-team with agents
  modify_agent:  update, delete, or move agents

All mutations are destructive (approval gated). Authorization is scoped to the
calling agent's team sub-tree via :func:`get_sub_tree_ids`.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Literal

from pydantic import BaseModel, Field

from simple_harmonic.store.repos import NewAgent, NewTeam, agents, teams
from simple_harmonic.team_tree import get_sub_tree_ids
from simple_harmonic.tools.registry import ToolDefinition
from simple_harmonic.tools.types import ToolExecResult, ToolResult, ToolRunContext

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


async def _assert_in_sub_tree(
    caller_team_id: str, target_team_id: str, target_label: str
) -> str | None:
    sub_tree = await get_sub_tree_ids(caller_team_id)
    if target_team_id not in sub_tree:
        return (
            f'"{target_label}" is outside your scope. You can only manage your team '
            "and its sub-teams."
        )
    return None


async def _resolve_team_id(team_name: str | None, fallback: str) -> tuple[str, str | None]:
    """Returns ``(team_id, error)``; ``error`` is set when the named team is missing."""
    if not team_name:
        return fallback, None
    team = next((t for t in await teams.all() if t.name == team_name), None)
    if team is None:
        return "", f'Team "{team_name}" not found.'
    return team.id, None


# ---------------------------------------------------------------------------
# set_team_goal
# ---------------------------------------------------------------------------


class SetTeamGoalArgs(BaseModel):
    team_name: str | None = Field(
        default=None, description="Team name. Defaults to your own team."
    )
    goal: str = Field(
        description="The team's objective. Clear, measurable, time-bound when possible."
    )


set_team_goal_def = ToolDefinition(
    name="set_team_goal",
    description=(
        "Set or update the goal for a team. The goal is injected into every agent's "
        "tick prompt so they work toward it. Scoped to your team and its sub-teams."
    ),
    category="internal",
    risk="destructive",
    schema=SetTeamGoalArgs,
)


async def set_team_goal_impl(args: SetTeamGoalArgs, ctx: ToolRunContext) -> ToolExecResult:
    try:
        team_id, error = await _resolve_team_id(args.team_name, ctx.teamId)
        if error:
            return ToolExecResult(toolName="set_team_goal", success=False, result=error)

        auth_err = await _assert_in_sub_tree(ctx.teamId, team_id, args.team_name or "target")
        if auth_err:
            return ToolExecResult(toolName="set_team_goal", success=False, result=auth_err)

        await teams.update(team_id, {"goal": args.goal})

        return ToolExecResult(
            toolName="set_team_goal",
            success=True,
            result=f'Goal set: "{args.goal}"',
            action=ToolResult(
                actionType="team_goal_set", payload={"teamId": team_id, "goal": args.goal}
            ),
        )
    except Exception as err:
        return ToolExecResult(
            toolName="set_team_goal", success=False, result=f"set_team_goal failed: {err}"
        )


# ---------------------------------------------------------------------------
# modify_team
# ---------------------------------------------------------------------------


class ModifyTeamUpdates(BaseModel):
    name: str | None = Field(default=None, description="Rename the team.")
    goal: str | None = Field(default=None, description="Set or update the team's goal.")
    paused: bool | None = Field(default=None, description="Pause or resume the team.")


class ModifyTeamArgs(BaseModel):
    team_name: str = Field(description="Name of the team to modify.")
    action: Literal["update", "delete"] = Field(
        description="'update' to change fields, 'delete' to dissolve the team and its agents."
    )
    updates: ModifyTeamUpdates | None = Field(
        default=None, description="Fields to update. Required for action 'update'."
    )


modify_team_def = ToolDefinition(
    name="modify_team",
    description=(
        "Update or delete a team. Update can rename, set goal, or pause/resume. "
        "Delete dissolves the team, its agents, and all sub-teams recursively. "
        "Scoped to your team's sub-tree."
    ),
    category="internal",
    risk="destructive",
    schema=ModifyTeamArgs,
)


async def modify_team_impl(args: ModifyTeamArgs, ctx: ToolRunContext) -> ToolExecResult:
    try:
        team_id, error = await _resolve_team_id(args.team_name, ctx.teamId)
        if error:
            return ToolExecResult(toolName="modify_team", success=False, result=error)

        auth_err = await _assert_in_sub_tree(ctx.teamId, team_id, args.team_name)
        if auth_err:
            return ToolExecResult(toolName="modify_team", success=False, result=auth_err)

        if args.action == "delete":
            if team_id == ctx.teamId:
                return ToolExecResult(
                    toolName="modify_team",
                    success=False,
                    result="Cannot delete your own team.",
                )
            # Deleting the team's folder removes the entire sub-tree: nested
            # sub-teams, every agent and its history, and the team's a2ax
            # messages. Count first for the report.
            sub_tree_ids = await get_sub_tree_ids(team_id)
            agents_deleted = len(await agents.byTeams(sub_tree_ids))
            await teams.delete(team_id)

            return ToolExecResult(
                toolName="modify_team",
                success=True,
                result=f'Team "{args.team_name}" and {agents_deleted} agent(s) deleted.',
                action=ToolResult(
                    actionType="team_deleted",
                    payload={
                        "teamId": team_id,
                        "teamName": args.team_name,
                        "agentsDeleted": agents_deleted,
                        "teamsDeleted": len(sub_tree_ids),
                    },
                ),
            )

        # Update
        if args.updates is None:
            return ToolExecResult(
                toolName="modify_team",
                success=False,
                result="action 'update' requires updates.",
            )

        patch: dict[str, object] = {}
        if args.updates.name is not None:
            patch["name"] = args.updates.name
        if args.updates.goal is not None:
            patch["goal"] = args.updates.goal
        if args.updates.paused is not None:
            patch["paused"] = args.updates.paused

        if not patch:
            return ToolExecResult(
                toolName="modify_team", success=False, result="No updates provided."
            )

        await teams.update(team_id, patch)

        return ToolExecResult(
            toolName="modify_team",
            success=True,
            result=f'Team "{args.team_name}" updated: {", ".join(patch.keys())}.',
            action=ToolResult(
                actionType="team_modified",
                payload={"teamId": team_id, "updates": list(patch.keys())},
            ),
        )
    except Exception as err:
        return ToolExecResult(
            toolName="modify_team", success=False, result=f"modify_team failed: {err}"
        )


# ---------------------------------------------------------------------------
# spawn_sub_team
# ---------------------------------------------------------------------------


class SpawnSubTeamAgent(BaseModel):
    name: str = Field(description="Kebab-case agent name")
    role: str = Field(description="One-line role description")
    archetype: str = Field(description="Agent archetype")
    tools: list[str] = Field(description="Tool names this agent can use")
    schedule_seconds: int = Field(description="How often this agent runs, in seconds")
    initial_prompt: str = Field(description="System prompt for this agent")


class SpawnSubTeamArgs(BaseModel):
    team_name: str = Field(description="Short, human-friendly name for the new sub-team.")
    agents: list[SpawnSubTeamAgent] = Field(
        description="Agents to create in the new sub-team"
    )


spawn_sub_team_def = ToolDefinition(
    name="spawn_sub_team",
    description=(
        "Create a new sub-team under your team with the specified agents. "
        "Use this to organize work into focused sub-groups."
    ),
    category="internal",
    risk="destructive",
    schema=SpawnSubTeamArgs,
)


async def spawn_sub_team_impl(args: SpawnSubTeamArgs, ctx: ToolRunContext) -> ToolExecResult:
    try:
        team = await teams.insert(NewTeam(name=args.team_name, parentTeamId=ctx.teamId))

        now = datetime.now(UTC)
        if args.agents:
            await agents.insertMany(
                team.id,
                [
                    NewAgent(
                        name=a.name,
                        role=a.role,
                        archetype=a.archetype,
                        tools=a.tools,
                        scheduleSeconds=a.schedule_seconds,
                        initialPrompt=a.initial_prompt,
                        nextRunAt=now
                        + timedelta(seconds=a.schedule_seconds, milliseconds=i * 2000),
                    )
                    for i, a in enumerate(args.agents)
                ],
            )

        return ToolExecResult(
            toolName="spawn_sub_team",
            success=True,
            result=f'Sub-team "{args.team_name}" created with {len(args.agents)} agent(s).',
            action=ToolResult(
                actionType="sub_team_spawned",
                payload={
                    "teamId": team.id,
                    "teamName": args.team_name,
                    "parentTeamId": ctx.teamId,
                    "agentCount": len(args.agents),
                },
            ),
        )
    except Exception as err:
        return ToolExecResult(
            toolName="spawn_sub_team", success=False, result=f"spawn_sub_team failed: {err}"
        )


# ---------------------------------------------------------------------------
# modify_agent (runner version, scoped to sub-tree)
# ---------------------------------------------------------------------------


class ModifyAgentUpdates(BaseModel):
    tools: list[str] | None = Field(
        default=None, description="Replace the agent's full tool list."
    )
    initial_prompt: str | None = Field(default=None, description="Replace the system prompt.")
    schedule_seconds: int | None = Field(default=None, description="Change the tick interval.")
    status: Literal["running", "paused"] | None = Field(
        default=None, description="Pause or resume."
    )
    role: str | None = Field(default=None, description="Update the role description.")
    output_contract: dict[str, object] | None = Field(
        default=None, description="JSON Schema defining expected output."
    )


class ModifyAgentArgs(BaseModel):
    agent_name: str = Field(description="Name of the agent to modify.")
    team_name: str | None = Field(
        default=None, description="Team the agent belongs to. Defaults to your own team."
    )
    action: Literal["update", "delete", "move"] | None = Field(
        default=None,
        description=(
            "'update' (default) to change fields, 'delete' to remove the agent, "
            "'move' to reassign to a different team."
        ),
    )
    move_to_team: str | None = Field(
        default=None, description="Team name to move the agent to. Required when action is 'move'."
    )
    updates: ModifyAgentUpdates | None = Field(
        default=None, description="Fields to update. Required for action 'update'."
    )


modify_agent_def = ToolDefinition(
    name="modify_agent",
    description=(
        "Update, delete, or move an agent. Update changes tools, prompt, schedule, status, "
        "role, or output contract. Delete removes the agent and its history. Move reassigns "
        "the agent to a different team. Scoped to your team's sub-tree. "
        "Self-prompt modification always requires human approval."
    ),
    category="internal",
    risk="destructive",
    schema=ModifyAgentArgs,
)


async def modify_agent_impl(args: ModifyAgentArgs, ctx: ToolRunContext) -> ToolExecResult:
    try:
        action_type = args.action or "update"

        target_team_id, error = await _resolve_team_id(args.team_name, ctx.teamId)
        if error:
            return ToolExecResult(toolName="modify_agent", success=False, result=error)

        auth_err = await _assert_in_sub_tree(
            ctx.teamId, target_team_id, args.team_name or "your team"
        )
        if auth_err:
            return ToolExecResult(toolName="modify_agent", success=False, result=auth_err)

        agent = next(
            (a for a in await agents.byTeam(target_team_id) if a.name == args.agent_name),
            None,
        )
        if agent is None:
            return ToolExecResult(
                toolName="modify_agent",
                success=False,
                result=f'Agent "{args.agent_name}" not found in "{args.team_name or "your team"}".',
            )

        # --- Self-deletion guard (always blocked) ---
        if agent.id == ctx.agentId and action_type == "delete":
            return ToolExecResult(
                toolName="modify_agent", success=False, result="Cannot delete yourself."
            )

        # --- Delete ---
        if action_type == "delete":
            await agents.delete(agent.id)
            return ToolExecResult(
                toolName="modify_agent",
                success=True,
                result=f'Agent "{args.agent_name}" deleted.',
                action=ToolResult(
                    actionType="agent_deleted",
                    payload={"agentId": agent.id, "agentName": args.agent_name},
                ),
            )

        # --- Move ---
        if action_type == "move":
            if not args.move_to_team:
                return ToolExecResult(
                    toolName="modify_agent",
                    success=False,
                    result="action 'move' requires move_to_team.",
                )
            dest_team = next(
                (t for t in await teams.all() if t.name == args.move_to_team), None
            )
            if dest_team is None:
                return ToolExecResult(
                    toolName="modify_agent",
                    success=False,
                    result=f'Destination team "{args.move_to_team}" not found.',
                )
            dest_auth_err = await _assert_in_sub_tree(
                ctx.teamId, dest_team.id, args.move_to_team
            )
            if dest_auth_err:
                return ToolExecResult(
                    toolName="modify_agent", success=False, result=dest_auth_err
                )

            await agents.move(agent.id, dest_team.id)

            return ToolExecResult(
                toolName="modify_agent",
                success=True,
                result=f'Agent "{args.agent_name}" moved to "{args.move_to_team}".',
                action=ToolResult(
                    actionType="agent_moved",
                    payload={
                        "agentId": agent.id,
                        "agentName": args.agent_name,
                        "fromTeam": target_team_id,
                        "toTeam": dest_team.id,
                    },
                ),
            )

        # --- Update ---
        if args.updates is None:
            return ToolExecResult(
                toolName="modify_agent", success=False, result="No updates provided."
            )

        patch: dict[str, object] = {}
        u = args.updates
        if u.tools is not None:
            patch["tools"] = u.tools
        if u.initial_prompt is not None:
            patch["initialPrompt"] = u.initial_prompt
        if u.schedule_seconds is not None:
            patch["scheduleSeconds"] = u.schedule_seconds
        if u.status is not None:
            patch["status"] = u.status
        if u.role is not None:
            patch["role"] = u.role
        if u.output_contract is not None:
            patch["outputContract"] = u.output_contract

        if not patch:
            return ToolExecResult(
                toolName="modify_agent", success=False, result="No updates provided."
            )

        await agents.update(agent.id, patch)

        return ToolExecResult(
            toolName="modify_agent",
            success=True,
            result=f"Updated {args.agent_name}: {', '.join(patch.keys())}.",
            action=ToolResult(
                actionType="agent_modified",
                payload={
                    "agentId": agent.id,
                    "agentName": args.agent_name,
                    "updates": list(patch.keys()),
                },
            ),
        )
    except Exception as err:
        return ToolExecResult(
            toolName="modify_agent", success=False, result=f"modify_agent failed: {err}"
        )

// ---------------------------------------------------------------------------
// Management tools for lead agents and Harmon.
//
// spawn_sub_team: create a sub-team with agents
// modify_agent: update, delete, or move agents
// modify_team: rename, set goal, pause/resume, or delete teams
// set_team_goal: shorthand for setting a team's goal
//
// All mutations are destructive (approval gated). Authorization: scoped
// to the calling agent's team sub-tree.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolDefinition, ToolImpl } from "../../lib/meta-agent/registry";
import { agents, teams } from "../store";
import type { Agent, Team } from "../store";
import { getSubTreeIds } from "../team-tree";

// ---------------------------------------------------------------------------
// Shared auth helper
// ---------------------------------------------------------------------------

async function assertInSubTree(
  callerTeamId: string,
  targetTeamId: string,
  targetLabel: string,
): Promise<string | null> {
  const subTree = await getSubTreeIds(callerTeamId);
  if (!subTree.has(targetTeamId)) {
    return `"${targetLabel}" is outside your scope. You can only manage your team and its sub-teams.`;
  }
  return null;
}

async function resolveTeamId(
  teamName: string | undefined,
  fallback: string,
): Promise<{ teamId: string; error?: string }> {
  if (!teamName) return { teamId: fallback };
  const team = (await teams.all()).find((t) => t.name === teamName);
  if (!team) return { teamId: "", error: `Team "${teamName}" not found.` };
  return { teamId: team.id };
}

// ---------------------------------------------------------------------------
// set_team_goal
// ---------------------------------------------------------------------------

const setTeamGoalSchema = z.object({
  team_name: z.string().optional().describe("Team name. Defaults to your own team."),
  goal: z.string().describe("The team's objective. Clear, measurable, time-bound when possible."),
});

export const setTeamGoalDef: ToolDefinition<typeof setTeamGoalSchema> = {
  name: "set_team_goal",
  description:
    "Set or update the goal for a team. The goal is injected into every agent's tick prompt " +
    "so they work toward it. Scoped to your team and its sub-teams.",
  category: "internal",
  risk: "destructive",
  schema: setTeamGoalSchema,
};

export const setTeamGoalImpl: ToolImpl<typeof setTeamGoalSchema> = async (args, ctx) => {
  try {
    const { teamId, error } = await resolveTeamId(args.team_name, ctx.teamId);
    if (error) return { toolName: "set_team_goal", success: false, result: error };

    const authErr = await assertInSubTree(ctx.teamId, teamId, args.team_name || "target");
    if (authErr) return { toolName: "set_team_goal", success: false, result: authErr };

    await teams.update(teamId, { goal: args.goal });

    return {
      toolName: "set_team_goal",
      success: true,
      result: `Goal set: "${args.goal}"`,
      action: { actionType: "team_goal_set", payload: { teamId, goal: args.goal } },
    };
  } catch (err) {
    return { toolName: "set_team_goal", success: false, result: `set_team_goal failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// ---------------------------------------------------------------------------
// modify_team
// ---------------------------------------------------------------------------

const modifyTeamSchema = z.object({
  team_name: z.string().describe("Name of the team to modify."),
  action: z
    .enum(["update", "delete"])
    .describe("'update' to change fields, 'delete' to dissolve the team and its agents."),
  updates: z.object({
    name: z.string().optional().describe("Rename the team."),
    goal: z.string().optional().describe("Set or update the team's goal."),
    paused: z.boolean().optional().describe("Pause or resume the team."),
  }).optional().describe("Fields to update. Required for action 'update'."),
});

export const modifyTeamDef: ToolDefinition<typeof modifyTeamSchema> = {
  name: "modify_team",
  description:
    "Update or delete a team. Update can rename, set goal, or pause/resume. " +
    "Delete dissolves the team, its agents, and all sub-teams recursively. " +
    "Scoped to your team's sub-tree.",
  category: "internal",
  risk: "destructive",
  schema: modifyTeamSchema,
};

export const modifyTeamImpl: ToolImpl<typeof modifyTeamSchema> = async (args, ctx) => {
  try {
    const { teamId, error } = await resolveTeamId(args.team_name, ctx.teamId);
    if (error) return { toolName: "modify_team", success: false, result: error };

    const authErr = await assertInSubTree(ctx.teamId, teamId, args.team_name);
    if (authErr) return { toolName: "modify_team", success: false, result: authErr };

    if (args.action === "delete") {
      // Can't delete your own team
      if (teamId === ctx.teamId) {
        return { toolName: "modify_team", success: false, result: "Cannot delete your own team." };
      }

      // Deleting the team's folder removes the entire sub-tree in one rmdir:
      // nested sub-teams, every agent and its approvals/actions/trace, and the
      // team's a2ax messages all live under it. Count first for the report.
      const subTreeIds = await getSubTreeIds(teamId);
      const agentsDeleted = (await agents.byTeams(subTreeIds)).length;
      await teams.delete(teamId);

      return {
        toolName: "modify_team",
        success: true,
        result: `Team "${args.team_name}" and ${agentsDeleted} agent(s) deleted.`,
        action: {
          actionType: "team_deleted",
          payload: {
            teamId,
            teamName: args.team_name,
            agentsDeleted,
            teamsDeleted: subTreeIds.size,
          },
        },
      };
    }

    // Update
    if (!args.updates) {
      return { toolName: "modify_team", success: false, result: "action 'update' requires updates." };
    }

    const set: Record<string, unknown> = {};
    if (args.updates.name !== undefined) set.name = args.updates.name;
    if (args.updates.goal !== undefined) set.goal = args.updates.goal;
    if (args.updates.paused !== undefined) set.paused = args.updates.paused;

    if (Object.keys(set).length === 0) {
      return { toolName: "modify_team", success: false, result: "No updates provided." };
    }

    await teams.update(teamId, set as Partial<Team>);

    return {
      toolName: "modify_team",
      success: true,
      result: `Team "${args.team_name}" updated: ${Object.keys(set).join(", ")}.`,
      action: {
        actionType: "team_modified",
        payload: { teamId, updates: Object.keys(set) },
      },
    };
  } catch (err) {
    return { toolName: "modify_team", success: false, result: `modify_team failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// ---------------------------------------------------------------------------
// spawn_sub_team
// ---------------------------------------------------------------------------

const spawnSubTeamSchema = z.object({
  team_name: z.string().describe("Short, human-friendly name for the new sub-team."),
  agents: z.array(
    z.object({
      name: z.string().describe("Kebab-case agent name"),
      role: z.string().describe("One-line role description"),
      archetype: z.string().describe("Agent archetype"),
      tools: z.array(z.string()).describe("Tool names this agent can use"),
      schedule_seconds: z.number().describe("How often this agent runs, in seconds"),
      initial_prompt: z.string().describe("System prompt for this agent"),
    }),
  ).describe("Agents to create in the new sub-team"),
});

export const spawnSubTeamDef: ToolDefinition<typeof spawnSubTeamSchema> = {
  name: "spawn_sub_team",
  description:
    "Create a new sub-team under your team with the specified agents. " +
    "Use this to organize work into focused sub-groups.",
  category: "internal",
  risk: "destructive",
  schema: spawnSubTeamSchema,
};

export const spawnSubTeamImpl: ToolImpl<typeof spawnSubTeamSchema> = async (args, ctx) => {
  try {
    const team = await teams.insert({ name: args.team_name, parentTeamId: ctx.teamId });

    const now = new Date();
    if (args.agents.length > 0) {
      await agents.insertMany(
        team.id,
        args.agents.map((a, i) => ({
          name: a.name,
          role: a.role,
          archetype: a.archetype,
          tools: a.tools,
          scheduleSeconds: a.schedule_seconds,
          initialPrompt: a.initial_prompt,
          nextRunAt: new Date(now.getTime() + a.schedule_seconds * 1000 + i * 2000),
        })),
      );
    }

    return {
      toolName: "spawn_sub_team",
      success: true,
      result: `Sub-team "${args.team_name}" created with ${args.agents.length} agent(s).`,
      action: {
        actionType: "sub_team_spawned",
        payload: { teamId: team.id, teamName: args.team_name, parentTeamId: ctx.teamId, agentCount: args.agents.length },
      },
    };
  } catch (err) {
    return { toolName: "spawn_sub_team", success: false, result: `spawn_sub_team failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// ---------------------------------------------------------------------------
// modify_agent (runner version, scoped to sub-tree)
// ---------------------------------------------------------------------------

const modifyAgentSchema = z.object({
  agent_name: z.string().describe("Name of the agent to modify."),
  team_name: z.string().optional().describe("Team the agent belongs to. Defaults to your own team."),
  action: z
    .enum(["update", "delete", "move"])
    .optional()
    .describe("'update' (default) to change fields, 'delete' to remove the agent, 'move' to reassign to a different team."),
  move_to_team: z.string().optional().describe("Team name to move the agent to. Required when action is 'move'."),
  updates: z.object({
    tools: z.array(z.string()).optional().describe("Replace the agent's full tool list."),
    initial_prompt: z.string().optional().describe("Replace the system prompt."),
    schedule_seconds: z.number().optional().describe("Change the tick interval."),
    status: z.enum(["running", "paused"]).optional().describe("Pause or resume."),
    role: z.string().optional().describe("Update the role description."),
    output_contract: z.record(z.string(), z.unknown()).optional().describe(
      "JSON Schema defining expected output.",
    ),
  }).optional().describe("Fields to update. Required for action 'update'."),
});

export const modifyAgentDef: ToolDefinition<typeof modifyAgentSchema> = {
  name: "modify_agent",
  description:
    "Update, delete, or move an agent. Update changes tools, prompt, schedule, status, role, " +
    "or output contract. Delete removes the agent and its history. Move reassigns the agent " +
    "to a different team. Scoped to your team's sub-tree. " +
    "Self-prompt modification always requires human approval.",
  category: "internal",
  risk: "destructive",
  schema: modifyAgentSchema,
};

export const modifyAgentImpl: ToolImpl<typeof modifyAgentSchema> = async (args, ctx) => {
  try {
    const actionType = args.action || "update";

    // Resolve target team
    const { teamId: targetTeamId, error } = await resolveTeamId(args.team_name, ctx.teamId);
    if (error) return { toolName: "modify_agent", success: false, result: error };

    const authErr = await assertInSubTree(ctx.teamId, targetTeamId, args.team_name || "your team");
    if (authErr) return { toolName: "modify_agent", success: false, result: authErr };

    // Find the agent
    const agent = (await agents.byTeam(targetTeamId)).find((a) => a.name === args.agent_name);
    if (!agent) {
      return { toolName: "modify_agent", success: false, result: `Agent "${args.agent_name}" not found in "${args.team_name || "your team"}".` };
    }

    // --- Self-deletion guard (always blocked) ---
    if (agent.id === ctx.agentId && actionType === "delete") {
      return { toolName: "modify_agent", success: false, result: "Cannot delete yourself." };
    }

    // --- Delete ---
    if (actionType === "delete") {
      // rmdir the agent folder: agent.json + its approvals/actions/trace.
      await agents.delete(agent.id);

      return {
        toolName: "modify_agent",
        success: true,
        result: `Agent "${args.agent_name}" deleted.`,
        action: { actionType: "agent_deleted", payload: { agentId: agent.id, agentName: args.agent_name } },
      };
    }

    // --- Move ---
    if (actionType === "move") {
      if (!args.move_to_team) {
        return { toolName: "modify_agent", success: false, result: "action 'move' requires move_to_team." };
      }
      const destTeam = (await teams.all()).find((t) => t.name === args.move_to_team);
      if (!destTeam) {
        return { toolName: "modify_agent", success: false, result: `Destination team "${args.move_to_team}" not found.` };
      }
      const destAuthErr = await assertInSubTree(ctx.teamId, destTeam.id, args.move_to_team);
      if (destAuthErr) return { toolName: "modify_agent", success: false, result: destAuthErr };

      await agents.move(agent.id, destTeam.id);

      return {
        toolName: "modify_agent",
        success: true,
        result: `Agent "${args.agent_name}" moved to "${args.move_to_team}".`,
        action: { actionType: "agent_moved", payload: { agentId: agent.id, agentName: args.agent_name, fromTeam: targetTeamId, toTeam: destTeam.id } },
      };
    }

    // --- Update ---
    if (!args.updates) {
      return { toolName: "modify_agent", success: false, result: "No updates provided." };
    }

    const set: Record<string, unknown> = {};
    const u = args.updates;
    if (u.tools !== undefined) set.tools = u.tools;
    if (u.initial_prompt !== undefined) set.initialPrompt = u.initial_prompt;
    if (u.schedule_seconds !== undefined) set.scheduleSeconds = u.schedule_seconds;
    if (u.status !== undefined) set.status = u.status;
    if (u.role !== undefined) set.role = u.role;
    if (u.output_contract !== undefined) set.outputContract = u.output_contract;

    if (Object.keys(set).length === 0) {
      return { toolName: "modify_agent", success: false, result: "No updates provided." };
    }

    await agents.update(agent.id, set as Partial<Agent>);

    return {
      toolName: "modify_agent",
      success: true,
      result: `Updated ${args.agent_name}: ${Object.keys(set).join(", ")}.`,
      action: { actionType: "agent_modified", payload: { agentId: agent.id, agentName: args.agent_name, updates: Object.keys(set) } },
    };
  } catch (err) {
    return { toolName: "modify_agent", success: false, result: `modify_agent failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

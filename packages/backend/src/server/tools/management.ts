// ---------------------------------------------------------------------------
// Management tools: spawn_sub_team, modify_agent (for lead agents).
//
// These are the same operations Harmon uses via the planner, but registered
// in the runner's tool registry so any agent with management tools can use
// them on ticks. Authorization: scoped to the agent's team sub-tree.
//
// An agent becomes a "lead" by having these tools in its tools array.
// Remove the tools to demote it. No special role type needed.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { ToolDefinition, ToolImpl } from "../../lib/meta-agent/registry";
import { db } from "../db";
import { agents, teams, chatSessions } from "../db/schema";
import { getSubTreeIds } from "../team-tree";

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
    const d = db();

    const [team] = await d
      .insert(teams)
      .values({
        name: args.team_name,
        parentTeamId: ctx.teamId,
      })
      .returning();

    await d.insert(chatSessions).values({ teamId: team.id });

    const now = new Date();
    if (args.agents.length > 0) {
      await d.insert(agents).values(
        args.agents.map((a, i) => ({
          teamId: team.id,
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
      result: `Sub-team "${args.team_name}" created with ${args.agents.length} agent(s) under your team.`,
      action: {
        actionType: "sub_team_spawned",
        payload: {
          teamId: team.id,
          teamName: args.team_name,
          parentTeamId: ctx.teamId,
          agentCount: args.agents.length,
          agentNames: args.agents.map((a) => a.name),
        },
      },
    };
  } catch (err) {
    return {
      toolName: "spawn_sub_team",
      success: false,
      result: `spawn_sub_team failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ---------------------------------------------------------------------------
// modify_agent (runner version, scoped to sub-tree)
// ---------------------------------------------------------------------------

const modifyAgentSchema = z.object({
  agent_name: z.string().describe("Name of the agent to modify."),
  team_name: z.string().optional().describe("Team the agent belongs to. Defaults to your own team."),
  updates: z.object({
    tools: z.array(z.string()).optional().describe("Replace the agent's full tool list."),
    initial_prompt: z.string().optional().describe("Replace the system prompt."),
    schedule_seconds: z.number().optional().describe("Change the tick interval."),
    status: z.enum(["running", "paused"]).optional().describe("Pause or resume."),
    role: z.string().optional().describe("Update the role description."),
    output_contract: z.record(z.string(), z.unknown()).optional().describe(
      "JSON Schema defining expected output. The agent's payload is validated against this each tick.",
    ),
  }).describe("Fields to update."),
});

export const modifyAgentDef: ToolDefinition<typeof modifyAgentSchema> = {
  name: "modify_agent",
  description:
    "Modify an agent's tools, prompt, schedule, status, or role. " +
    "Scoped to agents in your team and its sub-teams.",
  category: "internal",
  risk: "destructive",
  schema: modifyAgentSchema,
};

export const modifyAgentImpl: ToolImpl<typeof modifyAgentSchema> = async (args, ctx) => {
  try {
    const d = db();

    // Resolve which team the target agent is in
    let targetTeamId = ctx.teamId;
    if (args.team_name) {
      const targetTeam = await d.query.teams.findFirst({
        where: eq(teams.name, args.team_name),
      });
      if (!targetTeam) {
        return {
          toolName: "modify_agent",
          success: false,
          result: `Team "${args.team_name}" not found.`,
        };
      }
      targetTeamId = targetTeam.id;
    }

    // Authorization: target must be in the caller's sub-tree
    const subTree = await getSubTreeIds(ctx.teamId);
    if (!subTree.has(targetTeamId)) {
      return {
        toolName: "modify_agent",
        success: false,
        result: `You can only modify agents in your team or sub-teams. "${args.team_name || "target"}" is outside your scope.`,
      };
    }

    // Find the agent
    const agent = await d.query.agents.findFirst({
      where: and(eq(agents.teamId, targetTeamId), eq(agents.name, args.agent_name)),
    });
    if (!agent) {
      return {
        toolName: "modify_agent",
        success: false,
        result: `Agent "${args.agent_name}" not found in team "${args.team_name || "your team"}".`,
      };
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
      return {
        toolName: "modify_agent",
        success: false,
        result: "No updates provided.",
      };
    }

    await d.update(agents).set(set).where(eq(agents.id, agent.id));

    const changes = Object.keys(set).join(", ");
    return {
      toolName: "modify_agent",
      success: true,
      result: `Updated ${args.agent_name}: ${changes}.`,
      action: {
        actionType: "agent_modified",
        payload: {
          agentId: agent.id,
          agentName: args.agent_name,
          updates: Object.keys(set),
        },
      },
    };
  } catch (err) {
    return {
      toolName: "modify_agent",
      success: false,
      result: `modify_agent failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

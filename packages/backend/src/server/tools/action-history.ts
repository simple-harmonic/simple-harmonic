// ---------------------------------------------------------------------------
// action_history tool: query the action log for agents and teams.
//
// Lets any agent (especially leads and Harmon) review what other agents
// have done, including validation pass/fail results. This is the read
// side of the self-improving loop: agents observe outcomes, then use
// modify_agent to adjust prompts/tools/contracts.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { eq, desc, and, inArray } from "drizzle-orm";
import type { ToolDefinition, ToolImpl } from "../../lib/meta-agent/registry";
import { db } from "../db";
import { actionLog, agents, teams } from "../db/schema";
import { getSubTreeIds } from "../team-tree";

const actionHistorySchema = z.object({
  scope: z
    .enum(["agent", "team", "self"])
    .describe(
      "'self' = your own history, 'agent' = a specific agent by name, " +
        "'team' = all agents in a team (and its sub-teams).",
    ),
  agent_name: z
    .string()
    .optional()
    .describe("Agent name. Required when scope is 'agent'."),
  team_name: z
    .string()
    .optional()
    .describe("Team name. Required when scope is 'team'. Defaults to your own team for 'self'."),
  limit: z
    .number()
    .optional()
    .describe("Max entries to return. Default 20, max 50."),
  validation_only: z
    .boolean()
    .optional()
    .describe("If true, only return entries that have validation results."),
});

export const actionHistoryDef: ToolDefinition<typeof actionHistorySchema> = {
  name: "action_history",
  description:
    "Query recent actions and validation results for an agent or team. " +
    "Use 'self' to review your own history, 'agent' to check a specific agent, " +
    "or 'team' to see all activity in a team and its sub-teams. " +
    "Returns action types, summaries, and output contract validation (pass/fail with issues).",
  category: "internal",
  risk: "safe",
  schema: actionHistorySchema,
};

export const actionHistoryImpl: ToolImpl<typeof actionHistorySchema> = async (args, ctx) => {
  try {
    const d = db();
    const limit = Math.min(args.limit ?? 20, 50);

    let targetAgentIds: string[];

    if (args.scope === "self") {
      targetAgentIds = [ctx.agentId];
    } else if (args.scope === "agent") {
      if (!args.agent_name) {
        return {
          toolName: "action_history",
          success: false,
          result: "scope 'agent' requires agent_name.",
        };
      }
      const agent = await d.query.agents.findFirst({
        where: eq(agents.name, args.agent_name),
      });
      if (!agent) {
        return {
          toolName: "action_history",
          success: false,
          result: `Agent "${args.agent_name}" not found.`,
        };
      }
      targetAgentIds = [agent.id];
    } else {
      // team scope: all agents in the team sub-tree
      let teamId = ctx.teamId;
      if (args.team_name) {
        const team = await d.query.teams.findFirst({
          where: eq(teams.name, args.team_name),
        });
        if (!team) {
          return {
            toolName: "action_history",
            success: false,
            result: `Team "${args.team_name}" not found.`,
          };
        }
        teamId = team.id;
      }
      const subTreeIds = await getSubTreeIds(teamId);
      const teamAgents = await d.query.agents.findMany({
        where: inArray(agents.teamId, [...subTreeIds]),
      });
      targetAgentIds = teamAgents.map((a) => a.id);
      if (targetAgentIds.length === 0) {
        return {
          toolName: "action_history",
          success: true,
          result: "No agents found in this team.",
        };
      }
    }

    const rows = await d.query.actionLog.findMany({
      where: inArray(actionLog.agentId, targetAgentIds),
      orderBy: [desc(actionLog.executedAt)],
      limit: limit * 2,
    });

    // Resolve agent names
    const agentRows = await d.query.agents.findMany({
      where: inArray(agents.id, targetAgentIds),
    });
    const nameById = new Map(agentRows.map((a) => [a.id, a.name]));

    let entries = rows.map((r) => {
      const validation = r.payload?.validation as
        | { valid?: boolean; issues?: Array<{ path: string; message: string }> }
        | undefined;
      return {
        agent: nameById.get(r.agentId) ?? r.agentId,
        actionType: r.actionType,
        timestamp: r.executedAt.toISOString(),
        summary: summarize(r.actionType, r.payload),
        validation: validation
          ? {
              valid: validation.valid ?? true,
              issues: validation.issues ?? [],
            }
          : null,
      };
    });

    if (args.validation_only) {
      entries = entries.filter((e) => e.validation !== null);
    }

    entries = entries.slice(0, limit);

    if (entries.length === 0) {
      return {
        toolName: "action_history",
        success: true,
        result: args.validation_only
          ? "No entries with validation results found."
          : "No action history found.",
      };
    }

    const lines = entries.map((e) => {
      const ts = e.timestamp.slice(11, 19);
      let line = `[${ts}] ${e.agent} · ${e.actionType}: ${e.summary}`;
      if (e.validation) {
        if (e.validation.valid) {
          line += " [PASS]";
        } else {
          const issues = e.validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
          line += ` [FAIL: ${issues}]`;
        }
      }
      return line;
    });

    return {
      toolName: "action_history",
      success: true,
      result: `${entries.length} entries:\n${lines.join("\n")}`,
    };
  } catch (err) {
    return {
      toolName: "action_history",
      success: false,
      result: `action_history failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

function summarize(actionType: string, payload: Record<string, unknown>): string {
  if (payload.summary) return String(payload.summary).slice(0, 120);
  if (payload.conclusion) return String(payload.conclusion).slice(0, 120);
  if (payload.message) return String(payload.message).slice(0, 120);
  if (payload.tool && payload.args) {
    return `${payload.tool}(${JSON.stringify(payload.args).slice(0, 80)})`;
  }
  const json = JSON.stringify(payload);
  return json.length > 120 ? json.slice(0, 117) + "..." : json;
}

import OpenAI from "openai";
import { and, eq, lte } from "drizzle-orm";
import { NextResponse } from "next/server";
import { approveAgentTick, runAgent } from "@/lib/meta-agent";
import type { LLMClient } from "@/lib/meta-agent/runner";
import type { PeerAgent } from "@/lib/meta-agent/tools";
import { getA2AX } from "@/server/a2ax";
import { getApiKeySource, getConfig } from "@/server/config";
import { getCodexAccessToken } from "@/server/codex-auth";
import { db } from "@/server/db";
import { actionLog, agents, teams } from "@/server/db/schema";

const HIBERNATE_THRESHOLD_MS = 5 * 60 * 1000;

function getLLMClient(): LLMClient {
  const cfg = getConfig();
  const source = getApiKeySource();

  if (source === "codex") {
    // Codex path: use OpenAI SDK pointed at chatgpt.com
    return new OpenAI({
      apiKey: getCodexAccessToken() || "",
      baseURL: "https://chatgpt.com/backend-api/codex",
      timeout: 30000,
    }) as unknown as LLMClient;
  }

  return new OpenAI({
    apiKey: cfg.openaiApiKey || undefined,
    baseURL: cfg.openaiBaseUrl || undefined,
    timeout: 30000,
  }) as unknown as LLMClient;
}

export async function POST() {
  const d = db();
  const now = new Date();
  const hibernateThreshold = new Date(now.getTime() - HIBERNATE_THRESHOLD_MS);

  const activeTeams = await d.query.teams.findMany({
    where: and(eq(teams.paused, false), lte(teams.lastUserActiveAt, now)),
  });

  let totalRan = 0;
  const a2ax = getA2AX();
  const llm = getLLMClient();

  for (const team of activeTeams) {
    if (team.lastUserActiveAt < hibernateThreshold) continue;

    // Get all agents in team for peer context
    const allAgents = await d.query.agents.findMany({
      where: eq(agents.teamId, team.id),
    });

    // Use the central approval gate to decide which agents run. This is the
    // seam where per-action approval (v0.1) will also plug in. Today the gate
    // enforces: team not paused, agent running, not in-flight, due.
    const dueAgents = allAgents.filter((a) => {
      const decision = approveAgentTick(team, a, now);
      return decision.allowed;
    });

    for (const agent of dueAgents) {
      await d.update(agents).set({ inFlight: true }).where(eq(agents.id, agent.id));

      // Build peer list (all agents except self)
      const peers: PeerAgent[] = allAgents
        .filter((a) => a.id !== agent.id)
        .map((a) => ({ id: a.id, name: a.name, role: a.role }));

      try {
        // Fetch a2ax context (direct, broadcast, group, task messages)
        const ctx = await a2ax.getAgentContext(team.id, agent.id);

        const result = await runAgent({
          name: agent.name,
          archetype: agent.archetype,
          tools: agent.tools as string[],
          initialPrompt: agent.initialPrompt,
          a2axContext: ctx.formatted || undefined,
          teamId: team.id,
          agentId: agent.id,
          peers,
          a2ax,
          llm,
        });

        // Mark consumed messages as read
        await a2ax.markContextRead(ctx.messageIds);

        await d.insert(actionLog).values({
          agentId: agent.id,
          actionType: result.actionType,
          payload: result.payload,
        });

        await d
          .update(agents)
          .set({
            inFlight: false,
            nextRunAt: new Date(now.getTime() + agent.scheduleSeconds * 1000),
          })
          .where(eq(agents.id, agent.id));

        totalRan++;
      } catch {
        await d
          .update(agents)
          .set({ inFlight: false, status: "errored" })
          .where(eq(agents.id, agent.id));
      }
    }

    await d
      .update(teams)
      .set({ tickCount: team.tickCount + 1 })
      .where(eq(teams.id, team.id));
  }

  return NextResponse.json({ ok: true, agentsRan: totalRan, timestamp: now.toISOString() });
}

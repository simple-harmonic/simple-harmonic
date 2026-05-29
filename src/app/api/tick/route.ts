import OpenAI from "openai";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { approveAgentTick, runAgent } from "@simple-harmonic/backend/lib/meta-agent";
import { createAnthropicClient } from "@simple-harmonic/backend/lib/meta-agent/anthropic-adapter";
import { createCodexClient } from "@simple-harmonic/backend/lib/meta-agent/codex-adapter";
import type { LLMClient } from "@simple-harmonic/backend/lib/meta-agent/runner";
import type { PeerAgent } from "@simple-harmonic/backend/lib/meta-agent/tools";
import { getA2AX } from "@simple-harmonic/backend/server/a2ax";
import { getApiKeySource, getConfig } from "@simple-harmonic/backend/server/config";
import { db } from "@simple-harmonic/backend/server/db";
import { actionLog, agents, teams } from "@simple-harmonic/backend/server/db/schema";

// Skip ticks for teams with no recent user activity to control costs.
const HIBERNATE_THRESHOLD_MS = 5 * 60 * 1000;

export async function POST() {
  const d = db();
  const now = new Date();
  const allActive = await d.query.teams.findMany({
    where: eq(teams.paused, false),
  });

  // Filter out hibernated teams: no user heartbeat in the last 5 minutes.
  const activeTeams = allActive.filter((t) => {
    if (!t.lastUserActiveAt) return false;
    return now.getTime() - new Date(t.lastUserActiveAt).getTime() < HIBERNATE_THRESHOLD_MS;
  });

  let totalRan = 0;
  const a2ax = getA2AX();
  const cfg = getConfig();

  // LLM client resolution: Codex CLI > Anthropic > OpenAI
  const apiKeySource = getApiKeySource();
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  let llm: LLMClient;
  let modelOverride: string | undefined;

  if (apiKeySource === "codex") {
    // Use Codex CLI subprocess (ChatGPT subscription via codex exec)
    llm = createCodexClient({ model: cfg.model || "gpt-5.5" });
    modelOverride = cfg.model || "gpt-5.5";
  } else if (anthropicKey) {
    llm = createAnthropicClient({ apiKey: anthropicKey, timeout: 120_000 });
    modelOverride = "claude-sonnet-4-20250514";
  } else {
    llm = new OpenAI({
      apiKey: cfg.openaiApiKey || undefined,
      baseURL: cfg.openaiBaseUrl || undefined,
      timeout: 120_000,
    }) as unknown as LLMClient;
    modelOverride = cfg.model;
  }

  for (const team of activeTeams) {

    // Get all agents in team for peer context
    const allAgents = await d.query.agents.findMany({
      where: eq(agents.teamId, team.id),
    });

    // Auto-recover errored agents: reset to running so they retry on next tick.
    // v0.0 has no destructive tools, so retrying is always safe.
    for (const a of allAgents) {
      if (a.status === "errored") {
        await d.update(agents).set({ status: "running", inFlight: false }).where(eq(agents.id, a.id));
        a.status = "running";
        a.inFlight = false;
      }
    }

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
          model: modelOverride,
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
      } catch (err) {
        console.error(`[tick] Agent ${agent.name} failed:`, err instanceof Error ? err.message : err);
        // Advance nextRunAt even on failure so auto-recover doesn't create
        // a tight retry loop (agent would otherwise re-run every tick).
        await d
          .update(agents)
          .set({
            inFlight: false,
            status: "errored",
            nextRunAt: new Date(now.getTime() + agent.scheduleSeconds * 1000),
          })
          .where(eq(agents.id, agent.id));
      }
    }

    await d
      .update(teams)
      .set({ tickCount: sql`${teams.tickCount} + 1` })
      .where(eq(teams.id, team.id));
  }

  return NextResponse.json({ ok: true, agentsRan: totalRan, timestamp: now.toISOString() });
}

// Vercel cron sends GET requests
export async function GET() {
  return POST();
}

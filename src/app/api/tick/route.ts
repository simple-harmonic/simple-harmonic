import OpenAI from "openai";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { approveAgentTick, runAgent } from "@simple-harmonic/backend/lib/meta-agent";
import type {
  AgentSuspension,
  LLMClient,
  ToolDecision,
} from "@simple-harmonic/backend/lib/meta-agent/runner";
import { createAnthropicClient } from "@simple-harmonic/backend/lib/meta-agent/anthropic-adapter";
import { createCodexClient } from "@simple-harmonic/backend/lib/meta-agent/codex-adapter";
import type { PeerAgent } from "@simple-harmonic/backend/lib/meta-agent/tools";
import { createAppRegistry } from "@simple-harmonic/backend/server/tools";
import { getA2AX } from "@simple-harmonic/backend/server/a2ax";
import { getApiKeySource, getConfig } from "@simple-harmonic/backend/server/config";
import { db } from "@simple-harmonic/backend/server/db";
import {
  actionLog,
  agents,
  pendingApprovals,
  teams,
} from "@simple-harmonic/backend/server/db/schema";

// Skip ticks for teams with no recent user activity to control costs.
const HIBERNATE_THRESHOLD_MS = 5 * 60 * 1000;

// The tool registry decides which tools are destructive (need approval). One
// instance is fine — registration is stateless and the impls read per-call ctx.
const registry = createAppRegistry();

type AgentRow = typeof agents.$inferSelect;

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
    for (const a of allAgents) {
      if (a.status === "errored") {
        await d.update(agents).set({ status: "running", inFlight: false }).where(eq(agents.id, a.id));
        a.status = "running";
        a.inFlight = false;
      }
    }

    // --- Resume pass: agents parked awaiting approval --------------------------
    // An agent in "awaiting_approval" does not run a fresh tick; it resumes
    // once ALL of its pending approvals have been resolved (approved/rejected).
    for (const agent of allAgents) {
      if (agent.status !== "awaiting_approval") continue;
      const resumed = await tryResumeAgent({
        d,
        team,
        agent,
        allAgents,
        a2ax,
        llm,
        modelOverride,
        now,
      });
      if (resumed) totalRan++;
    }

    // --- Fresh pass: due agents ----------------------------------------------
    // approveAgentTick now also blocks "awaiting_approval", so parked agents
    // never enter this pass.
    const dueAgents = allAgents.filter((a) => approveAgentTick(team, a, now).allowed);

    for (const agent of dueAgents) {
      await d.update(agents).set({ inFlight: true }).where(eq(agents.id, agent.id));

      const peers = buildPeers(allAgents, agent.id);

      try {
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
          isDestructive: registry.isDestructive,
        });

        await a2ax.markContextRead(ctx.messageIds);
        await handleRunResult({ d, agent, result, now });
        totalRan++;
      } catch (err) {
        console.error(`[tick] Agent ${agent.name} failed:`, err instanceof Error ? err.message : err);
        // Advance nextRunAt even on failure so auto-recover doesn't create a
        // tight retry loop. Clear any parked conversation state.
        await d
          .update(agents)
          .set({
            inFlight: false,
            status: "errored",
            conversationState: null,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPeers(allAgents: AgentRow[], selfId: string): PeerAgent[] {
  return allAgents
    .filter((a) => a.id !== selfId)
    .map((a) => ({ id: a.id, name: a.name, role: a.role }));
}

/**
 * Resume an agent parked awaiting approval, IF all its pending approvals are
 * resolved. Returns true if the agent actually resumed (ran), false if it is
 * still waiting on at least one decision.
 */
async function tryResumeAgent(args: {
  d: ReturnType<typeof db>;
  team: typeof teams.$inferSelect;
  agent: AgentRow;
  allAgents: AgentRow[];
  a2ax: ReturnType<typeof getA2AX>;
  llm: LLMClient;
  modelOverride: string | undefined;
  now: Date;
}): Promise<boolean> {
  const { d, team, agent, allAgents, a2ax, llm, modelOverride, now } = args;

  const rows = await d.query.pendingApprovals.findMany({
    where: eq(pendingApprovals.agentId, agent.id),
  });
  // Only consider the still-open batch (pending rows block resume).
  const stillPending = rows.filter((r) => r.status === "pending");
  if (stillPending.length > 0) return false;

  const suspension = agent.conversationState as AgentSuspension | null;
  if (!suspension) {
    // Defensive: parked with no state. Clear the flag and let it tick fresh.
    await d
      .update(agents)
      .set({ status: "running", inFlight: false, conversationState: null })
      .where(eq(agents.id, agent.id));
    return false;
  }

  const decisions: ToolDecision[] = rows.map((r) => ({
    id: r.toolCallId,
    approved: r.status === "approved",
    note: r.decisionNote ?? undefined,
  }));

  await d.update(agents).set({ inFlight: true }).where(eq(agents.id, agent.id));

  try {
    const result = await runAgent({
      name: agent.name,
      archetype: agent.archetype,
      tools: agent.tools as string[],
      initialPrompt: agent.initialPrompt,
      teamId: team.id,
      agentId: agent.id,
      peers: buildPeers(allAgents, agent.id),
      a2ax,
      llm,
      model: modelOverride,
      isDestructive: registry.isDestructive,
      resume: { suspension, decisions },
    });

    // Consume the resolved approvals so they don't block a future suspension.
    await d.delete(pendingApprovals).where(eq(pendingApprovals.agentId, agent.id));
    await handleRunResult({ d, agent, result, now });
    return true;
  } catch (err) {
    console.error(`[tick] Resume of ${agent.name} failed:`, err instanceof Error ? err.message : err);
    await d.delete(pendingApprovals).where(eq(pendingApprovals.agentId, agent.id));
    await d
      .update(agents)
      .set({
        inFlight: false,
        status: "errored",
        conversationState: null,
        nextRunAt: new Date(now.getTime() + agent.scheduleSeconds * 1000),
      })
      .where(eq(agents.id, agent.id));
    return false;
  }
}

/**
 * Apply a runAgent result to the DB. If the run suspended, park the agent
 * (status awaiting_approval, conversation state saved, pending_approvals rows
 * created) WITHOUT advancing nextRunAt. Otherwise log the action and return the
 * agent to running.
 */
async function handleRunResult(args: {
  d: ReturnType<typeof db>;
  agent: AgentRow;
  result: Awaited<ReturnType<typeof runAgent>>;
  now: Date;
}): Promise<void> {
  const { d, agent, result, now } = args;

  if (result.suspension) {
    const s = result.suspension;
    await d
      .update(agents)
      .set({
        inFlight: false,
        status: "awaiting_approval",
        conversationState: s as unknown as Record<string, unknown>,
      })
      .where(eq(agents.id, agent.id));

    if (s.pending.length > 0) {
      await d.insert(pendingApprovals).values(
        s.pending.map((p) => ({
          teamId: agent.teamId,
          agentId: agent.id,
          toolCallId: p.id,
          toolName: p.name,
          toolArguments: p.arguments,
        })),
      );
    }

    // Log the suspension so it shows in the narration feed.
    await d.insert(actionLog).values({
      agentId: agent.id,
      actionType: "awaiting_approval",
      payload: result.payload,
    });
    return;
  }

  await d.insert(actionLog).values({
    agentId: agent.id,
    actionType: result.actionType,
    payload: result.payload,
  });

  await d
    .update(agents)
    .set({
      inFlight: false,
      status: "running",
      conversationState: null,
      nextRunAt: new Date(now.getTime() + agent.scheduleSeconds * 1000),
    })
    .where(eq(agents.id, agent.id));
}

// Vercel cron sends GET requests
export async function GET() {
  return POST();
}

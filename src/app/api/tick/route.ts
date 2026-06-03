import { approveAgentTick, runAgent } from "@simple-harmonic/backend/lib/meta-agent";
import { createAnthropicClient } from "@simple-harmonic/backend/lib/meta-agent/anthropic-adapter";
import { createCodexClient } from "@simple-harmonic/backend/lib/meta-agent/codex-adapter";
import type {
  AgentSuspension,
  LLMClient,
  ToolDecision,
} from "@simple-harmonic/backend/lib/meta-agent/runner";
import type { PeerAgent } from "@simple-harmonic/backend/lib/meta-agent/tools";
import { getA2AX } from "@simple-harmonic/backend/server/a2ax";
import { getApiKeySource, getConfig } from "@simple-harmonic/backend/server/config";
import { db } from "@simple-harmonic/backend/server/db";
import {
  actionLog,
  agents,
  pendingApprovals,
  teams,
} from "@simple-harmonic/backend/server/db/schema";
import { createAppRegistryWithCustomTools } from "@simple-harmonic/backend/server/tools";
import { and, desc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import OpenAI from "openai";

// Skip ticks for teams with no recent user activity to control costs.
const HIBERNATE_THRESHOLD_MS = 5 * 60 * 1000;

// Reset agents stuck in-flight from a previous crash, once per process.
let didResetInFlight = false;

// Per-agent wall-clock budget for a single tick (T5/D14). A hung LLM call or a
// slow tool can't pin an agent inFlight forever or stall the tick response. On
// timeout the agent is errored and rescheduled like any other failure. Override
// with SH_AGENT_TIMEOUT_MS. Default 120s matches the LLM client timeout.
function agentTimeoutMs(): number {
  const v = Number.parseInt(process.env.SH_AGENT_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 120_000;
}

// Registry rebuilt per-team tick with custom tools from .simple-harmonic/skills/.

// How many recent actions to feed back as working memory per tick.
const HISTORY_LIMIT = 10;

const VALIDATION_HISTORY_LIMIT = 5;

async function fetchRecentValidations(d: ReturnType<typeof db>, agentId: string): Promise<string | undefined> {
  const rows = await d.query.actionLog.findMany({
    where: eq(actionLog.agentId, agentId),
    orderBy: [desc(actionLog.executedAt)],
    limit: VALIDATION_HISTORY_LIMIT * 2,
  });

  const validations: string[] = [];
  for (const r of rows.reverse()) {
    const v = r.payload?.validation as { valid?: boolean; issues?: Array<{ path: string; message: string }> } | undefined;
    if (v === undefined) continue;
    if (v.valid) {
      validations.push(`[${r.executedAt.toISOString().slice(11, 19)}] PASS`);
    } else {
      const issueStr = (v.issues || []).map((i) => `${i.path}: ${i.message}`).join("; ");
      validations.push(`[${r.executedAt.toISOString().slice(11, 19)}] FAIL: ${issueStr}`);
    }
    if (validations.length >= VALIDATION_HISTORY_LIMIT) break;
  }

  return validations.length > 0 ? validations.join("\n") : undefined;
}

async function fetchRecentHistory(d: ReturnType<typeof db>, agentId: string): Promise<string | undefined> {
  const rows = await d.query.actionLog.findMany({
    where: eq(actionLog.agentId, agentId),
    orderBy: [desc(actionLog.executedAt)],
    limit: HISTORY_LIMIT,
  });
  if (rows.length === 0) return undefined;
  const lines = rows.reverse().map((r) => {
    const ts = r.executedAt.toISOString().slice(11, 19);
    const summary = summarizePayload(r.actionType, r.payload);
    return `[${ts}] ${r.actionType}: ${summary}`;
  });
  return lines.join("\n");
}

function summarizePayload(actionType: string, payload: Record<string, unknown>): string {
  if (actionType === "awaiting_approval") {
    const tool = payload.toolName ?? payload.tool ?? "unknown";
    return `requested approval for ${tool}`;
  }
  if (payload.tool && payload.args) {
    const args = typeof payload.args === "object" ? JSON.stringify(payload.args) : String(payload.args);
    const truncated = args.length > 120 ? args.slice(0, 117) + "..." : args;
    return `${payload.tool}(${truncated})`;
  }
  if (payload.summary) return String(payload.summary).slice(0, 150);
  if (payload.message) return String(payload.message).slice(0, 150);
  const json = JSON.stringify(payload);
  return json.length > 150 ? json.slice(0, 147) + "..." : json;
}

type AgentRow = typeof agents.$inferSelect;

export async function POST() {
  const d = db();
  const now = new Date();

  if (!didResetInFlight) {
    didResetInFlight = true;
    try {
      await d
        .update(agents)
        .set({ inFlight: false })
        .where(eq(agents.inFlight, true));
    } catch {
      didResetInFlight = false;
    }
  }

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

  const timeoutMs = agentTimeoutMs();

  for (const team of activeTeams) {
    const registry = createAppRegistryWithCustomTools();

    // Get all agents in team for peer context
    const allAgents = await d.query.agents.findMany({
      where: eq(agents.teamId, team.id),
    });

    // Auto-recover errored agents: reset to running so they retry on next tick.
    for (const a of allAgents) {
      if (a.status === "errored") {
        await d
          .update(agents)
          .set({ status: "running", inFlight: false })
          .where(eq(agents.id, a.id));
        a.status = "running";
        a.inFlight = false;
      }
    }

    // Agents in a team run CONCURRENTLY within each pass (T5/D20). They are
    // distinct DB rows and each has its own a2ax context, so they don't
    // contend; the team-level tickCount increment happens once after both
    // passes. Each agent run is independently time-bounded, so one slow agent
    // can't delay the others. Passes stay sequential: a resuming agent must
    // settle before the fresh pass (it's excluded from dueAgents anyway).

    // --- Resume pass: agents parked awaiting approval -------------------------
    const parked = allAgents.filter((a) => a.status === "awaiting_approval");
    const resumeOutcomes = await Promise.allSettled(
      parked.map((agent) =>
        tryResumeAgent({ d, team, agent, allAgents, a2ax, llm, modelOverride, now, timeoutMs, registry }),
      ),
    );
    totalRan += countRan(resumeOutcomes);

    // --- Fresh pass: due agents ----------------------------------------------
    // approveAgentTick blocks "awaiting_approval", so parked agents never enter.
    const dueAgents = allAgents.filter((a) => approveAgentTick(team, a, now).allowed);
    const freshOutcomes = await Promise.allSettled(
      dueAgents.map((agent) =>
        runFreshAgent({ d, team, agent, allAgents, a2ax, llm, modelOverride, now, timeoutMs, registry }),
      ),
    );
    totalRan += countRan(freshOutcomes);

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

/** Count how many parallel agent runs reported they actually ran. */
function countRan(outcomes: PromiseSettledResult<boolean>[]): number {
  let n = 0;
  for (const o of outcomes) {
    if (o.status === "fulfilled" && o.value) n++;
  }
  return n;
}

class AgentTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} exceeded the ${ms}ms tick budget`);
    this.name = "AgentTimeoutError";
  }
}

/**
 * Race a run against a wall-clock budget. On timeout, aborts the run's signal
 * so provider adapters that support cancellation stop doing work, then rejects
 * with AgentTimeoutError. The timer is always cleared so a resolved race
 * doesn't keep the event loop alive.
 */
function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const timeoutError = new AgentTimeoutError(label, ms);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort(timeoutError);
      reject(timeoutError);
    }, ms);
    run(controller.signal).then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

interface RunArgs {
  d: ReturnType<typeof db>;
  team: typeof teams.$inferSelect;
  agent: AgentRow;
  allAgents: AgentRow[];
  a2ax: ReturnType<typeof getA2AX>;
  llm: LLMClient;
  modelOverride: string | undefined;
  now: Date;
  timeoutMs: number;
  registry: ReturnType<typeof createAppRegistry>;
}

/**
 * Run a fresh tick for a due agent, time-bounded. Returns true if it ran (even
 * if it then suspended), false only on failure/timeout. Failures (including
 * timeout) error the agent and advance nextRunAt so the tick can't tight-loop.
 */
async function runFreshAgent(args: RunArgs): Promise<boolean> {
  const { d, team, agent, allAgents, a2ax, llm, modelOverride, now, timeoutMs, registry } = args;

  const claimed = await claimAgent(d, agent, "running");
  if (!claimed) return false;

  try {
    const contract = agent.outputContract as Record<string, unknown> | null;
    const [ctx, recentHistory, recentValidations] = await Promise.all([
      a2ax.getAgentContext(team.id, agent.id),
      fetchRecentHistory(d, agent.id),
      contract ? fetchRecentValidations(d, agent.id) : Promise.resolve(undefined),
    ]);

    const result = await withTimeout(
      (signal) =>
        runAgent({
          name: agent.name,
          archetype: agent.archetype,
          tools: agent.tools as string[],
          initialPrompt: agent.initialPrompt,
          a2axContext: ctx.formatted || undefined,
          recentHistory,
          outputContract: contract ?? undefined,
          recentValidations,
          teamId: team.id,
          agentId: agent.id,
          peers: buildPeers(allAgents, agent.id),
          a2ax,
          llm,
          model: modelOverride,
          signal,
          toolRegistry: registry,
          isDestructive: registry.isDestructive,
        }),
      timeoutMs,
      `agent ${agent.name}`,
    );

    await a2ax.markContextRead(ctx.messageIds);
    await handleRunResult({ d, agent, result, now });
    return true;
  } catch (err) {
    await failAgent({ d, agent, now, err, phase: "tick" });
    return false;
  }
}

/**
 * Resume an agent parked awaiting approval, IF all its pending approvals are
 * resolved. Returns true if the agent actually resumed (ran), false if it is
 * still waiting on at least one decision (or failed). Time-bounded.
 */
async function tryResumeAgent(args: RunArgs): Promise<boolean> {
  const { d, team, agent, allAgents, a2ax, llm, modelOverride, now, timeoutMs, registry } = args;

  const suspension = agent.conversationState as AgentSuspension | null;
  if (!suspension) {
    // Defensive: parked with no state. Clear both sides of the parked state so
    // stale approval cards cannot linger or contaminate a later suspension.
    await d.delete(pendingApprovals).where(eq(pendingApprovals.agentId, agent.id));
    await d
      .update(agents)
      .set({ status: "running", inFlight: false, conversationState: null })
      .where(eq(agents.id, agent.id));
    return false;
  }

  const rows = await d.query.pendingApprovals.findMany({
    where: eq(pendingApprovals.agentId, agent.id),
  });
  const expectedIds = new Set(suspension.pending.map((p) => p.id));
  const decisionRows = rows.filter((r) => expectedIds.has(r.toolCallId));

  // Missing approval rows means the parking write was incomplete. Hold rather
  // than implicitly treating the missing human decision as a rejection.
  if (decisionRows.length < suspension.pending.length) return false;
  const stillPending = decisionRows.filter((r) => r.status === "pending");
  if (stillPending.length > 0) return false;

  const rowByToolCallId = new Map(decisionRows.map((r) => [r.toolCallId, r]));
  const decisions: ToolDecision[] = suspension.pending.map((p) => {
    const r = rowByToolCallId.get(p.id);
    return {
      id: p.id,
      approved: r?.status === "approved",
      note: r?.decisionNote ?? undefined,
    };
  });

  const claimed = await claimAgent(d, agent, "awaiting_approval");
  if (!claimed) return false;

  try {
    const recentHistory = await fetchRecentHistory(d, agent.id);
    const result = await withTimeout(
      (signal) =>
        runAgent({
          name: agent.name,
          archetype: agent.archetype,
          tools: agent.tools as string[],
          initialPrompt: agent.initialPrompt,
          recentHistory,
          teamId: team.id,
          agentId: agent.id,
          peers: buildPeers(allAgents, agent.id),
          a2ax,
          llm,
          model: modelOverride,
          signal,
          toolRegistry: registry,
          isDestructive: registry.isDestructive,
          resume: { suspension, decisions },
        }),
      timeoutMs,
      `agent ${agent.name} (resume)`,
    );

    // Consume the resolved approvals so they don't block a future suspension.
    await d.delete(pendingApprovals).where(eq(pendingApprovals.agentId, agent.id));
    await handleRunResult({ d, agent, result, now });
    return true;
  } catch (err) {
    await d.delete(pendingApprovals).where(eq(pendingApprovals.agentId, agent.id));
    await failAgent({ d, agent, now, err, phase: "resume" });
    return false;
  }
}

async function claimAgent(
  d: ReturnType<typeof db>,
  agent: AgentRow,
  status: AgentRow["status"],
): Promise<boolean> {
  const claimed = await d
    .update(agents)
    .set({ inFlight: true })
    .where(and(eq(agents.id, agent.id), eq(agents.inFlight, false), eq(agents.status, status)))
    .returning({ id: agents.id });
  return claimed.length > 0;
}

/** Common failure handling: log, error the agent, advance nextRunAt, clear state. */
async function failAgent(args: {
  d: ReturnType<typeof db>;
  agent: AgentRow;
  now: Date;
  err: unknown;
  phase: "tick" | "resume";
}): Promise<void> {
  const { d, agent, now, err, phase } = args;
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[tick] ${phase} of ${agent.name} failed:`, msg);
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
    await d.transaction(async (tx) => {
      await tx
        .update(agents)
        .set({
          inFlight: false,
          status: "awaiting_approval",
          conversationState: s as unknown as Record<string, unknown>,
        })
        .where(eq(agents.id, agent.id));

      if (s.pending.length > 0) {
        await tx.insert(pendingApprovals).values(
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
      await tx.insert(actionLog).values({
        agentId: agent.id,
        actionType: "awaiting_approval",
        payload: result.payload,
      });
    });
    return;
  }

  const payload = result.validation
    ? { ...result.payload, validation: { valid: result.validation.valid, issues: result.validation.issues } }
    : result.payload;

  await d.insert(actionLog).values({
    agentId: agent.id,
    actionType: result.actionType,
    payload,
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

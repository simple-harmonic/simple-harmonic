import { approveAgentTick, runAgent } from "../../lib/meta-agent";
import {
  type CodexThreadSuspension,
  isCodexThreadSuspension,
  runCodexAgentTick,
} from "../../lib/meta-agent/codex-harness";
import type {
  AgentSuspension,
  LLMClient,
  PendingToolCall,
  ToolDecision,
} from "../../lib/meta-agent/runner";
import type { PeerAgent } from "../../lib/meta-agent/tools";
import { getA2AX } from "../a2ax";
import {
  emitAppEvent,
  formatEventsForPrompt,
  formatPlatformStatusForPrompt,
  getPlatformStatus,
  queryAppEvents,
} from "../app-events";
import { getApiKeySource } from "../config";
import { actionLog, agents, approvals, teams } from "../store";
import type { Agent, Team } from "../store";
import { resolveLLM } from "../llm";
import { isCronAuthorized } from "../operator-auth";
import {
  checkSpendAllowed,
  makeCountingLLM,
  recordSpend,
} from "../spend";
import { createAppRegistryWithCustomTools } from "../tools";
import {
  createTraceSink,
  type PersistentTraceSink,
  pruneTraceEvents,
} from "../trace";

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

async function fetchRecentValidations(agentId: string): Promise<string | undefined> {
  const rows = await actionLog.recentByAgent(agentId, VALIDATION_HISTORY_LIMIT * 2);

  const validations: string[] = [];
  for (const r of rows.reverse()) {
    const v = r.payload?.validation as
      | { valid?: boolean; issues?: Array<{ path: string; message: string }> }
      | undefined;
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

async function fetchRecentHistory(agentId: string): Promise<string | undefined> {
  const rows = await actionLog.recentByAgent(agentId, HISTORY_LIMIT);
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
    const args =
      typeof payload.args === "object" ? JSON.stringify(payload.args) : String(payload.args);
    const truncated = args.length > 120 ? `${args.slice(0, 117)}...` : args;
    return `${payload.tool}(${truncated})`;
  }
  if (payload.summary) return String(payload.summary).slice(0, 150);
  if (payload.message) return String(payload.message).slice(0, 150);
  const json = JSON.stringify(payload);
  return json.length > 150 ? `${json.slice(0, 147)}...` : json;
}

type AgentRow = Agent;

export async function POST(req: Request) {
  if (!isCronAuthorized(req, process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();

  // Retention sweep for play-by-play traces; internally throttled to hourly.
  void pruneTraceEvents();

  if (!didResetInFlight) {
    didResetInFlight = true;
    try {
      await agents.resetAllInFlight();
    } catch {
      didResetInFlight = false;
    }
  }

  const allActive = await teams.listUnpaused();

  // Filter out hibernated teams: no user heartbeat in the last 5 minutes.
  const activeTeams = allActive.filter((t) => {
    if (!t.lastUserActiveAt) return false;
    return now.getTime() - new Date(t.lastUserActiveAt).getTime() < HIBERNATE_THRESHOLD_MS;
  });

  let totalRan = 0;
  const a2ax = getA2AX();

  // LLM cascade: Codex CLI > Anthropic > OpenRouter > OpenAI (server/llm.ts).
  // Each completion call walks the configured providers in order; a provider
  // error falls through to the next step and logs a warning app event.
  const apiKeySource = getApiKeySource();
  const { llm, model: modelOverride } = resolveLLM({
    onFallback: ({ provider, model, error, next }) => {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      emitAppEvent({
        severity: "warning",
        source: "tick",
        message: next
          ? `LLM ${provider}/${model} failed (${reason}); falling back to ${next.provider}/${next.model}`
          : `LLM ${provider}/${model} failed (${reason}); cascade exhausted`,
      });
    },
  });

  // Engine mode (codex app-server harness): codex owns the agent loop and
  // calls SH tools back over RPC. Default for the codex provider; set
  // SH_CODEX_RUNTIME=exec to fall back to the legacy per-round exec adapter.
  // The exec-adapter cascade step is still constructed either way: it serves
  // legacy (message-based) suspensions parked before a deploy.
  const useCodexHarness = apiKeySource === "codex" && process.env.SH_CODEX_RUNTIME !== "exec";

  const timeoutMs = agentTimeoutMs();

  // Daily spend cap: bail before any LLM work if today's recorded spend is at
  // or over the ceiling. Fails OPEN on a ledger read error (see spend.ts) so a
  // missing ledger / IO hiccup can't silently halt every team's agents.
  const spend = await checkSpendAllowed(now);
  if (spend.unknown) {
    emitAppEvent({
      severity: "warning",
      source: "tick",
      message: "Spend ledger unreadable; proceeding without the cap this tick",
    });
  } else if (!spend.allowed) {
    emitAppEvent({
      severity: "error",
      source: "tick",
      message: `Daily spend cap reached: ${spend.spentCents}c >= ${spend.capCents}c; skipping tick`,
    });
    return Response.json({
      ok: true,
      agentsRan: 0,
      skipped: "spend_cap",
      spentCents: spend.spentCents,
      capCents: spend.capCents,
      timestamp: now.toISOString(),
    });
  }

  for (const team of activeTeams) {
    const registry = createAppRegistryWithCustomTools();

    // Get all agents in team for peer context
    const allAgents = await agents.byTeam(team.id);

    // Auto-recover errored agents: reset to running so they retry on next tick.
    for (const a of allAgents) {
      if (a.status === "errored") {
        await agents.update(a.id, { status: "running", inFlight: false });
        a.status = "running";
        a.inFlight = false;
      }
    }

    // Agents in a team run CONCURRENTLY within each pass (T5/D20). They are
    // distinct rows and each has its own a2ax context, so they don't contend;
    // the team-level tickCount increment happens once after both passes. Each
    // agent run is independently time-bounded, so one slow agent can't delay the
    // others. Passes stay sequential: a resuming agent must settle before the
    // fresh pass (it's excluded from dueAgents anyway).

    // --- Resume pass: agents parked awaiting approval -------------------------
    const parked = allAgents.filter((a) => a.status === "awaiting_approval");
    const resumeOutcomes = await Promise.allSettled(
      parked.map((agent) =>
        tryResumeAgent({
          team,
          agent,
          allAgents,
          a2ax,
          llm,
          modelOverride,
          now,
          timeoutMs,
          registry,
          useCodexHarness,
        }),
      ),
    );
    totalRan += countRan(resumeOutcomes);

    // --- Fresh pass: due agents ----------------------------------------------
    // approveAgentTick blocks "awaiting_approval", so parked agents never enter.
    const dueAgents = allAgents.filter((a) => approveAgentTick(team, a, now).allowed);
    const freshOutcomes = await Promise.allSettled(
      dueAgents.map((agent) =>
        runFreshAgent({
          team,
          agent,
          allAgents,
          a2ax,
          llm,
          modelOverride,
          now,
          timeoutMs,
          registry,
          useCodexHarness,
        }),
      ),
    );
    totalRan += countRan(freshOutcomes);

    await teams.incrementTickCount(team.id);
  }

  return Response.json({ ok: true, agentsRan: totalRan, timestamp: now.toISOString() });
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
  team: Team;
  agent: AgentRow;
  allAgents: AgentRow[];
  a2ax: ReturnType<typeof getA2AX>;
  llm: LLMClient;
  modelOverride: string | undefined;
  now: Date;
  timeoutMs: number;
  registry: ReturnType<typeof createAppRegistryWithCustomTools>;
  /** Engine mode: run via the codex app-server harness instead of the runner. */
  useCodexHarness: boolean;
}

/** Structural result both runAgent and runCodexAgentTick satisfy; all the
 *  route needs for parking, logging, and validation. The suspension is
 *  persisted opaquely (whole object), so only `pending` is typed here. */
interface RunOutcome {
  actionType: string;
  payload: Record<string, unknown>;
  suspension?: { pending: PendingToolCall[] };
  validation?: { valid: boolean; issues: Array<{ path: string; message: string }> };
}

/**
 * Run a fresh tick for a due agent, time-bounded. Returns true if it ran (even
 * if it then suspended), false only on failure/timeout. Failures (including
 * timeout) error the agent and advance nextRunAt so the tick can't tight-loop.
 */
async function runFreshAgent(args: RunArgs): Promise<boolean> {
  const { team, agent, allAgents, a2ax, llm, modelOverride, now, timeoutMs, registry } = args;

  const claimed = await agents.claim(agent.id, "running");
  if (!claimed) return false;

  const trace = createTraceSink({ teamId: team.id, agentId: agent.id });
  try {
    const contract = agent.outputContract as Record<string, unknown> | null;
    const [ctx, recentHistory, recentValidations, recentEvents, platformSt] = await Promise.all([
      a2ax.getAgentContext(team.id, agent.id),
      fetchRecentHistory(agent.id),
      contract ? fetchRecentValidations(agent.id) : Promise.resolve(undefined),
      queryAppEvents({
        teamId: team.id,
        since: new Date(now.getTime() - 3600000),
        limit: 10,
        includeInfra: false,
      }),
      getPlatformStatus(),
    ]);

    // Combine health context: events + platform status (origin/main)
    const healthParts = [
      formatEventsForPrompt(recentEvents),
      formatPlatformStatusForPrompt(platformSt),
    ].filter(Boolean);
    const appHealthContext = healthParts.length > 0 ? healthParts.join("\n\n") : undefined;

    const shared = {
      name: agent.name,
      archetype: agent.archetype,
      tools: agent.tools as string[],
      initialPrompt: agent.initialPrompt,
      a2axContext: ctx.formatted || undefined,
      recentHistory,
      teamGoal: team.goal ?? undefined,
      outputContract: contract ?? undefined,
      recentValidations,
      appHealthContext,
      teamId: team.id,
      agentId: agent.id,
      peers: buildPeers(allAgents, agent.id),
      a2ax,
      model: modelOverride,
      toolRegistry: registry,
      isDestructive: registry.isDestructive,
      trace: trace.emit,
    };

    let result: RunOutcome;
    let usage: { model: string; inputTokens: number; outputTokens: number };

    if (args.useCodexHarness) {
      const r = await withTimeout(
        (signal) => runCodexAgentTick({ ...shared, signal }),
        timeoutMs,
        `agent ${agent.name}`,
      );
      result = r;
      usage = { model: modelOverride ?? "gpt-5.5", ...r.usage };
    } else {
      const counting = makeCountingLLM(llm, modelOverride ?? "unknown");
      result = await withTimeout(
        (signal) => runAgent({ ...shared, llm: counting.llm, signal }),
        timeoutMs,
        `agent ${agent.name}`,
      );
      usage = counting.usage;
    }

    await a2ax.markContextRead(agent.id, ctx.messageIds);
    await handleRunResult({ agent, result, now, traceTickId: trace.tickId });
    await recordSpend(now, {
      teamId: team.id,
      agentId: agent.id,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    return true;
  } catch (err) {
    await failAgent({ agent, now, err, phase: "tick", a2ax, teamId: team.id, trace });
    return false;
  } finally {
    await trace.flush();
  }
}

/**
 * Resume an agent parked awaiting approval, IF all its pending approvals are
 * resolved. Returns true if the agent actually resumed (ran), false if it is
 * still waiting on at least one decision (or failed). Time-bounded.
 */
async function tryResumeAgent(args: RunArgs): Promise<boolean> {
  const { team, agent, allAgents, a2ax, llm, modelOverride, now, timeoutMs, registry } = args;

  // Either shape may be parked here: a legacy message-based runner suspension
  // or an engine-mode codex-thread suspension. Both carry `pending`.
  const suspension = agent.conversationState as
    | AgentSuspension
    | (CodexThreadSuspension & Record<string, unknown>)
    | null;
  if (!suspension) {
    // Defensive: parked with no state. Clear both sides of the parked state so
    // stale approval cards cannot linger or contaminate a later suspension.
    await approvals.clearForAgent(agent.id);
    await agents.update(agent.id, {
      status: "running",
      inFlight: false,
      conversationState: null,
    });
    return false;
  }

  const rows = await approvals.byAgent(agent.id);
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

  const claimed = await agents.claim(agent.id, "awaiting_approval");
  if (!claimed) return false;

  // Continue the original tick's play-by-play thread: handleRunResult parked
  // the trace tickId alongside the suspension when the agent paused.
  const trace = createTraceSink({
    teamId: team.id,
    agentId: agent.id,
    tickId: extractTraceTickId(agent.conversationState),
  });
  try {
    const recentHistory = await fetchRecentHistory(agent.id);

    const shared = {
      name: agent.name,
      archetype: agent.archetype,
      tools: agent.tools as string[],
      initialPrompt: agent.initialPrompt,
      recentHistory,
      teamId: team.id,
      agentId: agent.id,
      peers: buildPeers(allAgents, agent.id),
      a2ax,
      model: modelOverride,
      toolRegistry: registry,
      isDestructive: registry.isDestructive,
      trace: trace.emit,
    };

    let result: RunOutcome;
    let usage: { model: string; inputTokens: number; outputTokens: number };

    if (isCodexThreadSuspension(suspension)) {
      // Engine-mode park: resume the codex thread and feed the decisions in.
      const r = await withTimeout(
        (signal) => runCodexAgentTick({ ...shared, signal, resume: { suspension, decisions } }),
        timeoutMs,
        `agent ${agent.name} (resume)`,
      );
      result = r;
      usage = { model: modelOverride ?? "gpt-5.5", ...r.usage };
    } else {
      // Legacy message-based park (pre-harness, or SH_CODEX_RUNTIME=exec).
      const counting = makeCountingLLM(llm, modelOverride ?? "unknown");
      result = await withTimeout(
        (signal) =>
          runAgent({
            ...shared,
            llm: counting.llm,
            signal,
            resume: { suspension: suspension as AgentSuspension, decisions },
          }),
        timeoutMs,
        `agent ${agent.name} (resume)`,
      );
      usage = counting.usage;
    }

    // Consume the resolved approvals so they don't block a future suspension.
    await approvals.clearForAgent(agent.id);
    await handleRunResult({ agent, result, now, traceTickId: trace.tickId });
    await recordSpend(now, {
      teamId: team.id,
      agentId: agent.id,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    return true;
  } catch (err) {
    await approvals.clearForAgent(agent.id);
    await failAgent({ agent, now, err, phase: "resume", a2ax, teamId: team.id, trace });
    return false;
  } finally {
    await trace.flush();
  }
}

/** Pull the trace tickId persisted alongside a parked suspension, if any.
 *  Returns undefined (→ fresh tickId) for pre-trace suspensions or bad data. */
function extractTraceTickId(conversationState: unknown): string | undefined {
  const id = (conversationState as { traceTickId?: unknown } | null)?.traceTickId;
  return typeof id === "string" && UUID_RE.test(id) ? id : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Common failure handling: log, error the agent, advance nextRunAt, clear state.
 *  Double-writes: persists to app_events AND broadcasts via a2ax so peers
 *  see the failure immediately on their next tick. */
async function failAgent(args: {
  agent: AgentRow;
  now: Date;
  err: unknown;
  phase: "tick" | "resume";
  a2ax: ReturnType<typeof getA2AX>;
  teamId: string;
  trace?: PersistentTraceSink;
}): Promise<void> {
  const { agent, now, err, phase, a2ax, teamId, trace } = args;
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[tick] ${phase} of ${agent.name} failed:`, msg);

  // Terminal play-by-play step (the caller flushes the sink).
  trace?.emit({ type: "tick_failed", data: { phase, error: msg } });

  // Persistent record (queryable via observe_app tool)
  emitAppEvent({
    severity: "error",
    level: "agent",
    source: phase === "resume" ? "tick-resume" : "tick",
    message: `Agent ${agent.name} failed: ${msg}`,
    teamId: agent.teamId,
    agentId: agent.id,
    metadata: { phase, errorMessage: msg },
  });

  // Real-time alert: broadcast to the team so peers see it on their next tick.
  // Fire-and-forget; a failed broadcast should never block error recovery.
  a2ax
    .broadcast(teamId, agent.id, `[SYSTEM] Agent ${agent.name} errored during ${phase}: ${msg}`, {
      kind: "text",
      payload: { systemAlert: true, severity: "error", source: phase },
    })
    .catch(() => {});

  await agents.update(agent.id, {
    inFlight: false,
    status: "errored",
    conversationState: null,
    nextRunAt: new Date(now.getTime() + agent.scheduleSeconds * 1000),
  });
}

/**
 * Apply a runAgent result to the store. If the run suspended, park the agent
 * (status awaiting_approval, conversation state saved, approval rows created)
 * WITHOUT advancing nextRunAt. Otherwise log the action and return the agent to
 * running.
 */
async function handleRunResult(args: {
  agent: AgentRow;
  /** Result from either runAgent (runner) or runCodexAgentTick (harness);
   *  the suspension is persisted opaquely in both cases. */
  result: RunOutcome;
  now: Date;
  /** Trace thread id for this run; parked with the suspension so the resume
   *  pass can continue the same play-by-play thread. */
  traceTickId?: string;
}): Promise<void> {
  const { agent, result, now, traceTickId } = args;

  if (result.suspension) {
    const s = result.suspension;
    // No cross-file transaction: park the agent, write its approval rows, and
    // log the suspension as three sequential writes (each atomic on its own
    // file). A crash between them is recovered by the defensive clear in
    // tryResumeAgent and the once-per-process inFlight reset.
    await agents.update(agent.id, {
      inFlight: false,
      status: "awaiting_approval",
      // The extra traceTickId key rides along with the opaque suspension;
      // the runner ignores it and extractTraceTickId reads it on resume.
      conversationState: {
        ...(s as unknown as Record<string, unknown>),
        ...(traceTickId ? { traceTickId } : {}),
      },
    });

    if (s.pending.length > 0) {
      await approvals.insertMany(
        agent.id,
        s.pending.map((p) => ({
          teamId: agent.teamId,
          toolCallId: p.id,
          toolName: p.name,
          toolArguments: p.arguments,
        })),
      );
    }

    // Log the suspension so it shows in the narration feed.
    await actionLog.insert(agent.id, {
      actionType: "awaiting_approval",
      payload: result.payload,
    });
    return;
  }

  const payload = result.validation
    ? {
        ...result.payload,
        validation: { valid: result.validation.valid, issues: result.validation.issues },
      }
    : result.payload;

  await actionLog.insert(agent.id, { actionType: result.actionType, payload });

  await agents.update(agent.id, {
    inFlight: false,
    status: "running",
    conversationState: null,
    nextRunAt: new Date(now.getTime() + agent.scheduleSeconds * 1000),
  });
}

// Vercel cron sends GET requests
export async function GET(req: Request) {
  return POST(req);
}

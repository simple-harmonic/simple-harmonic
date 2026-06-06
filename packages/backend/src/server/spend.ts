// ---------------------------------------------------------------------------
// LLM spend ledger + daily cap. Bounds runaway cost from the autonomous tick
// loop (the $50/day cap named in CLAUDE.md).
//
// Every agent run records its token usage into the llm_spend table; the tick
// loop checks the day's total against SH_DAILY_SPEND_CAP_CENTS before running.
// ---------------------------------------------------------------------------

import { sql } from "drizzle-orm";
import type { LLMClient } from "../lib/meta-agent/runner";
import type { db } from "./db";
import { llmSpend } from "./db/schema";

type DB = ReturnType<typeof db>;

// Per-1M-token cost in US cents, by model-id prefix. Approximate published
// list prices; the fallback is deliberately expensive so an unknown model
// over- rather than under-counts.
const RATES: Array<{ prefix: string; inCents: number; outCents: number }> = [
  { prefix: "claude-sonnet", inCents: 300, outCents: 1500 },
  { prefix: "claude-opus", inCents: 1500, outCents: 7500 },
  { prefix: "claude-haiku", inCents: 80, outCents: 400 },
  { prefix: "gpt-5", inCents: 125, outCents: 1000 },
  { prefix: "o4", inCents: 110, outCents: 440 },
];
const FALLBACK_RATE = { inCents: 1500, outCents: 7500 };

/** Cost in (rounded-up) cents for a single call's token usage. */
export function costCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const m = (model || "").toLowerCase();
  const rate = RATES.find((r) => m.startsWith(r.prefix)) ?? FALLBACK_RATE;
  const cents =
    (inputTokens * rate.inCents + outputTokens * rate.outCents) / 1_000_000;
  return Math.ceil(cents);
}

/** Daily ceiling in cents. Default 5000 (= $50). */
export function dailyCapCents(): number {
  const v = Number.parseInt(process.env.SH_DAILY_SPEND_CAP_CENTS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 5000;
}

/** UTC calendar day, YYYY-MM-DD. */
export function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function spentTodayCents(d: DB, now: Date): Promise<number> {
  const day = todayUtc(now);
  const rows = await d
    .select({ total: sql<number>`coalesce(sum(${llmSpend.costCents}), 0)` })
    .from(llmSpend)
    .where(sql`${llmSpend.day} = ${day}`);
  return Number(rows[0]?.total ?? 0);
}

export interface SpendStatus {
  allowed: boolean;
  spentCents: number;
  capCents: number;
  /** True when the ledger could not be read (spentCents is unknown). */
  unknown?: boolean;
}

/**
 * Whether another tick is within today's budget. On a ledger READ error (e.g.
 * the llm_spend table has not been migrated yet, or a transient DB hiccup) this
 * deliberately fails OPEN — a missing migration must not silently halt every
 * team's agents. The runaway-cost surface is already bounded by hibernate-on-
 * idle and the per-agent tick timeout; the caller logs the failure loudly. The
 * cap re-engages as soon as the ledger is readable again.
 */
export async function checkSpendAllowed(d: DB, now: Date): Promise<SpendStatus> {
  const capCents = dailyCapCents();
  try {
    const spentCents = await spentTodayCents(d, now);
    return { allowed: spentCents < capCents, spentCents, capCents };
  } catch {
    return { allowed: true, spentCents: -1, capCents, unknown: true };
  }
}

/** Append one usage row. Best-effort: a ledger write failure never breaks a tick. */
export async function recordSpend(
  d: DB,
  now: Date,
  entry: {
    teamId?: string | null;
    agentId?: string | null;
    model: string;
    inputTokens: number;
    outputTokens: number;
  },
): Promise<void> {
  if (entry.inputTokens <= 0 && entry.outputTokens <= 0) return;
  try {
    await d.insert(llmSpend).values({
      teamId: entry.teamId ?? null,
      agentId: entry.agentId ?? null,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      costCents: costCents(entry.model, entry.inputTokens, entry.outputTokens),
      day: todayUtc(now),
    });
  } catch {
    // best-effort
  }
}

export interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/**
 * Wrap an LLM client so every completion call accumulates its token usage.
 * Used per-agent in the tick loop so each agent run records its own spend.
 */
export function makeCountingLLM(
  llm: LLMClient,
  model: string,
): { llm: LLMClient; usage: UsageAccumulator } {
  const usage: UsageAccumulator = { inputTokens: 0, outputTokens: 0, model };
  const wrapped: LLMClient = {
    chat: {
      completions: {
        create: async (params, options) => {
          const res = await llm.chat.completions.create(params, options);
          const u = (
            res as {
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                prompt_tokens?: number;
                completion_tokens?: number;
              };
            }
          ).usage;
          if (u) {
            usage.inputTokens += u.input_tokens ?? u.prompt_tokens ?? 0;
            usage.outputTokens += u.output_tokens ?? u.completion_tokens ?? 0;
          }
          const pm = (params as { model?: string }).model;
          if (pm) usage.model = pm;
          return res;
        },
      },
    },
  };
  return { llm: wrapped, usage };
}

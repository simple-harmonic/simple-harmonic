// ---------------------------------------------------------------------------
// Server-side play-by-play trace sink.
//
// Bridges the runner's TraceSink callback (lib/meta-agent/trace.ts) to the
// agent_trace_events table. Design constraints:
//
//   - emit() is synchronous and never throws: steps are buffered and a single
//     background drain loop batch-inserts them in emission order, so the
//     runner is never blocked on the DB and a tick stays observable LIVE
//     while it runs (the SSE trace route polls the table).
//   - Steps are scrubbed (PII) and truncated (long tool outputs / thoughts)
//     before persistence — same guardrails as app_events.
//   - flush() awaits everything buffered so far; the tick route calls it in a
//     finally block so steps survive run failures and timeouts.
//   - A resumed tick reuses the original tickId (carried on the parked
//     conversation state), so one logical tick reads as one thread. seq
//     restarts per invocation; (emittedAt, seq) is the global sort key.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { lt } from "drizzle-orm";
import type { TraceStep } from "../lib/meta-agent/trace";
import { scrubPII } from "./app-events";
import { db } from "./db";
import { agentTraceEvents } from "./db/schema";

/** Per-string cap. Tool results and thoughts beyond this are cut with a marker. */
const MAX_STRING_LENGTH = 4000;
/** Nested values deeper than this are replaced with a placeholder. */
const MAX_DEPTH = 6;
/** Arrays/objects keep at most this many entries/keys. */
const MAX_ENTRIES = 50;

export interface PersistentTraceSink {
  /** Groups every step of this logical tick (stable across suspend/resume). */
  tickId: string;
  /** Runner-facing callback: buffer one step. Never throws, never blocks. */
  emit: (step: TraceStep) => void;
  /** Await all buffered writes. Call after the run settles, success or not. */
  flush: () => Promise<void>;
}

export function createTraceSink(args: {
  teamId: string;
  agentId: string;
  /** Pass the original tick's id when resuming so the thread stays grouped. */
  tickId?: string;
}): PersistentTraceSink {
  const tickId = args.tickId ?? randomUUID();
  let seq = 0;
  const buffer: Array<typeof agentTraceEvents.$inferInsert> = [];
  let writer: Promise<void> = Promise.resolve();
  let draining = false;

  const drain = async (): Promise<void> => {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, buffer.length);
      try {
        await db().insert(agentTraceEvents).values(batch);
      } catch (err) {
        // Telemetry must never break a tick: drop the batch and carry on.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[trace] dropped ${batch.length} step(s): ${msg}`);
      }
    }
  };

  const emit = (step: TraceStep) => {
    try {
      buffer.push({
        teamId: args.teamId,
        agentId: args.agentId,
        tickId,
        seq: seq++,
        type: step.type,
        data: sanitizeTraceData(step.data),
        emittedAt: new Date(),
      });
      if (!draining) {
        draining = true;
        writer = drain().finally(() => {
          draining = false;
        });
      }
    } catch (err) {
      console.error("[trace] emit failed:", err instanceof Error ? err.message : String(err));
    }
  };

  const flush = async (): Promise<void> => {
    await writer;
    // A step pushed in the gap between the drain loop's last empty check and
    // its finally() sees draining===true and doesn't restart the loop. It is
    // only delayed, never lost: pick it up here.
    if (buffer.length > 0) {
      draining = true;
      writer = drain().finally(() => {
        draining = false;
      });
      await writer;
    }
  };

  return { tickId, emit, flush };
}

// ---------------------------------------------------------------------------
// Sanitization: PII scrub + truncation so a verbose tool result (file dumps,
// command output) can't bloat the table or leak credentials.
// ---------------------------------------------------------------------------

export function sanitizeTraceData(data: Record<string, unknown>): Record<string, unknown> {
  try {
    const out = sanitizeValue(data, 0);
    return (out && typeof out === "object" && !Array.isArray(out)
      ? out
      : { value: out }) as Record<string, unknown>;
  } catch (err) {
    return { unserializable: err instanceof Error ? err.message : String(err) };
  }
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    const scrubbed = scrubPII(value);
    if (scrubbed.length <= MAX_STRING_LENGTH) return scrubbed;
    return `${scrubbed.slice(0, MAX_STRING_LENGTH)}… [truncated ${scrubbed.length - MAX_STRING_LENGTH} chars]`;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return "[max depth]";
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ENTRIES).map((v) => sanitizeValue(v, depth + 1));
    if (value.length > MAX_ENTRIES) kept.push(`… [${value.length - MAX_ENTRIES} more]`);
    return kept;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [k, v] of entries.slice(0, MAX_ENTRIES)) {
      out[k] = sanitizeValue(v, depth + 1);
    }
    if (entries.length > MAX_ENTRIES) out["…"] = `[${entries.length - MAX_ENTRIES} more keys]`;
    return out;
  }
  // Functions, symbols, bigints: stringify defensively.
  return String(value);
}

// ---------------------------------------------------------------------------
// Retention: traces are high-volume telemetry. The tick route calls this once
// per cron invocation; the hourly throttle keeps it from running every minute.
// ---------------------------------------------------------------------------

const PRUNE_INTERVAL_MS = 3600_000;
let lastPruneAt = 0;

function retentionDays(): number {
  const v = Number.parseInt(process.env.SH_TRACE_RETENTION_DAYS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 14;
}

/** Delete trace events older than the retention window (default 14 days,
 *  override with SH_TRACE_RETENTION_DAYS). Throttled to once per hour. */
export async function pruneTraceEvents(now = Date.now()): Promise<void> {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  try {
    const cutoff = new Date(now - retentionDays() * 86_400_000);
    await db().delete(agentTraceEvents).where(lt(agentTraceEvents.emittedAt, cutoff));
  } catch (err) {
    console.error("[trace] prune failed:", err instanceof Error ? err.message : String(err));
  }
}

/** Test hook: reset the prune throttle. */
export function resetPruneThrottleForTests(): void {
  lastPruneAt = 0;
}

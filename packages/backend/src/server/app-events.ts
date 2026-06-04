// ---------------------------------------------------------------------------
// App event emitter -- the feedback loop for dogfooding.
//
// Captures errors, warnings, and health signals into the app_events table.
// Agents see these via the health context injected into their tick prompt,
// or by calling the observe_app tool directly.
//
// Usage:
//   import { emitAppEvent } from "@simple-harmonic/backend/server/app-events";
//   emitAppEvent({ severity: "error", source: "tick", message: "agent X failed", teamId, agentId, metadata });
//
// The emit is fire-and-forget (does not throw on DB errors) so it never
// disrupts the caller's flow. Errors in the emitter itself go to console.
// ---------------------------------------------------------------------------

import { db } from "./db";
import { appEvents } from "./db/schema";
import { desc, eq, and, gte, type SQL } from "drizzle-orm";

export interface AppEvent {
  severity: "info" | "warning" | "error";
  source: string;
  message: string;
  teamId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Write an event to the app_events table. Fire-and-forget.
 */
export function emitAppEvent(event: AppEvent): void {
  try {
    const d = db();
    d.insert(appEvents)
      .values({
        severity: event.severity,
        source: event.source,
        message: event.message,
        teamId: event.teamId ?? null,
        agentId: event.agentId ?? null,
        metadata: event.metadata ?? null,
      })
      .then(() => {})
      .catch((err) => {
        console.error("[app-events] Failed to write event:", err instanceof Error ? err.message : err);
      });
  } catch {
    // DB not initialized yet (e.g., during startup). Silently skip.
  }
}

export interface EventQuery {
  teamId?: string;
  severity?: "info" | "warning" | "error";
  source?: string;
  since?: Date;
  limit?: number;
}

/**
 * Query recent app events. Used by the observe_app tool and tick prompt builder.
 */
export async function queryAppEvents(query: EventQuery = {}): Promise<Array<typeof appEvents.$inferSelect>> {
  const d = db();
  const conditions: SQL[] = [];

  if (query.teamId) {
    conditions.push(eq(appEvents.teamId, query.teamId));
  }
  if (query.severity) {
    conditions.push(eq(appEvents.severity, query.severity));
  }
  if (query.source) {
    conditions.push(eq(appEvents.source, query.source));
  }
  if (query.since) {
    conditions.push(gte(appEvents.createdAt, query.since));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = query.limit ?? 20;

  return d.query.appEvents.findMany({
    where,
    orderBy: [desc(appEvents.createdAt)],
    limit,
  });
}

/**
 * Format events for injection into an agent's tick prompt.
 * Returns undefined if there are no events.
 */
export function formatEventsForPrompt(events: Array<typeof appEvents.$inferSelect>): string | undefined {
  if (events.length === 0) return undefined;

  const lines = events.map((e) => {
    const ts = e.createdAt.toISOString().slice(11, 19);
    const sev = e.severity === "error" ? "ERROR" : e.severity === "warning" ? "WARN" : "INFO";
    const agent = e.agentId ? ` (agent ${e.agentId.slice(0, 8)})` : "";
    return `[${ts}] ${sev} [${e.source}]${agent}: ${e.message}`;
  });

  return lines.join("\n");
}

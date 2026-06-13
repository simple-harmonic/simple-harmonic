// ---------------------------------------------------------------------------
// Play-by-play trace repo — append-only per-agent trace.jsonl. One row per
// agent step. Queries gather across a team's agents (or one agent), filter by
// tick, and sort by (emittedAt, seq) to match the old global sort key.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { agentTracePath } from "../data-dir";
import { appendJsonlMany, readJsonl, rewriteJsonl } from "../fs-store";
import { agentLoc, agentLocsForTeam, allAgentLocs } from "../index-cache";
import { reviveDatesAll } from "../serialize";
import type { AgentTraceEvent } from "../types";

const DATE_KEYS = ["emittedAt", "createdAt"] as const;

/** A step ready to persist (id/createdAt are filled here). */
export interface NewTraceEvent {
  teamId: string;
  agentId: string;
  tickId: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  emittedAt: Date;
}

function readForDir(dir: string): AgentTraceEvent[] {
  return reviveDatesAll(
    readJsonl<Record<string, unknown>>(agentTracePath(dir)),
    DATE_KEYS,
  ) as unknown as AgentTraceEvent[];
}

function cmp(a: AgentTraceEvent, b: AgentTraceEvent, order: "asc" | "desc"): number {
  const t = a.emittedAt.getTime() - b.emittedAt.getTime() || a.seq - b.seq;
  return order === "asc" ? t : -t;
}

export interface TraceQuery {
  teamId: string;
  agentId?: string | null;
  tickId?: string | null;
  since?: Date;
  order: "asc" | "desc";
  limit: number;
}

export const traceEvents = {
  /** Append a batch of steps. All rows in a batch share one agent. */
  async append(rows: NewTraceEvent[]): Promise<void> {
    if (rows.length === 0) return;
    const byAgent = new Map<string, AgentTraceEvent[]>();
    const now = new Date();
    for (const r of rows) {
      const full: AgentTraceEvent = { id: randomUUID(), ...r, createdAt: now };
      const list = byAgent.get(r.agentId) ?? [];
      list.push(full);
      byAgent.set(r.agentId, list);
    }
    for (const [agentId, list] of byAgent) {
      const loc = agentLoc(agentId);
      if (loc) appendJsonlMany(agentTracePath(loc.dir), list);
    }
  },

  async query(q: TraceQuery): Promise<AgentTraceEvent[]> {
    const dirs = q.agentId
      ? [agentLoc(q.agentId)?.dir].filter((d): d is string => Boolean(d))
      : agentLocsForTeam(q.teamId).map((l) => l.dir);

    let rows: AgentTraceEvent[] = [];
    for (const dir of dirs) rows.push(...readForDir(dir));

    rows = rows.filter((r) => r.teamId === q.teamId);
    if (q.agentId) rows = rows.filter((r) => r.agentId === q.agentId);
    if (q.tickId) rows = rows.filter((r) => r.tickId === q.tickId);
    if (q.since) {
      const ms = q.since.getTime();
      rows = rows.filter((r) => r.emittedAt.getTime() >= ms);
    }

    rows.sort((a, b) => cmp(a, b, q.order));
    return rows.slice(0, q.limit);
  },

  /** Delete trace steps older than the cutoff across every agent. */
  async pruneOlderThan(cutoff: Date): Promise<void> {
    const ms = cutoff.getTime();
    for (const loc of allAgentLocs()) {
      const path = agentTracePath(loc.dir);
      const rows = readForDir(loc.dir);
      const kept = rows.filter((r) => r.emittedAt.getTime() >= ms);
      if (kept.length !== rows.length) rewriteJsonl(path, kept);
    }
  },
};

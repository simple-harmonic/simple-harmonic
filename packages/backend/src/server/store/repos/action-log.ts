// ---------------------------------------------------------------------------
// Action log repo — append-only per-agent history in actions.jsonl. Reads merge
// across agents and sort newest-first to match the old `ORDER BY executed_at
// DESC` queries.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { agentActionsPath } from "../data-dir";
import { appendJsonl, readJsonl } from "../fs-store";
import { agentLoc } from "../index-cache";
import { reviveDatesAll } from "../serialize";
import type { ActionLogEntry } from "../types";

const DATE_KEYS = ["executedAt"] as const;

function readForAgent(agentId: string): ActionLogEntry[] {
  const loc = agentLoc(agentId);
  if (!loc) return [];
  return reviveDatesAll(
    readJsonl<Record<string, unknown>>(agentActionsPath(loc.dir)),
    DATE_KEYS,
  ) as unknown as ActionLogEntry[];
}

export interface NewAction {
  actionType: string;
  payload: Record<string, unknown>;
  metaAgentApprovalId?: string | null;
}

export const actionLog = {
  async insert(agentId: string, e: NewAction): Promise<ActionLogEntry> {
    const loc = agentLoc(agentId);
    if (!loc) throw new Error(`agent ${agentId} not found`);
    const row: ActionLogEntry = {
      id: randomUUID(),
      agentId,
      metaAgentApprovalId: e.metaAgentApprovalId ?? null,
      actionType: e.actionType,
      payload: e.payload,
      executedAt: new Date(),
    };
    appendJsonl(agentActionsPath(loc.dir), row);
    return row;
  },

  /** Newest-first action entries across the given agents. */
  async byAgents(
    agentIds: Iterable<string>,
    opts: { limit?: number; since?: Date } = {},
  ): Promise<ActionLogEntry[]> {
    let rows: ActionLogEntry[] = [];
    for (const id of agentIds) rows.push(...readForAgent(id));
    if (opts.since) {
      const ms = opts.since.getTime();
      rows = rows.filter((r) => r.executedAt.getTime() > ms);
    }
    rows.sort((a, b) => b.executedAt.getTime() - a.executedAt.getTime());
    return opts.limit ? rows.slice(0, opts.limit) : rows;
  },

  async recentByAgent(agentId: string, limit: number): Promise<ActionLogEntry[]> {
    return actionLog.byAgents([agentId], { limit });
  },
};

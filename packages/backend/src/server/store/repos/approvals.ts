// ---------------------------------------------------------------------------
// Pending approvals repo — stored per agent in approvals.json (an array). Each
// destructive tool call awaiting human sign-off is one entry. Deleting an agent
// folder removes its approvals for free, so there is no cascade to manage.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { agentApprovalsPath } from "../data-dir";
import { readJson, writeJson } from "../fs-store";
import { agentLoc, agentLocsForTeam } from "../index-cache";
import { reviveDatesAll } from "../serialize";
import type { ApprovalStatus, PendingApproval } from "../types";

const DATE_KEYS = ["createdAt", "resolvedAt"] as const;

function readForDir(dir: string): PendingApproval[] {
  return reviveDatesAll(
    readJson<Record<string, unknown>[]>(agentApprovalsPath(dir), []),
    DATE_KEYS,
  ) as unknown as PendingApproval[];
}

export interface NewApproval {
  teamId: string;
  toolCallId: string;
  toolName: string;
  toolArguments: string;
}

export const approvals = {
  async byAgent(agentId: string): Promise<PendingApproval[]> {
    const loc = agentLoc(agentId);
    return loc ? readForDir(loc.dir) : [];
  },

  /** Append approvals for an agent (all belong to the same agent). */
  async insertMany(agentId: string, rows: NewApproval[]): Promise<void> {
    const loc = agentLoc(agentId);
    if (!loc || rows.length === 0) return;
    const now = new Date();
    const existing = readJson<Record<string, unknown>[]>(agentApprovalsPath(loc.dir), []);
    for (const r of rows) {
      existing.push({
        id: randomUUID(),
        teamId: r.teamId,
        agentId,
        toolCallId: r.toolCallId,
        toolName: r.toolName,
        toolArguments: r.toolArguments,
        status: "pending",
        decisionNote: null,
        createdAt: now,
        resolvedAt: null,
      });
    }
    writeJson(agentApprovalsPath(loc.dir), existing);
  },

  /** Remove all approvals for an agent (consumed on resume / defensive clear). */
  async clearForAgent(agentId: string): Promise<void> {
    const loc = agentLoc(agentId);
    if (!loc) return;
    writeJson(agentApprovalsPath(loc.dir), []);
  },

  /** All pending approvals across a team's agents. */
  async pendingForTeam(teamId: string): Promise<PendingApproval[]> {
    const out: PendingApproval[] = [];
    for (const loc of agentLocsForTeam(teamId)) {
      for (const a of readForDir(loc.dir)) {
        if (a.status === "pending") out.push(a);
      }
    }
    return out;
  },

  /**
   * Resolve one approval within a team. Locates the owning agent by scanning the
   * team's agents. Returns the affected agentId, or a reason it could not.
   */
  async resolve(
    teamId: string,
    approvalId: string,
    decision: ApprovalStatus,
    note: string | null,
  ): Promise<{ ok: true; agentId: string } | { ok: false; reason: "not_found" | "already" }> {
    for (const loc of agentLocsForTeam(teamId)) {
      const rows = readJson<Record<string, unknown>[]>(agentApprovalsPath(loc.dir), []);
      const idx = rows.findIndex((r) => r.id === approvalId);
      if (idx === -1) continue;
      if (rows[idx].status !== "pending") return { ok: false, reason: "already" };
      rows[idx].status = decision;
      rows[idx].decisionNote = note;
      rows[idx].resolvedAt = new Date();
      writeJson(agentApprovalsPath(loc.dir), rows);
      return { ok: true, agentId: loc.agentId };
    }
    return { ok: false, reason: "not_found" };
  },
};

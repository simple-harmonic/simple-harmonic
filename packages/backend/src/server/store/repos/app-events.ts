// ---------------------------------------------------------------------------
// App events repo — append-only JSONL. Team/agent/tool events live in the
// owning team's events.jsonl; infra and team-less events live in
// system/events.jsonl. Queries gather across the relevant files, then filter +
// sort newest-first + limit, mirroring the old WHERE/ORDER BY/LIMIT.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { infraEventsPath, teamEventsPath } from "../data-dir";
import { appendJsonl, readJsonl, rewriteJsonl } from "../fs-store";
import { allTeamLocs, teamDir } from "../index-cache";
import { reviveDatesAll } from "../serialize";
import type { AppEvent, AppEventLevel, AppEventSeverity } from "../types";

const DATE_KEYS = ["acknowledgedAt", "createdAt"] as const;

function readPath(path: string): AppEvent[] {
  return reviveDatesAll(
    readJsonl<Record<string, unknown>>(path),
    DATE_KEYS,
  ) as unknown as AppEvent[];
}

/** All event-file paths (every team's + the system infra file). */
function allEventPaths(): string[] {
  return [...allTeamLocs().map((l) => teamEventsPath(l.dir)), infraEventsPath()];
}

export interface NewAppEvent {
  severity: AppEventSeverity;
  level: AppEventLevel;
  source: string;
  message: string;
  teamId: string | null;
  agentId: string | null;
  metadata: Record<string, unknown> | null;
}

export interface AppEventQuery {
  teamId?: string;
  severity?: AppEventSeverity;
  level?: AppEventLevel;
  source?: string;
  since?: Date;
  limit?: number;
  includeInfra?: boolean;
  unacknowledgedOnly?: boolean;
}

export const appEvents = {
  /** Append one event. Synchronous + fire-and-forget (telemetry never blocks). */
  insert(e: NewAppEvent): void {
    const row: AppEvent = {
      id: randomUUID(),
      teamId: e.teamId,
      agentId: e.agentId,
      severity: e.severity,
      level: e.level,
      source: e.source,
      message: e.message,
      metadata: e.metadata,
      acknowledgedAt: null,
      createdAt: new Date(),
    };
    // Team-scoped events go to the team file (if the team still exists);
    // infra and team-less events go to the system file.
    const dir = e.teamId ? teamDir(e.teamId) : undefined;
    appendJsonl(dir ? teamEventsPath(dir) : infraEventsPath(), row);
  },

  async query(q: AppEventQuery = {}): Promise<AppEvent[]> {
    // Narrow which files to read: a teamId filter only matches that team's file.
    const paths = q.teamId
      ? [teamDir(q.teamId) ? teamEventsPath(teamDir(q.teamId)!) : null].filter(
          (p): p is string => p !== null,
        )
      : allEventPaths();

    let rows: AppEvent[] = [];
    for (const p of paths) rows.push(...readPath(p));

    if (q.teamId) rows = rows.filter((r) => r.teamId === q.teamId);
    if (q.severity) rows = rows.filter((r) => r.severity === q.severity);
    if (q.level) rows = rows.filter((r) => r.level === q.level);
    if (q.source) rows = rows.filter((r) => r.source === q.source);
    if (q.since) {
      const ms = q.since.getTime();
      rows = rows.filter((r) => r.createdAt.getTime() >= ms);
    }
    if (!q.includeInfra) rows = rows.filter((r) => r.level !== "infra");
    if (q.unacknowledgedOnly) rows = rows.filter((r) => r.acknowledgedAt === null);

    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return rows.slice(0, q.limit ?? 20);
  },

  /** Mark events acknowledged by id (founder dismiss). Returns count touched. */
  async acknowledge(ids: string[]): Promise<number> {
    const wanted = new Set(ids);
    const now = new Date();
    let touched = 0;
    for (const path of allEventPaths()) {
      const rows = readJsonl<Record<string, unknown>>(path);
      let changed = false;
      for (const r of rows) {
        if (wanted.has(r.id as string) && r.acknowledgedAt == null) {
          r.acknowledgedAt = now;
          changed = true;
          touched++;
        }
      }
      if (changed) rewriteJsonl(path, rows);
    }
    return touched;
  },
};

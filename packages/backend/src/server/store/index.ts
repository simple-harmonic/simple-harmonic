// ---------------------------------------------------------------------------
// Public entry point for the JSON file store.
//
// Replaces the old Drizzle `db()` + schema. Import repos from here:
//
//   import { teams, agents, actionLog } from "../store";
//
// All repo methods are async (file IO is synchronous under the hood, wrapped in
// Promises so existing `await` call sites are unchanged). Single-process,
// single-writer: run one process against a data dir at a time.
// ---------------------------------------------------------------------------

import { mkdirSync, rmSync } from "node:fs";
import { getDataDir, systemDir, teamsRoot } from "./data-dir";
import { invalidateIndex } from "./index-cache";

export { actionLog, type NewAction } from "./repos/action-log";
export { agents, type NewAgent } from "./repos/agents";
export { appEvents, type AppEventQuery, type NewAppEvent } from "./repos/app-events";
export { approvals, type NewApproval } from "./repos/approvals";
export { platformStatus } from "./repos/platform-status";
export { spend, type NewSpend } from "./repos/spend";
export { teams, type NewTeam } from "./repos/teams";
export { traceEvents, type NewTraceEvent, type TraceQuery } from "./repos/trace-events";

export { getDataDir, setDataDir } from "./data-dir";
export type * from "./types";

/** Create the data directory skeleton (teams/ and system/). Idempotent. */
export function ensureDataDir(): string {
  mkdirSync(teamsRoot(), { recursive: true });
  mkdirSync(systemDir(), { recursive: true });
  return getDataDir();
}

/** Drop in-memory caches. Call after pointing the store at a new data dir. */
export function resetStore(): void {
  invalidateIndex();
}

/** Wipe all data (teams + system) and drop caches. For seeds and test setup. */
export function clearStore(): void {
  rmSync(teamsRoot(), { recursive: true, force: true });
  rmSync(systemDir(), { recursive: true, force: true });
  invalidateIndex();
}

// ---------------------------------------------------------------------------
// Data directory resolution + path helpers for the domain-aggregate file store.
//
// Layout (recursive on teams — sub-teams nest under their parent's teams/):
//
//   <dataDir>/
//   ├─ teams/<teamId>/
//   │  ├─ team.json
//   │  ├─ events.jsonl
//   │  ├─ agents/<agentId>/{ agent.json, approvals.json, actions.jsonl, trace.jsonl }
//   │  ├─ conversations/<sessionId>.json
//   │  ├─ messages/{ channels.json, members.json, tasks.json, log.jsonl,
//   │  │             reads.jsonl, cards.json, tokens.json }   (a2ax)
//   │  └─ teams/<subTeamId>/…                                  (recursive)
//   └─ system/{ platform-status.json, spend.jsonl, events.jsonl }
//
// The default lives under .simple-harmonic/data so it sits alongside the
// existing connectors/ and skills/ file conventions. Override with SH_DATA_DIR
// (env) or setDataDir() (tests). Team/agent folder paths are NOT fixed — they
// depend on hierarchy depth — so they are resolved through the location index
// (index-cache.ts); only the fixed roots live here.
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { getConfig } from "../config";

let override: string | null = null;

/** Absolute path to the data directory root. Resolution: test override >
 *  config (simple-harmonic.config.json) > SH_DATA_DIR env > default. */
export function getDataDir(): string {
  return override ?? getConfig().dataDir;
}

/** Point the store at a different directory (used by tests for isolation). */
export function setDataDir(dir: string | null): void {
  override = dir;
}

// --- Fixed roots ---

export function teamsRoot(): string {
  return join(getDataDir(), "teams");
}

export function systemDir(): string {
  return join(getDataDir(), "system");
}

export function platformStatusPath(): string {
  return join(systemDir(), "platform-status.json");
}

/** Global LLM spend ledger (day-keyed, drives the daily cap). */
export function spendLogPath(): string {
  return join(systemDir(), "spend.jsonl");
}

/** Infra-level app events (teamId === null). Team-scoped events live per team. */
export function infraEventsPath(): string {
  return join(systemDir(), "events.jsonl");
}

// --- Within a team folder (path resolved via the index) ---

export function teamJsonPath(teamDir: string): string {
  return join(teamDir, "team.json");
}

export function teamEventsPath(teamDir: string): string {
  return join(teamDir, "events.jsonl");
}

export function teamAgentsDir(teamDir: string): string {
  return join(teamDir, "agents");
}

export function teamMessagesDir(teamDir: string): string {
  return join(teamDir, "messages");
}

/** Folder holding this team's sub-teams (recursion). */
export function teamChildrenDir(teamDir: string): string {
  return join(teamDir, "teams");
}

// --- Within an agent folder ---

export function agentJsonPath(agentDir: string): string {
  return join(agentDir, "agent.json");
}

export function agentApprovalsPath(agentDir: string): string {
  return join(agentDir, "approvals.json");
}

export function agentActionsPath(agentDir: string): string {
  return join(agentDir, "actions.jsonl");
}

export function agentTracePath(agentDir: string): string {
  return join(agentDir, "trace.jsonl");
}

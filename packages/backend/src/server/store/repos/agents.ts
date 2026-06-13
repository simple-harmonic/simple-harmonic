// ---------------------------------------------------------------------------
// Agents repo — each agent is a folder under its team's agents/ dir, holding
// agent.json plus approvals/actions/trace files. The location index maps
// agentId → folder path so by-id lookups don't need the owning team.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { agentJsonPath, teamAgentsDir } from "../data-dir";
import { movePath, readJson, removePath, updateJson, writeJson } from "../fs-store";
import {
  agentLoc,
  agentLocsForTeam,
  allAgentLocs,
  invalidateIndex,
  teamDir,
} from "../index-cache";
import { reviveDates } from "../serialize";
import type { Agent, AgentStatus } from "../types";

const DATE_KEYS = ["nextRunAt", "createdAt"] as const;

function readAgent(dir: string): Agent | null {
  const raw = readJson<Record<string, unknown> | null>(agentJsonPath(dir), null);
  return raw ? (reviveDates(raw, DATE_KEYS) as unknown as Agent) : null;
}

export interface NewAgent {
  name: string;
  role: string;
  archetype: string;
  tools: string[];
  scheduleSeconds: number;
  initialPrompt: string;
  outputContract?: Record<string, unknown> | null;
  status?: AgentStatus;
  nextRunAt?: Date | null;
}

function buildRow(teamId: string, input: NewAgent): Agent {
  return {
    id: randomUUID(),
    teamId,
    name: input.name,
    role: input.role,
    archetype: input.archetype,
    tools: input.tools,
    scheduleSeconds: input.scheduleSeconds,
    initialPrompt: input.initialPrompt,
    outputContract: input.outputContract ?? null,
    status: input.status ?? "running",
    nextRunAt: input.nextRunAt ?? null,
    inFlight: false,
    conversationState: null,
    createdAt: new Date(),
  };
}

export const agents = {
  async byId(id: string): Promise<Agent | null> {
    const loc = agentLoc(id);
    return loc ? readAgent(loc.dir) : null;
  },

  async byTeam(teamId: string): Promise<Agent[]> {
    return agentLocsForTeam(teamId)
      .map((l) => readAgent(l.dir))
      .filter((a): a is Agent => a !== null);
  },

  /** Agents across many teams (e.g. a sub-tree). */
  async byTeams(teamIds: Iterable<string>): Promise<Agent[]> {
    const set = new Set(teamIds);
    return allAgentLocs()
      .filter((l) => set.has(l.teamId))
      .map((l) => readAgent(l.dir))
      .filter((a): a is Agent => a !== null);
  },

  async all(): Promise<Agent[]> {
    return allAgentLocs()
      .map((l) => readAgent(l.dir))
      .filter((a): a is Agent => a !== null);
  },

  async insert(teamId: string, input: NewAgent): Promise<Agent> {
    const dir = teamDir(teamId);
    if (!dir) throw new Error(`team ${teamId} not found`);
    const row = buildRow(teamId, input);
    writeJson(agentJsonPath(join(teamAgentsDir(dir), row.id)), row);
    invalidateIndex();
    return row;
  },

  async insertMany(teamId: string, inputs: NewAgent[]): Promise<Agent[]> {
    const dir = teamDir(teamId);
    if (!dir) throw new Error(`team ${teamId} not found`);
    const rows = inputs.map((i) => buildRow(teamId, i));
    for (const row of rows) {
      writeJson(agentJsonPath(join(teamAgentsDir(dir), row.id)), row);
    }
    if (rows.length > 0) invalidateIndex();
    return rows;
  },

  async update(id: string, patch: Partial<Agent>): Promise<Agent | null> {
    const loc = agentLoc(id);
    if (!loc) return null;
    const updated = updateJson<Record<string, unknown>>(agentJsonPath(loc.dir), {}, (cur) => ({
      ...cur,
      ...patch,
    }));
    return reviveDates(updated, DATE_KEYS) as unknown as Agent;
  },

  /** Move an agent's folder to a different team and rewrite its teamId. */
  async move(id: string, toTeamId: string): Promise<Agent | null> {
    const loc = agentLoc(id);
    const destDir = teamDir(toTeamId);
    if (!loc || !destDir) return null;
    const newDir = join(teamAgentsDir(destDir), id);
    updateJson<Record<string, unknown>>(agentJsonPath(loc.dir), {}, (cur) => ({
      ...cur,
      teamId: toTeamId,
    }));
    movePath(loc.dir, newDir);
    invalidateIndex();
    return readAgent(newDir);
  },

  async delete(id: string): Promise<void> {
    const loc = agentLoc(id);
    if (!loc) return;
    removePath(loc.dir);
    invalidateIndex();
  },

  /**
   * Atomically claim an agent for a tick: set inFlight true only if it is
   * currently not in flight and in the expected status. Synchronous read+write
   * (no await between) makes this race-free in Node's single thread — the
   * file-store equivalent of the old conditional UPDATE … RETURNING.
   */
  async claim(id: string, expectedStatus: AgentStatus): Promise<boolean> {
    const loc = agentLoc(id);
    if (!loc) return false;
    const path = agentJsonPath(loc.dir);
    const cur = readJson<Record<string, unknown> | null>(path, null);
    if (!cur || cur.inFlight === true || cur.status !== expectedStatus) return false;
    cur.inFlight = true;
    writeJson(path, cur);
    return true;
  },

  /** Clear inFlight on every agent (crash recovery on process start). */
  async resetAllInFlight(): Promise<void> {
    for (const loc of allAgentLocs()) {
      const path = agentJsonPath(loc.dir);
      const cur = readJson<Record<string, unknown> | null>(path, null);
      if (cur && cur.inFlight === true) {
        cur.inFlight = false;
        writeJson(path, cur);
      }
    }
  },
};

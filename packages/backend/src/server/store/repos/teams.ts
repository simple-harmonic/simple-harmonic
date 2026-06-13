// ---------------------------------------------------------------------------
// Teams repo — each team is a folder; the folder's location in the recursive
// tree encodes the hierarchy. team.json holds the row; the location index maps
// teamId → folder path.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { teamChildrenDir, teamJsonPath, teamsRoot } from "../data-dir";
import { readJson, removePath, updateJson, writeJson } from "../fs-store";
import {
  allTeamLocs,
  childTeamLocs,
  invalidateIndex,
  rootTeamLocs,
  teamDir,
} from "../index-cache";
import { reviveDates } from "../serialize";
import type { Team } from "../types";

const DATE_KEYS = ["lastUserActiveAt", "createdAt"] as const;

function readTeam(dir: string): Team | null {
  const raw = readJson<Record<string, unknown> | null>(teamJsonPath(dir), null);
  return raw ? (reviveDates(raw, DATE_KEYS) as unknown as Team) : null;
}

export interface NewTeam {
  name: string;
  parentTeamId?: string | null;
  goal?: string | null;
  cofounderName?: string | null;
  metaAgentPrompt?: string | null;
  paused?: boolean;
  tickCount?: number;
  telemetryEnabled?: boolean;
}

export const teams = {
  /** All teams, oldest-first. */
  async all(): Promise<Team[]> {
    return allTeamLocs()
      .map((l) => readTeam(l.dir))
      .filter((t): t is Team => t !== null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  },

  async byId(id: string): Promise<Team | null> {
    const dir = teamDir(id);
    return dir ? readTeam(dir) : null;
  },

  async roots(): Promise<Team[]> {
    return rootTeamLocs()
      .map((l) => readTeam(l.dir))
      .filter((t): t is Team => t !== null);
  },

  async children(parentId: string): Promise<Team[]> {
    return childTeamLocs(parentId)
      .map((l) => readTeam(l.dir))
      .filter((t): t is Team => t !== null);
  },

  async listUnpaused(): Promise<Team[]> {
    return (await teams.all()).filter((t) => !t.paused);
  },

  async insert(input: NewTeam): Promise<Team> {
    const id = randomUUID();
    const now = new Date();
    const parentTeamId = input.parentTeamId ?? null;
    let container = teamsRoot();
    if (parentTeamId) {
      const parentDir = teamDir(parentTeamId);
      if (!parentDir) throw new Error(`parent team ${parentTeamId} not found`);
      container = teamChildrenDir(parentDir);
    }
    const row: Team = {
      id,
      parentTeamId,
      name: input.name,
      goal: input.goal ?? null,
      paused: input.paused ?? false,
      tickCount: input.tickCount ?? 0,
      metaAgentPrompt: input.metaAgentPrompt ?? null,
      cofounderName: input.cofounderName ?? null,
      telemetryEnabled: input.telemetryEnabled ?? true,
      lastUserActiveAt: now,
      createdAt: now,
    };
    writeJson(teamJsonPath(join(container, id)), row);
    invalidateIndex();
    return row;
  },

  async update(id: string, patch: Partial<Team>): Promise<Team | null> {
    const dir = teamDir(id);
    if (!dir) return null;
    const updated = updateJson<Record<string, unknown>>(teamJsonPath(dir), {}, (cur) => ({
      ...cur,
      ...patch,
    }));
    return reviveDates(updated, DATE_KEYS) as unknown as Team;
  },

  async incrementTickCount(id: string): Promise<void> {
    const dir = teamDir(id);
    if (!dir) return;
    updateJson<Record<string, unknown>>(teamJsonPath(dir), {}, (cur) => ({
      ...cur,
      tickCount: (typeof cur.tickCount === "number" ? cur.tickCount : 0) + 1,
    }));
  },

  /** Delete a team and its whole subtree (agents, messages, sub-teams) by rmdir. */
  async delete(id: string): Promise<void> {
    const dir = teamDir(id);
    if (!dir) return;
    removePath(dir);
    invalidateIndex();
  },
};

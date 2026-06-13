// ---------------------------------------------------------------------------
// Location index for the recursive team tree.
//
// Teams nest under their parent's teams/ folder to arbitrary depth, so a team's
// on-disk path is not derivable from its id alone. This module walks the tree
// once and caches a map of teamId → { dir, parentTeamId } and agentId →
// { teamId, dir }. Tree queries (roots, children, sub-tree) read straight from
// the cache instead of re-walking. The cache is invalidated on any team/agent
// create/delete/move so the next access rebuilds it; the dataset is small
// (<100 teams) so a full rebuild is cheap.
// ---------------------------------------------------------------------------

import { join } from "node:path";
import {
  teamAgentsDir,
  teamChildrenDir,
  teamJsonPath,
  teamsRoot,
} from "./data-dir";
import { listSubdirs, pathExists } from "./fs-store";

export interface TeamLoc {
  teamId: string;
  dir: string;
  parentTeamId: string | null;
}

export interface AgentLoc {
  agentId: string;
  teamId: string;
  dir: string;
}

interface Index {
  teams: Map<string, TeamLoc>;
  agents: Map<string, AgentLoc>;
}

let cache: Index | null = null;

function walk(containerDir: string, parentTeamId: string | null, idx: Index): void {
  for (const teamId of listSubdirs(containerDir)) {
    const dir = join(containerDir, teamId);
    if (!pathExists(teamJsonPath(dir))) continue; // not a team folder
    idx.teams.set(teamId, { teamId, dir, parentTeamId });
    for (const agentId of listSubdirs(teamAgentsDir(dir))) {
      idx.agents.set(agentId, { agentId, teamId, dir: join(teamAgentsDir(dir), agentId) });
    }
    walk(teamChildrenDir(dir), teamId, idx); // recurse into sub-teams
  }
}

function build(): Index {
  const idx: Index = { teams: new Map(), agents: new Map() };
  walk(teamsRoot(), null, idx);
  return idx;
}

function index(): Index {
  if (!cache) cache = build();
  return cache;
}

/** Drop the cache so the next access re-walks the tree. */
export function invalidateIndex(): void {
  cache = null;
}

export function teamLoc(teamId: string): TeamLoc | undefined {
  return index().teams.get(teamId);
}

export function teamDir(teamId: string): string | undefined {
  return index().teams.get(teamId)?.dir;
}

export function allTeamLocs(): TeamLoc[] {
  return [...index().teams.values()];
}

export function childTeamLocs(parentTeamId: string): TeamLoc[] {
  return [...index().teams.values()].filter((t) => t.parentTeamId === parentTeamId);
}

export function rootTeamLocs(): TeamLoc[] {
  return [...index().teams.values()].filter((t) => t.parentTeamId === null);
}

export function agentLoc(agentId: string): AgentLoc | undefined {
  return index().agents.get(agentId);
}

export function agentLocsForTeam(teamId: string): AgentLoc[] {
  return [...index().agents.values()].filter((a) => a.teamId === teamId);
}

export function allAgentLocs(): AgentLoc[] {
  return [...index().agents.values()];
}

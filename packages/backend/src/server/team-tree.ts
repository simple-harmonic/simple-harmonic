// ---------------------------------------------------------------------------
// Team tree helpers: queries for the recursive team hierarchy.
//
// Teams form a tree via parent_team_id. These functions resolve ancestry,
// sub-trees, and authorization scoping for lead agents.
// ---------------------------------------------------------------------------

import { eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { teams } from "./db/schema";

type TeamRow = typeof teams.$inferSelect;

/**
 * Get all teams in the database (cheap for the expected scale of <100 teams).
 * The tree is small enough that in-memory traversal beats recursive SQL.
 */
async function allTeams(): Promise<TeamRow[]> {
  const d = db();
  return d.query.teams.findMany();
}

/**
 * Get the direct children of a team.
 */
export async function getChildTeams(teamId: string): Promise<TeamRow[]> {
  const d = db();
  return d.query.teams.findMany({
    where: eq(teams.parentTeamId, teamId),
  });
}

/**
 * Get all root teams (no parent).
 */
export async function getRootTeams(): Promise<TeamRow[]> {
  const d = db();
  return d.query.teams.findMany({
    where: isNull(teams.parentTeamId),
  });
}

/**
 * Get all team IDs in the sub-tree rooted at `teamId`, inclusive.
 * Used for authorization scoping: a lead agent can only manage
 * teams and agents within its sub-tree.
 */
export async function getSubTreeIds(teamId: string): Promise<Set<string>> {
  const all = await allTeams();
  const childMap = new Map<string, string[]>();
  for (const t of all) {
    if (t.parentTeamId) {
      const children = childMap.get(t.parentTeamId) ?? [];
      children.push(t.id);
      childMap.set(t.parentTeamId, children);
    }
  }

  const result = new Set<string>();
  const stack = [teamId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    result.add(id);
    const children = childMap.get(id) ?? [];
    stack.push(...children);
  }

  return result;
}

/**
 * Check if `ancestorId` is an ancestor of `teamId` (or equal to it).
 */
export async function isAncestor(ancestorId: string, teamId: string): Promise<boolean> {
  if (ancestorId === teamId) return true;
  const all = await allTeams();
  const parentMap = new Map(all.map((t) => [t.id, t.parentTeamId]));

  let current = teamId;
  const visited = new Set<string>();
  while (current) {
    if (current === ancestorId) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    const parent = parentMap.get(current);
    if (!parent) return false;
    current = parent;
  }
  return false;
}

/**
 * Get the full ancestor chain from teamId up to the root.
 * Returns [teamId, parentId, grandparentId, ...rootId].
 */
export async function getAncestorChain(teamId: string): Promise<string[]> {
  const all = await allTeams();
  const parentMap = new Map(all.map((t) => [t.id, t.parentTeamId]));

  const chain: string[] = [];
  let current: string | null = teamId;
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current)) break;
    visited.add(current);
    chain.push(current);
    current = parentMap.get(current) ?? null;
  }
  return chain;
}

/**
 * Build a tree structure for display purposes.
 */
export async function getTeamTree(): Promise<TeamTreeNode[]> {
  const all = await allTeams();
  const childMap = new Map<string | null, TeamRow[]>();
  for (const t of all) {
    const key = t.parentTeamId ?? null;
    const list = childMap.get(key) ?? [];
    list.push(t);
    childMap.set(key, list);
  }

  function buildNode(team: TeamRow): TeamTreeNode {
    const children = (childMap.get(team.id) ?? []).map(buildNode);
    return { id: team.id, name: team.name, paused: team.paused, children };
  }

  const roots = childMap.get(null) ?? [];
  return roots.map(buildNode);
}

export interface TeamTreeNode {
  id: string;
  name: string;
  paused: boolean;
  children: TeamTreeNode[];
}

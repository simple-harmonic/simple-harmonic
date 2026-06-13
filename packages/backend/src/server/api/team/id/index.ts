import { agents, teams } from "../../../store";
import type { Team } from "../../../store";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const team = await teams.byId(id);
  if (!team) return Response.json({ error: "not found" }, { status: 404 });

  // Get direct agents for this team
  const teamAgents = await agents.byTeam(id);

  // Get child teams and their agents for the sub-tree view
  const allTeams = await teams.all();
  const subTreeIds = getSubTreeIds(id, allTeams);
  subTreeIds.delete(id);

  let childTeams: Team[] = [];
  let childAgents: typeof teamAgents = [];
  if (subTreeIds.size > 0) {
    childTeams = allTeams.filter((t) => subTreeIds.has(t.id));
    childAgents = await agents.byTeams(subTreeIds);
  }

  return Response.json({
    team,
    agents: teamAgents,
    childTeams,
    childAgents,
  });
}

function getSubTreeIds(
  rootId: string,
  allTeams: Array<{ id: string; parentTeamId: string | null }>,
): Set<string> {
  const childMap = new Map<string, string[]>();
  for (const t of allTeams) {
    if (t.parentTeamId) {
      const list = childMap.get(t.parentTeamId) ?? [];
      list.push(t.id);
      childMap.set(t.parentTeamId, list);
    }
  }
  const result = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    result.add(id);
    stack.push(...(childMap.get(id) ?? []));
  }
  return result;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as Record<string, unknown>;

  const allowed = ["name", "metaAgentPrompt", "cofounderName"] as const;
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: "no valid fields" }, { status: 400 });
  }

  const updated = await teams.update(id, updates as Partial<Team>);
  if (!updated) return Response.json({ error: "not found" }, { status: 404 });

  return Response.json(updated);
}

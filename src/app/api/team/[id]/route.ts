import { db } from "@simple-harmonic/backend/server/db";
import { agents, teams } from "@simple-harmonic/backend/server/db/schema";
import { eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = db();

  const team = await d.query.teams.findFirst({ where: eq(teams.id, id) });
  if (!team) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Get direct agents for this team
  const teamAgents = await d.query.agents.findMany({ where: eq(agents.teamId, id) });

  // Get child teams and their agents for the sub-tree view
  const allTeams = await d.query.teams.findMany();
  const subTreeIds = getSubTreeIds(id, allTeams);
  subTreeIds.delete(id);

  let childTeams: typeof allTeams = [];
  let childAgents: typeof teamAgents = [];
  if (subTreeIds.size > 0) {
    const subIds = [...subTreeIds];
    childTeams = allTeams.filter((t) => subTreeIds.has(t.id));
    childAgents = await d.query.agents.findMany({
      where: inArray(agents.teamId, subIds),
    });
  }

  return NextResponse.json({
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
  const body = await req.json();

  const allowed = ["name", "metaAgentPrompt", "cofounderName"] as const;
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "no valid fields" }, { status: 400 });
  }

  const d = db();
  const [updated] = await d.update(teams).set(updates).where(eq(teams.id, id)).returning();
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json(updated);
}

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@simple-harmonic/backend/server/db";
import { agents, chatSessions, teams } from "@simple-harmonic/backend/server/db/schema";

interface SpawnAgent {
  name: string;
  role: string;
  archetype: string;
  tools: string[];
  schedule_seconds: number;
  initial_prompt: string;
}

interface SpawnPayload {
  agents: SpawnAgent[];
  teamName?: string;
  parentTeam?: string;
  parentTeamId?: string;
  cofounderName?: string | null;
}

export async function POST(request: Request) {
  const { agents: agentList, teamName, parentTeam, parentTeamId, cofounderName } =
    (await request.json()) as SpawnPayload;

  if (!agentList || !Array.isArray(agentList) || agentList.length === 0) {
    return NextResponse.json({ error: "agents required" }, { status: 400 });
  }

  const d = db();

  // Resolve parent team: by ID or by name
  let resolvedParentId: string | null = parentTeamId ?? null;
  if (!resolvedParentId && parentTeam) {
    const parent = await d.query.teams.findFirst({
      where: eq(teams.name, parentTeam),
    });
    if (!parent) {
      return NextResponse.json(
        { error: `Parent team "${parentTeam}" not found` },
        { status: 400 },
      );
    }
    resolvedParentId = parent.id;
  }

  const resolvedTeamName =
    teamName?.trim() ||
    agentList.map((a) => a.archetype).join("-").slice(0, 50);

  const [team] = await d
    .insert(teams)
    .values({
      name: resolvedTeamName,
      parentTeamId: resolvedParentId,
      cofounderName: cofounderName?.trim() || null,
    })
    .returning({ id: teams.id });

  await d.insert(chatSessions).values({ teamId: team.id });

  const now = new Date();
  await d.insert(agents).values(
    agentList.map((a, i) => ({
      teamId: team.id,
      name: a.name,
      role: a.role,
      archetype: a.archetype,
      tools: a.tools,
      scheduleSeconds: a.schedule_seconds,
      initialPrompt: a.initial_prompt,
      nextRunAt: new Date(now.getTime() + a.schedule_seconds * 1000 + i * 2000),
    })),
  );

  return NextResponse.json({ teamId: team.id, parentTeamId: resolvedParentId });
}

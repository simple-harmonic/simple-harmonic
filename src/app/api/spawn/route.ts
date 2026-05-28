import { NextResponse } from "next/server";
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
  cofounderName?: string | null;
}

export async function POST(request: Request) {
  const { agents: agentList, teamName, cofounderName } =
    (await request.json()) as SpawnPayload;

  if (!agentList || !Array.isArray(agentList) || agentList.length === 0) {
    return NextResponse.json({ error: "agents required" }, { status: 400 });
  }

  const d = db();

  // Prefer the planner-derived team name. Fall back to the legacy
  // archetype-join only if the client didn't provide one.
  const resolvedTeamName =
    teamName?.trim() ||
    agentList.map((a) => a.archetype).join("-").slice(0, 50);

  const [team] = await d
    .insert(teams)
    .values({
      name: resolvedTeamName,
      cofounderName: cofounderName?.trim() || null,
    })
    .returning({ id: teams.id });

  await d.insert(chatSessions).values({ teamId: team.id });

  const now = new Date();
  await d.insert(agents).values(
    agentList.map((a) => ({
      teamId: team.id,
      name: a.name,
      role: a.role,
      archetype: a.archetype,
      tools: a.tools,
      scheduleSeconds: a.schedule_seconds,
      initialPrompt: a.initial_prompt,
      nextRunAt: now,
    })),
  );

  return NextResponse.json({ teamId: team.id });
}

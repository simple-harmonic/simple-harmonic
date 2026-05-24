import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { agents, teams } from "@/server/db/schema";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = db();

  const team = await d.query.teams.findFirst({ where: eq(teams.id, id) });
  if (!team) return NextResponse.json({ error: "not found" }, { status: 404 });

  const teamAgents = await d.query.agents.findMany({ where: eq(agents.teamId, id) });

  return NextResponse.json({ team, agents: teamAgents });
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

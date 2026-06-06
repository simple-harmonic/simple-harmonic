import { db } from "@simple-harmonic/backend/server/db";
import { teams } from "@simple-harmonic/backend/server/db/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = db();

  const team = await d.query.teams.findFirst({ where: eq(teams.id, id) });
  if (!team) return NextResponse.json({ error: "not found" }, { status: 404 });

  const newPaused = !team.paused;
  await d.update(teams).set({ paused: newPaused }).where(eq(teams.id, id));

  return NextResponse.json({ paused: newPaused });
}

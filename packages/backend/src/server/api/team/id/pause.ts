import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { teams } from "../../../db/schema";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = db();

  const team = await d.query.teams.findFirst({ where: eq(teams.id, id) });
  if (!team) return Response.json({ error: "not found" }, { status: 404 });

  const newPaused = !team.paused;
  await d.update(teams).set({ paused: newPaused }).where(eq(teams.id, id));

  return Response.json({ paused: newPaused });
}

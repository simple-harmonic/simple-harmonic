import { teams } from "../../../store";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const team = await teams.byId(id);
  if (!team) return Response.json({ error: "not found" }, { status: 404 });

  const newPaused = !team.paused;
  await teams.update(id, { paused: newPaused });

  return Response.json({ paused: newPaused });
}

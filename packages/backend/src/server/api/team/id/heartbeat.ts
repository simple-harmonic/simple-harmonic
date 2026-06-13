import { teams } from "../../../store";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  await teams.update(id, { lastUserActiveAt: new Date() });

  return Response.json({ ok: true });
}

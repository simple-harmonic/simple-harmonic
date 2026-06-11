import { db } from "../../../db";
import { teams } from "../../../db/schema";
import { eq } from "drizzle-orm";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = db();

  await d.update(teams).set({ lastUserActiveAt: new Date() }).where(eq(teams.id, id));

  return Response.json({ ok: true });
}

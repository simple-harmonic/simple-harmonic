import { db } from "@simple-harmonic/backend/server/db";
import { teams } from "@simple-harmonic/backend/server/db/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = db();

  await d.update(teams).set({ lastUserActiveAt: new Date() }).where(eq(teams.id, id));

  return NextResponse.json({ ok: true });
}

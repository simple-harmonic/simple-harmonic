import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { teams } from "@/server/db/schema";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = db();

  await d.update(teams).set({ lastUserActiveAt: new Date() }).where(eq(teams.id, id));

  return NextResponse.json({ ok: true });
}

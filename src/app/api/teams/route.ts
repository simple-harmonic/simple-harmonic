import { db } from "@simple-harmonic/backend/server/db";
import { teams } from "@simple-harmonic/backend/server/db/schema";
import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function GET() {
  const d = db();
  const rows = await d.select().from(teams).orderBy(desc(teams.createdAt));
  return NextResponse.json(rows);
}

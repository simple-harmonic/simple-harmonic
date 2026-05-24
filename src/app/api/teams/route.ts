import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { teams } from "@/server/db/schema";

export async function GET() {
  const d = db();
  const rows = await d.select().from(teams).orderBy(desc(teams.createdAt));
  return NextResponse.json(rows);
}

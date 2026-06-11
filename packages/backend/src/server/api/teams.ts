import { desc } from "drizzle-orm";
import { db } from "../db";
import { teams } from "../db/schema";

export async function GET() {
  const d = db();
  const rows = await d.select().from(teams).orderBy(desc(teams.createdAt));
  return Response.json(rows);
}

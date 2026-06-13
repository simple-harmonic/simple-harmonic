import { teams } from "../store";

export async function GET() {
  const rows = await teams.all(); // oldest-first
  rows.reverse(); // newest-first, matching the old ORDER BY created_at DESC
  return Response.json(rows);
}

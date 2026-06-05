import { NextResponse } from "next/server";
import { db } from "@simple-harmonic/backend/server/db";
import { teams } from "@simple-harmonic/backend/server/db/schema";
import { eq } from "drizzle-orm";
import { invalidateTelemetryCache } from "@simple-harmonic/backend/server/app-events";

/**
 * GET /api/settings/telemetry?teamId=...
 * Returns the current telemetry setting for a team.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("teamId");

  if (!teamId) {
    return NextResponse.json({ error: "teamId required" }, { status: 400 });
  }

  try {
    const d = db();
    const team = await d.query.teams.findFirst({
      where: eq(teams.id, teamId),
      columns: { id: true, telemetryEnabled: true },
    });

    if (!team) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    return NextResponse.json({ teamId: team.id, telemetryEnabled: team.telemetryEnabled });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/settings/telemetry
 * Toggle telemetry for a team. Body: { teamId, enabled }
 */
export async function PUT(request: Request) {
  const body = await request.json().catch(() => null);

  if (!body || typeof body.teamId !== "string" || typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "Body must include teamId (string) and enabled (boolean)" },
      { status: 400 },
    );
  }

  try {
    const d = db();
    const updated = await d
      .update(teams)
      .set({ telemetryEnabled: body.enabled })
      .where(eq(teams.id, body.teamId))
      .returning({ id: teams.id });

    if (updated.length === 0) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    // Bust the cache so the next emitAppEvent picks up the change immediately
    invalidateTelemetryCache(body.teamId);

    return NextResponse.json({ ok: true, teamId: body.teamId, telemetryEnabled: body.enabled });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}

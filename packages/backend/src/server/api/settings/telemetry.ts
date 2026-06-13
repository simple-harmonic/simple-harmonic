import { invalidateTelemetryCache } from "../../app-events";
import { teams } from "../../store";

/**
 * GET /api/settings/telemetry?teamId=...
 * Returns the current telemetry setting for a team.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("teamId");

  if (!teamId) {
    return Response.json({ error: "teamId required" }, { status: 400 });
  }

  try {
    const team = await teams.byId(teamId);

    if (!team) {
      return Response.json({ error: "Team not found" }, { status: 404 });
    }

    return Response.json({ teamId: team.id, telemetryEnabled: team.telemetryEnabled });
  } catch (err) {
    return Response.json(
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
  const body = (await request.json().catch(() => null)) as {
    teamId?: unknown;
    enabled?: unknown;
  } | null;

  if (!body || typeof body.teamId !== "string" || typeof body.enabled !== "boolean") {
    return Response.json(
      { error: "Body must include teamId (string) and enabled (boolean)" },
      { status: 400 },
    );
  }

  try {
    const updated = await teams.update(body.teamId, { telemetryEnabled: body.enabled });

    if (!updated) {
      return Response.json({ error: "Team not found" }, { status: 404 });
    }

    // Bust the cache so the next emitAppEvent picks up the change immediately
    invalidateTelemetryCache(body.teamId);

    return Response.json({ ok: true, teamId: body.teamId, telemetryEnabled: body.enabled });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}

import { queryAppEvents } from "../app-events";
import { appEvents } from "../store";

const MAX_UNACKNOWLEDGED = 100;

/**
 * GET /api/infra-report
 * Founder-only: returns unacknowledged tool + infra events, capped at 100.
 */
export async function GET() {
  try {
    // Query tool and infra events (unacknowledged only), newest first
    const [infraEvents, toolEvents] = await Promise.all([
      queryAppEvents({
        level: "infra",
        includeInfra: true,
        unacknowledgedOnly: true,
        limit: MAX_UNACKNOWLEDGED,
      }),
      queryAppEvents({
        level: "tool",
        includeInfra: false,
        unacknowledgedOnly: true,
        limit: MAX_UNACKNOWLEDGED,
      }),
    ]);

    // Merge and sort by createdAt desc, cap at MAX_UNACKNOWLEDGED
    const all = [...infraEvents, ...toolEvents]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, MAX_UNACKNOWLEDGED);

    return Response.json({
      events: all.map((e) => ({
        id: e.id,
        level: e.level,
        severity: e.severity,
        source: e.source,
        message: e.message,
        metadata: e.metadata,
        agentId: e.agentId,
        teamId: e.teamId,
        createdAt: e.createdAt.toISOString(),
      })),
      total: all.length,
      infraCount: infraEvents.length,
      toolCount: toolEvents.length,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/infra-report
 * Acknowledge (dismiss) events. Body: { eventIds: string[] }
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { eventIds?: string[] } | null;

  if (!body || !Array.isArray(body.eventIds) || body.eventIds.length === 0) {
    return Response.json({ error: "eventIds array required" }, { status: 400 });
  }

  try {
    const acknowledged = await appEvents.acknowledge(body.eventIds);
    return Response.json({ ok: true, acknowledged });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}

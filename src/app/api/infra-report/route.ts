import { NextResponse } from "next/server";
import { db } from "@simple-harmonic/backend/server/db";
import { appEvents } from "@simple-harmonic/backend/server/db/schema";
import { queryAppEvents } from "@simple-harmonic/backend/server/app-events";
import { eq, inArray } from "drizzle-orm";

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

    return NextResponse.json({
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
    return NextResponse.json(
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
  const body = await request.json().catch(() => null);

  if (!body || !Array.isArray(body.eventIds) || body.eventIds.length === 0) {
    return NextResponse.json({ error: "eventIds array required" }, { status: 400 });
  }

  try {
    const d = db();
    await d
      .update(appEvents)
      .set({ acknowledgedAt: new Date() })
      .where(inArray(appEvents.id, body.eventIds));

    return NextResponse.json({ ok: true, acknowledged: body.eventIds.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}

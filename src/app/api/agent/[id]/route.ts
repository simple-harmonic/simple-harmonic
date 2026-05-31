import { db } from "@simple-harmonic/backend/server/db";
import { agents } from "@simple-harmonic/backend/server/db/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

const PUBLIC_STATUSES = new Set(["running", "paused", "errored"]);

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();

  if ("status" in body && !PUBLIC_STATUSES.has(String(body.status))) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }

  const allowed = [
    "name",
    "role",
    "archetype",
    "tools",
    "scheduleSeconds",
    "initialPrompt",
    "status",
  ] as const;
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  // Special action: wake — schedule the agent to run on the next tick.
  // Resets nextRunAt to now, and if currently paused, marks it running so the
  // tick loop will pick it up.
  if (body.wake === true) {
    updates.nextRunAt = new Date();
    if (!("status" in updates)) updates.status = "running";
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "no valid fields" }, { status: 400 });
  }

  const d = db();
  const current = await d.query.agents.findFirst({
    where: eq(agents.id, id),
  });
  if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (current.status === "awaiting_approval" && (body.wake === true || "status" in updates)) {
    return NextResponse.json(
      { error: "agent is awaiting approval; resolve or reject the pending action first" },
      { status: 409 },
    );
  }

  const [updated] = await d.update(agents).set(updates).where(eq(agents.id, id)).returning();
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json(updated);
}

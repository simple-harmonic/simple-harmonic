import { agents } from "../../store";
import type { Agent } from "../../store";

const PUBLIC_STATUSES = new Set(["running", "paused", "errored"]);

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as Record<string, unknown>;

  if ("status" in body && !PUBLIC_STATUSES.has(String(body.status))) {
    return Response.json({ error: "invalid status" }, { status: 400 });
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
    return Response.json({ error: "no valid fields" }, { status: 400 });
  }

  const current = await agents.byId(id);
  if (!current) return Response.json({ error: "not found" }, { status: 404 });

  if (current.status === "awaiting_approval" && (body.wake === true || "status" in updates)) {
    return Response.json(
      { error: "agent is awaiting approval; resolve or reject the pending action first" },
      { status: 409 },
    );
  }

  const updated = await agents.update(id, updates as Partial<Agent>);
  if (!updated) return Response.json({ error: "not found" }, { status: 404 });

  return Response.json(updated);
}

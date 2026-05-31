import { db } from "@simple-harmonic/backend/server/db";
import { agents, pendingApprovals, teams } from "@simple-harmonic/backend/server/db/schema";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

// GET /api/team/[id]/approvals — list pending approvals for the team's agents.
// Powers the approval queue in the team view.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = db();

  const rows = await d.query.pendingApprovals.findMany({
    where: and(eq(pendingApprovals.teamId, id), eq(pendingApprovals.status, "pending")),
  });

  return NextResponse.json({
    approvals: rows.map((r) => ({
      id: r.id,
      agentId: r.agentId,
      toolName: r.toolName,
      toolArguments: r.toolArguments,
      createdAt: r.createdAt,
    })),
  });
}

interface DecisionBody {
  approvalId: string;
  decision: "approved" | "rejected";
  note?: string;
}

// POST /api/team/[id]/approvals — resolve one pending approval.
// Body: { approvalId, decision: "approved" | "rejected", note? }
// The next tick picks up the resolved row and resumes the agent.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as DecisionBody;

  if (!body.approvalId || (body.decision !== "approved" && body.decision !== "rejected")) {
    return NextResponse.json(
      { error: "approvalId and decision ('approved'|'rejected') are required" },
      { status: 400 },
    );
  }

  const d = db();

  const row = await d.query.pendingApprovals.findFirst({
    where: and(eq(pendingApprovals.id, body.approvalId), eq(pendingApprovals.teamId, id)),
  });
  if (!row) {
    return NextResponse.json({ error: "approval not found" }, { status: 404 });
  }
  if (row.status !== "pending") {
    return NextResponse.json({ error: `approval already ${row.status}` }, { status: 409 });
  }

  const decidedAt = new Date();
  const [resolved] = await d
    .update(pendingApprovals)
    .set({
      status: body.decision,
      decisionNote: body.note ?? null,
      resolvedAt: decidedAt,
    })
    .where(
      and(
        eq(pendingApprovals.id, body.approvalId),
        eq(pendingApprovals.teamId, id),
        eq(pendingApprovals.status, "pending"),
      ),
    )
    .returning({ agentId: pendingApprovals.agentId });
  if (!resolved) {
    return NextResponse.json({ error: "approval already resolved" }, { status: 409 });
  }

  // Touch the agent so the resume pass re-checks it promptly. We don't change
  // status here — the tick route owns the parked -> running transition once all
  // approvals for the agent are resolved.
  await d.update(agents).set({ inFlight: false }).where(eq(agents.id, resolved.agentId));
  await d.update(teams).set({ lastUserActiveAt: decidedAt }).where(eq(teams.id, id));

  return NextResponse.json({ ok: true, decision: body.decision });
}

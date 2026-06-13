import { agents, approvals, teams } from "../../../store";

// GET /api/team/[id]/approvals — list pending approvals for the team's agents.
// Powers the approval queue in the team view.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const rows = await approvals.pendingForTeam(id);

  return Response.json({
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
    return Response.json(
      { error: "approvalId and decision ('approved'|'rejected') are required" },
      { status: 400 },
    );
  }

  const decidedAt = new Date();
  const result = await approvals.resolve(id, body.approvalId, body.decision, body.note ?? null);
  if (!result.ok) {
    return result.reason === "not_found"
      ? Response.json({ error: "approval not found" }, { status: 404 })
      : Response.json({ error: "approval already resolved" }, { status: 409 });
  }

  // Touch the agent so the resume pass re-checks it promptly. We don't change
  // status here — the tick route owns the parked -> running transition once all
  // approvals for the agent are resolved.
  await agents.update(result.agentId, { inFlight: false });
  await teams.update(id, { lastUserActiveAt: decidedAt });

  return Response.json({ ok: true, decision: body.decision });
}

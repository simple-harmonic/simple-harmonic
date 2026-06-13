import { describe, expect, it } from "vitest";
import { agents, approvals, teams } from "@/server/store";
import { useTempStore } from "../helpers/store";

function makeParams(teamId: string) {
  return { params: Promise.resolve({ id: teamId }) };
}

function postReq(teamId: string, body: unknown): Request {
  return new Request(`http://localhost/api/team/${teamId}/approvals`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

/** Seed a team + agent and append one pending approval; return ids. */
async function seedApproval(overrides: { toolName?: string } = {}) {
  const team = await teams.insert({ name: "Approvals Team" });
  const agent = await agents.insert(team.id, {
    name: "Worker",
    role: "dev",
    archetype: "researcher",
    tools: [],
    scheduleSeconds: 10,
    initialPrompt: "Work",
  });
  await approvals.insertMany(agent.id, [
    {
      teamId: team.id,
      toolCallId: "call-1",
      toolName: overrides.toolName ?? "write_file",
      toolArguments: '{"path":"x"}',
    },
  ]);
  const [row] = await approvals.byAgent(agent.id);
  return { team, agent, approval: row };
}

// ---------------------------------------------------------------------------
// GET — list pending approvals
// ---------------------------------------------------------------------------

describe("GET /api/team/[id]/approvals", () => {
  useTempStore();

  it("returns the team's pending approvals", async () => {
    const { GET } = await import("@/server/api/team/id/approvals");
    const { team, agent, approval } = await seedApproval();

    const res = await GET(new Request("http://localhost"), makeParams(team.id));
    const body = (await res.json()) as {
      approvals: Array<{ id: string; agentId: string; toolName: string }>;
    };

    expect(res.status).toBe(200);
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]).toMatchObject({
      id: approval.id,
      agentId: agent.id,
      toolName: "write_file",
    });
  });

  it("returns an empty list when nothing is pending", async () => {
    const { GET } = await import("@/server/api/team/id/approvals");
    const team = await teams.insert({ name: "Empty" });

    const res = await GET(new Request("http://localhost"), makeParams(team.id));
    const body = (await res.json()) as { approvals: unknown[] };

    expect(body.approvals).toEqual([]);
  });

  it("excludes already-resolved approvals", async () => {
    const { GET } = await import("@/server/api/team/id/approvals");
    const { team, approval } = await seedApproval();
    await approvals.resolve(team.id, approval.id, "approved", null);

    const res = await GET(new Request("http://localhost"), makeParams(team.id));
    const body = (await res.json()) as { approvals: unknown[] };

    expect(body.approvals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST — resolve an approval
// ---------------------------------------------------------------------------

describe("POST /api/team/[id]/approvals", () => {
  useTempStore();

  it("400s on a missing/invalid decision", async () => {
    const { POST } = await import("@/server/api/team/id/approvals");
    const { team, approval } = await seedApproval();

    const res = await POST(postReq(team.id, { approvalId: approval.id, decision: "maybe" }), makeParams(team.id));
    expect(res.status).toBe(400);
  });

  it("404s when the approval doesn't exist for the team", async () => {
    const { POST } = await import("@/server/api/team/id/approvals");
    const { team } = await seedApproval();

    const res = await POST(
      postReq(team.id, { approvalId: "nonexistent", decision: "approved" }),
      makeParams(team.id),
    );
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(404);
    expect(body.error).toBe("approval not found");
  });

  it("approves a pending row and marks it resolved", async () => {
    const { POST } = await import("@/server/api/team/id/approvals");
    const { team, agent, approval } = await seedApproval();

    const res = await POST(
      postReq(team.id, { approvalId: approval.id, decision: "approved" }),
      makeParams(team.id),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, decision: "approved" });

    const [stored] = await approvals.byAgent(agent.id);
    expect(stored.status).toBe("approved");
    expect(stored.resolvedAt).toBeInstanceOf(Date);
  });

  it("stores the rejection note", async () => {
    const { POST } = await import("@/server/api/team/id/approvals");
    const { team, agent, approval } = await seedApproval();

    await POST(
      postReq(team.id, { approvalId: approval.id, decision: "rejected", note: "no thanks" }),
      makeParams(team.id),
    );

    const [stored] = await approvals.byAgent(agent.id);
    expect(stored.status).toBe("rejected");
    expect(stored.decisionNote).toBe("no thanks");
  });

  it("409s when the approval is already resolved", async () => {
    const { POST } = await import("@/server/api/team/id/approvals");
    const { team, approval } = await seedApproval();

    // First resolution succeeds.
    const first = await POST(
      postReq(team.id, { approvalId: approval.id, decision: "approved" }),
      makeParams(team.id),
    );
    expect(first.status).toBe(200);

    // Second resolution of the same row is a conflict.
    const second = await POST(
      postReq(team.id, { approvalId: approval.id, decision: "approved" }),
      makeParams(team.id),
    );
    const body = (await second.json()) as { error?: string };

    expect(second.status).toBe(409);
    expect(body.error).toBe("approval already resolved");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUpdateReturning = vi.fn();
const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

const mockDb = {
  query: {
    pendingApprovals: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
  update: mockUpdate,
};

vi.mock("@/server/db", () => ({
  db: () => mockDb,
}));

vi.mock("@/server/db/schema", () => ({
  agents: { id: "agents.id" },
  teams: { id: "teams.id" },
  pendingApprovals: {
    id: "pending_approvals.id",
    agentId: "pending_approvals.agentId",
    teamId: "pending_approvals.teamId",
    status: "pending_approvals.status",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ _eq: val })),
  and: vi.fn((...clauses: unknown[]) => ({ _and: clauses })),
}));

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/team/team-1/approvals", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const params = Promise.resolve({ id: "team-1" });

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockReturnValue({ set: mockUpdateSet });
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateReturning.mockResolvedValue([{ agentId: "agent-1" }]);
  mockUpdateWhere.mockImplementation(() => {
    const result = Promise.resolve(undefined) as Promise<undefined> & {
      returning: typeof mockUpdateReturning;
    };
    result.returning = mockUpdateReturning;
    return result;
  });
});

// ---------------------------------------------------------------------------
// GET — list pending approvals
// ---------------------------------------------------------------------------

describe("GET /api/team/[id]/approvals", () => {
  it("returns the team's pending approvals", async () => {
    const { GET } = await import("@/server/api/team/id/approvals");
    mockDb.query.pendingApprovals.findMany.mockResolvedValueOnce([
      {
        id: "ap-1",
        agentId: "agent-1",
        toolName: "write_file",
        toolArguments: '{"path":"x"}',
        createdAt: new Date("2026-05-30T00:00:00Z"),
      },
    ]);

    const res = await GET(new Request("http://localhost"), { params });
    const body = (await res.json()) as { approvals: unknown[] };

    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]).toMatchObject({
      id: "ap-1",
      agentId: "agent-1",
      toolName: "write_file",
    });
  });
});

// ---------------------------------------------------------------------------
// POST — resolve an approval
// ---------------------------------------------------------------------------

describe("POST /api/team/[id]/approvals", () => {
  it("400s on a missing/invalid decision", async () => {
    const { POST } = await import("@/server/api/team/id/approvals");
    const res = await POST(makeReq({ approvalId: "ap-1", decision: "maybe" }), { params });
    expect(res.status).toBe(400);
  });

  it("404s when the approval doesn't exist for the team", async () => {
    const { POST } = await import("@/server/api/team/id/approvals");
    mockDb.query.pendingApprovals.findFirst.mockResolvedValueOnce(undefined);
    const res = await POST(makeReq({ approvalId: "ap-x", decision: "approved" }), { params });
    expect(res.status).toBe(404);
  });

  it("409s when the approval is already resolved", async () => {
    const { POST } = await import("@/server/api/team/id/approvals");
    mockDb.query.pendingApprovals.findFirst.mockResolvedValueOnce({
      id: "ap-1",
      agentId: "agent-1",
      teamId: "team-1",
      status: "approved",
    });
    const res = await POST(makeReq({ approvalId: "ap-1", decision: "approved" }), { params });
    expect(res.status).toBe(409);
  });

  it("approves a pending row and sets status + resolvedAt", async () => {
    const { POST } = await import("@/server/api/team/id/approvals");
    mockDb.query.pendingApprovals.findFirst.mockResolvedValueOnce({
      id: "ap-1",
      agentId: "agent-1",
      teamId: "team-1",
      status: "pending",
    });

    const res = await POST(makeReq({ approvalId: "ap-1", decision: "approved" }), { params });
    const body = await res.json();

    expect(body).toEqual({ ok: true, decision: "approved" });
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "approved", resolvedAt: expect.any(Date) }),
    );
    expect(mockUpdateReturning).toHaveBeenCalledWith({ agentId: "pending_approvals.agentId" });
  });

  it("stores the rejection note", async () => {
    const { POST } = await import("@/server/api/team/id/approvals");
    mockDb.query.pendingApprovals.findFirst.mockResolvedValueOnce({
      id: "ap-1",
      agentId: "agent-1",
      teamId: "team-1",
      status: "pending",
    });

    await POST(
      makeReq({ approvalId: "ap-1", decision: "rejected", note: "no thanks" }),
      { params },
    );

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rejected", decisionNote: "no thanks" }),
    );
  });

  it("409s when the pending row is resolved concurrently", async () => {
    const { POST } = await import("@/server/api/team/id/approvals");
    mockDb.query.pendingApprovals.findFirst.mockResolvedValueOnce({
      id: "ap-1",
      agentId: "agent-1",
      teamId: "team-1",
      status: "pending",
    });
    mockUpdateReturning.mockResolvedValueOnce([]);

    const res = await POST(makeReq({ approvalId: "ap-1", decision: "approved" }), { params });

    expect(res.status).toBe(409);
  });
});

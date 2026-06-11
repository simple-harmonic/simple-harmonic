import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLimit = vi.fn().mockResolvedValue([]);
const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

const mockDb = {
  query: {
    teams: { findFirst: vi.fn() },
    agents: { findMany: vi.fn() },
  },
  select: mockSelect,
  from: mockFrom,
  where: mockWhere,
  orderBy: mockOrderBy,
  limit: mockLimit,
};

vi.mock("@/server/db", () => ({
  db: () => mockDb,
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ _eq: val })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  or: vi.fn((...args: unknown[]) => ({ _or: args })),
}));

vi.mock("@/server/db/schema", () => ({
  teams: { id: "teams.id" },
  agents: { teamId: "agents.teamId" },
  a2axTasks: {
    teamId: "a2axTasks.teamId",
    requestorId: "a2axTasks.requestorId",
    assigneeId: "a2axTasks.assigneeId",
    updatedAt: "a2axTasks.updatedAt",
  },
}));

vi.mock("@/lib/meta-agent/identity", () => ({
  COFOUNDER_AGENT_ID: "00000000-0000-0000-0000-00000000c0f0",
  COFOUNDER_POV: "cofounder",
  USER_AGENT_ID: "00000000-0000-0000-0000-00000000fffe",
  USER_DISPLAY_NAME: "You",
  USER_POV: "user",
  resolveCofounderName: (name: string | null | undefined) =>
    name?.trim() || "Harmon",
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = "team-1";
const COFOUNDER_AGENT_ID = "00000000-0000-0000-0000-00000000c0f0";
const USER_AGENT_ID = "00000000-0000-0000-0000-00000000fffe";
const AGENT_A_ID = "aaaa-1111";
const AGENT_B_ID = "bbbb-2222";

const teamRow = {
  id: TEAM_ID,
  name: "Test Team",
  cofounderName: null,
};

const agentRows = [
  { id: AGENT_A_ID, name: "Researcher", teamId: TEAM_ID },
  { id: AGENT_B_ID, name: "Writer", teamId: TEAM_ID },
];

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    title: "Research market trends",
    description: "Analyze Q4 data",
    state: "submitted",
    requestorId: AGENT_A_ID,
    assigneeId: AGENT_B_ID,
    teamId: TEAM_ID,
    channelId: "task:task-1",
    metadata: null,
    createdAt: new Date("2026-05-20T10:00:00Z"),
    updatedAt: new Date("2026-05-20T12:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(agentId?: string): Request {
  const url = agentId
    ? `http://localhost/api/team/team-1/tasks?agentId=${agentId}`
    : "http://localhost/api/team/team-1/tasks";
  return new Request(url);
}

function makeParams(id = "team-1") {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Re-wire chained mocks after clear
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ orderBy: mockOrderBy });
  mockOrderBy.mockReturnValue({ limit: mockLimit });
  mockLimit.mockResolvedValue([]);
});

// ===========================================================================
// GET /api/team/[id]/tasks
// ===========================================================================

describe("GET /api/team/[id]/tasks", () => {
  it("returns 400 when agentId is missing", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");

    const res = await GET(makeReq(), makeParams());
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("agentId query param required");
  });

  it("returns empty array when no tasks exist", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");

    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);
    mockLimit.mockResolvedValueOnce([]);

    const res = await GET(makeReq(AGENT_A_ID), makeParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });

  it("'team' agentId returns all tasks for the team", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");

    const tasks = [
      makeTask({ id: "t1" }),
      makeTask({ id: "t2", requestorId: AGENT_B_ID, assigneeId: AGENT_A_ID }),
    ];
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);
    mockLimit.mockResolvedValueOnce(tasks);

    const res = await GET(makeReq("team"), makeParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
  });

  it("translates 'cofounder' agentId to COFOUNDER_AGENT_ID", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");

    const task = makeTask({
      requestorId: COFOUNDER_AGENT_ID,
      assigneeId: AGENT_A_ID,
    });
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);
    mockLimit.mockResolvedValueOnce([task]);

    const res = await GET(makeReq("cofounder"), makeParams());
    const body = (await res.json()) as Array<{ requestorName: string }>;

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].requestorName).toBe("Harmon");
  });

  it("translates 'user' agentId to USER_AGENT_ID", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");

    const task = makeTask({
      requestorId: USER_AGENT_ID,
      assigneeId: AGENT_A_ID,
    });
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);
    mockLimit.mockResolvedValueOnce([task]);

    const res = await GET(makeReq("user"), makeParams());
    const body = (await res.json()) as Array<{ requestorName: string }>;

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].requestorName).toBe("You");
  });

  it("enriches tasks with requestorName and assigneeName", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");

    const task = makeTask({
      requestorId: AGENT_A_ID,
      assigneeId: AGENT_B_ID,
    });
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);
    mockLimit.mockResolvedValueOnce([task]);

    const res = await GET(makeReq("team"), makeParams());
    const body = (await res.json()) as Array<{ requestorName: string; assigneeName: string }>;

    expect(body[0].requestorName).toBe("Researcher");
    expect(body[0].assigneeName).toBe("Writer");
  });

  it("falls back to raw ID when agent name is not in the name map", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");

    const unknownRequestorId = "unknown-req-xxx";
    const unknownAssigneeId = "unknown-asgn-yyy";
    const task = makeTask({
      requestorId: unknownRequestorId,
      assigneeId: unknownAssigneeId,
    });
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);
    mockLimit.mockResolvedValueOnce([task]);

    const res = await GET(makeReq("team"), makeParams());
    const body = (await res.json()) as Array<{ requestorName: string; assigneeName: string }>;

    expect(body[0].requestorName).toBe(unknownRequestorId);
    expect(body[0].assigneeName).toBe(unknownAssigneeId);
  });

  it("includes all expected fields in enriched task", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");

    const task = makeTask({
      id: "task-full",
      title: "Build feature X",
      description: "Build and test feature X",
      state: "working",
      requestorId: AGENT_A_ID,
      assigneeId: AGENT_B_ID,
      createdAt: new Date("2026-05-20T10:00:00Z"),
      updatedAt: new Date("2026-05-20T14:00:00Z"),
    });
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);
    mockLimit.mockResolvedValueOnce([task]);

    const res = await GET(makeReq("team"), makeParams());
    const body = (await res.json()) as Array<{
      id: string;
      title: string;
      description: string;
      state: string;
      requestorId: string;
      requestorName: string;
      assigneeId: string;
      assigneeName: string;
      createdAt: string;
      updatedAt: string;
    }>;

    const t = body[0];
    expect(t.id).toBe("task-full");
    expect(t.title).toBe("Build feature X");
    expect(t.description).toBe("Build and test feature X");
    expect(t.state).toBe("working");
    expect(t.requestorId).toBe(AGENT_A_ID);
    expect(t.requestorName).toBe("Researcher");
    expect(t.assigneeId).toBe(AGENT_B_ID);
    expect(t.assigneeName).toBe("Writer");
    expect(t.createdAt).toBe("2026-05-20T10:00:00.000Z");
    expect(t.updatedAt).toBe("2026-05-20T14:00:00.000Z");
  });

  it("serializes createdAt and updatedAt as ISO strings", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");

    const task = makeTask({
      createdAt: new Date("2026-05-20T09:00:00Z"),
      updatedAt: new Date("2026-05-21T18:30:00Z"),
    });
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);
    mockLimit.mockResolvedValueOnce([task]);

    const res = await GET(makeReq("team"), makeParams());
    const body = (await res.json()) as Array<{ createdAt: string; updatedAt: string }>;

    expect(body[0].createdAt).toBe("2026-05-20T09:00:00.000Z");
    expect(body[0].updatedAt).toBe("2026-05-21T18:30:00.000Z");
  });

  it("uses custom cofounder name from team row in the name map", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");

    const task = makeTask({
      requestorId: COFOUNDER_AGENT_ID,
      assigneeId: AGENT_A_ID,
    });
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce({
      ...teamRow,
      cofounderName: "Ada",
    });
    mockLimit.mockResolvedValueOnce([task]);

    const res = await GET(makeReq("team"), makeParams());
    const body = (await res.json()) as Array<{ requestorName: string }>;

    expect(body[0].requestorName).toBe("Ada");
  });

  it("USER_AGENT_ID resolves to 'You' in the name map", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");

    const task = makeTask({
      requestorId: AGENT_A_ID,
      assigneeId: USER_AGENT_ID,
    });
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);
    mockLimit.mockResolvedValueOnce([task]);

    const res = await GET(makeReq("team"), makeParams());
    const body = (await res.json()) as Array<{ assigneeName: string }>;

    expect(body[0].assigneeName).toBe("You");
  });

  it("handles specific agent filtering (non-team, non-sentinel)", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");

    const task = makeTask({
      requestorId: AGENT_A_ID,
      assigneeId: AGENT_B_ID,
    });
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);
    mockLimit.mockResolvedValueOnce([task]);

    const res = await GET(makeReq(AGENT_A_ID), makeParams());
    const body = (await res.json()) as Array<{ requestorId: string }>;

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    // The DB query filters by requestorId or assigneeId matching AGENT_A_ID
    expect(body[0].requestorId).toBe(AGENT_A_ID);
  });

  it("returns multiple enriched tasks", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");

    const tasks = [
      makeTask({
        id: "t1",
        title: "Task 1",
        requestorId: AGENT_A_ID,
        assigneeId: AGENT_B_ID,
      }),
      makeTask({
        id: "t2",
        title: "Task 2",
        requestorId: AGENT_B_ID,
        assigneeId: AGENT_A_ID,
      }),
      makeTask({
        id: "t3",
        title: "Task 3",
        requestorId: COFOUNDER_AGENT_ID,
        assigneeId: USER_AGENT_ID,
      }),
    ];
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);
    mockLimit.mockResolvedValueOnce(tasks);

    const res = await GET(makeReq("team"), makeParams());
    const body = (await res.json()) as Array<{ requestorName: string; assigneeName: string }>;

    expect(body).toHaveLength(3);
    expect(body[0].requestorName).toBe("Researcher");
    expect(body[0].assigneeName).toBe("Writer");
    expect(body[1].requestorName).toBe("Writer");
    expect(body[1].assigneeName).toBe("Researcher");
    expect(body[2].requestorName).toBe("Harmon");
    expect(body[2].assigneeName).toBe("You");
  });

  it("uses the correct teamId from route params", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");

    mockDb.query.agents.findMany.mockResolvedValueOnce([]);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);
    mockLimit.mockResolvedValueOnce([]);

    await GET(makeReq("team"), makeParams("custom-team-99"));

    expect(mockDb.query.agents.findMany).toHaveBeenCalled();
    expect(mockDb.query.teams.findFirst).toHaveBeenCalled();
  });
});

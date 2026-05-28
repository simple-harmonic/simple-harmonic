import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockReturning = vi.fn().mockResolvedValue([]);
const mockWhereOnUpdate = vi.fn().mockReturnValue({ returning: mockReturning });
const mockSet = vi.fn().mockReturnValue({ where: mockWhereOnUpdate });
const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

const mockDb = {
  query: {
    teams: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    agents: {
      findMany: vi.fn(),
    },
  },
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockResolvedValue([]),
  update: mockUpdate,
  insert: vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([]),
    }),
  }),
};

vi.mock("@/server/db", () => ({
  db: () => mockDb,
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ _eq: val })),
  desc: vi.fn((col: unknown) => ({ _desc: col })),
}));

vi.mock("@/server/db/schema", () => ({
  teams: { id: "teams.id", createdAt: "teams.createdAt" },
  agents: { teamId: "agents.teamId" },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/team/team-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const TEAM_ID = "team-1";

const sampleTeam = {
  id: TEAM_ID,
  name: "Test Team",
  paused: false,
  tickCount: 0,
  metaAgentPrompt: null,
  cofounderName: null,
  lastUserActiveAt: new Date("2026-05-20T00:00:00Z"),
  createdAt: new Date("2026-05-19T00:00:00Z"),
};

const sampleAgent = {
  id: "agent-1",
  teamId: TEAM_ID,
  name: "Researcher",
  role: "research",
  archetype: "researcher",
  tools: [],
  scheduleSeconds: 10,
  initialPrompt: "Do research",
  status: "running",
  nextRunAt: null,
  inFlight: false,
  createdAt: new Date("2026-05-19T00:00:00Z"),
};

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Re-wire the chained mock returns after clearAllMocks
  mockUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({ where: mockWhereOnUpdate });
  mockWhereOnUpdate.mockReturnValue({ returning: mockReturning });
  mockReturning.mockResolvedValue([]);
  mockDb.select.mockReturnThis();
  mockDb.from.mockReturnThis();
  mockDb.orderBy.mockResolvedValue([]);
});

// ===========================================================================
// GET /api/teams
// ===========================================================================

describe("GET /api/teams", () => {
  it("returns all teams ordered by createdAt desc", async () => {
    const { GET } = await import("@/app/api/teams/route");
    const teamsList = [sampleTeam, { ...sampleTeam, id: "team-2", name: "Second" }];
    mockDb.orderBy.mockResolvedValueOnce(teamsList);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe(TEAM_ID);
    expect(mockDb.select).toHaveBeenCalled();
    expect(mockDb.from).toHaveBeenCalled();
    expect(mockDb.orderBy).toHaveBeenCalled();
  });

  it("returns empty array when no teams exist", async () => {
    const { GET } = await import("@/app/api/teams/route");
    mockDb.orderBy.mockResolvedValueOnce([]);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });
});

// ===========================================================================
// GET /api/team/[id]
// ===========================================================================

describe("GET /api/team/[id]", () => {
  it("returns team and agents when team exists", async () => {
    const { GET } = await import("@/app/api/team/[id]/route");
    mockDb.query.teams.findFirst.mockResolvedValueOnce(sampleTeam);
    mockDb.query.agents.findMany.mockResolvedValueOnce([sampleAgent]);

    const res = await GET(new Request("http://localhost"), makeParams(TEAM_ID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.team.id).toBe(TEAM_ID);
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].id).toBe("agent-1");
  });

  it("returns team with empty agents array", async () => {
    const { GET } = await import("@/app/api/team/[id]/route");
    mockDb.query.teams.findFirst.mockResolvedValueOnce(sampleTeam);
    mockDb.query.agents.findMany.mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost"), makeParams(TEAM_ID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.team.id).toBe(TEAM_ID);
    expect(body.agents).toEqual([]);
  });

  it("returns 404 when team not found", async () => {
    const { GET } = await import("@/app/api/team/[id]/route");
    mockDb.query.teams.findFirst.mockResolvedValueOnce(undefined);
    mockDb.query.agents.findMany.mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost"), makeParams("nonexistent"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("not found");
  });
});

// ===========================================================================
// PATCH /api/team/[id]
// ===========================================================================

describe("PATCH /api/team/[id]", () => {
  it("updates name field and returns updated team", async () => {
    const { PATCH } = await import("@/app/api/team/[id]/route");
    const updated = { ...sampleTeam, name: "Renamed" };
    mockReturning.mockResolvedValueOnce([updated]);

    const res = await PATCH(
      makeRequest({ name: "Renamed" }),
      makeParams(TEAM_ID),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.name).toBe("Renamed");
    expect(mockSet).toHaveBeenCalledWith({ name: "Renamed" });
  });

  it("updates metaAgentPrompt field", async () => {
    const { PATCH } = await import("@/app/api/team/[id]/route");
    const updated = { ...sampleTeam, metaAgentPrompt: "New prompt" };
    mockReturning.mockResolvedValueOnce([updated]);

    const res = await PATCH(
      makeRequest({ metaAgentPrompt: "New prompt" }),
      makeParams(TEAM_ID),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.metaAgentPrompt).toBe("New prompt");
    expect(mockSet).toHaveBeenCalledWith({ metaAgentPrompt: "New prompt" });
  });

  it("updates cofounderName field", async () => {
    const { PATCH } = await import("@/app/api/team/[id]/route");
    const updated = { ...sampleTeam, cofounderName: "Ada" };
    mockReturning.mockResolvedValueOnce([updated]);

    const res = await PATCH(
      makeRequest({ cofounderName: "Ada" }),
      makeParams(TEAM_ID),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.cofounderName).toBe("Ada");
    expect(mockSet).toHaveBeenCalledWith({ cofounderName: "Ada" });
  });

  it("updates multiple allowed fields at once", async () => {
    const { PATCH } = await import("@/app/api/team/[id]/route");
    const updated = { ...sampleTeam, name: "New", cofounderName: "Eve" };
    mockReturning.mockResolvedValueOnce([updated]);

    const res = await PATCH(
      makeRequest({ name: "New", cofounderName: "Eve" }),
      makeParams(TEAM_ID),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.name).toBe("New");
    expect(body.cofounderName).toBe("Eve");
    expect(mockSet).toHaveBeenCalledWith({ name: "New", cofounderName: "Eve" });
  });

  it("ignores disallowed fields and only applies allowed ones", async () => {
    const { PATCH } = await import("@/app/api/team/[id]/route");
    const updated = { ...sampleTeam, name: "Good" };
    mockReturning.mockResolvedValueOnce([updated]);

    const res = await PATCH(
      makeRequest({ name: "Good", paused: true, tickCount: 999 }),
      makeParams(TEAM_ID),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith({ name: "Good" });
  });

  it("returns 400 when no valid fields provided", async () => {
    const { PATCH } = await import("@/app/api/team/[id]/route");

    const res = await PATCH(
      makeRequest({ paused: true, tickCount: 5 }),
      makeParams(TEAM_ID),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("no valid fields");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 for empty body (no fields)", async () => {
    const { PATCH } = await import("@/app/api/team/[id]/route");

    const res = await PATCH(makeRequest({}), makeParams(TEAM_ID));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("no valid fields");
  });

  it("returns 404 when team to update not found", async () => {
    const { PATCH } = await import("@/app/api/team/[id]/route");
    mockReturning.mockResolvedValueOnce([]);

    const res = await PATCH(
      makeRequest({ name: "Ghost" }),
      makeParams("nonexistent"),
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("not found");
  });
});

// ===========================================================================
// POST /api/team/[id]/heartbeat
// ===========================================================================

describe("POST /api/team/[id]/heartbeat", () => {
  it("updates lastUserActiveAt and returns ok", async () => {
    const { POST } = await import("@/app/api/team/[id]/heartbeat/route");

    const res = await POST(new Request("http://localhost", { method: "POST" }), makeParams(TEAM_ID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ lastUserActiveAt: expect.any(Date) }),
    );
  });

  it("calls update with the correct team id", async () => {
    const { POST } = await import("@/app/api/team/[id]/heartbeat/route");

    await POST(new Request("http://localhost", { method: "POST" }), makeParams("team-99"));

    expect(mockWhereOnUpdate).toHaveBeenCalled();
  });
});

// ===========================================================================
// POST /api/team/[id]/pause
// ===========================================================================

describe("POST /api/team/[id]/pause", () => {
  it("toggles paused from false to true", async () => {
    const { POST } = await import("@/app/api/team/[id]/pause/route");
    mockDb.query.teams.findFirst.mockResolvedValueOnce({ ...sampleTeam, paused: false });

    const res = await POST(new Request("http://localhost", { method: "POST" }), makeParams(TEAM_ID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.paused).toBe(true);
    expect(mockSet).toHaveBeenCalledWith({ paused: true });
  });

  it("toggles paused from true to false", async () => {
    const { POST } = await import("@/app/api/team/[id]/pause/route");
    mockDb.query.teams.findFirst.mockResolvedValueOnce({ ...sampleTeam, paused: true });

    const res = await POST(new Request("http://localhost", { method: "POST" }), makeParams(TEAM_ID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.paused).toBe(false);
    expect(mockSet).toHaveBeenCalledWith({ paused: false });
  });

  it("returns 404 when team not found", async () => {
    const { POST } = await import("@/app/api/team/[id]/pause/route");
    mockDb.query.teams.findFirst.mockResolvedValueOnce(undefined);

    const res = await POST(new Request("http://localhost", { method: "POST" }), makeParams("ghost"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("not found");
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

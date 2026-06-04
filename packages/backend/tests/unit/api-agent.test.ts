import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockReturning = vi.fn();
const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

const mockInsertReturning = vi.fn();
const mockInsertValues = vi.fn().mockReturnValue({ returning: mockInsertReturning });
const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

const mockDb = {
  query: {
    agents: {
      findFirst: vi.fn(),
    },
  },
  update: mockUpdate,
  insert: mockInsert,
};

vi.mock("@/server/db", () => ({
  db: () => mockDb,
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock("@/server/db/schema", () => ({
  agents: { id: "agents.id" },
  teams: { id: "teams.id" },
  chatSessions: {},
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { PATCH } from "@/app/api/agent/[id]/route";
import { POST } from "@/app/api/spawn/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// PATCH /api/agent/[id]
// ---------------------------------------------------------------------------

describe("PATCH /api/agent/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.agents.findFirst.mockResolvedValue({ id: "agent-1", status: "running" });
    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: mockWhere });
  });

  it("updates a valid field and returns the updated agent", async () => {
    const agent = { id: "agent-1", name: "renamed", role: "dev" };
    mockReturning.mockResolvedValueOnce([agent]);

    const res = await PATCH(
      makeRequest({ name: "renamed" }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.name).toBe("renamed");
    expect(mockSet).toHaveBeenCalledWith({ name: "renamed" });
    expect(mockWhere).toHaveBeenCalledWith({ col: "agents.id", val: "agent-1" });
  });

  it("sets nextRunAt and status when wake=true", async () => {
    const agent = { id: "agent-1", status: "running", nextRunAt: new Date().toISOString() };
    mockReturning.mockResolvedValueOnce([agent]);

    const before = Date.now();
    const res = await PATCH(
      makeRequest({ wake: true }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(res.status).toBe(200);
    const setArg = mockSet.mock.calls[0][0];
    expect(setArg.status).toBe("running");
    expect(setArg.nextRunAt).toBeInstanceOf(Date);
    expect(setArg.nextRunAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("respects explicit status when wake=true", async () => {
    const agent = { id: "agent-1", status: "paused" };
    mockReturning.mockResolvedValueOnce([agent]);

    const res = await PATCH(
      makeRequest({ wake: true, status: "paused" }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(res.status).toBe(200);
    const setArg = mockSet.mock.calls[0][0];
    expect(setArg.status).toBe("paused");
    expect(setArg.nextRunAt).toBeInstanceOf(Date);
  });

  it("returns 400 when no valid fields are provided", async () => {
    const res = await PATCH(
      makeRequest({ bogus: "value" }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("no valid fields");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 for protected approval status writes", async () => {
    const res = await PATCH(
      makeRequest({ status: "awaiting_approval" }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(res.status).toBe(400);
    expect(mockDb.query.agents.findFirst).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("blocks wake/status changes while awaiting approval", async () => {
    mockDb.query.agents.findFirst.mockResolvedValueOnce({
      id: "agent-1",
      status: "awaiting_approval",
    });

    const res = await PATCH(
      makeRequest({ wake: true }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(res.status).toBe(409);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 when agent is not found", async () => {
    mockDb.query.agents.findFirst.mockResolvedValueOnce(undefined);

    const res = await PATCH(
      makeRequest({ name: "ghost" }),
      { params: Promise.resolve({ id: "no-such-id" }) },
    );

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("not found");
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/spawn
// ---------------------------------------------------------------------------

describe("POST /api/spawn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // insert(teams).values({...}).returning() needs to resolve to [{ id }].
    // insert(chatSessions).values({...}) and insert(agents).values([...])
    // are awaited directly (no .returning()).
    // So mockInsertValues must return a thenable that ALSO has .returning().
    mockInsertReturning.mockResolvedValue([{ id: "team-abc" }]);
    mockInsertValues.mockImplementation(() => {
      const result = Promise.resolve(undefined) as Promise<undefined> & {
        returning: typeof mockInsertReturning;
      };
      result.returning = mockInsertReturning;
      return result;
    });
  });

  const validAgent = {
    name: "Ops Monitor",
    role: "monitors ops",
    archetype: "ops-monitor",
    tools: ["report_action"],
    schedule_seconds: 10,
    initial_prompt: "You are ops.",
  };

  it("creates team, chat session, and agents for valid input", async () => {
    const res = await POST(
      makeRequest({ agents: [validAgent], teamName: "My Team" }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.teamId).toBe("team-abc");

    // insert called 3 times: teams, chatSessions, agents
    expect(mockInsert).toHaveBeenCalledTimes(3);
  });

  it("returns 400 when agents field is missing", async () => {
    const res = await POST(makeRequest({}));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("agents required");
  });

  it("returns 400 when agents array is empty", async () => {
    const res = await POST(makeRequest({ agents: [] }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("agents required");
  });

  it("uses teamName when provided", async () => {
    await POST(makeRequest({ agents: [validAgent], teamName: "  Custom Name  " }));

    // First insert call is for teams
    const teamsValues = mockInsertValues.mock.calls[0][0];
    expect(teamsValues.name).toBe("Custom Name");
  });

  it("falls back to archetype-based name when teamName is absent", async () => {
    const agents = [
      { ...validAgent, archetype: "ops-monitor" },
      { ...validAgent, archetype: "content-scheduler" },
    ];
    await POST(makeRequest({ agents }));

    const teamsValues = mockInsertValues.mock.calls[0][0];
    expect(teamsValues.name).toBe("ops-monitor-content-scheduler");
  });

  it("passes cofounderName when provided", async () => {
    await POST(
      makeRequest({ agents: [validAgent], cofounderName: "  Aria  " }),
    );

    const teamsValues = mockInsertValues.mock.calls[0][0];
    expect(teamsValues.cofounderName).toBe("Aria");
  });

  it("defaults cofounderName to Harmon when not provided", async () => {
    await POST(makeRequest({ agents: [validAgent] }));

    const teamsValues = mockInsertValues.mock.calls[0][0];
    expect(teamsValues.cofounderName).toBe("Harmon");
  });
});

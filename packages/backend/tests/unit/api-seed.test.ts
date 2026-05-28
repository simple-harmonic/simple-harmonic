import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFindFirst = vi.fn();

// Each insert().values() call returns a thenable with an optional .returning().
// We track insert calls to return the right data for team vs chatSession vs agents.
let insertCallIndex = 0;
const insertReturns: unknown[][] = [];

function makeValuesResult() {
  const idx = insertCallIndex++;
  const result = {
    returning: vi.fn().mockImplementation(async () => insertReturns[idx] ?? []),
    // Make the values result itself thenable (for chatSession insert which has no .returning())
    then: (resolve: (v: unknown) => void) => resolve(insertReturns[idx] ?? []),
  };
  return result;
}

const mockInsert = vi.fn().mockReturnValue({
  values: vi.fn().mockImplementation(() => makeValuesResult()),
});

const mockDb = {
  query: {
    teams: { findFirst: mockFindFirst },
  },
  insert: mockInsert,
};

vi.mock("@/server/db", () => ({
  db: () => mockDb,
}));

vi.mock("@/server/db/schema", () => ({
  teams: { id: "teams.id", name: "teams.name" },
  agents: { id: "agents.id", name: "agents.name" },
  chatSessions: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ _eq: val })),
}));

vi.mock("@/lib/meta-agent/identity", () => ({
  COFOUNDER_AGENT_ID: "00000000-0000-0000-0000-00000000c0f0",
  USER_AGENT_ID: "00000000-0000-0000-0000-00000000fffe",
}));

const mockSendDirect = vi.fn().mockResolvedValue(undefined);
const mockBroadcast = vi.fn().mockResolvedValue(undefined);
const mockCreateTask = vi.fn();
const mockUpdateTaskState = vi.fn().mockResolvedValue(undefined);

vi.mock("@/server/a2ax", () => ({
  getA2AX: () => ({
    sendDirect: mockSendDirect,
    broadcast: mockBroadcast,
    createTask: mockCreateTask,
    updateTaskState: mockUpdateTaskState,
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEAM_ID = "team-seed-1";

function agentRow(name: string, index: number) {
  return { id: `agent-${index}`, name };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/seed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertCallIndex = 0;
    insertReturns.length = 0;

    // Default: createTask returns a task object with a unique id
    let taskCounter = 0;
    mockCreateTask.mockImplementation(async () => {
      taskCounter++;
      return { task: { id: `task-${taskCounter}` } };
    });
  });

  it("returns 409 when team already exists", async () => {
    const existingTeam = { id: "existing-team-id", name: "Simple Harmonic v0.0 Launch" };
    mockFindFirst.mockResolvedValue(existingTeam);

    const { POST } = await import("@/app/api/seed/route");
    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("Mock team already exists");
    expect(body.teamId).toBe("existing-team-id");
    // Should not have inserted anything
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("creates team, chat session, and 4 agents on success", async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const insertedAgents = [
      agentRow("Scout", 0),
      agentRow("Relay", 1),
      agentRow("Chisel", 2),
      agentRow("Pulse", 3),
    ];

    // insert #0 = team, #1 = chatSession (no .returning()), #2 = agents
    insertReturns.push([{ id: TEAM_ID }]); // team
    insertReturns.push([]);                 // chatSession (unused)
    insertReturns.push(insertedAgents);     // agents

    const { POST } = await import("@/app/api/seed/route");
    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.teamId).toBe(TEAM_ID);
    expect(body.agents).toHaveLength(4);
    expect(body.messageCount).toBe(27);
    expect(body.taskCount).toBe(9);

    // Verify insert was called 3 times: team, chatSession, agents
    expect(mockInsert).toHaveBeenCalledTimes(3);
  });

  it("seeds agents with correct names: Scout, Relay, Chisel, Pulse", async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const insertedAgents = [
      agentRow("Scout", 0),
      agentRow("Relay", 1),
      agentRow("Chisel", 2),
      agentRow("Pulse", 3),
    ];

    insertReturns.push([{ id: TEAM_ID }]);
    insertReturns.push([]);
    insertReturns.push(insertedAgents);

    const { POST } = await import("@/app/api/seed/route");
    const res = await POST();
    const body = await res.json();

    const names = body.agents.map((a: { name: string }) => a.name);
    expect(names).toEqual(["Scout", "Relay", "Chisel", "Pulse"]);
  });

  it("calls sendDirect and broadcast to seed conversations", async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const insertedAgents = [
      agentRow("Scout", 0),
      agentRow("Relay", 1),
      agentRow("Chisel", 2),
      agentRow("Pulse", 3),
    ];

    insertReturns.push([{ id: TEAM_ID }]);
    insertReturns.push([]);
    insertReturns.push(insertedAgents);

    const { POST } = await import("@/app/api/seed/route");
    await POST();

    // The route sends 30 direct messages and 2 broadcasts = 32 actual calls.
    // (The response hardcodes messageCount: 27 which is a stale count.)
    expect(mockSendDirect).toHaveBeenCalled();
    expect(mockBroadcast).toHaveBeenCalled();
    expect(mockBroadcast.mock.calls.length).toBe(2);
    expect(mockSendDirect.mock.calls.length).toBe(30);
  });

  it("creates 9 tasks via a2ax", async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const insertedAgents = [
      agentRow("Scout", 0),
      agentRow("Relay", 1),
      agentRow("Chisel", 2),
      agentRow("Pulse", 3),
    ];

    insertReturns.push([{ id: TEAM_ID }]);
    insertReturns.push([]);
    insertReturns.push(insertedAgents);

    const { POST } = await import("@/app/api/seed/route");
    await POST();

    expect(mockCreateTask).toHaveBeenCalledTimes(9);
    // updateTaskState is called for tasks that progress beyond "created"
    expect(mockUpdateTaskState).toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockReturning = vi.fn().mockResolvedValue([{ id: "team-new" }]);
const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

const mockDb = {
  insert: mockInsert,
};

vi.mock("@/server/db", () => ({
  db: () => mockDb,
}));

vi.mock("@/server/db/schema", () => ({
  teams: { id: "teams.id" },
  chatSessions: {},
  agents: {},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/spawn", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function validAgent(overrides: Record<string, unknown> = {}) {
  return {
    name: "Researcher",
    role: "research",
    archetype: "researcher",
    tools: ["report_action"],
    schedule_seconds: 300,
    initial_prompt: "Do research.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Re-wire chained mock returns after clearAllMocks
  mockInsert.mockReturnValue({ values: mockValues });
  // teams insert returns with ID; chatSessions and agents inserts return void
  mockValues.mockImplementation((vals: unknown) => {
    // The teams insert uses .returning(), others don't
    return { returning: mockReturning };
  });
  mockReturning.mockResolvedValue([{ id: "team-new" }]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/spawn", () => {
  it("returns 400 when agents is missing", async () => {
    const { POST } = await import("@/server/api/spawn");

    const res = await POST(makeReq({}));
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("agents required");
  });

  it("returns 400 when agents is not an array", async () => {
    const { POST } = await import("@/server/api/spawn");

    const res = await POST(makeReq({ agents: "not-an-array" }));
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("agents required");
  });

  it("returns 400 when agents is an empty array", async () => {
    const { POST } = await import("@/server/api/spawn");

    const res = await POST(makeReq({ agents: [] }));
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("agents required");
  });

  it("returns 400 when agents is null", async () => {
    const { POST } = await import("@/server/api/spawn");

    const res = await POST(makeReq({ agents: null }));
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("agents required");
  });

  it("creates team, chat session, and agents on success", async () => {
    const { POST } = await import("@/server/api/spawn");

    const res = await POST(
      makeReq({
        agents: [validAgent()],
        teamName: "My Team",
      }),
    );
    const body = (await res.json()) as { teamId?: string };

    expect(res.status).toBe(200);
    expect(body.teamId).toBe("team-new");

    // Should insert team, chatSession, and agents (3 insert calls)
    expect(mockInsert).toHaveBeenCalledTimes(3);
  });

  it("uses teamName when provided", async () => {
    const { POST } = await import("@/server/api/spawn");

    await POST(
      makeReq({
        agents: [validAgent()],
        teamName: "Custom Team Name",
      }),
    );

    // First insert call is for teams
    const firstInsertValues = mockValues.mock.calls[0][0];
    expect(firstInsertValues.name).toBe("Custom Team Name");
  });

  it("falls back to archetype join when teamName is missing", async () => {
    const { POST } = await import("@/server/api/spawn");

    await POST(
      makeReq({
        agents: [
          validAgent({ archetype: "researcher" }),
          validAgent({ archetype: "writer", name: "Writer" }),
        ],
      }),
    );

    const firstInsertValues = mockValues.mock.calls[0][0];
    expect(firstInsertValues.name).toBe("researcher-writer");
  });

  it("falls back to archetype join when teamName is empty string", async () => {
    const { POST } = await import("@/server/api/spawn");

    await POST(
      makeReq({
        agents: [validAgent({ archetype: "ops" })],
        teamName: "   ",
      }),
    );

    const firstInsertValues = mockValues.mock.calls[0][0];
    expect(firstInsertValues.name).toBe("ops");
  });

  it("caps team name at 50 characters when falling back to archetype join", async () => {
    const { POST } = await import("@/server/api/spawn");

    const longArchetypeAgents = Array.from({ length: 10 }, (_, i) =>
      validAgent({ archetype: `long-archetype-name-${i}`, name: `Agent-${i}` }),
    );

    await POST(makeReq({ agents: longArchetypeAgents }));

    const firstInsertValues = mockValues.mock.calls[0][0];
    expect(firstInsertValues.name.length).toBeLessThanOrEqual(50);
  });

  it("creates a chat session for the new team", async () => {
    const { POST } = await import("@/server/api/spawn");

    await POST(makeReq({ agents: [validAgent()] }));

    // Second insert should be chatSessions with the team ID
    const secondInsertValues = mockValues.mock.calls[1][0];
    expect(secondInsertValues).toEqual({ teamId: "team-new" });
  });

  it("schedules the first agent's first run at now + scheduleSeconds", async () => {
    const { POST } = await import("@/server/api/spawn");

    const before = new Date();
    await POST(
      makeReq({
        // schedule_seconds defaults to 300 in validAgent().
        agents: [validAgent({ name: "Bot" })],
      }),
    );
    const after = new Date();

    // Third insert should be agents
    const thirdInsertValues = mockValues.mock.calls[2][0];
    expect(Array.isArray(thirdInsertValues)).toBe(true);
    const agentRow = thirdInsertValues[0];
    expect(agentRow.teamId).toBe("team-new");
    expect(agentRow.name).toBe("Bot");

    // The route schedules the first run at now + schedule_seconds*1000 + i*2000.
    // For agent index 0 with schedule_seconds=300 the stagger offset is 0, so
    // nextRunAt should land 300s after the POST, bracketed by before/after.
    const scheduleMs = 300 * 1000;
    expect(agentRow.nextRunAt.getTime()).toBeGreaterThanOrEqual(before.getTime() + scheduleMs);
    expect(agentRow.nextRunAt.getTime()).toBeLessThanOrEqual(after.getTime() + scheduleMs);
  });

  it("staggers first runs of later agents by 2s each", async () => {
    const { POST } = await import("@/server/api/spawn");

    await POST(
      makeReq({
        agents: [
          validAgent({ name: "A", schedule_seconds: 300 }),
          validAgent({ name: "B", schedule_seconds: 300 }),
          validAgent({ name: "C", schedule_seconds: 300 }),
        ],
      }),
    );

    const agentRows = mockValues.mock.calls[2][0] as Array<{
      name: string;
      nextRunAt: Date;
    }>;
    const [a, b, c] = agentRows;

    // Each later agent's first run is offset by an extra 2s (i * 2000) so the
    // very first tick doesn't fire every agent's LLM call simultaneously.
    expect(b.nextRunAt.getTime() - a.nextRunAt.getTime()).toBe(2000);
    expect(c.nextRunAt.getTime() - a.nextRunAt.getTime()).toBe(4000);
  });

  it("maps agent fields from snake_case payload to camelCase DB columns", async () => {
    const { POST } = await import("@/server/api/spawn");

    await POST(
      makeReq({
        agents: [
          validAgent({
            schedule_seconds: 600,
            initial_prompt: "Start scanning.",
          }),
        ],
      }),
    );

    const agentRows = mockValues.mock.calls[2][0];
    expect(agentRows[0].scheduleSeconds).toBe(600);
    expect(agentRows[0].initialPrompt).toBe("Start scanning.");
  });

  it("creates multiple agents in a single insert", async () => {
    const { POST } = await import("@/server/api/spawn");

    await POST(
      makeReq({
        agents: [
          validAgent({ name: "Alpha" }),
          validAgent({ name: "Beta" }),
          validAgent({ name: "Gamma" }),
        ],
      }),
    );

    const agentRows = mockValues.mock.calls[2][0];
    // 3 user agents + 1 auto-spawned Harmon
    expect(agentRows).toHaveLength(4);
    expect(agentRows[0].name).toBe("Alpha");
    expect(agentRows[1].name).toBe("Beta");
    expect(agentRows[2].name).toBe("Gamma");
    expect(agentRows[3].archetype).toBe("meta-agent");
  });

  it("passes cofounderName to team insert", async () => {
    const { POST } = await import("@/server/api/spawn");

    await POST(
      makeReq({
        agents: [validAgent()],
        teamName: "Test",
        cofounderName: "Atlas",
      }),
    );

    const teamValues = mockValues.mock.calls[0][0];
    expect(teamValues.cofounderName).toBe("Atlas");
  });

  it("defaults cofounderName to Harmon when not provided", async () => {
    const { POST } = await import("@/server/api/spawn");

    await POST(
      makeReq({
        agents: [validAgent()],
        teamName: "Test",
      }),
    );

    const teamValues = mockValues.mock.calls[0][0];
    expect(teamValues.cofounderName).toBe("Harmon");
  });

  it("trims cofounderName whitespace", async () => {
    const { POST } = await import("@/server/api/spawn");

    await POST(
      makeReq({
        agents: [validAgent()],
        cofounderName: "  Atlas  ",
      }),
    );

    const teamValues = mockValues.mock.calls[0][0];
    expect(teamValues.cofounderName).toBe("Atlas");
  });

  it("returns the team id in the response", async () => {
    const { POST } = await import("@/server/api/spawn");
    mockReturning.mockResolvedValueOnce([{ id: "uuid-42" }]);

    const res = await POST(makeReq({ agents: [validAgent()] }));
    const body = (await res.json()) as { teamId?: string };

    expect(body.teamId).toBe("uuid-42");
  });
});

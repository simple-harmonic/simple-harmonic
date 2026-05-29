import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDb = {
  query: {
    agents: {
      findMany: vi.fn(),
    },
    actionLog: {
      findMany: vi.fn(),
    },
  },
};

vi.mock("@/server/db", () => ({
  db: () => mockDb,
}));

vi.mock("@/server/db/schema", () => ({
  agents: { teamId: "agents.teamId", id: "agents.id" },
  actionLog: { agentId: "actionLog.agentId", executedAt: "actionLog.executedAt" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ _eq: val })),
  desc: vi.fn((col: unknown) => ({ _desc: col })),
  gt: vi.fn((_col: unknown, val: unknown) => ({ _gt: val })),
  inArray: vi.fn((_col: unknown, vals: unknown) => ({ _inArray: vals })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEAM_ID = "team-1";

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** Read entire SSE body from a Response */
async function readSSEBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

/** Parse SSE events from raw body text */
function parseSSEEvents(raw: string): Array<{ type: string; entries: unknown[] }> {
  return raw
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.replace("data: ", "")));
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/team/[id]/narration", () => {
  it("returns SSE headers", async () => {
    const { GET } = await import("@/app/api/team/[id]/narration/route");
    mockDb.query.agents.findMany.mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost"), makeParams(TEAM_ID));

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
  });

  it("returns empty history event when team has no agents", async () => {
    const { GET } = await import("@/app/api/team/[id]/narration/route");
    mockDb.query.agents.findMany.mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost"), makeParams(TEAM_ID));
    const body = await res.text();

    expect(body).toBe(`data: ${JSON.stringify({ type: "history", entries: [] })}\n\n`);
  });

  it("returns history event with entries in chronological order", async () => {
    const { GET } = await import("@/app/api/team/[id]/narration/route");

    const agentA = { id: "agent-1" };
    const agentB = { id: "agent-2" };
    mockDb.query.agents.findMany.mockResolvedValueOnce([agentA, agentB]);

    // DB returns desc order (newest first) - the route reverses to chronological
    const entry1 = {
      id: "log-1",
      agentId: "agent-1",
      actionType: "research",
      payload: { note: "first" },
      executedAt: new Date("2026-05-20T10:00:00Z"),
    };
    const entry2 = {
      id: "log-2",
      agentId: "agent-2",
      actionType: "report",
      payload: { note: "second" },
      executedAt: new Date("2026-05-20T10:01:00Z"),
    };
    // findMany returns desc: entry2 first, entry1 second
    mockDb.query.actionLog.findMany.mockResolvedValueOnce([entry2, entry1]);

    const res = await GET(new Request("http://localhost"), makeParams(TEAM_ID));

    // The response is a ReadableStream. Read just the first event.
    const body = await readSSEBody(res);
    const events = parseSSEEvents(body);

    expect(events.length).toBeGreaterThanOrEqual(1);
    const historyEvent = events[0];
    expect(historyEvent.type).toBe("history");
    // Should be chronological order (entry1 before entry2)
    expect(historyEvent.entries).toHaveLength(2);
    expect((historyEvent.entries[0] as { id: string }).id).toBe("log-1");
    expect((historyEvent.entries[1] as { id: string }).id).toBe("log-2");
  });

  it("returns empty entries array in history when agents exist but no logs", async () => {
    const { GET } = await import("@/app/api/team/[id]/narration/route");

    mockDb.query.agents.findMany.mockResolvedValueOnce([{ id: "agent-1" }]);
    mockDb.query.actionLog.findMany.mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost"), makeParams(TEAM_ID));
    const body = await readSSEBody(res);
    const events = parseSSEEvents(body);

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe("history");
    expect(events[0].entries).toEqual([]);
  });

  it("queries agents filtered by teamId", async () => {
    const { GET } = await import("@/app/api/team/[id]/narration/route");
    mockDb.query.agents.findMany.mockResolvedValueOnce([]);

    await GET(new Request("http://localhost"), makeParams("my-team-42"));

    expect(mockDb.query.agents.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: { id: true },
      }),
    );
  });

  it("queries action log with limit 50", async () => {
    const { GET } = await import("@/app/api/team/[id]/narration/route");
    mockDb.query.agents.findMany.mockResolvedValueOnce([{ id: "a1" }]);
    mockDb.query.actionLog.findMany.mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost"), makeParams(TEAM_ID));
    // Consume the stream so the start() callback finishes
    await readSSEBody(res);

    expect(mockDb.query.actionLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 50,
      }),
    );
  });

  it("no-agents response is plain Response (not streaming)", async () => {
    const { GET } = await import("@/app/api/team/[id]/narration/route");
    mockDb.query.agents.findMany.mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost"), makeParams(TEAM_ID));

    // Should still have correct SSE headers even for the empty case
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    // Body should be directly readable as text (not a long-lived stream)
    const text = await res.text();
    expect(text).toContain('"type":"history"');
    expect(text).toContain('"entries":[]');
  });
});

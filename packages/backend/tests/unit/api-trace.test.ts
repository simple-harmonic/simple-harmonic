import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDb = {
  query: {
    agentTraceEvents: {
      findMany: vi.fn(),
    },
  },
};

vi.mock("@/server/db", () => ({
  db: () => mockDb,
}));

vi.mock("@/server/db/schema", () => ({
  agentTraceEvents: {
    teamId: "agent_trace_events.teamId",
    agentId: "agent_trace_events.agentId",
    tickId: "agent_trace_events.tickId",
    seq: "agent_trace_events.seq",
    emittedAt: "agent_trace_events.emittedAt",
  },
}));

const eqMock = vi.fn((_col: unknown, val: unknown) => ({ _eq: val }));
vi.mock("drizzle-orm", () => ({
  eq: (...args: [unknown, unknown]) => eqMock(...args),
  and: vi.fn((...clauses: unknown[]) => ({ _and: clauses })),
  gte: vi.fn((_col: unknown, val: unknown) => ({ _gte: val })),
  asc: vi.fn((col: unknown) => ({ _asc: col })),
  desc: vi.fn((col: unknown) => ({ _desc: col })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEAM_ID = "team-1";

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** Read the FIRST complete SSE event then cancel the stream (so the route's
 *  poll interval is torn down and the test doesn't wait on it). */
async function readFirstSSEEvent(res: Response): Promise<{ type: string; entries: unknown[] }> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no body");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const idx = buffer.indexOf("\n\n");
      if (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        if (chunk.startsWith("data: ")) return JSON.parse(chunk.slice(6));
      }
    }
    throw new Error("stream ended without an event");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function traceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    teamId: TEAM_ID,
    agentId: "agent-1",
    tickId: "tick-1",
    seq: 0,
    type: "tick_started",
    data: { mode: "fresh" },
    emittedAt: new Date("2026-06-10T10:00:00Z"),
    createdAt: new Date("2026-06-10T10:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.query.agentTraceEvents.findMany.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/team/[id]/trace", () => {
  it("returns SSE headers", async () => {
    const { GET } = await import("@/server/api/team/id/trace");

    const res = await GET(new Request("http://localhost/api/team/team-1/trace"), makeParams(TEAM_ID));

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    await res.body?.cancel();
  });

  it("emits a history event with entries reversed to chronological order", async () => {
    const { GET } = await import("@/server/api/team/id/trace");

    const e1 = traceRow({ id: "evt-1", seq: 0, emittedAt: new Date("2026-06-10T10:00:00Z") });
    const e2 = traceRow({
      id: "evt-2",
      seq: 1,
      type: "tick_finished",
      emittedAt: new Date("2026-06-10T10:00:05Z"),
    });
    // DB returns newest-first; the route reverses to chronological.
    mockDb.query.agentTraceEvents.findMany.mockResolvedValueOnce([e2, e1]);

    const res = await GET(new Request("http://localhost/api/team/team-1/trace"), makeParams(TEAM_ID));
    const event = await readFirstSSEEvent(res);

    expect(event.type).toBe("history");
    expect(event.entries).toHaveLength(2);
    expect((event.entries[0] as { id: string }).id).toBe("evt-1");
    expect((event.entries[1] as { id: string }).id).toBe("evt-2");
    expect(mockDb.query.agentTraceEvents.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200 }),
    );
  });

  it("emits an empty history when there are no trace events", async () => {
    const { GET } = await import("@/server/api/team/id/trace");
    mockDb.query.agentTraceEvents.findMany.mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/team/team-1/trace"), makeParams(TEAM_ID));
    const event = await readFirstSSEEvent(res);

    expect(event).toEqual({ type: "history", entries: [] });
  });

  it("applies agentId and tickId filters from the query string", async () => {
    const { GET } = await import("@/server/api/team/id/trace");
    mockDb.query.agentTraceEvents.findMany.mockResolvedValueOnce([]);

    const res = await GET(
      new Request("http://localhost/api/team/team-1/trace?agentId=agent-7&tickId=tick-9"),
      makeParams(TEAM_ID),
    );
    await readFirstSSEEvent(res);

    const eqValues = eqMock.mock.calls.map((c) => c[1]);
    expect(eqValues).toContain(TEAM_ID);
    expect(eqValues).toContain("agent-7");
    expect(eqValues).toContain("tick-9");
  });
});

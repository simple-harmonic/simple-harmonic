import { describe, expect, it } from "vitest";
import { actionLog, agents, teams } from "@/server/store";
import { useTempStore } from "../helpers/store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** Read the entire SSE body from a Response (the start() callback emits the
 *  history event synchronously, then the poll interval keeps the stream open;
 *  we cancel after the first event so the read settles). */
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

async function seedTeam(overrides: Record<string, unknown> = {}) {
  return teams.insert({ name: "Test Team", ...overrides });
}

async function seedAgent(teamId: string, overrides: Record<string, unknown> = {}) {
  return agents.insert(teamId, {
    name: "Researcher",
    role: "research",
    archetype: "researcher",
    tools: [],
    scheduleSeconds: 10,
    initialPrompt: "Do research",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/team/[id]/narration", () => {
  useTempStore();

  it("returns SSE headers", async () => {
    const { GET } = await import("@/server/api/team/id/narration");
    const team = await seedTeam();

    const res = await GET(new Request("http://localhost"), makeParams(team.id));

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    await res.body?.cancel();
  });

  it("returns empty history event when team has no agents", async () => {
    const { GET } = await import("@/server/api/team/id/narration");
    const team = await seedTeam();

    const res = await GET(new Request("http://localhost"), makeParams(team.id));
    const body = await res.text();

    expect(body).toBe(`data: ${JSON.stringify({ type: "history", entries: [] })}\n\n`);
  });

  it("returns history event with entries in chronological order", async () => {
    const { GET } = await import("@/server/api/team/id/narration");

    const team = await seedTeam();
    const agentA = await seedAgent(team.id, { name: "Alpha" });
    const agentB = await seedAgent(team.id, { name: "Beta" });

    // Insert oldest-first; the route returns them chronological in history.
    const e1 = await actionLog.insert(agentA.id, {
      actionType: "research",
      payload: { note: "first" },
    });
    // Ensure a strictly later executedAt so ordering is deterministic.
    await new Promise((r) => setTimeout(r, 5));
    const e2 = await actionLog.insert(agentB.id, {
      actionType: "report",
      payload: { note: "second" },
    });

    const res = await GET(new Request("http://localhost"), makeParams(team.id));
    const event = await readFirstSSEEvent(res);

    expect(event.type).toBe("history");
    expect(event.entries).toHaveLength(2);
    // Chronological: e1 (oldest) before e2 (newest).
    expect((event.entries[0] as { id: string }).id).toBe(e1.id);
    expect((event.entries[1] as { id: string }).id).toBe(e2.id);
    expect((event.entries[0] as { payload: { note: string } }).payload.note).toBe("first");
  });

  it("returns empty entries array in history when agents exist but no logs", async () => {
    const { GET } = await import("@/server/api/team/id/narration");

    const team = await seedTeam();
    await seedAgent(team.id);

    const res = await GET(new Request("http://localhost"), makeParams(team.id));
    const event = await readFirstSSEEvent(res);

    expect(event.type).toBe("history");
    expect(event.entries).toEqual([]);
  });

  it("only includes entries for agents in the requested team", async () => {
    const { GET } = await import("@/server/api/team/id/narration");

    const team = await seedTeam({ name: "Mine" });
    const other = await seedTeam({ name: "Other" });
    const mine = await seedAgent(team.id, { name: "Mine" });
    const theirs = await seedAgent(other.id, { name: "Theirs" });

    await actionLog.insert(mine.id, { actionType: "research", payload: { note: "mine" } });
    await actionLog.insert(theirs.id, { actionType: "research", payload: { note: "theirs" } });

    const res = await GET(new Request("http://localhost"), makeParams(team.id));
    const event = await readFirstSSEEvent(res);

    expect(event.entries).toHaveLength(1);
    expect((event.entries[0] as { agentId: string }).agentId).toBe(mine.id);
  });

  it("caps history at 50 entries (newest 50, chronological)", async () => {
    const { GET } = await import("@/server/api/team/id/narration");

    const team = await seedTeam();
    const agent = await seedAgent(team.id);
    for (let i = 0; i < 60; i++) {
      await actionLog.insert(agent.id, { actionType: "research", payload: { i } });
    }

    const res = await GET(new Request("http://localhost"), makeParams(team.id));
    const event = await readFirstSSEEvent(res);

    expect(event.entries).toHaveLength(50);
  });

  it("no-agents response is plain Response (not streaming)", async () => {
    const { GET } = await import("@/server/api/team/id/narration");
    const team = await seedTeam();

    const res = await GET(new Request("http://localhost"), makeParams(team.id));

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"type":"history"');
    expect(text).toContain('"entries":[]');
  });
});

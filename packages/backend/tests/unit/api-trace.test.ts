import { describe, expect, it } from "vitest";
import { agents, teams, traceEvents } from "@/server/store";
import { useTempStore } from "../helpers/store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function seedTeamAndAgent(overrides: Record<string, unknown> = {}) {
  const team = await teams.insert({ name: "Test Team" });
  const agent = await agents.insert(team.id, {
    name: "Researcher",
    role: "research",
    archetype: "researcher",
    tools: [],
    scheduleSeconds: 10,
    initialPrompt: "Do research",
    ...overrides,
  });
  return { team, agent };
}

let seq = 0;
/** Append one trace step for the given team/agent. traceEvents.append writes
 *  into the agent's folder, so the agent must already exist. */
async function appendStep(
  teamId: string,
  agentId: string,
  step: { tickId: string; type: string; data?: Record<string, unknown>; emittedAt?: Date },
) {
  await traceEvents.append([
    {
      teamId,
      agentId,
      tickId: step.tickId,
      seq: seq++,
      type: step.type,
      data: step.data ?? {},
      emittedAt: step.emittedAt ?? new Date(),
    },
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/team/[id]/trace", () => {
  useTempStore();

  it("returns SSE headers", async () => {
    const { GET } = await import("@/server/api/team/id/trace");
    const { team } = await seedTeamAndAgent();

    const res = await GET(
      new Request(`http://localhost/api/team/${team.id}/trace`),
      makeParams(team.id),
    );

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    await res.body?.cancel();
  });

  it("emits a history event with entries in chronological order", async () => {
    const { GET } = await import("@/server/api/team/id/trace");
    const { team, agent } = await seedTeamAndAgent();

    await appendStep(team.id, agent.id, {
      tickId: "tick-1",
      type: "tick_started",
      data: { mode: "fresh" },
      emittedAt: new Date("2026-06-10T10:00:00Z"),
    });
    await appendStep(team.id, agent.id, {
      tickId: "tick-1",
      type: "tick_finished",
      data: { actionType: "noop" },
      emittedAt: new Date("2026-06-10T10:00:05Z"),
    });

    const res = await GET(
      new Request(`http://localhost/api/team/${team.id}/trace`),
      makeParams(team.id),
    );
    const event = await readFirstSSEEvent(res);

    expect(event.type).toBe("history");
    expect(event.entries).toHaveLength(2);
    expect((event.entries[0] as { type: string }).type).toBe("tick_started");
    expect((event.entries[1] as { type: string }).type).toBe("tick_finished");
  });

  it("emits an empty history when there are no trace events", async () => {
    const { GET } = await import("@/server/api/team/id/trace");
    const { team } = await seedTeamAndAgent();

    const res = await GET(
      new Request(`http://localhost/api/team/${team.id}/trace`),
      makeParams(team.id),
    );
    const event = await readFirstSSEEvent(res);

    expect(event).toEqual({ type: "history", entries: [] });
  });

  it("applies the agentId filter from the query string", async () => {
    const { GET } = await import("@/server/api/team/id/trace");
    const { team, agent } = await seedTeamAndAgent({ name: "Alpha" });
    const other = await agents.insert(team.id, {
      name: "Beta",
      role: "research",
      archetype: "researcher",
      tools: [],
      scheduleSeconds: 10,
      initialPrompt: "Do research",
    });

    await appendStep(team.id, agent.id, { tickId: "t1", type: "tick_started" });
    await appendStep(team.id, other.id, { tickId: "t2", type: "tick_started" });

    const res = await GET(
      new Request(`http://localhost/api/team/${team.id}/trace?agentId=${agent.id}`),
      makeParams(team.id),
    );
    const event = await readFirstSSEEvent(res);

    expect(event.entries).toHaveLength(1);
    expect((event.entries[0] as { agentId: string }).agentId).toBe(agent.id);
  });

  it("applies the tickId filter from the query string", async () => {
    const { GET } = await import("@/server/api/team/id/trace");
    const { team, agent } = await seedTeamAndAgent();

    await appendStep(team.id, agent.id, { tickId: "tick-keep", type: "tick_started" });
    await appendStep(team.id, agent.id, { tickId: "tick-drop", type: "tick_started" });

    const res = await GET(
      new Request(`http://localhost/api/team/${team.id}/trace?tickId=tick-keep`),
      makeParams(team.id),
    );
    const event = await readFirstSSEEvent(res);

    expect(event.entries).toHaveLength(1);
    expect((event.entries[0] as { tickId: string }).tickId).toBe("tick-keep");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { agents, teams, traceEvents } from "@/server/store";
import {
  createTraceSink,
  pruneTraceEvents,
  resetPruneThrottleForTests,
  sanitizeTraceData,
} from "@/server/trace";
import { useTempStore } from "../helpers/store";

// ---------------------------------------------------------------------------
// Seeding — traceEvents.append() writes into the *agent's* folder, so a
// team + agent must exist or the append is silently skipped.
// ---------------------------------------------------------------------------

async function seedTeamAndAgent() {
  const team = await teams.insert({ name: "Test Team" });
  const agent = await agents.insert(team.id, {
    name: "Researcher",
    role: "research",
    archetype: "researcher",
    tools: [],
    scheduleSeconds: 10,
    initialPrompt: "Do research",
  });
  return { teamId: team.id, agentId: agent.id };
}

/** All persisted steps for the seeded agent, chronological. */
async function readSteps(teamId: string, agentId: string) {
  return traceEvents.query({ teamId, agentId, order: "asc", limit: 1000 });
}

beforeEach(() => {
  resetPruneThrottleForTests();
});

// ---------------------------------------------------------------------------
// createTraceSink
// ---------------------------------------------------------------------------

describe("createTraceSink", () => {
  useTempStore();

  it("persists emitted steps in order with increasing seq and one tickId", async () => {
    const { teamId, agentId } = await seedTeamAndAgent();
    const sink = createTraceSink({ teamId, agentId });

    sink.emit({ type: "tick_started", data: { mode: "fresh", round: 0 } });
    sink.emit({ type: "llm_request", data: { round: 0, model: "o4-mini" } });
    sink.emit({ type: "tick_finished", data: { actionType: "noop" } });
    await sink.flush();

    const rows = await readSteps(teamId, agentId);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.type)).toEqual(["tick_started", "llm_request", "tick_finished"]);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);
    for (const r of rows) {
      expect(r.teamId).toBe(teamId);
      expect(r.agentId).toBe(agentId);
      expect(r.tickId).toBe(sink.tickId);
      expect(r.emittedAt).toBeInstanceOf(Date);
    }
    expect(sink.tickId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reuses a provided tickId so resumed ticks stay one thread", async () => {
    const { teamId, agentId } = await seedTeamAndAgent();
    const original = createTraceSink({ teamId, agentId });
    const resumed = createTraceSink({ teamId, agentId, tickId: original.tickId });
    expect(resumed.tickId).toBe(original.tickId);
  });

  it("steps emitted while a drain is in flight are not lost", async () => {
    const { teamId, agentId } = await seedTeamAndAgent();
    const sink = createTraceSink({ teamId, agentId });

    // Slow the first append so later emits land mid-drain.
    let release: () => void = () => {};
    const real = traceEvents.append.bind(traceEvents);
    const appendSpy = vi
      .spyOn(traceEvents, "append")
      .mockImplementationOnce(async (rows) => {
        await new Promise<void>((r) => {
          release = r;
        });
        await real(rows);
      });

    sink.emit({ type: "tick_started", data: {} });
    sink.emit({ type: "llm_request", data: {} });
    sink.emit({ type: "llm_response", data: {} });
    release();
    await sink.flush();
    appendSpy.mockRestore();

    const rows = await readSteps(teamId, agentId);
    expect(rows.map((r) => r.type)).toEqual(["tick_started", "llm_request", "llm_response"]);
  });

  it("swallows insert failures (telemetry never breaks a tick)", async () => {
    const { teamId, agentId } = await seedTeamAndAgent();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const appendSpy = vi
      .spyOn(traceEvents, "append")
      .mockRejectedValue(new Error("store down"));
    try {
      const sink = createTraceSink({ teamId, agentId });
      sink.emit({ type: "tick_started", data: {} });
      await expect(sink.flush()).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      appendSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// sanitizeTraceData
// ---------------------------------------------------------------------------

describe("sanitizeTraceData", () => {
  it("truncates long strings with a marker", () => {
    const long = "x".repeat(5000);
    const out = sanitizeTraceData({ result: long });
    const result = out.result as string;
    expect(result.length).toBeLessThan(4100);
    expect(result).toContain("[truncated 1000 chars]");
  });

  it("scrubs PII (emails, API keys) from strings", () => {
    const out = sanitizeTraceData({
      result: `mailto founder@example.com with key sk-${"a".repeat(24)}`,
    });
    const result = out.result as string;
    expect(result).not.toContain("founder@example.com");
    expect(result).not.toContain("sk-aaaaaaaa");
    expect(result).toContain("[REDACTED]");
  });

  it("caps nesting depth and entry counts", () => {
    let deep: Record<string, unknown> = { leaf: "bottom" };
    for (let i = 0; i < 10; i++) deep = { nested: deep };
    const out = sanitizeTraceData({ deep, wide: Array.from({ length: 60 }, (_, i) => i) });

    expect(JSON.stringify(out)).toContain("[max depth]");
    const wide = out.wide as unknown[];
    expect(wide).toHaveLength(51); // 50 kept + truncation marker
    expect(wide[50]).toBe("… [10 more]");
  });

  it("passes primitives through and stringifies exotic values", () => {
    const out = sanitizeTraceData({ n: 3, b: true, nil: null, f: (() => 1) as unknown });
    expect(out.n).toBe(3);
    expect(out.b).toBe(true);
    expect(out.nil).toBeNull();
    expect(typeof out.f).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// pruneTraceEvents
// ---------------------------------------------------------------------------

describe("pruneTraceEvents", () => {
  useTempStore();

  it("prunes old rows, then throttles for an hour", async () => {
    resetPruneThrottleForTests();
    const pruneSpy = vi.spyOn(traceEvents, "pruneOlderThan");
    try {
      await pruneTraceEvents();
      expect(pruneSpy).toHaveBeenCalledTimes(1);

      await pruneTraceEvents();
      expect(pruneSpy).toHaveBeenCalledTimes(1); // throttled within the hour

      resetPruneThrottleForTests();
      await pruneTraceEvents();
      expect(pruneSpy).toHaveBeenCalledTimes(2);
    } finally {
      pruneSpy.mockRestore();
    }
  });

  it("actually deletes trace events older than the retention window", async () => {
    resetPruneThrottleForTests();
    const { teamId, agentId } = await seedTeamAndAgent();

    const old = new Date(Date.now() - 30 * 86_400_000); // 30 days ago (> 14d default)
    const fresh = new Date();
    await traceEvents.append([
      { teamId, agentId, tickId: "t", seq: 0, type: "old", data: {}, emittedAt: old },
      { teamId, agentId, tickId: "t", seq: 1, type: "fresh", data: {}, emittedAt: fresh },
    ]);

    await pruneTraceEvents();

    const rows = await readSteps(teamId, agentId);
    expect(rows.map((r) => r.type)).toEqual(["fresh"]);
  });

  it("never throws on store failure", async () => {
    resetPruneThrottleForTests();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pruneSpy = vi
      .spyOn(traceEvents, "pruneOlderThan")
      .mockRejectedValueOnce(new Error("no table"));
    try {
      await expect(pruneTraceEvents()).resolves.toBeUndefined();
    } finally {
      pruneSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

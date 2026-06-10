import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — DB (insert/delete captured; schema + drizzle stay real)
// ---------------------------------------------------------------------------

const insertedBatches: Array<Array<Record<string, unknown>>> = [];
const mockValues = vi.fn(async (rows: Array<Record<string, unknown>>) => {
  insertedBatches.push(rows);
});
const mockInsert = vi.fn(() => ({ values: mockValues }));
const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
const mockDelete = vi.fn(() => ({ where: mockDeleteWhere }));

vi.mock("@/server/db", () => ({
  db: () => ({ insert: mockInsert, delete: mockDelete }),
}));

import {
  createTraceSink,
  pruneTraceEvents,
  resetPruneThrottleForTests,
  sanitizeTraceData,
} from "@/server/trace";

beforeEach(() => {
  vi.clearAllMocks();
  insertedBatches.length = 0;
  mockValues.mockImplementation(async (rows: Array<Record<string, unknown>>) => {
    insertedBatches.push(rows);
  });
  mockInsert.mockImplementation(() => ({ values: mockValues }));
  mockDelete.mockImplementation(() => ({ where: mockDeleteWhere }));
  resetPruneThrottleForTests();
});

function allRows(): Array<Record<string, unknown>> {
  return insertedBatches.flat();
}

// ---------------------------------------------------------------------------
// createTraceSink
// ---------------------------------------------------------------------------

describe("createTraceSink", () => {
  it("persists emitted steps in order with increasing seq and one tickId", async () => {
    const sink = createTraceSink({ teamId: "team-1", agentId: "agent-1" });

    sink.emit({ type: "tick_started", data: { mode: "fresh", round: 0 } });
    sink.emit({ type: "llm_request", data: { round: 0, model: "o4-mini" } });
    sink.emit({ type: "tick_finished", data: { actionType: "noop" } });
    await sink.flush();

    const rows = allRows();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.type)).toEqual(["tick_started", "llm_request", "tick_finished"]);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);
    for (const r of rows) {
      expect(r.teamId).toBe("team-1");
      expect(r.agentId).toBe("agent-1");
      expect(r.tickId).toBe(sink.tickId);
      expect(r.emittedAt).toBeInstanceOf(Date);
    }
    expect(sink.tickId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reuses a provided tickId so resumed ticks stay one thread", async () => {
    const original = createTraceSink({ teamId: "team-1", agentId: "agent-1" });
    const resumed = createTraceSink({
      teamId: "team-1",
      agentId: "agent-1",
      tickId: original.tickId,
    });
    expect(resumed.tickId).toBe(original.tickId);
  });

  it("steps emitted while a drain is in flight are not lost", async () => {
    const sink = createTraceSink({ teamId: "team-1", agentId: "agent-1" });
    // Slow first insert so later emits land mid-drain.
    let release: () => void = () => {};
    mockValues.mockImplementationOnce(async (rows: Array<Record<string, unknown>>) => {
      await new Promise<void>((r) => {
        release = r;
      });
      insertedBatches.push(rows);
    });

    sink.emit({ type: "tick_started", data: {} });
    sink.emit({ type: "llm_request", data: {} });
    sink.emit({ type: "llm_response", data: {} });
    release();
    await sink.flush();

    expect(allRows().map((r) => r.type)).toEqual([
      "tick_started",
      "llm_request",
      "llm_response",
    ]);
  });

  it("swallows insert failures (telemetry never breaks a tick)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockValues.mockRejectedValueOnce(new Error("db down"));
      const sink = createTraceSink({ teamId: "team-1", agentId: "agent-1" });
      sink.emit({ type: "tick_started", data: {} });
      await expect(sink.flush()).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalled();
    } finally {
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
  it("deletes old rows, then throttles for an hour", async () => {
    await pruneTraceEvents();
    expect(mockDelete).toHaveBeenCalledTimes(1);

    await pruneTraceEvents();
    expect(mockDelete).toHaveBeenCalledTimes(1); // throttled

    resetPruneThrottleForTests();
    await pruneTraceEvents();
    expect(mockDelete).toHaveBeenCalledTimes(2);
  });

  it("never throws on DB failure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockDeleteWhere.mockRejectedValueOnce(new Error("no table"));
      await expect(pruneTraceEvents()).resolves.toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
  });
});

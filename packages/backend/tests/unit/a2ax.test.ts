import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock captures: track constructor args across module reloads
// ---------------------------------------------------------------------------
const drizzleTransportArgs: unknown[] = [];
const a2axArgs: unknown[] = [];
const fakeDb = { __brand: "fake-db" };

vi.mock("@simple-harmonic/a2ax", () => {
  class A2AX {
    constructor(...args: unknown[]) {
      a2axArgs.push(...args);
    }
  }
  return { A2AX };
});

vi.mock("@simple-harmonic/a2ax/adapters/drizzle", () => {
  class DrizzleTransport {
    constructor(...args: unknown[]) {
      drizzleTransportArgs.push(...args);
    }
  }
  return { DrizzleTransport };
});

vi.mock("@/server/db", () => ({
  db: () => fakeDb,
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getA2AX", () => {
  beforeEach(() => {
    vi.resetModules();
    drizzleTransportArgs.length = 0;
    a2axArgs.length = 0;
  });

  it("creates an A2AX instance on first call", async () => {
    const { getA2AX } = await import("@/server/a2ax");

    const result = getA2AX();

    expect(result).toBeDefined();
    expect(a2axArgs.length).toBe(1);
  });

  it("returns the same instance on subsequent calls (singleton)", async () => {
    const { getA2AX } = await import("@/server/a2ax");

    const first = getA2AX();
    const second = getA2AX();

    expect(first).toBe(second);
    // Constructor should only be called once
    expect(a2axArgs.length).toBe(1);
  });

  it("constructs DrizzleTransport with db() result", async () => {
    const { getA2AX } = await import("@/server/a2ax");

    getA2AX();

    expect(drizzleTransportArgs.length).toBe(1);
    expect(drizzleTransportArgs[0]).toBe(fakeDb);
  });

  it("constructs A2AX with correct config", async () => {
    const { getA2AX } = await import("@/server/a2ax");

    getA2AX();

    expect(a2axArgs.length).toBe(1);
    const config = a2axArgs[0] as Record<string, unknown>;
    expect(config.maxContextMessages).toBe(20);
    expect(config.defaultExpiryMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(config.transport).toBeDefined();
  });
});

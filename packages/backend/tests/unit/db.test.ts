import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock pg Pool as a proper class
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => {
  return {
    Pool: class MockPool {
      static instances: Array<{ config: Record<string, unknown>; end: () => void }> = [];
      end = mockEnd;
      config: Record<string, unknown>;
      constructor(config: Record<string, unknown>) {
        this.config = config;
        MockPool.instances.push(this);
      }
    },
  };
});

// Mock drizzle
const mockDrizzleReturn = { __drizzle: true };
const mockDrizzle = vi.fn().mockReturnValue(mockDrizzleReturn);
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: (...args: unknown[]) => mockDrizzle(...args),
}));

// Mock schema
vi.mock("@/server/db/schema", () => ({}));

// Mock config
const mockGetConfig = vi.fn();
vi.mock("@/server/config", () => ({
  getConfig: () => mockGetConfig(),
}));

describe("db()", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetConfig.mockReturnValue({
      databaseUrl: "postgresql://localhost:5432/test_db",
    });
    // Reset the Pool instances tracker
    const { Pool } = await import("pg");
    (Pool as unknown as { instances: unknown[] }).instances = [];
  });

  async function loadDb() {
    return (await import("@/server/db")).db;
  }

  it("creates a Pool and drizzle instance on first call", async () => {
    const db = await loadDb();
    const instance = db();

    const { Pool } = await import("pg");
    const instances = (Pool as unknown as { instances: Array<{ config: Record<string, unknown> }> }).instances;
    expect(instances).toHaveLength(1);
    // max:1 is intentional — the pooled Neon connection must cap at 1 so the
    // 10s tick loop can't exhaust the pool (see db/index.ts + CLAUDE.md
    // "Critical pre-commit items"). The timeout settings are asserted
    // separately in the "configures pool with timeout settings" test below.
    expect(instances[0].config).toEqual(
      expect.objectContaining({
        connectionString: "postgresql://localhost:5432/test_db",
        max: 1,
      }),
    );
    expect(mockDrizzle).toHaveBeenCalledTimes(1);
    expect(instance).toEqual(mockDrizzleReturn);
  });

  it("returns the same instance on subsequent calls with same URL", async () => {
    const db = await loadDb();
    const first = db();
    const second = db();

    expect(first).toBe(second);
    const { Pool } = await import("pg");
    expect((Pool as unknown as { instances: unknown[] }).instances).toHaveLength(1);
  });

  it("recreates instance when database URL changes", async () => {
    const db = await loadDb();
    db(); // first call

    mockGetConfig.mockReturnValue({
      databaseUrl: "postgresql://localhost:5432/other_db",
    });

    db(); // second call with different URL

    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockDrizzle).toHaveBeenCalledTimes(2);
  });

  it("configures pool with timeout settings", async () => {
    const db = await loadDb();
    db();

    const { Pool } = await import("pg");
    const instances = (Pool as unknown as { instances: Array<{ config: Record<string, unknown> }> }).instances;
    expect(instances[0].config).toEqual(
      expect.objectContaining({
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
      }),
    );
  });
});

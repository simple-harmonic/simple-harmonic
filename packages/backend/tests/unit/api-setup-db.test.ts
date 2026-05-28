import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
}));

const mockGetConfig = vi.fn();
const mockSetConfig = vi.fn();
vi.mock("@/server/config", () => ({
  getConfig: mockGetConfig,
  setConfig: mockSetConfig,
}));

const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockPoolConnect = vi.fn();
const mockPoolEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => {
  class MockPool {
    connect = mockPoolConnect;
    end = mockPoolEnd;
  }
  return { Pool: MockPool };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/api/settings/setup-db", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeMockClient(queryResults: Record<string, unknown> = {}) {
  mockClientQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("pg_database")) {
      return queryResults.pgDatabase ?? { rowCount: 1 };
    }
    if (sql.includes("pg_tables")) {
      return queryResults.pgTables ?? { rows: [{ tablename: "teams" }, { tablename: "agents" }] };
    }
    return { rows: [], rowCount: 0 };
  });
  mockClientRelease.mockClear();

  const client = {
    query: mockClientQuery,
    release: mockClientRelease,
  };
  mockPoolConnect.mockResolvedValue(client);
  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/settings/setup-db", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfig.mockReturnValue({ databaseUrl: "" });
    mockExecSync.mockReturnValue("");
  });

  it("returns error when no database URL is available", async () => {
    mockGetConfig.mockReturnValue({ databaseUrl: "" });

    const { POST } = await import("@/app/api/settings/setup-db/route");
    const res = await POST(makeRequest({}));
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.error).toBe("No database URL provided");
  });

  it("uses provided databaseUrl over config", async () => {
    const dbUrl = "postgresql://localhost:5432/test_db";
    makeMockClient({ pgDatabase: { rowCount: 1 } });

    const { POST } = await import("@/app/api/settings/setup-db/route");
    const res = await POST(makeRequest({ databaseUrl: dbUrl }));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(mockSetConfig).toHaveBeenCalledWith({ databaseUrl: dbUrl });
    expect(body.steps).toContain("Saved database URL to config");
  });

  it("falls back to config databaseUrl when none provided", async () => {
    const dbUrl = "postgresql://localhost:5432/fallback_db";
    mockGetConfig.mockReturnValue({ databaseUrl: dbUrl });
    makeMockClient({ pgDatabase: { rowCount: 1 } });

    const { POST } = await import("@/app/api/settings/setup-db/route");
    const res = await POST(makeRequest({}));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(mockSetConfig).not.toHaveBeenCalled();
  });

  it("returns error on invalid URL", async () => {
    const { POST } = await import("@/app/api/settings/setup-db/route");
    const res = await POST(makeRequest({ databaseUrl: "not-a-valid-url" }));
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.error).toBe("Invalid database URL");
  });

  it("returns error when URL has no database name", async () => {
    const { POST } = await import("@/app/api/settings/setup-db/route");
    const res = await POST(makeRequest({ databaseUrl: "postgresql://localhost:5432/" }));
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.error).toBe("No database name in URL");
  });

  it("creates database when it does not exist", async () => {
    makeMockClient({ pgDatabase: { rowCount: 0 } });

    const { POST } = await import("@/app/api/settings/setup-db/route");
    const res = await POST(makeRequest({ databaseUrl: "postgresql://localhost:5432/new_db" }));
    const body = await res.json();

    expect(body.ok).toBe(true);
    // Should have called CREATE DATABASE
    const createDbCall = mockClientQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("CREATE DATABASE"),
    );
    expect(createDbCall).toBeTruthy();
    expect(body.steps).toContainEqual(expect.stringContaining("Created database"));
  });

  it("skips creation when database already exists", async () => {
    makeMockClient({ pgDatabase: { rowCount: 1 } });

    const { POST } = await import("@/app/api/settings/setup-db/route");
    const res = await POST(makeRequest({ databaseUrl: "postgresql://localhost:5432/existing_db" }));
    const body = await res.json();

    expect(body.ok).toBe(true);
    const createDbCall = mockClientQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("CREATE DATABASE"),
    );
    expect(createDbCall).toBeUndefined();
    expect(body.steps).toContainEqual(expect.stringContaining("already exists"));
  });

  it("runs drizzle-kit push after db creation", async () => {
    makeMockClient({ pgDatabase: { rowCount: 1 } });

    const { POST } = await import("@/app/api/settings/setup-db/route");
    const res = await POST(makeRequest({ databaseUrl: "postgresql://localhost:5432/test_db" }));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      "npx drizzle-kit push --force",
      expect.objectContaining({
        env: expect.objectContaining({ DATABASE_URL: "postgresql://localhost:5432/test_db" }),
        timeout: 30000,
      }),
    );
    expect(body.steps).toContain("Schema pushed successfully");
  });

  it("returns error when pg connection fails", async () => {
    mockPoolConnect.mockRejectedValue({ code: "ECONNREFUSED" });

    const { POST } = await import("@/app/api/settings/setup-db/route");
    const res = await POST(makeRequest({ databaseUrl: "postgresql://localhost:5432/test_db" }));
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.error).toContain("Connection refused");
  });

  it("returns error when drizzle-kit push fails", async () => {
    makeMockClient({ pgDatabase: { rowCount: 1 } });
    mockExecSync.mockImplementation(() => {
      const err = new Error("push failed") as Error & { stderr?: string };
      err.stderr = "Migration error: table conflict";
      throw err;
    });

    const { POST } = await import("@/app/api/settings/setup-db/route");
    const res = await POST(makeRequest({ databaseUrl: "postgresql://localhost:5432/test_db" }));
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.error).toContain("Schema push failed");
    expect(body.error).toContain("Migration error");
  });

  it("verifies connection and lists tables after push", async () => {
    // Admin pool for create-db step
    // Verify pool for the final check
    // Both use the same mock, so we set up the client to handle both phases
    makeMockClient({
      pgDatabase: { rowCount: 1 },
      pgTables: { rows: [{ tablename: "teams" }, { tablename: "agents" }, { tablename: "tasks" }] },
    });

    const { POST } = await import("@/app/api/settings/setup-db/route");
    const res = await POST(makeRequest({ databaseUrl: "postgresql://localhost:5432/test_db" }));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.steps).toContainEqual(expect.stringContaining("Tables:"));
    expect(body.steps).toContainEqual(expect.stringContaining("teams"));
  });

  it("handles ENOTFOUND pg error", async () => {
    mockPoolConnect.mockRejectedValue({ code: "ENOTFOUND" });

    const { POST } = await import("@/app/api/settings/setup-db/route");
    const res = await POST(makeRequest({ databaseUrl: "postgresql://badhost:5432/test_db" }));
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.error).toContain("Host not found");
  });

  it("handles ETIMEDOUT pg error", async () => {
    mockPoolConnect.mockRejectedValue({ code: "ETIMEDOUT" });

    const { POST } = await import("@/app/api/settings/setup-db/route");
    const res = await POST(makeRequest({ databaseUrl: "postgresql://slowhost:5432/test_db" }));
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.error).toContain("Connection timed out");
  });

  it("saves URL to config only when provided in the request body", async () => {
    const dbUrl = "postgresql://localhost:5432/test_db";
    mockGetConfig.mockReturnValue({ databaseUrl: dbUrl });
    makeMockClient({ pgDatabase: { rowCount: 1 } });

    const { POST } = await import("@/app/api/settings/setup-db/route");

    // Request without databaseUrl in body: should NOT save
    await POST(makeRequest({}));
    expect(mockSetConfig).not.toHaveBeenCalled();
  });

  it("handles verify step failure gracefully", async () => {
    // First pool (admin) succeeds, second pool (verify) fails
    let poolCallCount = 0;
    mockPoolConnect.mockImplementation(async () => {
      poolCallCount++;
      if (poolCallCount <= 1) {
        // Admin pool: success
        return {
          query: mockClientQuery,
          release: mockClientRelease,
        };
      }
      // Verify pool: fail
      throw new Error("verify connection failed");
    });
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_database")) return { rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const { POST } = await import("@/app/api/settings/setup-db/route");
    const res = await POST(makeRequest({ databaseUrl: "postgresql://localhost:5432/test_db" }));
    const body = await res.json();

    // Should still return ok=true because verify failure is just a warning
    expect(body.ok).toBe(true);
    expect(body.steps).toContainEqual(expect.stringContaining("Warning"));
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted so they're available inside hoisted vi.mock factories)
// ---------------------------------------------------------------------------

const { mockRelease, mockQuery, mockConnect, mockEnd, mockGetConfig } = vi.hoisted(() => {
  const mockRelease = vi.fn();
  const mockQuery = vi.fn();
  const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: mockRelease });
  const mockEnd = vi.fn();
  const mockGetConfig = vi.fn();
  return { mockRelease, mockQuery, mockConnect, mockEnd, mockGetConfig };
});

vi.mock("pg", () => {
  const Pool = vi.fn().mockImplementation(function () {
    return { connect: mockConnect, end: mockEnd };
  });
  return { Pool };
});

vi.mock("@/server/config", () => ({
  getConfig: mockGetConfig,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { POST } from "@/server/api/settings/test-db";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/settings/test-db", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnd.mockResolvedValue(undefined);
  });

  it("returns ok:false when no database URL is configured", async () => {
    mockGetConfig.mockReturnValue({ databaseUrl: "" });

    const res = await POST();
    const json = await res.json();

    expect(json).toEqual({ ok: false, error: "No database URL configured" });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("returns ok:true on successful connection", async () => {
    mockGetConfig.mockReturnValue({ databaseUrl: "postgresql://localhost:5432/test" });
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }] });

    const res = await POST();
    const json = await res.json();

    expect(json).toEqual({ ok: true });
    expect(mockConnect).toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledWith("SELECT 1 as ok");
    expect(mockRelease).toHaveBeenCalled();
    expect(mockEnd).toHaveBeenCalled();
  });

  it("returns ok:false with error message on connection error", async () => {
    mockGetConfig.mockReturnValue({ databaseUrl: "postgresql://localhost:5432/test" });
    mockConnect.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await POST();
    const json = await res.json();

    expect(json).toEqual({ ok: false, error: "ECONNREFUSED" });
    expect(mockEnd).toHaveBeenCalled();
  });

  it('returns "Connection failed" when a non-Error is thrown', async () => {
    mockGetConfig.mockReturnValue({ databaseUrl: "postgresql://localhost:5432/test" });
    mockConnect.mockRejectedValueOnce("some string error");

    const res = await POST();
    const json = await res.json();

    expect(json).toEqual({ ok: false, error: "Connection failed" });
    expect(mockEnd).toHaveBeenCalled();
  });
});

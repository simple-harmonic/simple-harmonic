import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

const mockExistsSync = vi.fn();
const mockUnlinkSync = vi.fn();
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  unlinkSync: mockUnlinkSync,
}));

const mockGetCodexAuthStatus = vi.fn();
vi.mock("@/server/codex-auth", () => ({
  getCodexAuthStatus: mockGetCodexAuthStatus,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeProcess(overrides: Record<string, unknown> = {}) {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    stdout: {
      on: vi.fn(),
    },
    stderr: {
      on: vi.fn(),
    },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    }),
    unref: vi.fn(),
    kill: vi.fn(),
    _listeners: listeners,
    _fireExit: (code: number | null) => {
      for (const cb of listeners.exit || []) cb(code);
    },
    ...overrides,
  };
}

function makePostRequest(force = false): Request {
  const url = force
    ? "http://localhost/api/settings/codex-login?force=true"
    : "http://localhost/api/settings/codex-login";
  return new Request(url, { method: "POST" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/settings/codex-login", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetCodexAuthStatus.mockReturnValue({ found: false, hasAccessToken: false });
  });

  it("returns already_authenticated when auth exists and not force", async () => {
    mockGetCodexAuthStatus.mockReturnValue({ found: true, hasAccessToken: true });

    const { POST } = await import("@/app/api/settings/codex-login/route");
    const res = await POST(makePostRequest(false));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("already_authenticated");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("returns already_running when login process is active", async () => {
    const fakeProc = makeFakeProcess();
    mockSpawn.mockReturnValue(fakeProc);

    const { POST } = await import("@/app/api/settings/codex-login/route");

    // First call starts the login
    const res1 = await POST(makePostRequest());
    const body1 = await res1.json();
    expect(body1.status).toBe("started");

    // Second call sees already_running
    const res2 = await POST(makePostRequest());
    const body2 = await res2.json();
    expect(body2.status).toBe("already_running");
  });

  it("deletes auth.json when force=true and file exists", async () => {
    mockExistsSync.mockReturnValue(true);
    const fakeProc = makeFakeProcess();
    mockSpawn.mockReturnValue(fakeProc);

    const { POST } = await import("@/app/api/settings/codex-login/route");
    const res = await POST(makePostRequest(true));
    const body = await res.json();

    expect(body.status).toBe("started");
    expect(mockExistsSync).toHaveBeenCalled();
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it("spawns codex login and returns started on success", async () => {
    const fakeProc = makeFakeProcess();
    mockSpawn.mockReturnValue(fakeProc);

    const { POST } = await import("@/app/api/settings/codex-login/route");
    const res = await POST(makePostRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("started");
    expect(mockSpawn).toHaveBeenCalledWith("codex", ["login"], expect.objectContaining({
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }));
    expect(fakeProc.unref).toHaveBeenCalled();
  });

  it("returns 500 when spawn throws", async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { POST } = await import("@/app/api/settings/codex-login/route");
    const res = await POST(makePostRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Failed to spawn");
  });

  it("kills stale login process older than 5 minutes", async () => {
    const fakeProc1 = makeFakeProcess();
    mockSpawn.mockReturnValue(fakeProc1);

    const { POST } = await import("@/app/api/settings/codex-login/route");

    // Start first login
    await POST(makePostRequest());

    // Simulate time passing (>5 minutes)
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000);

    // Second call should kill the stale process and start a new one
    const fakeProc2 = makeFakeProcess();
    mockSpawn.mockReturnValue(fakeProc2);

    const res = await POST(makePostRequest());
    const body = await res.json();

    expect(fakeProc1.kill).toHaveBeenCalled();
    expect(body.status).toBe("started");

    vi.restoreAllMocks();
  });

  it("force mode bypasses already_authenticated check", async () => {
    mockGetCodexAuthStatus.mockReturnValue({ found: true, hasAccessToken: true });
    mockExistsSync.mockReturnValue(false);
    const fakeProc = makeFakeProcess();
    mockSpawn.mockReturnValue(fakeProc);

    const { POST } = await import("@/app/api/settings/codex-login/route");
    const res = await POST(makePostRequest(true));
    const body = await res.json();

    expect(body.status).toBe("started");
    expect(mockSpawn).toHaveBeenCalled();
  });
});

describe("GET /api/settings/codex-login", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns authenticated=true when codex auth is valid", async () => {
    mockGetCodexAuthStatus.mockReturnValue({ found: true, hasAccessToken: true });

    const { GET } = await import("@/app/api/settings/codex-login/route");
    const res = await GET();
    const body = await res.json();

    expect(body.authenticated).toBe(true);
  });

  it("returns authenticated=false when no auth exists", async () => {
    mockGetCodexAuthStatus.mockReturnValue({ found: false, hasAccessToken: false });

    const { GET } = await import("@/app/api/settings/codex-login/route");
    const res = await GET();
    const body = await res.json();

    expect(body.authenticated).toBe(false);
    expect(body.loginRunning).toBe(false);
  });

  it("returns loginRunning=true when login process is active", async () => {
    mockGetCodexAuthStatus.mockReturnValue({ found: false, hasAccessToken: false });
    const fakeProc = makeFakeProcess();
    mockSpawn.mockReturnValue(fakeProc);

    const mod = await import("@/app/api/settings/codex-login/route");

    // Start a login first
    await mod.POST(makePostRequest());

    // Now GET should show loginRunning=true
    const res = await mod.GET();
    const body = await res.json();

    expect(body.loginRunning).toBe(true);
  });
});

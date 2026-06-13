import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------- mocks ----------

const mockGetSafeConfig = vi.fn();
const mockSetConfig = vi.fn();

vi.mock("@/server/config", () => ({
  getSafeConfig: (...args: unknown[]) => mockGetSafeConfig(...args),
  setConfig: (...args: unknown[]) => mockSetConfig(...args),
  getConfig: vi.fn(),
}));

const mockGetCodexAuthStatus = vi.fn();
const mockGetCodexModels = vi.fn();
const mockRefreshCodexToken = vi.fn();

vi.mock("@/server/codex-auth", () => ({
  getCodexAuthStatus: (...args: unknown[]) => mockGetCodexAuthStatus(...args),
  getCodexModels: (...args: unknown[]) => mockGetCodexModels(...args),
  refreshCodexToken: (...args: unknown[]) => mockRefreshCodexToken(...args),
}));

// ---------- helpers ----------

function jsonRequest(
  url: string,
  body: unknown,
): Request {
  return new Request(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

// ---------- /api/settings ----------

describe("GET /api/settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the safe config as JSON", async () => {
    const safeConfig = {
      openaiApiKey: "sk-1••••cdef",
      openaiBaseUrl: "https://api.openai.com/v1",
      model: "o4-mini",
      dataDir: "/some/data/dir",
      hasOpenaiKey: true,
      hasDataDir: true,
      apiKeySource: "config" as const,
    };
    mockGetSafeConfig.mockReturnValue(safeConfig);

    const { GET } = await import("@/server/api/settings/index");
    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(safeConfig);
    expect(mockGetSafeConfig).toHaveBeenCalledOnce();
  });
});

describe("POST /api/settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates allowed fields and returns safe config", async () => {
    const updatedSafe = {
      openaiApiKey: "sk-n••••wxyz",
      openaiBaseUrl: "https://custom.api.com/v1",
      model: "gpt-5",
      dataDir: "/some/data/dir",
      hasOpenaiKey: true,
      hasDataDir: true,
      apiKeySource: "config" as const,
    };
    mockSetConfig.mockReturnValue(undefined);
    mockGetSafeConfig.mockReturnValue(updatedSafe);

    const { POST } = await import("@/server/api/settings/index");
    const req = jsonRequest("http://localhost/api/settings", {
      openaiApiKey: "sk-new-key-wxyz",
      openaiBaseUrl: "https://custom.api.com/v1",
      model: "gpt-5",
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(updatedSafe);
    expect(mockSetConfig).toHaveBeenCalledOnce();
    expect(mockSetConfig).toHaveBeenCalledWith({
      openaiApiKey: "sk-new-key-wxyz",
      openaiBaseUrl: "https://custom.api.com/v1",
      model: "gpt-5",
    });
  });

  it("updates a single allowed field", async () => {
    const updatedSafe = { model: "gpt-5" };
    mockSetConfig.mockReturnValue(undefined);
    mockGetSafeConfig.mockReturnValue(updatedSafe);

    const { POST } = await import("@/server/api/settings/index");
    const req = jsonRequest("http://localhost/api/settings", {
      model: "gpt-5",
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockSetConfig).toHaveBeenCalledWith({ model: "gpt-5" });
  });

  it("accepts dataDir as an allowed field", async () => {
    mockSetConfig.mockReturnValue(undefined);
    mockGetSafeConfig.mockReturnValue({});

    const { POST } = await import("@/server/api/settings/index");
    const req = jsonRequest("http://localhost/api/settings", {
      dataDir: "/new/data/dir",
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockSetConfig).toHaveBeenCalledWith({
      dataDir: "/new/data/dir",
    });
  });

  it("returns 400 when body has no valid fields", async () => {
    const { POST } = await import("@/server/api/settings/index");
    const req = jsonRequest("http://localhost/api/settings", {});
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no valid fields" });
    expect(mockSetConfig).not.toHaveBeenCalled();
  });

  it("returns 400 when body only has disallowed fields", async () => {
    const { POST } = await import("@/server/api/settings/index");
    const req = jsonRequest("http://localhost/api/settings", {
      secretField: "should-be-ignored",
      adminPassword: "nope",
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no valid fields" });
    expect(mockSetConfig).not.toHaveBeenCalled();
  });

  it("ignores disallowed fields but processes allowed ones", async () => {
    mockSetConfig.mockReturnValue(undefined);
    mockGetSafeConfig.mockReturnValue({});

    const { POST } = await import("@/server/api/settings/index");
    const req = jsonRequest("http://localhost/api/settings", {
      model: "gpt-5",
      secretField: "ignored",
      adminOverride: "ignored",
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockSetConfig).toHaveBeenCalledWith({ model: "gpt-5" });
  });

  it("ignores fields with non-string values", async () => {
    mockSetConfig.mockReturnValue(undefined);
    mockGetSafeConfig.mockReturnValue({});

    const { POST } = await import("@/server/api/settings/index");
    const req = jsonRequest("http://localhost/api/settings", {
      model: 42,
      openaiApiKey: true,
      openaiBaseUrl: "https://valid.com/v1",
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    // Only the string field should be included
    expect(mockSetConfig).toHaveBeenCalledWith({
      openaiBaseUrl: "https://valid.com/v1",
    });
  });

  it("ignores empty string values", async () => {
    const { POST } = await import("@/server/api/settings/index");
    const req = jsonRequest("http://localhost/api/settings", {
      model: "",
      openaiApiKey: "",
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no valid fields" });
    expect(mockSetConfig).not.toHaveBeenCalled();
  });

  it("returns 400 when all allowed fields are empty strings", async () => {
    const { POST } = await import("@/server/api/settings/index");
    const req = jsonRequest("http://localhost/api/settings", {
      openaiApiKey: "",
      openaiBaseUrl: "",
      model: "",
      dataDir: "",
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no valid fields" });
  });
});

// ---------- /api/settings/codex ----------

describe("GET /api/settings/codex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns auth status merged with models", async () => {
    const authStatus = {
      found: true,
      authMode: "browser",
      email: "user@example.com",
      plan: "plus",
      accountId: "acc-123",
      lastRefresh: "2026-05-20T00:00:00Z",
      tokenExpiry: "2026-05-21T00:00:00Z",
      hasAccessToken: true,
    };
    const models = [
      {
        slug: "o4-mini",
        displayName: "O4 Mini",
        description: "Fast model",
        priority: 1,
        supportedInApi: true,
      },
    ];
    mockGetCodexAuthStatus.mockReturnValue(authStatus);
    mockGetCodexModels.mockReturnValue(models);

    const { GET } = await import("@/server/api/settings/codex");
    const res = await GET();

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      found: boolean;
      email: string;
      plan: string;
      hasAccessToken: boolean;
      models: unknown;
    };
    expect(json.found).toBe(true);
    expect(json.email).toBe("user@example.com");
    expect(json.plan).toBe("plus");
    expect(json.hasAccessToken).toBe(true);
    expect(json.models).toEqual(models);
    expect(mockGetCodexAuthStatus).toHaveBeenCalledOnce();
    expect(mockGetCodexModels).toHaveBeenCalledOnce();
  });

  it("returns not-found status with empty models when no auth", async () => {
    mockGetCodexAuthStatus.mockReturnValue({
      found: false,
      authMode: null,
      email: null,
      plan: null,
      accountId: null,
      lastRefresh: null,
      tokenExpiry: null,
      hasAccessToken: false,
    });
    mockGetCodexModels.mockReturnValue([]);

    const { GET } = await import("@/server/api/settings/codex");
    const res = await GET();

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      found: boolean;
      hasAccessToken: boolean;
      models: unknown;
    };
    expect(json.found).toBe(false);
    expect(json.hasAccessToken).toBe(false);
    expect(json.models).toEqual([]);
  });
});

describe("POST /api/settings/codex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns success result from refreshCodexToken", async () => {
    const refreshResult = {
      ok: true,
      accessToken: "new-access-token",
    };
    mockRefreshCodexToken.mockResolvedValue(refreshResult);

    const { POST } = await import("@/server/api/settings/codex");
    const res = await POST();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(refreshResult);
    expect(mockRefreshCodexToken).toHaveBeenCalledOnce();
  });

  it("returns error result when refresh fails", async () => {
    const refreshResult = {
      ok: false,
      error: "No Codex refresh token found",
    };
    mockRefreshCodexToken.mockResolvedValue(refreshResult);

    const { POST } = await import("@/server/api/settings/codex");
    const res = await POST();

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe("No Codex refresh token found");
  });

  it("returns error when token refresh HTTP request fails", async () => {
    const refreshResult = {
      ok: false,
      error: "Refresh failed (401): Unauthorized",
    };
    mockRefreshCodexToken.mockResolvedValue(refreshResult);

    const { POST } = await import("@/server/api/settings/codex");
    const res = await POST();

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("401");
  });
});

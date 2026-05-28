import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs before importing
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from "node:fs";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

// Build a mock JWT with given payload
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("codex-auth", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.CODEX_HOME;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function loadModule() {
    return await import("@/server/codex-auth");
  }

  describe("getCodexAccessToken", () => {
    it("returns null when auth file does not exist", async () => {
      mockExistsSync.mockReturnValue(false);
      const { getCodexAccessToken } = await loadModule();
      expect(getCodexAccessToken()).toBeNull();
    });

    it("returns the access token when file exists", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        auth_mode: "browser",
        tokens: {
          access_token: "test-access-token",
          id_token: "id",
          refresh_token: "refresh",
          account_id: "acc-1",
        },
      }));

      const { getCodexAccessToken } = await loadModule();
      expect(getCodexAccessToken()).toBe("test-access-token");
    });

    it("returns null when file is corrupted", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("invalid json");

      const { getCodexAccessToken } = await loadModule();
      expect(getCodexAccessToken()).toBeNull();
    });

    it("returns null when tokens are missing", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ auth_mode: "browser" }));

      const { getCodexAccessToken } = await loadModule();
      expect(getCodexAccessToken()).toBeNull();
    });
  });

  describe("getCodexAuthStatus", () => {
    it("returns found: false when no auth file", async () => {
      mockExistsSync.mockReturnValue(false);
      const { getCodexAuthStatus } = await loadModule();
      const status = getCodexAuthStatus();

      expect(status.found).toBe(false);
      expect(status.hasAccessToken).toBe(false);
      expect(status.email).toBeNull();
      expect(status.plan).toBeNull();
      expect(status.accountId).toBeNull();
    });

    it("returns full status with valid JWT", async () => {
      const jwt = makeJwt({
        "https://api.openai.com/profile": { email: "user@test.com" },
        "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
        exp: 1700000000,
      });

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        auth_mode: "browser",
        tokens: {
          access_token: jwt,
          id_token: "id",
          refresh_token: "refresh",
          account_id: "acc-1",
        },
        last_refresh: "2025-01-01T00:00:00Z",
      }));

      const { getCodexAuthStatus } = await loadModule();
      const status = getCodexAuthStatus();

      expect(status.found).toBe(true);
      expect(status.hasAccessToken).toBe(true);
      expect(status.authMode).toBe("browser");
      expect(status.email).toBe("user@test.com");
      expect(status.plan).toBe("plus");
      expect(status.accountId).toBe("acc-1");
      expect(status.lastRefresh).toBe("2025-01-01T00:00:00Z");
      expect(status.tokenExpiry).toBeTruthy();
    });

    it("handles JWT without profile claims", async () => {
      const jwt = makeJwt({ sub: "user123" });

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        auth_mode: "browser",
        tokens: {
          access_token: jwt,
          id_token: "id",
          refresh_token: "refresh",
          account_id: "",
        },
      }));

      const { getCodexAuthStatus } = await loadModule();
      const status = getCodexAuthStatus();

      expect(status.found).toBe(true);
      expect(status.email).toBeNull();
      expect(status.plan).toBeNull();
      expect(status.tokenExpiry).toBeNull();
    });

    it("returns found: false when tokens.access_token is missing", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        auth_mode: "browser",
        tokens: {
          id_token: "id",
          refresh_token: "refresh",
          account_id: "acc",
        },
      }));

      const { getCodexAuthStatus } = await loadModule();
      const status = getCodexAuthStatus();

      expect(status.found).toBe(false);
      expect(status.hasAccessToken).toBe(false);
    });
  });

  describe("getCodexModels", () => {
    it("returns empty array when cache file does not exist", async () => {
      mockExistsSync.mockReturnValue(false);
      const { getCodexModels } = await loadModule();
      expect(getCodexModels()).toEqual([]);
    });

    it("parses models from cache file", async () => {
      mockExistsSync.mockImplementation((path) => {
        return String(path).includes("models_cache.json");
      });
      mockReadFileSync.mockReturnValue(JSON.stringify({
        models: [
          { slug: "gpt-5.5", display_name: "GPT 5.5", description: "Latest", priority: 1, supported_in_api: true },
          { slug: "gpt-5.4-mini", display_name: "GPT 5.4 Mini", description: "Fast", priority: 2, supported_in_api: true },
          { slug: "internal-only", display_name: "Internal", description: "", priority: 3, supported_in_api: false },
        ],
      }));

      const { getCodexModels } = await loadModule();
      const models = getCodexModels();

      expect(models).toHaveLength(2); // internal-only filtered out
      expect(models[0].slug).toBe("gpt-5.5");
      expect(models[1].slug).toBe("gpt-5.4-mini");
    });

    it("sorts by priority ascending", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        models: [
          { slug: "low-priority", priority: 10, supported_in_api: true },
          { slug: "high-priority", priority: 1, supported_in_api: true },
        ],
      }));

      const { getCodexModels } = await loadModule();
      const models = getCodexModels();

      expect(models[0].slug).toBe("high-priority");
      expect(models[1].slug).toBe("low-priority");
    });

    it("handles corrupted cache file", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("not json");

      const { getCodexModels } = await loadModule();
      expect(getCodexModels()).toEqual([]);
    });

    it("skips models without slug", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        models: [
          { display_name: "No Slug", supported_in_api: true },
          { slug: "valid", supported_in_api: true },
        ],
      }));

      const { getCodexModels } = await loadModule();
      expect(getCodexModels()).toHaveLength(1);
    });

    it("handles flat array format (no .models wrapper)", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify([
        { slug: "gpt-5.5", supported_in_api: true },
      ]));

      const { getCodexModels } = await loadModule();
      expect(getCodexModels()).toHaveLength(1);
    });

    it("uses CODEX_HOME env var for path resolution", async () => {
      process.env.CODEX_HOME = "/custom/codex";
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ models: [] }));

      const { getCodexModels } = await loadModule();
      getCodexModels();

      const calledPath = String(mockExistsSync.mock.calls[0]?.[0]);
      expect(calledPath).toContain("/custom/codex");
    });
  });

  describe("decodeJwtPayload edge cases (via getCodexAuthStatus)", () => {
    it("handles JWT with only 2 parts", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        auth_mode: "browser",
        tokens: {
          access_token: "only.twoparts",
          id_token: "id",
          refresh_token: "refresh",
          account_id: "acc-1",
        },
      }));

      const { getCodexAuthStatus } = await loadModule();
      const status = getCodexAuthStatus();

      expect(status.found).toBe(true);
      // JWT decode fails, so profile fields are null
      expect(status.email).toBeNull();
      expect(status.plan).toBeNull();
    });

    it("handles JWT with invalid base64 payload", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        auth_mode: "browser",
        tokens: {
          access_token: "header.!!!invalid!!!.sig",
          id_token: "id",
          refresh_token: "refresh",
          account_id: "acc-1",
        },
      }));

      const { getCodexAuthStatus } = await loadModule();
      const status = getCodexAuthStatus();

      expect(status.found).toBe(true);
      expect(status.email).toBeNull();
    });
  });

  describe("refreshCodexToken", () => {
    it("returns error when no refresh token found", async () => {
      mockExistsSync.mockReturnValue(false);

      const { refreshCodexToken } = await loadModule();
      const result = await refreshCodexToken();

      expect(result.ok).toBe(false);
      expect(result.error).toContain("No Codex refresh token");
    });

    it("returns error when auth file exists but has no refresh_token", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        auth_mode: "browser",
        tokens: {
          access_token: "access",
          id_token: "id",
          account_id: "acc",
        },
      }));

      const { refreshCodexToken } = await loadModule();
      const result = await refreshCodexToken();

      expect(result.ok).toBe(false);
      expect(result.error).toContain("No Codex refresh token");
    });

    it("handles fetch failure", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        auth_mode: "browser",
        tokens: {
          access_token: "access",
          id_token: "id",
          refresh_token: "refresh",
          account_id: "acc",
        },
      }));

      // Mock global fetch to fail
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const { refreshCodexToken } = await loadModule();
      const result = await refreshCodexToken();

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Network error");

      globalThis.fetch = originalFetch;
    });

    it("handles non-ok HTTP response", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        auth_mode: "browser",
        tokens: {
          access_token: "access",
          id_token: "id",
          refresh_token: "refresh",
          account_id: "acc",
        },
      }));

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });

      const { refreshCodexToken } = await loadModule();
      const result = await refreshCodexToken();

      expect(result.ok).toBe(false);
      expect(result.error).toContain("401");

      globalThis.fetch = originalFetch;
    });

    it("handles response missing access_token", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        auth_mode: "browser",
        tokens: {
          access_token: "access",
          id_token: "id",
          refresh_token: "refresh",
          account_id: "acc",
        },
      }));

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id_token: "new-id" }), // no access_token
      });

      const { refreshCodexToken } = await loadModule();
      const result = await refreshCodexToken();

      expect(result.ok).toBe(false);
      expect(result.error).toContain("No access_token");

      globalThis.fetch = originalFetch;
    });

    it("refreshes successfully and writes updated auth file", async () => {
      const { writeFileSync: mockWrite } = await import("node:fs");
      const mockWriteFileSync = vi.mocked(mockWrite);

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        auth_mode: "browser",
        tokens: {
          access_token: "old-access",
          id_token: "old-id",
          refresh_token: "old-refresh",
          account_id: "acc",
        },
        last_refresh: "2025-01-01T00:00:00Z",
      }));

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          access_token: "new-access",
          id_token: "new-id",
          refresh_token: "new-refresh",
        }),
      });

      const { refreshCodexToken } = await loadModule();
      const result = await refreshCodexToken();

      expect(result.ok).toBe(true);
      expect(result.accessToken).toBe("new-access");
      expect(mockWriteFileSync).toHaveBeenCalled();

      // Verify the written content
      const writtenContent = JSON.parse(
        (mockWriteFileSync.mock.calls[mockWriteFileSync.mock.calls.length - 1]?.[1] as string).trim(),
      );
      expect(writtenContent.tokens.access_token).toBe("new-access");

      globalThis.fetch = originalFetch;
    });
  });
});

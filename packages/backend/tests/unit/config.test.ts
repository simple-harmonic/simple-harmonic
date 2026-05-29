import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Mock filesystem and codex-auth before importing config
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("@/server/codex-auth", () => ({
  getCodexAccessToken: vi.fn().mockReturnValue(null),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

describe("config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Clear env vars that config reads
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_MODEL;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function loadConfig() {
    return await import("@/server/config");
  }

  describe("getConfig", () => {
    it("returns defaults when no config file exists", async () => {
      mockExistsSync.mockReturnValue(false);
      const { getConfig } = await loadConfig();
      const cfg = getConfig();

      expect(cfg.openaiApiKey).toBe("");
      expect(cfg.openaiBaseUrl).toBe("https://api.openai.com/v1");
      expect(cfg.model).toBe("o4-mini");
      expect(cfg.databaseUrl).toBe("postgresql://localhost:5432/simple_harmonic");
    });

    it("reads values from config file", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        openaiApiKey: "sk-test-key",
        openaiBaseUrl: "https://custom.api.com/v1",
        model: "gpt-5.5",
        databaseUrl: "postgresql://prod:5432/mydb",
      }));

      const { getConfig } = await loadConfig();
      const cfg = getConfig();

      expect(cfg.openaiApiKey).toBe("sk-test-key");
      expect(cfg.openaiBaseUrl).toBe("https://custom.api.com/v1");
      expect(cfg.model).toBe("gpt-5.5");
      expect(cfg.databaseUrl).toBe("postgresql://prod:5432/mydb");
    });

    it("falls back to env vars when config file has no values", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("{}");

      process.env.OPENAI_API_KEY = "sk-env-key";
      process.env.OPENAI_BASE_URL = "https://env.api.com/v1";
      process.env.OPENAI_MODEL = "gpt-env";
      process.env.DATABASE_URL = "postgresql://env:5432/envdb";

      const { getConfig } = await loadConfig();
      const cfg = getConfig();

      expect(cfg.openaiApiKey).toBe("sk-env-key");
      expect(cfg.openaiBaseUrl).toBe("https://env.api.com/v1");
      expect(cfg.model).toBe("gpt-env");
      expect(cfg.databaseUrl).toBe("postgresql://env:5432/envdb");
    });

    it("handles corrupted config file gracefully", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("not valid json {{{");

      const { getConfig } = await loadConfig();
      const cfg = getConfig();

      // Should fall back to defaults
      expect(cfg.model).toBe("o4-mini");
    });

    it("config file takes precedence over env vars", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ model: "from-file" }));
      process.env.OPENAI_MODEL = "from-env";

      const { getConfig } = await loadConfig();
      const cfg = getConfig();

      expect(cfg.model).toBe("from-file");
    });
  });

  describe("getApiKeySource", () => {
    it("returns 'config' when file has apiKey", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ openaiApiKey: "sk-file" }));

      const { getApiKeySource } = await loadConfig();
      expect(getApiKeySource()).toBe("config");
    });

    it("returns 'env' when env var is set but file has no key", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("{}");
      process.env.OPENAI_API_KEY = "sk-env";

      const { getApiKeySource } = await loadConfig();
      expect(getApiKeySource()).toBe("env");
    });

    it("returns 'none' when no key source is available", async () => {
      mockExistsSync.mockReturnValue(false);

      const { getApiKeySource } = await loadConfig();
      expect(getApiKeySource()).toBe("none");
    });
  });

  describe("setConfig", () => {
    it("writes merged config to disk", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ model: "old-model" }));

      const { setConfig } = await loadConfig();
      setConfig({ model: "new-model" });

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const writtenContent = JSON.parse(
        (mockWriteFileSync.mock.calls[0][1] as string).trim(),
      );
      expect(writtenContent.model).toBe("new-model");
    });

    it("preserves existing fields when updating", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        model: "existing",
        databaseUrl: "postgresql://keep:5432/db",
      }));

      const { setConfig } = await loadConfig();
      setConfig({ model: "updated" });

      const writtenContent = JSON.parse(
        (mockWriteFileSync.mock.calls[0][1] as string).trim(),
      );
      expect(writtenContent.model).toBe("updated");
      expect(writtenContent.databaseUrl).toBe("postgresql://keep:5432/db");
    });
  });

  describe("getSafeConfig", () => {
    it("masks the API key", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        openaiApiKey: "sk-1234567890abcdef",
      }));

      const { getSafeConfig } = await loadConfig();
      const safe = getSafeConfig();

      expect(safe.openaiApiKey).not.toBe("sk-1234567890abcdef");
      expect(safe.openaiApiKey).toContain("sk-1");
      expect(safe.openaiApiKey).toContain("cdef");
      expect(safe.openaiApiKey).toContain("••••");
    });

    it("masks empty API key as empty string", async () => {
      mockExistsSync.mockReturnValue(false);

      const { getSafeConfig } = await loadConfig();
      const safe = getSafeConfig();

      expect(safe.openaiApiKey).toBe("");
    });

    it("masks key <= 8 chars as all dots", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        openaiApiKey: "sk-short",
      }));

      const { getSafeConfig } = await loadConfig();
      const safe = getSafeConfig();

      // "sk-short" is exactly 8 chars, so maskSecret returns all dots
      expect(safe.openaiApiKey).toBe("••••••••");
    });

    it("masks key > 8 chars showing first 4 and last 4", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        openaiApiKey: "sk-123456789",
      }));

      const { getSafeConfig } = await loadConfig();
      const safe = getSafeConfig();

      expect(safe.openaiApiKey).toBe("sk-1••••6789");
    });

    it("masks password in database URL", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        databaseUrl: "postgresql://user:secret@host:5432/db",
      }));

      const { getSafeConfig } = await loadConfig();
      const safe = getSafeConfig();

      expect(safe.databaseUrl).not.toContain("secret");
      // URL constructor encodes the bullet chars, so check it's not the original password
      expect(safe.databaseUrl).toContain("user:");
      expect(safe.databaseUrl).toContain("@host:5432/db");
    });

    it("handles database URL without password", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        databaseUrl: "postgresql://localhost:5432/db",
      }));

      const { getSafeConfig } = await loadConfig();
      const safe = getSafeConfig();

      expect(safe.databaseUrl).toBe("postgresql://localhost:5432/db");
    });

    it("handles invalid database URL gracefully", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        databaseUrl: "not-a-url",
      }));

      const { getSafeConfig } = await loadConfig();
      const safe = getSafeConfig();

      expect(safe.databaseUrl).toBe("not-a-url");
    });

    it("includes hasOpenaiKey and hasDatabase flags", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        openaiApiKey: "sk-test",
        databaseUrl: "postgresql://localhost:5432/db",
      }));

      const { getSafeConfig } = await loadConfig();
      const safe = getSafeConfig();

      expect(safe.hasOpenaiKey).toBe(true);
      expect(safe.hasDatabase).toBe(true);
    });

    it("reports apiKeySource", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        openaiApiKey: "sk-test",
      }));

      const { getSafeConfig } = await loadConfig();
      const safe = getSafeConfig();

      expect(safe.apiKeySource).toBe("config");
    });
  });
});

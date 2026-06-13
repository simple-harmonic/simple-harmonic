import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    delete process.env.SH_DATA_DIR;
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
      // Default dataDir resolves to <cwd>/.simple-harmonic/data
      expect(cfg.dataDir).toBe(`${process.cwd()}/.simple-harmonic/data`);
    });

    it("reads values from config file", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          openaiApiKey: "sk-test-key",
          openaiBaseUrl: "https://custom.api.com/v1",
          model: "gpt-5.5",
          dataDir: "/var/lib/simple-harmonic",
        }),
      );

      const { getConfig } = await loadConfig();
      const cfg = getConfig();

      expect(cfg.openaiApiKey).toBe("sk-test-key");
      expect(cfg.openaiBaseUrl).toBe("https://custom.api.com/v1");
      expect(cfg.model).toBe("gpt-5.5");
      expect(cfg.dataDir).toBe("/var/lib/simple-harmonic");
    });

    it("falls back to env vars when config file has no values", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("{}");

      process.env.OPENAI_API_KEY = "sk-env-key";
      process.env.OPENAI_BASE_URL = "https://env.api.com/v1";
      process.env.OPENAI_MODEL = "gpt-env";
      process.env.SH_DATA_DIR = "/env/data/dir";

      const { getConfig } = await loadConfig();
      const cfg = getConfig();

      expect(cfg.openaiApiKey).toBe("sk-env-key");
      expect(cfg.openaiBaseUrl).toBe("https://env.api.com/v1");
      expect(cfg.model).toBe("gpt-env");
      expect(cfg.dataDir).toBe("/env/data/dir");
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

    it("config file dataDir takes precedence over SH_DATA_DIR env", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ dataDir: "/from/file" }));
      process.env.SH_DATA_DIR = "/from/env";

      const { getConfig } = await loadConfig();
      const cfg = getConfig();

      expect(cfg.dataDir).toBe("/from/file");
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
      const writtenContent = JSON.parse((mockWriteFileSync.mock.calls[0][1] as string).trim());
      expect(writtenContent.model).toBe("new-model");
    });

    it("preserves existing fields when updating", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          model: "existing",
          dataDir: "/keep/this/dir",
        }),
      );

      const { setConfig } = await loadConfig();
      setConfig({ model: "updated" });

      const writtenContent = JSON.parse((mockWriteFileSync.mock.calls[0][1] as string).trim());
      expect(writtenContent.model).toBe("updated");
      expect(writtenContent.dataDir).toBe("/keep/this/dir");
    });
  });

  describe("getSafeConfig", () => {
    it("masks the API key", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          openaiApiKey: "sk-1234567890abcdef",
        }),
      );

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
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          openaiApiKey: "sk-short",
        }),
      );

      const { getSafeConfig } = await loadConfig();
      const safe = getSafeConfig();

      // "sk-short" is exactly 8 chars, so maskSecret returns all dots
      expect(safe.openaiApiKey).toBe("••••••••");
    });

    it("masks key > 8 chars showing first 4 and last 4", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          openaiApiKey: "sk-123456789",
        }),
      );

      const { getSafeConfig } = await loadConfig();
      const safe = getSafeConfig();

      expect(safe.openaiApiKey).toBe("sk-1••••6789");
    });

    it("returns the dataDir unmasked", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          dataDir: "/var/lib/simple-harmonic/data",
        }),
      );

      const { getSafeConfig } = await loadConfig();
      const safe = getSafeConfig();

      expect(safe.dataDir).toBe("/var/lib/simple-harmonic/data");
    });

    it("includes hasOpenaiKey and hasDataDir flags", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          openaiApiKey: "sk-test",
          dataDir: "/some/data/dir",
        }),
      );

      const { getSafeConfig } = await loadConfig();
      const safe = getSafeConfig();

      expect(safe.hasOpenaiKey).toBe(true);
      expect(safe.hasDataDir).toBe(true);
    });

    it("reports apiKeySource", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          openaiApiKey: "sk-test",
        }),
      );

      const { getSafeConfig } = await loadConfig();
      const safe = getSafeConfig();

      expect(safe.apiKeySource).toBe("config");
    });

    it("includes codingBackend and codingConfig", async () => {
      mockExistsSync.mockReturnValue(false);

      const { getSafeConfig } = await loadConfig();
      const safe = getSafeConfig();

      expect(safe.codingBackend).toBe("codex");
      expect(safe.codingConfig).toBeDefined();
    });
  });
});

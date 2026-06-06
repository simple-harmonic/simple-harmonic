import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/codex-auth", () => ({
  getCodexAccessToken: () => null,
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("codingBackend config", () => {
  it("defaults to codex", async () => {
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return { ...actual, existsSync: () => false };
    });
    vi.resetModules();
    const { getConfig } = await import("@/server/config");
    expect(getConfig().codingBackend).toBe("codex");
  });

  it("reads from SH_CODING_BACKEND env var", async () => {
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return { ...actual, existsSync: () => false };
    });
    vi.stubEnv("SH_CODING_BACKEND", "claude-code");
    vi.resetModules();
    const { getConfig } = await import("@/server/config");
    expect(getConfig().codingBackend).toBe("claude-code");
  });

  it("rejects invalid backend names", async () => {
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return { ...actual, existsSync: () => false };
    });
    vi.stubEnv("SH_CODING_BACKEND", "invalid-backend");
    vi.resetModules();
    const { getConfig } = await import("@/server/config");
    expect(getConfig().codingBackend).toBe("codex");
  });

  it("includes per-backend codingConfig", async () => {
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return { ...actual, existsSync: () => false };
    });
    vi.resetModules();
    const { getConfig } = await import("@/server/config");
    const cfg = getConfig();
    expect(cfg.codingConfig).toBeDefined();
    expect(cfg.codingConfig.codex).toBeDefined();
    expect(cfg.codingConfig["claude-code"]).toBeDefined();
    expect(cfg.codingConfig.opencode).toBeDefined();
  });
});

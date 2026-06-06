import { describe, expect, it } from "vitest";

// We mock these to avoid their side effects during import
vi.mock("@/server/config", () => ({
  getConfig: () => ({
    openaiApiKey: "sk-test",
    openaiBaseUrl: "https://api.openai.com/v1",
    model: "gpt-5.4-mini",
    databaseUrl: "",
  }),
  getApiKeySource: () => "config" as const,
}));

vi.mock("@/server/codex-auth", () => ({
  getCodexAccessToken: () => null,
  getCodexAuthStatus: () => ({ found: false, accountId: null }),
}));

vi.mock("@/server/proxy-fetch", () => ({
  proxyFetch: vi.fn(),
}));

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: vi.fn() } };
  }
  return { default: MockOpenAI };
});

import { vi } from "vitest";

describe("meta-agent/index exports", () => {
  it("re-exports all expected symbols", async () => {
    const mod = await import("@/lib/meta-agent/index");

    // Types are compile-time only, check runtime exports
    expect(typeof mod.plannerStream).toBe("function");
    expect(typeof mod.runAgent).toBe("function");
    expect(typeof mod.executeTool).toBe("function");
    expect(typeof mod.approveAgentTick).toBe("function");
    expect(typeof mod.approveAgentAction).toBe("function");
    expect(typeof mod.DEFAULT_META_AGENT_PROMPT).toBe("string");
    expect(Array.isArray(mod.AGENT_TOOL_DEFS)).toBe(true);
  });
});

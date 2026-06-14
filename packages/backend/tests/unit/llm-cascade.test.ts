import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks for the resolver (server/llm.ts). The cascade itself is pure.
// ---------------------------------------------------------------------------

const mockGetConfig = vi.fn();
const mockGetApiKeySource = vi.fn();
vi.mock("../../src/server/config", () => ({
  getConfig: () => mockGetConfig(),
  getApiKeySource: () => mockGetApiKeySource(),
}));

const mockCreateAnthropicClient = vi.fn();
vi.mock("../../src/lib/meta-agent/anthropic-adapter", () => ({
  createAnthropicClient: (...args: unknown[]) => mockCreateAnthropicClient(...args),
}));

const mockCreateCodexAppServerClient = vi.fn();
vi.mock("../../src/lib/meta-agent/codex-harness", () => ({
  createCodexAppServerClient: (...args: unknown[]) => mockCreateCodexAppServerClient(...args),
}));

const openaiCtorOpts: Array<Record<string, unknown>> = [];
vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: vi.fn() } };
    constructor(opts: Record<string, unknown>) {
      openaiCtorOpts.push(opts);
    }
  }
  return { default: MockOpenAI };
});

import {
  createCascadeLLM,
  type LLMCandidate,
} from "../../src/lib/meta-agent/cascade";
import { resolveLLM, resolveLLMCandidates } from "../../src/server/llm";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubClient(create: ReturnType<typeof vi.fn>): LLMCandidate["llm"] {
  return { chat: { completions: { create } } } as unknown as LLMCandidate["llm"];
}

function candidate(
  provider: string,
  model: string,
  create: ReturnType<typeof vi.fn>,
): LLMCandidate {
  return { provider, model, llm: stubClient(create) };
}

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_FALLBACK_MODELS",
  "OPENROUTER_BASE_URL",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  openaiCtorOpts.length = 0;
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  mockGetConfig.mockReturnValue({
    openaiApiKey: "",
    openaiBaseUrl: "https://api.openai.com/v1",
    model: "o4-mini",
  });
  mockGetApiKeySource.mockReturnValue("none");
  mockCreateAnthropicClient.mockReturnValue(stubClient(vi.fn()));
  mockCreateCodexAppServerClient.mockReturnValue(stubClient(vi.fn()));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ---------------------------------------------------------------------------
// createCascadeLLM
// ---------------------------------------------------------------------------

describe("createCascadeLLM", () => {
  it("serves from the first candidate and stamps the model", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [] });
    const llm = createCascadeLLM([candidate("anthropic", "claude-sonnet-4", create)]);

    const res = await llm.chat.completions.create({ model: "requested", messages: [] });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4" }),
      undefined,
    );
    expect((res as { model?: string }).model).toBe("claude-sonnet-4");
  });

  it("keeps a model already present on the response", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [], model: "served-2026-01" });
    const llm = createCascadeLLM([candidate("openai", "o4-mini", create)]);
    const res = await llm.chat.completions.create({ messages: [] });
    expect((res as { model?: string }).model).toBe("served-2026-01");
  });

  it("falls through to the next candidate on error and reports the fallback", async () => {
    const first = vi.fn().mockRejectedValue(new Error("429 rate limited"));
    const second = vi.fn().mockResolvedValue({ choices: [] });
    const onFallback = vi.fn();
    const llm = createCascadeLLM(
      [
        candidate("anthropic", "claude-sonnet-4", first),
        candidate("openrouter", "openai/gpt-5.5", second),
      ],
      { onFallback },
    );

    const res = await llm.chat.completions.create({ messages: [] });

    expect(second).toHaveBeenCalledWith(
      expect.objectContaining({ model: "openai/gpt-5.5" }),
      undefined,
    );
    expect((res as { model?: string }).model).toBe("openai/gpt-5.5");
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-4",
        next: { provider: "openrouter", model: "openai/gpt-5.5" },
      }),
    );
  });

  it("rethrows immediately when the call was aborted (no fallback)", async () => {
    const controller = new AbortController();
    const timeout = new Error("tick budget exceeded");
    const first = vi.fn().mockImplementation(async () => {
      controller.abort(timeout);
      throw timeout;
    });
    const second = vi.fn();
    const onFallback = vi.fn();
    const llm = createCascadeLLM(
      [candidate("anthropic", "a", first), candidate("openai", "b", second)],
      { onFallback },
    );

    await expect(
      llm.chat.completions.create({ messages: [] }, { signal: controller.signal }),
    ).rejects.toBe(timeout);
    expect(second).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("throws the last error when every candidate fails", async () => {
    const e1 = new Error("first down");
    const e2 = new Error("second down");
    const onFallback = vi.fn();
    const llm = createCascadeLLM(
      [
        candidate("anthropic", "a", vi.fn().mockRejectedValue(e1)),
        candidate("openai", "b", vi.fn().mockRejectedValue(e2)),
      ],
      { onFallback },
    );

    await expect(llm.chat.completions.create({ messages: [] })).rejects.toBe(e2);
    expect(onFallback).toHaveBeenCalledTimes(2);
    expect(onFallback).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: "openai", model: "b", next: undefined }),
    );
  });

  it("a throwing onFallback observer does not break the cascade", async () => {
    const llm = createCascadeLLM(
      [
        candidate("anthropic", "a", vi.fn().mockRejectedValue(new Error("down"))),
        candidate("openai", "b", vi.fn().mockResolvedValue({ choices: [] })),
      ],
      {
        onFallback: () => {
          throw new Error("buggy observer");
        },
      },
    );
    await expect(llm.chat.completions.create({ messages: [] })).resolves.toBeTruthy();
  });

  it("requires at least one candidate", () => {
    expect(() => createCascadeLLM([])).toThrow(/at least one candidate/);
  });
});

// ---------------------------------------------------------------------------
// resolveLLMCandidates / resolveLLM
// ---------------------------------------------------------------------------

describe("resolveLLMCandidates", () => {
  it("orders codex > anthropic > openrouter and skips openai under the codex source", () => {
    mockGetApiKeySource.mockReturnValue("codex");
    mockGetConfig.mockReturnValue({ openaiApiKey: "chatgpt-token", openaiBaseUrl: "", model: "" });
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    const c = resolveLLMCandidates();

    // Codex (app-server wrapped as an LLMClient) is the top cascade candidate
    // under the codex source; the direct OpenAI key is skipped (openaiApiKey is
    // the ChatGPT token there, not a platform key).
    expect(c.map((x) => x.provider)).toEqual(["codex", "anthropic", "openrouter"]);
    expect(c[0].model).toBe("gpt-5.5");
    expect(mockCreateCodexAppServerClient).toHaveBeenCalledWith({ model: "gpt-5.5" });
  });

  it("expands OPENROUTER_MODEL + OPENROUTER_FALLBACK_MODELS into deduped steps", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.OPENROUTER_MODEL = "anthropic/claude-sonnet-4";
    process.env.OPENROUTER_FALLBACK_MODELS =
      " openai/gpt-5.5, google/gemini-2.5-pro ,anthropic/claude-sonnet-4,";

    const c = resolveLLMCandidates();

    expect(c.filter((x) => x.provider === "openrouter").map((x) => x.model)).toEqual([
      "anthropic/claude-sonnet-4",
      "openai/gpt-5.5",
      "google/gemini-2.5-pro",
    ]);
    expect(openaiCtorOpts[0]).toMatchObject({
      apiKey: "sk-or-test",
      baseURL: "https://openrouter.ai/api/v1",
    });
  });

  it("appends the direct OpenAI key after anthropic and openrouter", () => {
    mockGetApiKeySource.mockReturnValue("env");
    mockGetConfig.mockReturnValue({
      openaiApiKey: "sk-openai",
      openaiBaseUrl: "https://api.openai.com/v1",
      model: "o4-mini",
    });
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.ANTHROPIC_MODEL = "claude-haiku-4-5";
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    const c = resolveLLMCandidates();

    expect(c.map((x) => `${x.provider}/${x.model}`)).toEqual([
      "anthropic/claude-haiku-4-5",
      "openrouter/anthropic/claude-sonnet-4",
      "openai/o4-mini",
    ]);
    expect(mockCreateAnthropicClient).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-ant-test", timeout: 120_000 }),
    );
  });

  it("falls back to a key-less openai candidate when nothing is configured", () => {
    const c = resolveLLMCandidates();
    expect(c).toHaveLength(1);
    expect(c[0].provider).toBe("openai");
    expect(c[0].model).toBe("o4-mini");
  });

  it("resolveLLM exposes the primary model and the chain", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    const { model, chain } = resolveLLM();

    expect(model).toBe("claude-sonnet-4-20250514");
    expect(chain).toEqual([
      "anthropic/claude-sonnet-4-20250514",
      "openrouter/anthropic/claude-sonnet-4",
    ]);
  });
});

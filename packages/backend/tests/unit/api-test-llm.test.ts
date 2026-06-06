import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted so they're available inside hoisted vi.mock factories)
// ---------------------------------------------------------------------------

const {
  mockCreate,
  mockGetConfig,
  mockGetApiKeySource,
  mockGetCodexAccessToken,
  mockGetCodexAuthStatus,
  mockProxyFetch,
} = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockGetConfig: vi.fn(),
  mockGetApiKeySource: vi.fn(),
  mockGetCodexAccessToken: vi.fn(),
  mockGetCodexAuthStatus: vi.fn(),
  mockProxyFetch: vi.fn(),
}));

vi.mock("openai", () => {
  const OpenAI = vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockCreate } } };
  });
  return { default: OpenAI };
});

vi.mock("@/server/config", () => ({
  getConfig: mockGetConfig,
  getApiKeySource: mockGetApiKeySource,
}));

vi.mock("@/server/codex-auth", () => ({
  getCodexAccessToken: mockGetCodexAccessToken,
  getCodexAuthStatus: mockGetCodexAuthStatus,
}));

vi.mock("@/server/proxy-fetch", () => ({
  proxyFetch: mockProxyFetch,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { POST } from "@/app/api/settings/test-llm/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ssePayload(events: Array<{ type: string; [k: string]: unknown }>): string {
  return events.map((e) => `data: ${JSON.stringify(e)}`).join("\n") + "\n";
}

function makeResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/settings/test-llm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // No API key, not codex
  // -----------------------------------------------------------------------

  describe("when no API key and source is not codex", () => {
    it("returns error about missing API key", async () => {
      mockGetConfig.mockReturnValue({ openaiApiKey: "", openaiBaseUrl: "", model: "o4-mini" });
      mockGetApiKeySource.mockReturnValue("none");

      const res = await POST();
      const json = await res.json();

      expect(json.ok).toBe(false);
      expect(json.error).toMatch(/No API key configured/);
    });
  });

  // -----------------------------------------------------------------------
  // OpenAI path (non-codex)
  // -----------------------------------------------------------------------

  describe("openai path", () => {
    beforeEach(() => {
      mockGetConfig.mockReturnValue({
        openaiApiKey: "sk-test",
        openaiBaseUrl: "https://api.openai.com/v1",
        model: "o4-mini",
      });
      mockGetApiKeySource.mockReturnValue("config");
    });

    it("returns ok:true with model and response on success", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "OK" } }],
      });

      const res = await POST();
      const json = await res.json();

      expect(json).toEqual({ ok: true, model: "o4-mini", response: "OK" });
    });

    it("returns ok:false with describeError on failure", async () => {
      mockCreate.mockRejectedValueOnce(new Error("Connection refused"));

      const res = await POST();
      const json = await res.json();

      expect(json.ok).toBe(false);
      expect(json.error).toBe("Connection refused");
    });
  });

  // -----------------------------------------------------------------------
  // Codex path
  // -----------------------------------------------------------------------

  describe("codex path", () => {
    beforeEach(() => {
      mockGetConfig.mockReturnValue({
        openaiApiKey: "",
        openaiBaseUrl: "",
        model: "codex-mini",
      });
      mockGetApiKeySource.mockReturnValue("codex");
    });

    it("returns error when no codex access token", async () => {
      mockGetCodexAccessToken.mockReturnValue(null);

      const res = await POST();
      const json = await res.json();

      expect(json.ok).toBe(false);
      expect(json.error).toMatch(/No Codex access token/);
    });

    it("returns error when no accountId", async () => {
      mockGetCodexAccessToken.mockReturnValue("tok-abc");
      mockGetCodexAuthStatus.mockReturnValue({ accountId: "" });

      const res = await POST();
      const json = await res.json();

      expect(json.ok).toBe(false);
      expect(json.error).toMatch(/no account_id/);
    });

    it("parses SSE response and returns ok:true on success", async () => {
      mockGetCodexAccessToken.mockReturnValue("tok-abc");
      mockGetCodexAuthStatus.mockReturnValue({ accountId: "acc-123" });

      const body = ssePayload([
        { type: "response.created", response: { model: "codex-mini-latest" } },
        { type: "response.output_text.done", text: "OK" },
      ]);
      // Inject "model" into raw text so the regex picks it up
      const raw = body + '\ndata: {"model":"codex-mini-latest"}';
      mockProxyFetch.mockResolvedValueOnce(makeResponse(raw));

      const res = await POST();
      const json = await res.json();

      expect(json.ok).toBe(true);
      expect(json.model).toBe("codex-mini-latest");
      expect(json.response).toBe("OK");
    });

    it("falls back to requested model when regex doesn't match", async () => {
      mockGetCodexAccessToken.mockReturnValue("tok-abc");
      mockGetCodexAuthStatus.mockReturnValue({ accountId: "acc-123" });

      const body = ssePayload([
        { type: "response.output_text.done", text: "Hello" },
      ]);
      mockProxyFetch.mockResolvedValueOnce(makeResponse(body));

      const res = await POST();
      const json = await res.json();

      expect(json.ok).toBe(true);
      expect(json.model).toBe("codex-mini");
      expect(json.response).toBe("Hello");
    });

    it("returns error on non-ok API response", async () => {
      mockGetCodexAccessToken.mockReturnValue("tok-abc");
      mockGetCodexAuthStatus.mockReturnValue({ accountId: "acc-123" });

      mockProxyFetch.mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401 }),
      );

      const res = await POST();
      const json = await res.json();

      expect(json.ok).toBe(false);
      expect(json.error).toMatch(/Codex API 401/);
    });

    it("returns describeError on network error", async () => {
      mockGetCodexAccessToken.mockReturnValue("tok-abc");
      mockGetCodexAuthStatus.mockReturnValue({ accountId: "acc-123" });

      const inner = new Error("ECONNREFUSED");
      const outer = new Error("fetch failed");
      (outer as unknown as { cause: Error }).cause = inner;
      mockProxyFetch.mockRejectedValueOnce(outer);

      const res = await POST();
      const json = await res.json();

      expect(json.ok).toBe(false);
      expect(json.error).toBe("fetch failed · ECONNREFUSED");
    });
  });

  // -----------------------------------------------------------------------
  // describeError edge cases (exercised through error paths)
  // -----------------------------------------------------------------------

  describe("describeError behavior", () => {
    beforeEach(() => {
      mockGetConfig.mockReturnValue({
        openaiApiKey: "sk-test",
        openaiBaseUrl: "https://api.openai.com/v1",
        model: "o4-mini",
      });
      mockGetApiKeySource.mockReturnValue("config");
    });

    it('returns "Unknown error" for non-Error throws', async () => {
      mockCreate.mockRejectedValueOnce("string-error");

      const res = await POST();
      const json = await res.json();

      expect(json.ok).toBe(false);
      expect(json.error).toBe("Unknown error");
    });

    it("walks an Error cause chain", async () => {
      const root = new Error("ETIMEDOUT");
      const mid = new Error("connect failed");
      (mid as unknown as { cause: Error }).cause = root;
      const top = new Error("fetch failed");
      (top as unknown as { cause: Error }).cause = mid;

      mockCreate.mockRejectedValueOnce(top);

      const res = await POST();
      const json = await res.json();

      expect(json.ok).toBe(false);
      expect(json.error).toBe("fetch failed · connect failed · ETIMEDOUT");
    });

    it("handles object cause with code and message", async () => {
      const err = new Error("request failed");
      (err as unknown as { cause: { code: string; message: string } }).cause = {
        code: "ENOTFOUND",
        message: "getaddrinfo ENOTFOUND api.openai.com",
      };

      mockCreate.mockRejectedValueOnce(err);

      const res = await POST();
      const json = await res.json();

      expect(json.ok).toBe(false);
      expect(json.error).toBe(
        "request failed · code=ENOTFOUND · getaddrinfo ENOTFOUND api.openai.com",
      );
    });

    it("deduplicates consecutive identical fragments", async () => {
      const inner = new Error("fetch failed");
      const outer = new Error("fetch failed");
      (outer as unknown as { cause: Error }).cause = inner;

      mockCreate.mockRejectedValueOnce(outer);

      const res = await POST();
      const json = await res.json();

      expect(json.ok).toBe(false);
      // Deduplication collapses "fetch failed · fetch failed" into one
      expect(json.error).toBe("fetch failed");
    });
  });
});

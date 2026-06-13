import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApiToolDef, buildApiToolImpl } from "@/server/tools/api-tool-runtime";
import type { ApiToolConfig } from "@/server/store/types";
import type { ToolRunContext } from "@/lib/meta-agent/tools";

vi.mock("@/server/connectors", () => ({
  resolveConnector: (key: string) => {
    if (key === "TEST_TOKEN") return "tok_123";
    return null;
  },
}));

const mockFetch = vi.fn();
vi.mock("@/server/proxy-fetch", () => ({
  proxyFetch: (...args: unknown[]) => mockFetch(...args),
}));

// The SSRF guard (url-guard) resolves DNS before fetching; mock it to a public
// IP so these tests exercise the request path, not real DNS.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

const baseConfig: ApiToolConfig = {
  baseUrl: "https://api.example.com",
  connectorKey: "TEST_TOKEN",
  allowedMethods: ["GET", "POST"],
};

const ctx: ToolRunContext = {
  teamId: "team-1",
  agentId: "agent-1",
  agentName: "test-agent",
  peers: [],
  a2ax: { sendDirect: vi.fn(), broadcast: vi.fn() },
};

describe("buildApiToolDef", () => {
  it("creates a tool definition with correct metadata", () => {
    const def = buildApiToolDef("test_api", "Test API", baseConfig);
    expect(def.name).toBe("test_api");
    expect(def.description).toBe("Test API");
    expect(def.category).toBe("network");
    expect(def.risk).toBe("destructive");
  });

  it("classifies GET as safe via isDestructive", () => {
    const def = buildApiToolDef("test_api", "Test", baseConfig);
    expect(def.isDestructive!({ method: "GET", path: "/test" })).toBe(false);
    expect(def.isDestructive!({ method: "POST", path: "/test" })).toBe(true);
  });
});

describe("buildApiToolImpl", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("makes an authenticated GET request", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{"ok":true}') })
            .mockResolvedValueOnce({ done: true }),
        }),
      },
    });

    const impl = buildApiToolImpl("test_api", baseConfig);
    const result = await impl({ method: "GET", path: "/users" }, ctx);

    expect(result.success).toBe(true);
    expect(result.result).toContain('"ok":true');
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.example.com/users",
      expect.objectContaining({ method: "GET" }),
      { ip: "93.184.216.34", family: 4 },
    );

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer tok_123");
  });

  it("sends JSON body on POST", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      statusText: "Created",
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{"id":1}') })
            .mockResolvedValueOnce({ done: true }),
        }),
      },
    });

    const impl = buildApiToolImpl("test_api", baseConfig);
    const result = await impl(
      { method: "POST", path: "/items", body: { name: "test" } },
      ctx,
    );

    expect(result.success).toBe(true);
    const callBody = mockFetch.mock.calls[0][1].body;
    expect(JSON.parse(callBody)).toEqual({ name: "test" });
  });

  it("appends query parameters", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      body: { getReader: () => ({ read: vi.fn().mockResolvedValue({ done: true }) }) },
    });

    const impl = buildApiToolImpl("test_api", baseConfig);
    await impl({ method: "GET", path: "/search", query: { q: "hello" } }, ctx);

    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain("q=hello");
  });

  it("fails on missing connector for write methods", async () => {
    const noTokenConfig: ApiToolConfig = { ...baseConfig, connectorKey: "MISSING_TOKEN" };
    const impl = buildApiToolImpl("test_api", noTokenConfig);
    const result = await impl({ method: "POST", path: "/data" }, ctx);

    expect(result.success).toBe(false);
    expect(result.result).toContain("MISSING_TOKEN");
  });

  it("uses custom auth header and prefix", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      body: { getReader: () => ({ read: vi.fn().mockResolvedValue({ done: true }) }) },
    });

    const customAuthConfig: ApiToolConfig = {
      ...baseConfig,
      authHeader: "X-API-Key",
      authPrefix: "",
    };

    const impl = buildApiToolImpl("test_api", customAuthConfig);
    await impl({ method: "GET", path: "/test" }, ctx);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["X-API-Key"]).toBe("tok_123");
    expect(headers.Authorization).toBeUndefined();
  });

  it("includes pathPrefix in URL", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      body: { getReader: () => ({ read: vi.fn().mockResolvedValue({ done: true }) }) },
    });

    const prefixConfig: ApiToolConfig = { ...baseConfig, pathPrefix: "/v2" };
    const impl = buildApiToolImpl("test_api", prefixConfig);
    await impl({ method: "GET", path: "/users" }, ctx);

    expect(mockFetch.mock.calls[0][0]).toBe("https://api.example.com/v2/users");
  });

  it("reports HTTP errors", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode("not found") })
            .mockResolvedValueOnce({ done: true }),
        }),
      },
    });

    const impl = buildApiToolImpl("test_api", baseConfig);
    const result = await impl({ method: "GET", path: "/missing" }, ctx);

    expect(result.success).toBe(false);
    expect(result.result).toContain("404");
  });
});

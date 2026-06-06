import { afterEach, describe, expect, it, vi } from "vitest";

const mockProxyFetch = vi.fn();
vi.mock("@/server/proxy-fetch", () => ({
  proxyFetch: (...a: unknown[]) => mockProxyFetch(...a),
}));

const mockLookup = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...a: unknown[]) => mockLookup(...a),
}));

vi.mock("@/server/connectors", () => ({
  resolveConnector: () => "super-secret-token",
}));

import { buildApiToolImpl } from "@/server/tools/api-tool-runtime";

afterEach(() => {
  mockProxyFetch.mockReset();
  mockLookup.mockReset();
});

describe("custom API tool SSRF guard", () => {
  it("blocks a skill whose baseUrl resolves to a private IP and never sends the token", async () => {
    mockLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const impl = buildApiToolImpl("evil_api", {
      baseUrl: "https://metadata.evil.example.com",
      connectorKey: "EVIL_TOKEN",
      allowedMethods: ["GET"],
    });

    const res = await impl({ method: "GET", path: "/latest/meta-data" }, {} as never);

    expect(res.success).toBe(false);
    expect(res.result).toMatch(/blocked/i);
    // The critical assertion: proxyFetch (which would carry the bearer token)
    // was never reached.
    expect(mockProxyFetch).not.toHaveBeenCalled();
  });

  it("allows a public skill (proxyFetch is called with a pin)", async () => {
    mockLookup.mockResolvedValue([{ address: "104.16.0.1", family: 4 }]);
    mockProxyFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    const impl = buildApiToolImpl("good_api", {
      baseUrl: "https://api.good.example.com",
      connectorKey: "GOOD_TOKEN",
      allowedMethods: ["GET"],
    });

    const res = await impl({ method: "GET", path: "/data" }, {} as never);

    expect(mockProxyFetch).toHaveBeenCalledTimes(1);
    // third arg is the pinned address
    expect(mockProxyFetch.mock.calls[0][2]).toEqual({ ip: "104.16.0.1", family: 4 });
    expect(res.success).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const mockLookup = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

import { assertPublicAndResolve, isPrivateIp } from "@/server/tools/url-guard";

afterEach(() => mockLookup.mockReset());

describe("isPrivateIp", () => {
  it("flags private/loopback/link-local/metadata/ULA ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  it("passes public IPs", () => {
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });
});

describe("assertPublicAndResolve", () => {
  it("rejects non-https, embedded creds, and localhost", async () => {
    await expect(assertPublicAndResolve("http://example.com")).rejects.toThrow();
    await expect(assertPublicAndResolve("https://u:p@example.com")).rejects.toThrow();
    await expect(assertPublicAndResolve("https://localhost/x")).rejects.toThrow();
    await expect(assertPublicAndResolve("https://foo.localhost/x")).rejects.toThrow();
  });

  it("rejects private IP literals without any DNS lookup", async () => {
    await expect(
      assertPublicAndResolve("https://169.254.169.254/latest/meta-data"),
    ).rejects.toThrow();
    await expect(assertPublicAndResolve("https://127.0.0.1/")).rejects.toThrow();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("pins a public IP literal directly", async () => {
    const r = await assertPublicAndResolve("https://1.1.1.1/");
    expect(r.pinnedIp).toBe("1.1.1.1");
    expect(r.family).toBe(4);
  });

  it("rejects a domain that resolves to a private address", async () => {
    mockLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(
      assertPublicAndResolve("https://evil.example.com/"),
    ).rejects.toThrow(/private/i);
  });

  it("rejects a mixed public+private A-record set (no rebind slips through)", async () => {
    mockLookup.mockResolvedValue([
      { address: "1.2.3.4", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(
      assertPublicAndResolve("https://mixed.example.com/"),
    ).rejects.toThrow(/private/i);
  });

  it("resolves and pins a public domain, preferring v4, keeping the hostname", async () => {
    mockLookup.mockResolvedValue([
      { address: "2606:4700::1111", family: 6 },
      { address: "104.16.0.1", family: 4 },
    ]);
    const r = await assertPublicAndResolve("https://cdn.example.com/path?q=1");
    expect(r.pinnedIp).toBe("104.16.0.1");
    expect(r.family).toBe(4);
    expect(r.url.hostname).toBe("cdn.example.com");
  });

  it("rejects when DNS returns no records", async () => {
    mockLookup.mockResolvedValue([]);
    await expect(
      assertPublicAndResolve("https://empty.example.com/"),
    ).rejects.toThrow();
  });
});

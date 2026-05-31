import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// proxyFetch is mocked for the network tools; hoisted so the vi.mock factory
// can see it.
const mockProxyFetch = vi.hoisted(() => vi.fn());
vi.mock("@/server/proxy-fetch", () => ({
  proxyFetch: mockProxyFetch,
}));

import {
  readFileDef,
  readFileImpl,
  writeFileDef,
  writeFileImpl,
} from "@/server/tools/filesystem";
import { runCommandDef, runCommandImpl } from "@/server/tools/shell";
import {
  httpFetchDef,
  httpFetchImpl,
  githubApiDef,
  githubApiImpl,
} from "@/server/tools/network";
import { createAppRegistry } from "@/server/tools";
import { resolveInJail, JailEscapeError } from "@/server/tools/sandbox";
import type { ToolRunContext } from "@/lib/meta-agent/tools";

// ---------------------------------------------------------------------------
// Shared setup: a temp jail dir, restored env per test
// ---------------------------------------------------------------------------

let jail: string;
const ORIGINAL_ENV = { ...process.env };

function ctx(): ToolRunContext {
  return {
    teamId: "t1",
    agentId: "a1",
    agentName: "agent",
    peers: [],
    a2ax: { sendDirect: vi.fn(), broadcast: vi.fn() },
  };
}

beforeEach(() => {
  jail = mkdtempSync(join(tmpdir(), "sh-tools-"));
  process.env.SH_TOOLS_CWD = jail;
  delete process.env.SH_ENABLE_TOOLS;
  delete process.env.GITHUB_TOKEN;
  mockProxyFetch.mockReset();
});

afterEach(() => {
  rmSync(jail, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// sandbox: resolveInJail
// ---------------------------------------------------------------------------

describe("resolveInJail", () => {
  it("resolves a relative path inside the jail", () => {
    const abs = resolveInJail("sub/file.txt");
    expect(abs.startsWith(jail)).toBe(true);
  });

  it("rejects ../ traversal", () => {
    expect(() => resolveInJail("../escape.txt")).toThrow(JailEscapeError);
  });

  it("rejects absolute paths outside the jail", () => {
    expect(() => resolveInJail("/etc/passwd")).toThrow(JailEscapeError);
  });

  it("rejects null bytes", () => {
    expect(() => resolveInJail("a\0b")).toThrow(JailEscapeError);
  });

  it("allows the jail root itself", () => {
    expect(resolveInJail(".")).toBe(jail);
  });
});

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

describe("read_file", () => {
  it("is a safe filesystem tool", () => {
    expect(readFileDef.risk).toBe("safe");
    expect(readFileDef.category).toBe("filesystem");
  });

  it("reads a file inside the jail", async () => {
    writeFileSync(join(jail, "hello.txt"), "world");
    const res = await readFileImpl({ path: "hello.txt" }, ctx());
    expect(res.success).toBe(true);
    expect(res.result).toBe("world");
    expect(res.action?.actionType).toBe("file_read");
    // T8: the content snippet is mirrored into the action payload for the UI.
    expect(res.action?.payload.output).toBe("world");
  });

  it("returns an error for a missing file", async () => {
    const res = await readFileImpl({ path: "nope.txt" }, ctx());
    expect(res.success).toBe(false);
    expect(res.result).toContain("not found");
  });

  it("refuses path traversal", async () => {
    const res = await readFileImpl({ path: "../../etc/passwd" }, ctx());
    expect(res.success).toBe(false);
    expect(res.result).toContain("outside the allowed working directory");
  });

  it("refuses to read a directory", async () => {
    mkdirSync(join(jail, "adir"));
    const res = await readFileImpl({ path: "adir" }, ctx());
    expect(res.success).toBe(false);
    expect(res.result).toContain("Not a file");
  });
});

// ---------------------------------------------------------------------------
// write_file (gated)
// ---------------------------------------------------------------------------

describe("write_file", () => {
  it("is a destructive filesystem tool", () => {
    expect(writeFileDef.risk).toBe("destructive");
  });

  it("is disabled without SH_ENABLE_TOOLS", async () => {
    const res = await writeFileImpl({ path: "out.txt", content: "x" }, ctx());
    expect(res.success).toBe(false);
    expect(res.result).toContain("disabled");
  });

  it("writes when enabled", async () => {
    process.env.SH_ENABLE_TOOLS = "1";
    const res = await writeFileImpl(
      { path: "nested/out.txt", content: "hello" },
      ctx(),
    );
    expect(res.success).toBe(true);
    expect(res.action?.actionType).toBe("file_written");
    // Round-trip via read_file.
    const back = await readFileImpl({ path: "nested/out.txt" }, ctx());
    expect(back.result).toBe("hello");
  });

  it("refuses traversal even when enabled", async () => {
    process.env.SH_ENABLE_TOOLS = "1";
    const res = await writeFileImpl(
      { path: "../evil.txt", content: "x" },
      ctx(),
    );
    expect(res.success).toBe(false);
    expect(res.result).toContain("outside the allowed working directory");
  });
});

// ---------------------------------------------------------------------------
// run_command (gated)
// ---------------------------------------------------------------------------

describe("run_command", () => {
  it("is a destructive shell tool", () => {
    expect(runCommandDef.risk).toBe("destructive");
    expect(runCommandDef.category).toBe("shell");
  });

  it("is disabled without SH_ENABLE_TOOLS", async () => {
    const res = await runCommandImpl({ command: "echo", args: ["hi"] }, ctx());
    expect(res.success).toBe(false);
    expect(res.result).toContain("disabled");
  });

  it("runs an allowlisted program when enabled", async () => {
    process.env.SH_ENABLE_TOOLS = "1";
    const res = await runCommandImpl({ command: "echo", args: ["hi"] }, ctx());
    expect(res.success).toBe(true);
    expect(res.result).toContain("hi");
    expect(res.action?.actionType).toBe("command_run");
  });

  it("refuses programs not on the allowlist", async () => {
    process.env.SH_ENABLE_TOOLS = "1";
    const res = await runCommandImpl({ command: "rm", args: ["-rf", "/"] }, ctx());
    expect(res.success).toBe(false);
    expect(res.result).toContain("not allowed");
  });

  it("treats shell metacharacters as literal argv (no injection)", async () => {
    process.env.SH_ENABLE_TOOLS = "1";
    // If this went through a shell, the `;` would start a second command.
    // Via execFile argv it's just a literal echo argument.
    const res = await runCommandImpl(
      { command: "echo", args: ["a; touch pwned"] },
      ctx(),
    );
    expect(res.success).toBe(true);
    expect(res.result).toContain("a; touch pwned");
    // The injected file must NOT exist.
    const check = await readFileImpl({ path: "pwned" }, ctx());
    expect(check.success).toBe(false);
  });

  it("refuses mutating git subcommands", async () => {
    process.env.SH_ENABLE_TOOLS = "1";
    const res = await runCommandImpl({ command: "git", args: ["push"] }, ctx());
    expect(res.success).toBe(false);
    expect(res.result).toContain("not allowed");
  });
});

// ---------------------------------------------------------------------------
// http_fetch
// ---------------------------------------------------------------------------

describe("http_fetch", () => {
  it("is a safe network tool", () => {
    expect(httpFetchDef.risk).toBe("safe");
    expect(httpFetchDef.category).toBe("network");
  });

  it("GETs a URL and returns the body", async () => {
    mockProxyFetch.mockResolvedValue(
      new Response("hello body", { status: 200 }),
    );
    const res = await httpFetchImpl({ url: "https://example.com" }, ctx());
    expect(res.success).toBe(true);
    expect(res.result).toBe("hello body");
    expect(mockProxyFetch).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("reports non-2xx as failure", async () => {
    mockProxyFetch.mockResolvedValue(
      new Response("nope", { status: 404, statusText: "Not Found" }),
    );
    const res = await httpFetchImpl({ url: "https://example.com/x" }, ctx());
    expect(res.success).toBe(false);
    expect(res.result).toContain("404");
  });
});

// ---------------------------------------------------------------------------
// github_api
// ---------------------------------------------------------------------------

describe("github_api", () => {
  it("is a destructive network tool", () => {
    expect(githubApiDef.risk).toBe("destructive");
  });

  it("allows GET without the kill switch", async () => {
    mockProxyFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const res = await githubApiImpl(
      { method: "GET", path: "/repos/o/r" },
      ctx(),
    );
    expect(res.success).toBe(true);
    expect(mockProxyFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/o/r",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("blocks writes without the kill switch", async () => {
    const res = await githubApiImpl(
      { method: "POST", path: "/repos/o/r/issues", body: { title: "x" } },
      ctx(),
    );
    expect(res.success).toBe(false);
    expect(res.result).toContain("disabled");
    expect(mockProxyFetch).not.toHaveBeenCalled();
  });

  it("blocks writes when enabled but no token", async () => {
    process.env.SH_ENABLE_TOOLS = "1";
    const res = await githubApiImpl(
      { method: "POST", path: "/repos/o/r/issues", body: { title: "x" } },
      ctx(),
    );
    expect(res.success).toBe(false);
    expect(res.result).toContain("GITHUB_TOKEN");
    expect(mockProxyFetch).not.toHaveBeenCalled();
  });

  it("performs a write when enabled with a token", async () => {
    process.env.SH_ENABLE_TOOLS = "1";
    process.env.GITHUB_TOKEN = "ghp_test";
    mockProxyFetch.mockResolvedValue(
      new Response(JSON.stringify({ number: 5 }), { status: 201 }),
    );
    const res = await githubApiImpl(
      { method: "POST", path: "/repos/o/r/issues", body: { title: "x" } },
      ctx(),
    );
    expect(res.success).toBe(true);
    const [, init] = mockProxyFetch.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer ghp_test");
    expect(init.body).toContain("title");
  });

  it("rejects a path without a leading slash", async () => {
    const res = await githubApiImpl({ method: "GET", path: "repos/o/r" }, ctx());
    expect(res.success).toBe(false);
    expect(res.result).toContain("must start with '/'");
  });
});

// ---------------------------------------------------------------------------
// createAppRegistry
// ---------------------------------------------------------------------------

describe("createAppRegistry", () => {
  it("registers all 8 tools (3 internal + 5 app)", () => {
    const r = createAppRegistry();
    const names = r.listForAgent().map((d) => d.name).sort();
    expect(names).toEqual([
      "broadcast",
      "github_api",
      "http_fetch",
      "read_file",
      "report_action",
      "run_command",
      "send_message",
      "write_file",
    ]);
  });

  it("labels destructive tools correctly", () => {
    const r = createAppRegistry();
    const destructive = r
      .listForAgent()
      .filter((d) => d.risk === "destructive")
      .map((d) => d.name)
      .sort();
    expect(destructive).toEqual(["github_api", "run_command", "write_file"]);
  });

  it("getOpenAIDefs emits a valid function def per tool", () => {
    const defs = createAppRegistry().getOpenAIDefs();
    expect(defs).toHaveLength(8);
    for (const d of defs) {
      expect(d.type).toBe("function");
      expect(typeof d.function.name).toBe("string");
      expect(d.function.parameters?.type).toBe("object");
    }
  });
});

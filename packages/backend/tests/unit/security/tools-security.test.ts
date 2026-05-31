import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// T4 security suite — adversarial coverage for the tool sandbox.
//
// Groups: path traversal & symlink escape (read/write), command injection
// (run_command argv vs shell), argument validation via the registry, env
// scrubbing, and the destructive kill-switch boundary. These are the cases the
// sandbox MUST hold before SH_ENABLE_TOOLS is flipped on a real checkout.
// ---------------------------------------------------------------------------

const mockProxyFetch = vi.hoisted(() => vi.fn());
vi.mock("@/server/proxy-fetch", () => ({ proxyFetch: mockProxyFetch }));

import { readFileImpl, writeFileImpl } from "@/server/tools/filesystem";
import { runCommandImpl } from "@/server/tools/shell";
import { githubApiImpl } from "@/server/tools/network";
import { createAppRegistry } from "@/server/tools";
import {
  resolveInJail,
  resolveInJailReal,
  scrubbedEnv,
  JailEscapeError,
} from "@/server/tools/sandbox";
import type { ToolRunContext } from "@/lib/meta-agent/tools";

let jail: string;
let outside: string;
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
  jail = mkdtempSync(join(tmpdir(), "sh-sec-jail-"));
  outside = mkdtempSync(join(tmpdir(), "sh-sec-out-"));
  process.env.SH_TOOLS_CWD = jail;
  process.env.SH_ENABLE_TOOLS = "1"; // exercise the dangerous paths on purpose
  mockProxyFetch.mockReset();
});

afterEach(() => {
  rmSync(jail, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// Path traversal — logical
// ---------------------------------------------------------------------------

describe("path traversal (logical)", () => {
  const escapes = [
    "../escape.txt",
    "../../etc/passwd",
    "../../../../../../etc/passwd",
    "a/../../b",
    "/etc/passwd",
    "/",
  ];

  for (const p of escapes) {
    it(`resolveInJail rejects "${p}"`, () => {
      expect(() => resolveInJail(p)).toThrow(JailEscapeError);
    });
  }

  it("rejects null-byte injection", () => {
    expect(() => resolveInJail("ok.txt\0../../etc/passwd")).toThrow(JailEscapeError);
  });

  it("allows a legitimate nested path", () => {
    expect(() => resolveInJail("sub/dir/file.txt")).not.toThrow();
  });

  it("read_file refuses traversal end-to-end", async () => {
    writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
    const res = await readFileImpl(
      { path: `../${join(outside, "secret.txt").split("/").pop()}` },
      ctx(),
    );
    expect(res.success).toBe(false);
    expect(res.result).not.toContain("TOPSECRET");
  });
});

// ---------------------------------------------------------------------------
// Symlink escape (T3) — the hole the logical check can't see
// ---------------------------------------------------------------------------

describe("symlink escape (symlink-aware)", () => {
  it("resolveInJailReal rejects reading through a symlinked dir pointing outside", async () => {
    // jail/link -> outside ; then jail/link/secret.txt resolves outside.
    writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
    symlinkSync(outside, join(jail, "link"));
    await expect(resolveInJailReal("link/secret.txt")).rejects.toThrow(JailEscapeError);
  });

  it("resolveInJailReal rejects a symlinked file pointing outside", async () => {
    writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
    symlinkSync(join(outside, "secret.txt"), join(jail, "alias.txt"));
    await expect(resolveInJailReal("alias.txt")).rejects.toThrow(JailEscapeError);
  });

  it("read_file does not leak contents through a symlink", async () => {
    writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
    symlinkSync(join(outside, "secret.txt"), join(jail, "alias.txt"));
    const res = await readFileImpl({ path: "alias.txt" }, ctx());
    expect(res.success).toBe(false);
    expect(res.result).not.toContain("TOPSECRET");
  });

  it("write_file refuses to write through a symlinked dir pointing outside", async () => {
    symlinkSync(outside, join(jail, "link"));
    const res = await writeFileImpl(
      { path: "link/evil.txt", content: "x" },
      ctx(),
    );
    expect(res.success).toBe(false);
    // The file must NOT have been created outside the jail.
    const escaped = await readFileImpl({ path: "link/evil.txt" }, ctx());
    expect(escaped.success).toBe(false);
  });

  it("allows a symlink that stays inside the jail", async () => {
    mkdirSync(join(jail, "real"));
    writeFileSync(join(jail, "real", "f.txt"), "inside");
    symlinkSync(join(jail, "real"), join(jail, "innerlink"));
    const res = await readFileImpl({ path: "innerlink/f.txt" }, ctx());
    expect(res.success).toBe(true);
    expect(res.result).toBe("inside");
  });
});

// ---------------------------------------------------------------------------
// Command injection — argv vs shell
// ---------------------------------------------------------------------------

describe("command injection (run_command is shell-free)", () => {
  const payloads = [
    ["echo", ["hi; touch pwned1"]],
    ["echo", ["hi && touch pwned2"]],
    ["echo", ["hi | tee pwned3"]],
    ["echo", ["$(touch pwned4)"]],
    ["echo", ["`touch pwned5`"]],
    ["echo", ["hi > pwned6"]],
  ] as const;

  for (const [cmd, args] of payloads) {
    it(`treats "${args[0]}" as a literal argument, not shell`, async () => {
      const res = await runCommandImpl({ command: cmd, args: [...args] }, ctx());
      expect(res.success).toBe(true);
      // The injected text was echoed verbatim (no substitution happened).
      expect(res.result).toContain(args[0]);
      // No shell side-effect file landed anywhere in the jail. Check the jail
      // dir directly (per-test, captured) rather than via a tool that reads the
      // mutable SH_TOOLS_CWD env — avoids cross-test env races.
      for (const marker of ["pwned1", "pwned2", "pwned3", "pwned4", "pwned5", "pwned6"]) {
        expect(existsSync(join(jail, marker))).toBe(false);
      }
    });
  }

  it("refuses programs off the allowlist", async () => {
    for (const prog of ["rm", "sh", "bash", "curl", "python3", "/bin/sh"]) {
      const res = await runCommandImpl({ command: prog, args: [] }, ctx());
      expect(res.success).toBe(false);
      expect(res.result).toContain("not allowed");
    }
  });

  it("refuses mutating git subcommands", async () => {
    for (const sub of ["push", "reset", "clean", "commit", "checkout"]) {
      const res = await runCommandImpl({ command: "git", args: [sub] }, ctx());
      expect(res.success).toBe(false);
      expect(res.result).toContain("not allowed");
    }
  });

  it("runs entirely disabled without the kill switch", async () => {
    process.env.SH_ENABLE_TOOLS = "";
    const res = await runCommandImpl({ command: "echo", args: ["hi"] }, ctx());
    expect(res.success).toBe(false);
    expect(res.result).toContain("disabled");
  });
});

// ---------------------------------------------------------------------------
// Env scrubbing
// ---------------------------------------------------------------------------

describe("env scrubbing", () => {
  it("strips secret-bearing vars from the child env", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret";
    process.env.OPENAI_API_KEY = "sk-openai-secret";
    process.env.GITHUB_TOKEN = "ghp_secret";
    process.env.DATABASE_URL = "postgres://u:pw@host/db";
    const env = scrubbedEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("keeps PATH so allowlisted programs can be found", () => {
    expect(scrubbedEnv().PATH).toBe(process.env.PATH);
  });

  it("run_command cannot echo a secret from the environment", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-LEAKME";
    // `node -e` is allowlisted; have it print the secret. With the scrubbed env
    // the var is absent, so the real value can never reach stdout. The
    // security-critical assertion is the absence of the secret in the output.
    const res = await runCommandImpl(
      {
        command: "node",
        args: ["-e", "process.stdout.write('VAL[' + String(process.env.ANTHROPIC_API_KEY) + ']')"],
      },
      ctx(),
    );
    expect(res.success).toBe(true);
    expect(res.result).not.toContain("LEAKME");
    // And the var was genuinely absent (printed as undefined), not just empty.
    expect(res.result).toContain("VAL[undefined]");
  });
});

// ---------------------------------------------------------------------------
// Argument validation via the registry
// ---------------------------------------------------------------------------

describe("argument validation (registry Zod gate)", () => {
  it("rejects wrong-typed args without invoking the impl", async () => {
    const r = createAppRegistry();
    const res = await r.execute("read_file", { path: 123 }, ctx());
    expect(res.success).toBe(false);
    expect(res.result).toContain("Invalid arguments for read_file");
  });

  it("rejects missing required fields", async () => {
    const r = createAppRegistry();
    const res = await r.execute("write_file", { path: "x.txt" }, ctx());
    expect(res.success).toBe(false);
    expect(res.result).toContain("Invalid arguments for write_file");
  });

  it("rejects an unknown tool name (fail safe)", async () => {
    const r = createAppRegistry();
    const res = await r.execute("exec_anything", { cmd: "rm -rf /" }, ctx());
    expect(res.success).toBe(false);
    expect(res.result).toContain("Unknown tool");
  });

  it("rejects a non-URL for http_fetch", async () => {
    const r = createAppRegistry();
    const res = await r.execute("http_fetch", { url: "not a url" }, ctx());
    expect(res.success).toBe(false);
    expect(res.result).toContain("Invalid arguments for http_fetch");
    expect(mockProxyFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Destructive boundary — classifier + kill switch
// ---------------------------------------------------------------------------

describe("destructive boundary", () => {
  it("registry marks exactly the mutating tools destructive", () => {
    const r = createAppRegistry();
    expect(r.isDestructive("write_file")).toBe(true);
    expect(r.isDestructive("run_command")).toBe(true);
    expect(r.isDestructive("github_api")).toBe(true);
    expect(r.isDestructive("read_file")).toBe(false);
    expect(r.isDestructive("http_fetch")).toBe(false);
    expect(r.isDestructive("send_message")).toBe(false);
    // Unknown tools are treated as destructive (fail safe).
    expect(r.isDestructive("ghost")).toBe(true);
  });

  it("github_api write is blocked without the kill switch even with a token", async () => {
    process.env.SH_ENABLE_TOOLS = "";
    process.env.GITHUB_TOKEN = "ghp_x";
    const res = await githubApiImpl(
      { method: "DELETE", path: "/repos/o/r" },
      ctx(),
    );
    expect(res.success).toBe(false);
    expect(res.result).toContain("disabled");
    expect(mockProxyFetch).not.toHaveBeenCalled();
  });
});

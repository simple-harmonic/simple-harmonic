import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSubprocess } from "../../src/server/tools/coding/run-subprocess";
import type { CodingResult } from "../../src/server/tools/coding/types";

// Trivial parse: collect `msg` fields from each JSONL line.
function parse(jsonl: string): CodingResult {
  const messages: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { msg?: string };
      if (e.msg) messages.push(e.msg);
    } catch {
      // skip partial / non-JSON
    }
  }
  return { messages, commands: [], errors: [] };
}

function baseOpts(jail: string, maxOutputBytes = 256 * 1024) {
  return {
    cwd: jail,
    timeoutMs: 10_000,
    maxOutputBytes,
    envKeys: [] as string[],
    label: "node",
  };
}

describe("runSubprocess", () => {
  let jail: string;

  beforeEach(() => {
    jail = mkdtempSync(join(tmpdir(), "rs-jail-"));
    vi.stubEnv("SH_TOOLS_CWD", jail);
  });

  afterEach(() => {
    rmSync(jail, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("spawns a process and parses its JSONL stdout", async () => {
    const script =
      'process.stdout.write(JSON.stringify({msg:"hello"})+"\\n"+JSON.stringify({msg:"world"})+"\\n")';
    const res = await runSubprocess("node", ["-e", script], parse, baseOpts(jail));
    expect(res.messages).toEqual(["hello", "world"]);
  });

  it("rejects a cwd outside the tools jail", async () => {
    await expect(
      runSubprocess("node", ["-e", ""], parse, { ...baseOpts(jail), cwd: "/etc" }),
    ).rejects.toThrow();
  });

  it("does not leak secrets into the child env", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://secret");
    const script =
      'process.stdout.write(JSON.stringify({msg: process.env.DATABASE_URL || "ABSENT"})+"\\n")';
    const res = await runSubprocess("node", ["-e", script], parse, baseOpts(jail));
    expect(res.messages).toEqual(["ABSENT"]);
  });

  it("truncates on a line boundary, preserving the tail and never corrupting records", async () => {
    // Emit far more than maxOutputBytes; the retained window must start at a
    // clean line so every parsed record is whole and the last record survives.
    const script =
      'for(let i=0;i<2000;i++){process.stdout.write(JSON.stringify({msg:"m"+i})+"\\n")}';
    const res = await runSubprocess("node", ["-e", script], parse, baseOpts(jail, 200));
    expect(res.messages.length).toBeGreaterThan(0);
    expect(res.messages.every((m) => /^m\d+$/.test(m))).toBe(true);
    expect(res.messages.at(-1)).toBe("m1999");
  });
});

// ---------------------------------------------------------------------------
// Shell tool: run_command (destructive).
//
// This is the v0.1 floor for shell execution. It is intentionally conservative:
//   - gated behind the destructive kill switch (toolsEnabled)
//   - runs via execFile with a parsed argv (NO shell), so metacharacters like
//     |, ;, &&, $(), backticks are inert — they become literal argv tokens
//   - the program must be on a small allowlist
//   - cwd is pinned to the jail root
//   - hard timeout + output cap
//
// T3 hardens this further (env scrubbing, per-agent time budget, richer
// allowlist policy). The argv/no-shell design here is the key safety property
// and is deliberately not deferred: shelling out through `sh -c` would reopen
// command injection that no allowlist can fully close.
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { z } from "zod";
import type { ToolDefinition, ToolImpl } from "../../lib/meta-agent/registry";
import { toolsRoot, toolsEnabled, scrubbedEnv } from "./sandbox";

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

// Allowlisted programs. Read-mostly dev tooling for dogfooding. Anything not
// here is refused. git is allowed but write-capable subcommands are filtered
// below — the allowlist is per-program, the deny-list is per-git-subcommand.
const ALLOWED_PROGRAMS = new Set([
  "git",
  "ls",
  "cat",
  "rg",
  "grep",
  "find",
  "node",
  "npm",
  "npx",
  "bun",
  "tsc",
  "vitest",
  "echo",
  "pwd",
  "wc",
  "head",
  "tail",
]);

// git subcommands that mutate remote/repo state. Refused even though `git`
// is allowed, so an agent can inspect (status/log/diff) but not push/reset
// while the gate is still maturing.
const DENIED_GIT_SUBCOMMANDS = new Set([
  "push",
  "reset",
  "clean",
  "rebase",
  "merge",
  "commit",
  "checkout",
  "switch",
  "restore",
]);

const runCommandSchema = z.object({
  command: z
    .string()
    .describe(
      "Program to run (must be on the allowlist, e.g. git, ls, rg, node). No shell features.",
    ),
  args: z
    .array(z.string())
    .optional()
    .describe("Arguments passed to the program as a literal argv (not a shell string)."),
});

export const runCommandDef: ToolDefinition<typeof runCommandSchema> = {
  name: "run_command",
  description:
    "Run an allowlisted program in the project working directory and return its output. Arguments are passed as a literal argv — there is no shell, so pipes/redirection/variable expansion do not work. Allowed: git (read-only subcommands), ls, cat, rg, grep, find, node, npm, npx, bun, tsc, vitest, echo, pwd, wc, head, tail.",
  category: "shell",
  risk: "destructive",
  schema: runCommandSchema,
};

export const runCommandImpl: ToolImpl<typeof runCommandSchema> = async (args) => {
  if (!toolsEnabled()) {
    return {
      toolName: "run_command",
      success: false,
      result:
        "run_command is disabled. Destructive tools require SH_ENABLE_TOOLS to be set; they remain gated until the approval flow is enabled.",
    };
  }

  const program = args.command.trim();
  const argv = args.args ?? [];

  if (!ALLOWED_PROGRAMS.has(program)) {
    return {
      toolName: "run_command",
      success: false,
      result: `Program "${program}" is not allowed. Allowed: ${[...ALLOWED_PROGRAMS].sort().join(", ")}`,
    };
  }

  if (program === "git" && argv.length > 0 && DENIED_GIT_SUBCOMMANDS.has(argv[0])) {
    return {
      toolName: "run_command",
      success: false,
      result: `git ${argv[0]} is not allowed (mutates repo/remote state). Use read-only git subcommands like status, log, diff, show.`,
    };
  }

  return new Promise((resolvePromise) => {
    execFile(
      program,
      argv,
      {
        cwd: toolsRoot(),
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        // T3: scrubbed env — secrets (API keys, DB URL) are stripped so a
        // shelled-out command can't read credentials from the agent process.
        env: scrubbedEnv(),
      },
      (err, stdout, stderr) => {
        const out = (stdout || "").toString();
        const errOut = (stderr || "").toString();

        if (err) {
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (killed) {
            resolvePromise({
              toolName: "run_command",
              success: false,
              result: `Command timed out after ${TIMEOUT_MS}ms: ${program} ${argv.join(" ")}`,
            });
            return;
          }
          resolvePromise({
            toolName: "run_command",
            success: false,
            result: `Command failed: ${program} ${argv.join(" ")}\n${errOut || out || (err as Error).message}`.slice(
              0,
              MAX_OUTPUT_BYTES,
            ),
          });
          return;
        }

        const combined = errOut ? `${out}\n[stderr]\n${errOut}` : out;
        const text = combined.slice(0, MAX_OUTPUT_BYTES) || "(no output)";
        resolvePromise({
          toolName: "run_command",
          success: true,
          result: text,
          action: {
            actionType: "command_run",
            payload: {
              command: program,
              args: argv,
              // UI snippet (T8/D19) — capped so action_log stays lean.
              output: text.slice(0, 2_000),
            },
          },
        });
      },
    );
  });
};

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
// here is refused. Interpreters/package runners are intentionally excluded:
// they can execute arbitrary code and bypass a command allowlist.
const ALLOWED_PROGRAMS = new Set([
  "git",
  "ls",
  "cat",
  "rg",
  "grep",
  "find",
  "diff",
  "tsc",
  "vitest",
  "npm",
  "npx",
  "biome",
  "echo",
  "pwd",
  "wc",
  "head",
  "tail",
  "mkdir",
  "cp",
  "mv",
  "sort",
  "uniq",
  "tr",
]);

// Git subcommand allowlist. Read-only subcommands are always allowed. Write
// subcommands are allowed here because run_command itself is classified as
// destructive and goes through the approval gate (T2), so the human always
// approves before any write-capable git operation runs.
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  // read-only
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "grep",
  "blame",
  "branch",
  "stash",
  // write (gated by approval)
  "add",
  "commit",
  "push",
  "pull",
  "fetch",
  "checkout",
  "switch",
  "merge",
  "rebase",
  "cherry-pick",
  "restore",
  "reset",
  "tag",
]);

const runCommandSchema = z.object({
  command: z
    .string()
    .describe(
      "Program to run (must be on the allowlist, e.g. git, ls, rg, vitest, npm, biome). No shell features.",
    ),
  args: z
    .array(z.string())
    .optional()
    .describe("Arguments passed to the program as a literal argv (not a shell string)."),
});

export const runCommandDef: ToolDefinition<typeof runCommandSchema> = {
  name: "run_command",
  description:
    "Run an allowlisted program in the project working directory and return its output. Arguments are passed as a literal argv — there is no shell, so pipes/redirection/variable expansion do not work. Allowed: git (read and write subcommands), ls, cat, rg, grep, find, diff, tsc, vitest, npm, npx, biome, echo, pwd, wc, head, tail, mkdir, cp, mv, sort, uniq, tr.",
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

  const badArg = argv.find(isEscapingArg);
  if (badArg) {
    return {
      toolName: "run_command",
      success: false,
      result: `Argument "${badArg}" is not allowed because it can access paths outside the working directory`,
    };
  }

  if (program === "git") {
    const subcommand = argv[0];
    if (!subcommand || !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
      return {
        toolName: "run_command",
        success: false,
        result: `git ${subcommand ?? "(missing subcommand)"} is not allowed. Use read-only git subcommands like status, log, diff, show, ls-files, grep, or blame.`,
      };
    }
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

function isEscapingArg(arg: string): boolean {
  if (arg.includes("\0")) return true;
  if (arg.startsWith("/") || arg === "~" || arg.startsWith("~/")) return true;
  if (arg === ".." || arg.startsWith("../") || arg.includes("/../")) return true;
  if (/^--(?:git-dir|work-tree|output|exec-path)=/.test(arg)) return true;
  return false;
}

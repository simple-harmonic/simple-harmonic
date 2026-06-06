// ---------------------------------------------------------------------------
// Codex CLI backend: `codex exec --json -s workspace-write`
// ---------------------------------------------------------------------------

import { runSubprocess } from "./run-subprocess";
import type { CodingBackend, CodingResult, CodingRunOpts } from "./types";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

interface CodexEvent {
  type: string;
  item?: {
    type: string;
    text?: string;
    status?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
  };
  error?: { message: string };
}

function parseEvents(jsonl: string): CodingResult {
  const messages: string[] = [];
  const commands: CodingResult["commands"] = [];
  const errors: string[] = [];

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event: CodexEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "item.completed" && event.item) {
      if (event.item.type === "agent_message" && event.item.text) {
        messages.push(event.item.text);
      }
      if (
        event.item.type === "tool_call" &&
        event.item.command &&
        event.item.status === "completed"
      ) {
        commands.push({
          command: event.item.command,
          output: (event.item.aggregated_output || "").slice(0, 2_000),
          exitCode: event.item.exit_code ?? -1,
        });
      }
    }
    if (event.type === "error" && event.error?.message) {
      errors.push(event.error.message);
    }
  }

  return { messages, commands, errors };
}

export function createCodexBackend(): CodingBackend {
  return {
    name: "codex",

    run(opts: CodingRunOpts): Promise<CodingResult> {
      const args = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        // workspace-write keeps codex's writes inside the (jailed) cwd; never
        // danger-full-access. cwd is re-asserted in the jail by runSubprocess.
        "-s",
        "workspace-write",
        "-C",
        opts.cwd,
      ];
      if (opts.model) args.push("-m", opts.model);
      args.push(opts.task);

      return runSubprocess("codex", args, parseEvents, {
        cwd: opts.cwd,
        signal: opts.signal,
        timeoutMs: opts.timeout || DEFAULT_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        // Codex auth is file-based (~/.codex/auth.json under HOME, kept by the
        // scrubbed env); forward CODEX_HOME/OPENAI_API_KEY only if the operator
        // set them.
        envKeys: ["CODEX_HOME", "OPENAI_API_KEY"],
        label: "codex",
      });
    },
  };
}

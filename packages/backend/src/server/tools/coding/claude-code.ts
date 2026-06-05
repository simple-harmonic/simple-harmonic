// ---------------------------------------------------------------------------
// Claude Code CLI backend: `claude -p --output-format stream-json --verbose`
// ---------------------------------------------------------------------------

import { runSubprocess } from "./run-subprocess";
import type { CodingBackend, CodingResult, CodingRunOpts } from "./types";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

function parseEvents(jsonl: string): CodingResult {
  const messages: string[] = [];
  const commands: CodingResult["commands"] = [];
  const errors: string[] = [];

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    // Assistant message: { type: "assistant", message: { content: [{ type: "text", text: "..." }] } }
    if (event.type === "assistant") {
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg?.content && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            messages.push(block.text as string);
          }
          if (block.type === "tool_use") {
            const input = block.input as Record<string, unknown> | undefined;
            const name = (block.name as string) || "";
            const cmd = (input?.command as string) || name;
            if (cmd) {
              commands.push({
                command: cmd,
                output: (input?.description as string) || "",
                exitCode: 0,
              });
            }
          }
        }
      }
    }

    // Result: { type: "result", result: "..." }
    if (event.type === "result") {
      const text = (event.result as string) || "";
      if (text && !messages.includes(text)) messages.push(text);
    }

    if (event.type === "error") {
      errors.push((event.message as string) || "Unknown error");
    }
  }

  return { messages, commands, errors };
}

export function createClaudeCodeBackend(): CodingBackend {
  return {
    name: "claude-code",

    run(opts: CodingRunOpts): Promise<CodingResult> {
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        // Acceptable only because runSubprocess pins cwd inside the tools jail
        // and scrubs the env (codingEnv): the agent gets no secrets and cannot
        // escape the jail. coding_task is already gated behind SH_ENABLE_TOOLS.
        "--dangerously-skip-permissions",
        "--no-session-persistence",
      ];
      if (opts.model) args.push("--model", opts.model);
      args.push(opts.task);

      return runSubprocess("claude", args, parseEvents, {
        cwd: opts.cwd,
        signal: opts.signal,
        timeoutMs: opts.timeout || DEFAULT_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        envKeys: ["ANTHROPIC_API_KEY"],
        label: "claude",
      });
    },
  };
}

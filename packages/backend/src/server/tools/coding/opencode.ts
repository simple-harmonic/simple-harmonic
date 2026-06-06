// ---------------------------------------------------------------------------
// OpenCode CLI backend: `opencode run --format json -q`
// ---------------------------------------------------------------------------

import { runSubprocess } from "./run-subprocess";
import type { CodingBackend, CodingResult, CodingRunOpts } from "./types";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

interface OpenCodeEvent {
  type: string;
  text?: string;
  content?: string;
  reason?: string;
  tool?: string;
  input?: { command?: string };
  output?: string;
  exit_code?: number;
  message?: string;
}

function parseEvents(jsonl: string): CodingResult {
  const messages: string[] = [];
  const commands: CodingResult["commands"] = [];
  const errors: string[] = [];

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event: OpenCodeEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "text" && event.text) {
      messages.push(event.text);
    }

    if (event.type === "tool_use") {
      const cmd = event.input?.command || event.tool || "";
      if (cmd) {
        commands.push({
          command: cmd,
          output: (event.output || "").slice(0, 2_000),
          exitCode: event.exit_code ?? 0,
        });
      }
    }

    if (event.type === "step_finish" && event.reason === "stop" && event.content) {
      messages.push(event.content);
    }

    if (event.type === "error") {
      errors.push(event.message || event.text || "Unknown error");
    }
  }

  return { messages, commands, errors };
}

export function createOpenCodeBackend(): CodingBackend {
  return {
    name: "opencode",

    run(opts: CodingRunOpts): Promise<CodingResult> {
      const args = ["run", "--format", "json", "-q", "--working-dir", opts.cwd];
      if (opts.model) args.push("--model", opts.model);
      args.push(opts.task);

      return runSubprocess("opencode", args, parseEvents, {
        cwd: opts.cwd,
        signal: opts.signal,
        timeoutMs: opts.timeout || DEFAULT_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
        label: "opencode",
      });
    },
  };
}

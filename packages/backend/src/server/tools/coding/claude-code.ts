// ---------------------------------------------------------------------------
// Claude Code CLI backend: `claude -p --output-format stream-json`
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import type { CodingBackend, CodingResult, CodingRunOpts } from "./types";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  // assistant message
  content_block?: { type: string; text?: string };
  // tool use
  tool_name?: string;
  tool_input?: { command?: string; description?: string };
  // result
  content?: string;
  result?: string;
  message?: string;
}

function parseEvents(jsonl: string): CodingResult {
  const messages: string[] = [];
  const commands: CodingResult["commands"] = [];
  const errors: string[] = [];

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event: ClaudeStreamEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "assistant" && event.subtype === "message") {
      const text = event.message || event.content || "";
      if (text) messages.push(text);
    }

    if (event.type === "result") {
      const text = event.result || event.content || "";
      if (text) messages.push(text);
    }

    if (event.type === "tool_use" || event.subtype === "tool_use") {
      const cmd = event.tool_input?.command || event.tool_name || "";
      if (cmd) {
        commands.push({
          command: cmd,
          output: event.tool_input?.description || "",
          exitCode: 0,
        });
      }
    }

    if (event.type === "error") {
      errors.push(event.message || "Unknown error");
    }
  }

  return { messages, commands, errors };
}

export function createClaudeCodeBackend(): CodingBackend {
  return {
    name: "claude-code",

    run(opts: CodingRunOpts): Promise<CodingResult> {
      return new Promise((resolve, reject) => {
        const timeoutMs = opts.timeout || DEFAULT_TIMEOUT_MS;
        const args = [
          "-p",
          "--output-format", "stream-json",
          "--dangerously-skip-permissions",
          "--no-session-persistence",
        ];
        if (opts.model) args.push("--model", opts.model);
        args.push(opts.task);

        let stdout = "";
        let stderr = "";
        let settled = false;

        const child = spawn("claude", args, {
          cwd: opts.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env },
        });

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGTERM");
          const partial = parseEvents(stdout);
          partial.errors.push(`Timed out after ${timeoutMs / 1000}s`);
          resolve(partial);
        }, timeoutMs);

        const onAbort = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill("SIGTERM");
          reject(opts.signal?.reason instanceof Error ? opts.signal.reason : new Error("aborted"));
        };
        if (opts.signal?.aborted) { onAbort(); return; }
        opts.signal?.addEventListener("abort", onAbort, { once: true });

        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(-MAX_OUTPUT_BYTES);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString().slice(0, 8_192);
        });

        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ messages: [], commands: [], errors: [`Failed to spawn claude: ${err.message}`] });
        });

        child.on("exit", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const result = parseEvents(stdout);
          if (code !== 0 && !result.messages.length) {
            result.errors.push(stderr || `claude exited with code ${code}`);
          }
          resolve(result);
        });
      });
    },
  };
}

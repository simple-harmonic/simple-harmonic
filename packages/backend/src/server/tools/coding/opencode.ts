// ---------------------------------------------------------------------------
// OpenCode CLI backend: `opencode run --format json -q`
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
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
      return new Promise((resolve, reject) => {
        const timeoutMs = opts.timeout || DEFAULT_TIMEOUT_MS;
        const args = [
          "run",
          "--format", "json",
          "-q",
          "--working-dir", opts.cwd,
        ];
        if (opts.model) args.push("--model", opts.model);
        args.push(opts.task);

        let stdout = "";
        let stderr = "";
        let settled = false;

        const child = spawn("opencode", args, {
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
          resolve({ messages: [], commands: [], errors: [`Failed to spawn opencode: ${err.message}`] });
        });

        child.on("exit", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const result = parseEvents(stdout);
          if (code !== 0 && !result.messages.length) {
            result.errors.push(stderr || `opencode exited with code ${code}`);
          }
          resolve(result);
        });
      });
    },
  };
}

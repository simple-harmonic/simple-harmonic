// ---------------------------------------------------------------------------
// Codex CLI backend: `codex exec --json -s workspace-write`
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
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
      return new Promise((resolve, reject) => {
        const timeoutMs = opts.timeout || DEFAULT_TIMEOUT_MS;
        const args = [
          "exec",
          "--json",
          "--skip-git-repo-check",
          "-s", "workspace-write",
          "-C", opts.cwd,
        ];
        if (opts.model) args.push("-m", opts.model);
        args.push(opts.task);

        let stdout = "";
        let stderr = "";
        let settled = false;

        const child = spawn("codex", args, {
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
          resolve({ messages: [], commands: [], errors: [`Failed to spawn codex: ${err.message}`] });
        });

        child.on("exit", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const result = parseEvents(stdout);
          if (code !== 0 && !result.messages.length) {
            result.errors.push(stderr || `codex exited with code ${code}`);
          }
          resolve(result);
        });
      });
    },
  };
}

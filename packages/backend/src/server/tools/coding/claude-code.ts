// ---------------------------------------------------------------------------
// Claude Code CLI backend: `claude -p --output-format stream-json --verbose`
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
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
      return new Promise((resolve, reject) => {
        const timeoutMs = opts.timeout || DEFAULT_TIMEOUT_MS;
        const args = [
          "-p",
          "--output-format", "stream-json",
          "--verbose",
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

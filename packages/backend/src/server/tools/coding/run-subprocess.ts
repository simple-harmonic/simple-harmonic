// ---------------------------------------------------------------------------
// Shared subprocess lifecycle for the coding CLIs (claude-code/codex/opencode).
//
// Previously each adapter copy-pasted ~80 identical lines of
// spawn/timeout/abort/buffer/exit handling. They now all delegate here, which
// also makes the security posture single-sourced:
//   - env is codingEnv(envKeys): scrubbed base + only the named provider keys
//   - cwd is re-asserted inside the tools jail (resolveInJail) before spawn
//   - stdout truncation drops whole leading lines, never a mid-JSONL-record cut
// Only the command, argv, and parseEvents differ per backend.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { codingEnv, resolveInJail } from "../sandbox";
import type { CodingResult } from "./types";

export interface RunSubprocessOpts {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Provider keys to forward into the otherwise-scrubbed child env. */
  envKeys: string[];
  /** Short command label used in error messages, e.g. "claude". */
  label: string;
}

export function runSubprocess(
  cmd: string,
  argv: string[],
  parseEvents: (jsonl: string) => CodingResult,
  opts: RunSubprocessOpts,
): Promise<CodingResult> {
  return new Promise((resolve, reject) => {
    // Re-assert containment: never hand an unvalidated cwd to spawn, even though
    // the caller passes toolsRoot() today.
    let cwd: string;
    try {
      cwd = resolveInJail(opts.cwd);
    } catch (err) {
      reject(err instanceof Error ? err : new Error("cwd outside jail"));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(cmd, argv, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: codingEnv(opts.envKeys),
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      const partial = parseEvents(stdout);
      partial.errors.push(`Timed out after ${opts.timeoutMs / 1000}s`);
      resolve(partial);
    }, opts.timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      reject(
        opts.signal?.reason instanceof Error
          ? opts.signal.reason
          : new Error("aborted"),
      );
    };
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > opts.maxOutputBytes) {
        // Keep the last ~maxOutputBytes, but start at a line boundary so we
        // never slice mid-record (the stream is newline-delimited JSON; a
        // mid-line cut corrupts the next parse). Fall back to a raw tail slice
        // if the window has no newline (one giant line).
        const cutFrom = stdout.length - opts.maxOutputBytes;
        const nl = stdout.indexOf("\n", cutFrom);
        stdout = nl >= 0 ? stdout.slice(nl + 1) : stdout.slice(cutFrom);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString().slice(0, 8_192);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        messages: [],
        commands: [],
        errors: [`Failed to spawn ${opts.label}: ${err.message}`],
      });
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = parseEvents(stdout);
      if (code !== 0 && !result.messages.length) {
        result.errors.push(stderr || `${opts.label} exited with code ${code}`);
      }
      resolve(result);
    });
  });
}

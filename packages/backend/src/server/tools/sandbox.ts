// ---------------------------------------------------------------------------
// Tool sandbox primitives (app side) — T3 hardened.
//
// Containment for the filesystem + shell tools:
//   toolsRoot()          ── the jail root (SH_TOOLS_CWD or process.cwd())
//   toolsEnabled()       ── master switch for DESTRUCTIVE tools (default OFF)
//   resolveInJail(p)     ── synchronous LOGICAL containment (no fs); rejects
//                            `..`, absolute paths, null bytes.
//   resolveInJailReal(p) ── async SYMLINK-AWARE containment: realpaths the
//                            deepest existing ancestor so a symlink inside the
//                            jail can't point out. Use this in the fs tools.
//   scrubbedEnv()        ── minimal child-process env with secrets stripped,
//                            for run_command.
// ---------------------------------------------------------------------------

import { realpath, lstat } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";

/**
 * Root of the filesystem/shell jail. Defaults to the process cwd (the repo
 * root in dev). Override with SH_TOOLS_CWD to point agents at a specific
 * checkout. All read_file/write_file/run_command paths resolve against this.
 */
export function toolsRoot(): string {
  return resolve(process.env.SH_TOOLS_CWD || process.cwd());
}

/**
 * Master kill switch for DESTRUCTIVE tools (write_file, run_command, and
 * mutating github_api calls). Default OFF. Set SH_ENABLE_TOOLS=1 to allow them
 * (intended for local dogfooding once the operator opts in).
 *
 * Read tools (read_file, http_fetch GET) are not gated by this — they are
 * read-only and cwd/method constrained.
 */
export function toolsEnabled(): boolean {
  const v = (process.env.SH_ENABLE_TOOLS || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Thrown when a tool path resolves outside the jail root. */
export class JailEscapeError extends Error {
  constructor(requested: string) {
    super(`Path "${requested}" resolves outside the allowed working directory`);
    this.name = "JailEscapeError";
  }
}

/**
 * Synchronous LOGICAL containment check. Resolves a user/LLM-supplied path
 * against the jail root and guarantees the textual result stays inside it.
 * Rejects null bytes, absolute paths, and `..` traversal.
 *
 * This does NOT follow symlinks — a symlink inside the jail pointing out would
 * pass. Use resolveInJailReal for the symlink-aware check; this remains as the
 * fast first gate and for callers that only need the logical path.
 */
export function resolveInJail(requestedPath: string): string {
  const root = toolsRoot();

  if (requestedPath.includes("\0")) {
    throw new JailEscapeError(requestedPath);
  }

  // Resolve relative to root. An absolute input is resolved as-is by node, so
  // the relative()-based check below still catches escapes.
  const abs = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(root, requestedPath);

  if (!isContained(root, abs)) {
    throw new JailEscapeError(requestedPath);
  }
  return abs;
}

/**
 * Symlink-aware containment check. Does the logical check first, then realpaths
 * the deepest EXISTING ancestor of the target and re-verifies containment.
 * This closes the symlink hole: if any existing path component is a symlink
 * that points outside the jail, the realpath'd location fails the check.
 *
 * The non-existent tail (e.g. a write_file target that doesn't exist yet) can't
 * be a symlink, so it's safe to append after the realpath'd existing prefix.
 *
 * Returns the logical absolute path (callers read/write through it; the OS
 * resolves the now-verified symlinks).
 */
export async function resolveInJailReal(requestedPath: string): Promise<string> {
  const abs = resolveInJail(requestedPath);
  const root = toolsRoot();

  // Realpath the jail root itself (it may live under a symlink, e.g. /tmp on
  // macOS is a symlink to /private/tmp). Compare real-to-real.
  const rootReal = await realpath(root).catch(() => root);

  const effectiveReal = await realpathDeepestExisting(abs);
  if (!isContained(rootReal, effectiveReal)) {
    throw new JailEscapeError(requestedPath);
  }
  return abs;
}

/**
 * Minimal environment for a child process. Strips known secret-bearing vars so
 * a shelled-out command (or anything it execs) can't read credentials out of
 * the agent process's environment. Keeps only a small allowlist needed for
 * normal dev tooling to run.
 */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const allow = ["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TZ"];
  const out: Record<string, string> = {};
  for (const key of allow) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  return out as NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** True if `target` is `root` or strictly inside it (textual, no fs). */
function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return true; // the root itself
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Walk up from `abs` to the deepest path component that exists on disk,
 * realpath that, then re-append the non-existent tail. The result is the
 * effective real location the OS would resolve `abs` to.
 */
async function realpathDeepestExisting(abs: string): Promise<string> {
  const tail: string[] = [];
  let cur = abs;

  // Walk up until a component exists (or we hit the filesystem root).
  for (;;) {
    const exists = await pathExists(cur);
    if (exists) {
      const real = await realpath(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    }
    const parent = dirname(cur);
    if (parent === cur) {
      // Reached the fs root without finding an existing component (shouldn't
      // happen since "/" exists, but guard against infinite loops).
      return abs;
    }
    tail.push(cur.slice(parent.length + 1));
    cur = parent;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

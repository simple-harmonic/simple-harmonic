// ---------------------------------------------------------------------------
// Minimal tool sandbox primitives (app side).
//
// This is the floor, not the ceiling. T3 (process-level sandbox) hardens shell
// execution with an allowlist, timeouts, and env scrubbing. What lives here is
// the bare containment that filesystem + shell tools need to not be trivially
// exploitable even before T3: a cwd jail and a destructive-tool kill switch.
//
//   toolsRoot() ── the jail root (SH_TOOLS_CWD or process.cwd())
//   resolveInJail(p) ── absolute path, or throws if it escapes the root
//   toolsEnabled() ── master switch for DESTRUCTIVE tools (default OFF)
// ---------------------------------------------------------------------------

import { resolve, relative, isAbsolute } from "node:path";

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
 * mutating github_api calls). Default OFF: the impls are fully built and
 * tested, but cannot run on the live tick loop until the approval gate (T2)
 * and the hardened sandbox (T3) are in place. Set SH_ENABLE_TOOLS=1 to allow
 * them (intended for local dogfooding once the operator opts in).
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
 * Resolve a user/LLM-supplied path against the jail root and guarantee the
 * result stays inside it. Rejects absolute paths and any `..` traversal that
 * would escape. Returns the absolute, contained path.
 *
 * Containment is checked on the resolved path via `relative()`: if the
 * relative path from root to target starts with `..` (or is itself absolute),
 * the target is outside the jail. This catches `../`, encoded variants once
 * decoded by the caller, and absolute paths like `/etc/passwd`.
 *
 * NOTE: this does not yet resolve symlinks (a symlink inside the root could
 * point out). T3 adds realpath-based checking; until then the jail assumes the
 * working tree contains no adversarial symlinks, which holds for a git checkout
 * the operator controls.
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

  const rel = relative(root, abs);
  if (rel === "" ) {
    // The root itself — allowed (e.g. listing the root dir).
    return abs;
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new JailEscapeError(requestedPath);
  }
  return abs;
}

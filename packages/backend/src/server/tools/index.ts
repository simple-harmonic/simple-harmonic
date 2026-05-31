// ---------------------------------------------------------------------------
// App-side tool assembly.
//
// createAppRegistry() returns a ToolRegistry loaded with BOTH the internal
// message-passing tools (from the library's default registry) AND the
// app-specific filesystem/shell/network tools defined here. This is the
// registry the tick loop / runner should use once T1 is wired into runtime.
//
// Library boundary (D8): the registry class and internal tools live in
// packages/backend/src/lib/meta-agent (NPM-extractable, no I/O). The impls
// below do real I/O (fs, child_process, network) and live here in server/.
// ---------------------------------------------------------------------------

import { createDefaultRegistry } from "../../lib/meta-agent/default-tools";
import type { ToolRegistry } from "../../lib/meta-agent/registry";
import { readFileDef, readFileImpl, writeFileDef, writeFileImpl } from "./filesystem";
import { runCommandDef, runCommandImpl } from "./shell";
import {
  httpFetchDef,
  httpFetchImpl,
  githubApiDef,
  githubApiImpl,
} from "./network";

/**
 * Build the full tool registry: internal tools + filesystem/shell/network.
 * Each call returns a fresh registry (registration is cheap and the impls are
 * stateless), so callers don't share mutable registry state.
 */
export function createAppRegistry(): ToolRegistry {
  const registry = createDefaultRegistry();

  registry.register(readFileDef, readFileImpl);
  registry.register(writeFileDef, writeFileImpl);
  registry.register(runCommandDef, runCommandImpl);
  registry.register(httpFetchDef, httpFetchImpl);
  registry.register(githubApiDef, githubApiImpl);

  return registry;
}

export {
  readFileDef,
  readFileImpl,
  writeFileDef,
  writeFileImpl,
} from "./filesystem";
export { runCommandDef, runCommandImpl } from "./shell";
export {
  httpFetchDef,
  httpFetchImpl,
  githubApiDef,
  githubApiImpl,
} from "./network";
export {
  toolsRoot,
  toolsEnabled,
  resolveInJail,
  JailEscapeError,
} from "./sandbox";

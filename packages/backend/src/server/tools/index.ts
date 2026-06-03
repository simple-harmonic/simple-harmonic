// ---------------------------------------------------------------------------
// App-side tool assembly.
//
// createAppRegistry() returns a ToolRegistry loaded with the internal
// message-passing tools + app-specific filesystem/shell/network tools.
//
// createAppRegistryWithCustomTools() additionally loads custom API tools
// from .simple-harmonic/skills/*.json files and registers them. Use this
// in the tick loop where the project directory is available.
//
// Library boundary (D8): the registry class and internal tools live in
// packages/backend/src/lib/meta-agent (NPM-extractable, no I/O). The impls
// below do real I/O (fs, child_process, network) and live here in server/.
// ---------------------------------------------------------------------------

import { createDefaultRegistry } from "../../lib/meta-agent/default-tools";
import type { ToolRegistry } from "../../lib/meta-agent/registry";
import { listCustomToolFiles } from "../custom-tools";
import { buildApiToolDef, buildApiToolImpl } from "./api-tool-runtime";
import { readFileDef, readFileImpl, writeFileDef, writeFileImpl } from "./filesystem";
import { runCommandDef, runCommandImpl } from "./shell";
import { codingTaskDef, codingTaskImpl } from "./coding";
import {
  httpFetchDef,
  httpFetchImpl,
  githubApiDef,
  githubApiImpl,
} from "./network";
import {
  spawnSubTeamDef,
  spawnSubTeamImpl,
  modifyAgentDef,
  modifyAgentImpl,
} from "./management";

/**
 * Build the built-in tool registry. Does NOT include custom tools from files.
 */
export function createAppRegistry(): ToolRegistry {
  const registry = createDefaultRegistry();

  registry.register(readFileDef, readFileImpl);
  registry.register(writeFileDef, writeFileImpl);
  registry.register(runCommandDef, runCommandImpl);
  registry.register(codingTaskDef, codingTaskImpl);
  registry.register(httpFetchDef, httpFetchImpl);
  registry.register(githubApiDef, githubApiImpl);
  registry.register(spawnSubTeamDef, spawnSubTeamImpl);
  registry.register(modifyAgentDef, modifyAgentImpl);

  return registry;
}

/**
 * Build the full registry including custom API tools from
 * .simple-harmonic/skills/*.json. Synchronous (file reads).
 */
export function createAppRegistryWithCustomTools(): ToolRegistry {
  const registry = createAppRegistry();

  try {
    const customs = listCustomToolFiles();
    for (const tool of customs) {
      if (registry.has(tool.name)) continue;
      const def = buildApiToolDef(tool.name, tool.description, tool.config);
      const impl = buildApiToolImpl(tool.name, tool.config);
      registry.register(def, impl);
    }
  } catch {
    // files unavailable: custom tools silently absent
  }

  return registry;
}

export {
  readFileDef,
  readFileImpl,
  writeFileDef,
  writeFileImpl,
} from "./filesystem";
export { runCommandDef, runCommandImpl } from "./shell";
export { codingTaskDef, codingTaskImpl } from "./coding";
export {
  httpFetchDef,
  httpFetchImpl,
  githubApiDef,
  githubApiImpl,
} from "./network";
export {
  spawnSubTeamDef,
  spawnSubTeamImpl,
  modifyAgentDef,
  modifyAgentImpl,
} from "./management";
export {
  toolsRoot,
  toolsEnabled,
  resolveInJail,
  JailEscapeError,
} from "./sandbox";

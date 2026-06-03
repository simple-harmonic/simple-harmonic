// ---------------------------------------------------------------------------
// Unified coding_task tool.
//
// One tool surface for all coding backends. The running agent sees
// `coding_task` regardless of whether Codex, Claude Code, or OpenCode
// executes the work. Backend selection: SH_CODING_BACKEND env var or
// config file, defaulting to codex.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolDefinition, ToolImpl } from "../../../lib/meta-agent/registry";
import { getConfig } from "../../config";
import { toolsRoot, toolsEnabled } from "../sandbox";
import type { CodingBackend, CodingResult } from "./types";
import { createCodexBackend } from "./codex";
import { createClaudeCodeBackend } from "./claude-code";
import { createOpenCodeBackend } from "./opencode";

export type { CodingBackend, CodingResult, CodingRunOpts } from "./types";

const BACKENDS: Record<string, () => CodingBackend> = {
  codex: createCodexBackend,
  "claude-code": createClaudeCodeBackend,
  opencode: createOpenCodeBackend,
};

export function createCodingBackend(name?: string): CodingBackend {
  const key = name || getConfig().codingBackend;
  const factory = BACKENDS[key];
  if (!factory) {
    throw new Error(
      `Unknown coding backend "${key}". Available: ${Object.keys(BACKENDS).join(", ")}`,
    );
  }
  return factory();
}

function buildSummary(result: CodingResult): string {
  const parts: string[] = [];

  if (result.errors.length > 0) {
    parts.push(`Errors:\n${result.errors.join("\n")}`);
  }

  if (result.commands.length > 0) {
    parts.push(
      `Commands run (${result.commands.length}):\n` +
        result.commands
          .map(
            (c) =>
              `  $ ${c.command} → exit ${c.exitCode}` +
              (c.output
                ? `\n    ${c.output.split("\n").slice(0, 5).join("\n    ")}`
                : ""),
          )
          .join("\n"),
    );
  }

  const lastMessage = result.messages[result.messages.length - 1];
  if (lastMessage) {
    parts.push(`Agent conclusion:\n${lastMessage.slice(0, 4_000)}`);
  }

  return parts.join("\n\n") || "No output from coding agent.";
}

// ---------------------------------------------------------------------------
// Tool definition + implementation
// ---------------------------------------------------------------------------

const codingTaskSchema = z.object({
  task: z
    .string()
    .describe(
      "A clear, specific description of what to accomplish. Can be coding (implement X, fix Y), " +
        "research (investigate why Z happens), testing (run the test suite and report failures), " +
        "or any development task.",
    ),
  scope: z
    .string()
    .optional()
    .describe(
      "Optional file or directory scope to focus the work (e.g. 'src/lib/meta-agent', 'tests/'). " +
        "Helps the agent focus on the right area of the codebase.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Model override. Defaults to the backend's default model.",
    ),
});

export const codingTaskDef: ToolDefinition<typeof codingTaskSchema> = {
  name: "coding_task",
  description:
    "Run an end-to-end coding, research, or testing task using an autonomous coding agent. " +
    "The agent can read and write files, run commands, and iterate until the task is complete. " +
    "Use for tasks that require multi-file changes, investigation, test runs, or anything " +
    "beyond what read_file/write_file/run_command can do individually. " +
    "The task prompt should be specific and self-contained.",
  category: "shell",
  risk: "destructive",
  schema: codingTaskSchema,
};

export const codingTaskImpl: ToolImpl<typeof codingTaskSchema> = async (args) => {
  if (!toolsEnabled()) {
    return {
      toolName: "coding_task",
      success: false,
      result:
        "coding_task is disabled. Set SH_ENABLE_TOOLS=1 to enable destructive tools.",
    };
  }

  const cfg = getConfig();
  const cwd = toolsRoot();
  const backend = createCodingBackend();
  const backendCfg = cfg.codingConfig[cfg.codingBackend];

  let task = args.task;
  if (args.scope) {
    task = `Focus on: ${args.scope}\n\n${task}`;
  }

  const model = args.model || backendCfg?.model;
  const timeout = backendCfg?.timeout ? backendCfg.timeout * 1000 : undefined;

  try {
    const result = await backend.run({ task, cwd, model, timeout });
    const summary = buildSummary(result);

    if (result.errors.length > 0 && result.messages.length === 0) {
      return {
        toolName: "coding_task",
        success: false,
        result: summary,
      };
    }

    return {
      toolName: "coding_task",
      success: true,
      result: summary,
      action: {
        actionType: "coding_task_completed",
        payload: {
          backend: backend.name,
          task: args.task.slice(0, 500),
          scope: args.scope || null,
          commandsRun: result.commands.length,
          conclusion: (result.messages[result.messages.length - 1] || "").slice(
            0,
            2_000,
          ),
        },
      },
    };
  } catch (err) {
    return {
      toolName: "coding_task",
      success: false,
      result: `coding_task failed (${backend.name}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ---------------------------------------------------------------------------
// Filesystem tools: read_file (safe) and write_file (destructive).
//
// Both are jailed via resolveInJailReal, which is symlink-aware (T3): a symlink
// inside the jail that points outside is rejected, not followed. write_file
// additionally requires the destructive-tools kill switch (toolsEnabled).
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { z } from "zod";
import type { ToolDefinition, ToolImpl } from "../../lib/meta-agent/registry";
import { resolveInJailReal, toolsRoot, toolsEnabled, JailEscapeError } from "./sandbox";

// Cap reads so a giant file can't blow the LLM context or the tick budget.
const MAX_READ_BYTES = 256 * 1024;

// Cap the UI-facing output snippet stored in action_log (T8). Much smaller than
// the LLM-facing result so the narration feed and DB stay lean.
const UI_SNIPPET_BYTES = 2_000;

const readFileSchema = z.object({
  path: z
    .string()
    .describe("Path to read, relative to the project working directory"),
});

const writeFileSchema = z.object({
  path: z
    .string()
    .describe("Path to write, relative to the project working directory"),
  content: z.string().describe("Full file contents to write"),
});

export const readFileDef: ToolDefinition<typeof readFileSchema> = {
  name: "read_file",
  description:
    "Read a UTF-8 text file from the project working directory. Returns the file contents. Paths are relative to the project root; paths escaping it are rejected.",
  category: "filesystem",
  risk: "safe",
  schema: readFileSchema,
};

export const readFileImpl: ToolImpl<typeof readFileSchema> = async (args) => {
  try {
    const abs = await resolveInJailReal(args.path);
    const info = await stat(abs);
    if (!info.isFile()) {
      return {
        toolName: "read_file",
        success: false,
        result: `Not a file: ${args.path}`,
      };
    }
    if (info.size > MAX_READ_BYTES) {
      return {
        toolName: "read_file",
        success: false,
        result: `File too large (${info.size} bytes, max ${MAX_READ_BYTES}). Read a smaller file or a subset.`,
      };
    }
    const content = await readFile(abs, "utf-8");
    return {
      toolName: "read_file",
      success: true,
      result: content,
      action: {
        actionType: "file_read",
        payload: {
          path: relative(toolsRoot(), abs),
          bytes: info.size,
          // UI snippet (T8/D19): the action log shows tool output inline. The
          // LLM still gets the full content via `result`; this is capped so
          // action_log rows don't bloat.
          output: content.slice(0, UI_SNIPPET_BYTES),
        },
      },
    };
  } catch (err) {
    return {
      toolName: "read_file",
      success: false,
      result: errToMessage("read_file", args.path, err),
    };
  }
};

export const writeFileDef: ToolDefinition<typeof writeFileSchema> = {
  name: "write_file",
  description:
    "Write a UTF-8 text file in the project working directory, creating parent directories as needed. Overwrites existing files. Paths are relative to the project root; paths escaping it are rejected.",
  category: "filesystem",
  risk: "destructive",
  schema: writeFileSchema,
};

export const writeFileImpl: ToolImpl<typeof writeFileSchema> = async (args) => {
  if (!toolsEnabled()) {
    return {
      toolName: "write_file",
      success: false,
      result:
        "write_file is disabled. Destructive tools require SH_ENABLE_TOOLS to be set; they remain gated until the approval flow is enabled.",
    };
  }
  try {
    const abs = await resolveInJailReal(args.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, args.content, "utf-8");
    return {
      toolName: "write_file",
      success: true,
      result: `Wrote ${args.content.length} chars to ${relative(toolsRoot(), abs)}`,
      action: {
        actionType: "file_written",
        payload: {
          path: relative(toolsRoot(), abs),
          chars: args.content.length,
        },
      },
    };
  } catch (err) {
    return {
      toolName: "write_file",
      success: false,
      result: errToMessage("write_file", args.path, err),
    };
  }
};

function errToMessage(tool: string, path: string, err: unknown): string {
  if (err instanceof JailEscapeError) return err.message;
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return `File not found: ${path}`;
  if (code === "EACCES") return `Permission denied: ${path}`;
  if (code === "EISDIR") return `Path is a directory, not a file: ${path}`;
  return `${tool} failed for ${path}: ${err instanceof Error ? err.message : String(err)}`;
}

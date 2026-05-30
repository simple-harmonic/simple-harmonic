// ---------------------------------------------------------------------------
// Codex CLI adapter: shells out to `codex exec` to make LLM calls using
// the user's Codex subscription (ChatGPT OAuth). This bypasses the need
// for a standard OpenAI API key.
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LLMClient } from "./runner";
import type { OpenAIToolDef } from "./types";

interface CodexEvent {
  type: string;
  item?: {
    id: string;
    type: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
    status?: string;
  };
  error?: { message: string };
}

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

/**
 * Format OpenAI-style messages + tools into a single prompt for codex exec.
 * Since codex exec doesn't support custom tools, we encode tool definitions
 * in the prompt and instruct the model to output structured JSON.
 */
function buildCodexPrompt(
  messages: OpenAIMessage[],
  tools?: OpenAIToolDef[],
): string {
  const parts: string[] = [];

  // System messages
  for (const m of messages) {
    if (m.role === "system") {
      parts.push(m.content ?? "");
    }
  }

  // Tool definitions
  if (tools && tools.length > 0) {
    parts.push("\n## Available Tools\n");
    parts.push(
      "You MUST respond with a JSON object. If you want to use a tool, set " +
        '"tool_calls" to an array of calls. If you just want to respond with text, ' +
        'set "content" to your message.\n',
    );
    parts.push("Response format:");
    parts.push("```json");
    parts.push(
      JSON.stringify(
        {
          content: "your text response (or null if using tools)",
          tool_calls: [
            {
              name: "tool_name",
              arguments: { key: "value" },
            },
          ],
        },
        null,
        2,
      ),
    );
    parts.push("```\n");
    parts.push("Available tools:");
    for (const t of tools) {
      parts.push(
        `- **${t.function.name}**: ${t.function.description || ""}`,
      );
      if (t.function.parameters) {
        parts.push(
          `  Parameters: ${JSON.stringify(t.function.parameters)}`,
        );
      }
    }
    parts.push("");
  }

  // User/assistant messages
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      parts.push(`\n[User]\n${m.content ?? ""}`);
    } else if (m.role === "assistant") {
      parts.push(`\n[Assistant]\n${m.content ?? ""}`);
    } else if (m.role === "tool") {
      parts.push(`\n[Tool Result]\n${m.content ?? ""}`);
    }
  }

  parts.push(
    "\n\nRespond with ONLY a valid JSON object. No markdown fences, no extra text.",
  );

  return parts.join("\n");
}

/**
 * Parse the JSONL output from codex exec and extract the agent's response.
 */
function parseCodexOutput(jsonlOutput: string): string {
  const lines = jsonlOutput.trim().split("\n");
  let lastText = "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event: CodexEvent = JSON.parse(line);
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        event.item.text
      ) {
        lastText = event.item.text;
      }
      if (event.type === "error") {
        console.error("[codex-adapter] Error event:", event.error?.message);
      }
    } catch {
      // skip non-JSON lines
    }
  }

  return lastText;
}

/**
 * Try to parse the agent's text response as structured JSON with tool calls.
 */
function parseStructuredResponse(text: string): {
  content: string | null;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
} {
  // Try to extract JSON from the text (might be wrapped in markdown fences)
  let jsonStr = text;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1];
  }

  try {
    const parsed = JSON.parse(jsonStr.trim());
    if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
      return {
        content: parsed.content ?? null,
        tool_calls: parsed.tool_calls.map(
          (tc: { name: string; arguments: Record<string, unknown> }, i: number) => ({
            id: `call_${Date.now()}_${i}`,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments || {}),
            },
          }),
        ),
      };
    }
    return { content: parsed.content ?? text };
  } catch {
    // Not valid JSON, treat as plain text response
    return { content: text };
  }
}

function runCodexExec(prompt: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Write prompt to a temp file to avoid shell escaping issues
    const tmpDir = mkdtempSync(join(tmpdir(), "sh-codex-"));
    const promptFile = join(tmpDir, "prompt.txt");
    writeFileSync(promptFile, prompt);

    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-rules",
      "-c",
      `model="${model}"`,
      "-c",
      'model_reasoning_effort="low"',
      "-c",
      "sandbox=\"read-only\"",
      "-",
    ];

    const child = execFile("codex", args, {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env },
    }, (err, stdout, stderr) => {
      // Cleanup temp files
      try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }

      if (err && !stdout) {
        reject(new Error(`codex exec failed: ${err.message}`));
        return;
      }
      resolve(stdout);
    });

    // Pipe the prompt via stdin
    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}

/**
 * Create an LLMClient backed by the Codex CLI.
 * Uses `codex exec --json` to make LLM calls via the user's ChatGPT subscription.
 */
export function createCodexClient(opts?: { model?: string }): LLMClient {
  const model = opts?.model || "gpt-5.5";

  return {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          const messages = params.messages as OpenAIMessage[];
          const tools = params.tools as OpenAIToolDef[] | undefined;
          const requestModel = (params.model as string) || model;

          const prompt = buildCodexPrompt(messages, tools);

          const output = await runCodexExec(prompt, requestModel);
          const text = parseCodexOutput(output);

          if (!text) {
            return {
              choices: [
                {
                  message: { content: "No response from agent.", tool_calls: undefined },
                  finish_reason: "stop",
                },
              ],
            };
          }

          // If tools were provided, try to parse structured response
          if (tools && tools.length > 0) {
            const parsed = parseStructuredResponse(text);
            return {
              choices: [
                {
                  message: {
                    content: parsed.content,
                    tool_calls:
                      parsed.tool_calls && parsed.tool_calls.length > 0
                        ? parsed.tool_calls
                        : undefined,
                  },
                  finish_reason: parsed.tool_calls ? "tool_calls" : "stop",
                },
              ],
            };
          }

          return {
            choices: [
              {
                message: { content: text, tool_calls: undefined },
                finish_reason: "stop",
              },
            ],
          };
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic SDK adapter: wraps @anthropic-ai/sdk in the LLMClient interface
// so the runner can use Anthropic models without changing its OpenAI-shaped
// calling convention.
// ---------------------------------------------------------------------------

import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient } from "./runner";
import type { OpenAIToolDef } from "./types";

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

/** Convert OpenAI-style tool defs to Anthropic format */
function convertTools(tools?: OpenAIToolDef[]): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description || "",
    input_schema: t.function.parameters || { type: "object", properties: {} },
  }));
}

/** Map OpenAI role names to Anthropic role names, extracting system */
function convertMessages(messages: Array<Record<string, unknown>>): {
  system: string | undefined;
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
} {
  let system: string | undefined;
  const converted: Array<{ role: "user" | "assistant"; content: unknown }> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = (system ? system + "\n\n" : "") + String(msg.content ?? "");
      continue;
    }

    if (msg.role === "tool") {
      // Anthropic expects tool results as user messages with tool_result content blocks
      converted.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: String(msg.content ?? ""),
          },
        ],
      });
      continue;
    }

    if (msg.role === "assistant") {
      // If assistant message has tool_calls, convert to Anthropic content blocks
      const toolCalls = msg.tool_calls as
        | Array<{ id: string; function: { name: string; arguments: string } }>
        | undefined;

      if (toolCalls && toolCalls.length > 0) {
        const content: unknown[] = [];
        if (msg.content) {
          content.push({ type: "text", text: String(msg.content) });
        }
        for (const tc of toolCalls) {
          let input: Record<string, unknown>;
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            input = {};
          }
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
        converted.push({ role: "assistant", content });
      } else {
        converted.push({ role: "assistant", content: String(msg.content ?? "") });
      }
      continue;
    }

    // user messages
    converted.push({ role: "user", content: String(msg.content ?? "") });
  }

  return { system, messages: converted };
}

/**
 * Create an LLMClient backed by the Anthropic SDK.
 *
 * Usage:
 *   const llm = createAnthropicClient({ apiKey: "..." });
 *   // Works just like OpenAI client via the LLMClient interface
 */
export function createAnthropicClient(opts: {
  apiKey?: string;
  baseURL?: string;
  timeout?: number;
}): LLMClient {
  const client = new Anthropic({
    apiKey: opts.apiKey || process.env.ANTHROPIC_API_KEY,
    baseURL: opts.baseURL || process.env.ANTHROPIC_BASE_URL || undefined,
    timeout: opts.timeout ?? 60_000,
  });

  return {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          const { system, messages } = convertMessages(
            params.messages as Array<Record<string, unknown>>,
          );

          const tools = convertTools(params.tools as OpenAIToolDef[] | undefined);

          const anthropicParams: Record<string, unknown> = {
            model: String(params.model || "claude-sonnet-4-20250514"),
            max_tokens: (params.max_tokens as number) || 1024,
            messages,
          };

          if (system) anthropicParams.system = system;
          if (tools) anthropicParams.tools = tools;

          const response = await client.messages.create(
            anthropicParams as unknown as Parameters<typeof client.messages.create>[0],
            options?.signal ? { signal: options.signal } : undefined,
          ) as Anthropic.Message;

          // Convert Anthropic response to OpenAI format
          const content = response.content;
          let textContent: string | null = null;
          const toolCalls: Array<{
            id: string;
            function: { name: string; arguments: string };
          }> = [];

          for (const block of content) {
            if (block.type === "text") {
              textContent = (textContent ?? "") + block.text;
            } else if (block.type === "tool_use") {
              toolCalls.push({
                id: block.id,
                function: {
                  name: block.name,
                  arguments: JSON.stringify(block.input),
                },
              });
            }
          }

          const finishReason =
            response.stop_reason === "tool_use" ? "tool_calls" : "stop";

          return {
            // Echo the serving model (OpenAI wire shape) so the spend counter
            // and the cascade attribute the call correctly.
            model: response.model,
            choices: [
              {
                message: {
                  content: textContent,
                  tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                },
                finish_reason: finishReason,
              },
            ],
            usage: {
              input_tokens: response.usage?.input_tokens ?? 0,
              output_tokens: response.usage?.output_tokens ?? 0,
              // OpenAI-compatible aliases so the counting wrapper reads either.
              prompt_tokens: response.usage?.input_tokens ?? 0,
              completion_tokens: response.usage?.output_tokens ?? 0,
            },
          };
        },
      },
    },
  };
}

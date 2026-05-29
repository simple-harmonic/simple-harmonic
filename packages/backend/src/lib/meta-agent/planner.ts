import OpenAI from "openai";
import { getCodexAccessToken, getCodexAuthStatus } from "../../server/codex-auth";
import { getApiKeySource, getConfig } from "../../server/config";
import { proxyFetch } from "../../server/proxy-fetch";
import { DEFAULT_META_AGENT_PROMPT } from "./default-prompt";

// ---------------------------------------------------------------------------
// OpenAI SDK client (for Platform API key / env var)
// ---------------------------------------------------------------------------

function openaiClient() {
  const cfg = getConfig();
  return new OpenAI({
    apiKey: cfg.openaiApiKey || undefined,
    baseURL: cfg.openaiBaseUrl || undefined,
    timeout: 30000,
  });
}

// ---------------------------------------------------------------------------
// Tool definition (shared between both paths)
// ---------------------------------------------------------------------------

const SPAWN_TOOL_DEF = {
  name: "spawn_team",
  description:
    "Spawn a team of agents based on the conversation. Call this when you and the founder have aligned on a team composition.",
  parameters: {
    type: "object" as const,
    properties: {
      team_name: {
        type: "string" as const,
        description:
          "Short, human-friendly team name derived from the company or focus area (e.g., 'Acme Studio', 'Newsletter Ops', 'Indie Launch'). 1-4 words. NOT auto-generated from archetypes.",
      },
      cofounder_name: {
        type: "string" as const,
        description:
          "Optional. The name the founder wants to call you (their AI cofounder). Default is 'Harmon'. Only set if the founder explicitly named you during the conversation.",
      },
      agents: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            name: { type: "string" as const, description: "Kebab-case agent name" },
            role: { type: "string" as const, description: "One-line role description" },
            archetype: {
              type: "string" as const,
              enum: [
                "support-responder",
                "content-scheduler",
                "sales-followup",
                "ops-monitor",
                "research-summarizer",
              ],
            },
            tools: {
              type: "array" as const,
              items: { type: "string" as const },
              description: "Tool names this agent can use",
            },
            schedule_seconds: {
              type: "number" as const,
              description: "How often this agent wakes up and acts, in seconds. Typical values: 300 (5 min) for monitors, 600 (10 min) for content/ops, 1800 (30 min) for research. Range: 60-3600. Do NOT use 86400 (daily).",
            },
            initial_prompt: {
              type: "string" as const,
              description: "System prompt for this agent",
            },
          },
          required: ["name", "role", "archetype", "tools", "schedule_seconds", "initial_prompt"],
        },
      },
    },
    required: ["team_name", "agents"],
  },
};

// Re-export for backward compatibility
export { DEFAULT_META_AGENT_PROMPT } from "./default-prompt";

export interface PlannerMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SpawnTeamAgent {
  name: string;
  role: string;
  archetype: string;
  tools: string[];
  schedule_seconds: number;
  initial_prompt: string;
}

export interface SpawnTeamResult {
  team_name: string;
  cofounder_name?: string;
  agents: SpawnTeamAgent[];
}

type PlannerResult =
  | { type: "message"; content: string }
  | { type: "spawn"; content: string; result: SpawnTeamResult };

// ---------------------------------------------------------------------------
// Public entry point: picks the right backend
// ---------------------------------------------------------------------------

export async function plannerStream(
  messages: PlannerMessage[],
  onToken: (token: string) => void,
): Promise<PlannerResult> {
  const source = getApiKeySource();
  if (source === "codex") {
    return codexResponsesStream(messages, onToken);
  }
  return openaiChatStream(messages, onToken);
}

// ---------------------------------------------------------------------------
// Path A: OpenAI Chat Completions (Platform API key / env var)
// ---------------------------------------------------------------------------

async function openaiChatStream(
  messages: PlannerMessage[],
  onToken: (token: string) => void,
): Promise<PlannerResult> {
  const stream = await openaiClient().chat.completions.create({
    model: getConfig().model,
    stream: true,
    messages: [
      { role: "system", content: DEFAULT_META_AGENT_PROMPT },
      ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ],
    tools: [{ type: "function", function: SPAWN_TOOL_DEF }],
  });

  let fullText = "";
  let toolCallName = "";
  let toolCallArgs = "";

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      fullText += delta.content;
      onToken(delta.content);
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.function?.name) toolCallName = tc.function.name;
        if (tc.function?.arguments) toolCallArgs += tc.function.arguments;
      }
    }
  }

  return finalize(fullText, toolCallName, toolCallArgs);
}

// ---------------------------------------------------------------------------
// Path B: Codex Subscription via chatgpt.com/backend-api/codex/responses
// ---------------------------------------------------------------------------

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

function codexHeaders(): Record<string, string> {
  const token = getCodexAccessToken();
  if (!token) throw new Error("No Codex access token available");

  const status = getCodexAuthStatus();
  const accountId = status.accountId || "";

  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "ChatGPT-Account-ID": accountId,
    "User-Agent": "codex_cli_rs/0.0.0",
    originator: "codex_cli_rs",
  };
}

async function codexResponsesStream(
  messages: PlannerMessage[],
  onToken: (token: string) => void,
): Promise<PlannerResult> {
  const input = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const body = {
    model: getConfig().model,
    instructions: DEFAULT_META_AGENT_PROMPT,
    input,
    tools: [
      {
        type: "function",
        name: SPAWN_TOOL_DEF.name,
        description: SPAWN_TOOL_DEF.description,
        parameters: SPAWN_TOOL_DEF.parameters,
      },
    ],
    store: false,
    stream: true,
  };

  const res = await proxyFetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: codexHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Codex API error ${res.status}: ${text.slice(0, 200)}`);
  }

  if (!res.body) {
    throw new Error("No response body from Codex API");
  }

  let fullText = "";
  let toolCallName = "";
  let toolCallArgs = "";

  // Parse SSE stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Process complete lines
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    let currentEvent = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
        continue;
      }
      if (!line.startsWith("data: ")) continue;

      const json = line.slice(6);
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(json);
      } catch {
        continue;
      }

      const eventType = (data.type as string) || currentEvent;

      if (eventType === "response.output_text.delta") {
        const delta = data.delta as string;
        if (delta) {
          fullText += delta;
          onToken(delta);
        }
      } else if (eventType === "response.output_item.added") {
        const item = data.item as Record<string, unknown>;
        if (item?.type === "function_call" && item.name) {
          toolCallName = item.name as string;
        }
      } else if (eventType === "response.function_call_arguments.delta") {
        const delta = data.delta as string;
        if (delta) {
          toolCallArgs += delta;
        }
      }
    }
  }

  return finalize(fullText, toolCallName, toolCallArgs);
}

// ---------------------------------------------------------------------------
// Shared: finalize result from accumulated text + tool call
// ---------------------------------------------------------------------------

function finalize(fullText: string, toolCallName: string, toolCallArgs: string): PlannerResult {
  if (toolCallName === "spawn_team" && toolCallArgs) {
    try {
      const parsed = JSON.parse(toolCallArgs) as SpawnTeamResult;
      return { type: "spawn", content: fullText, result: parsed };
    } catch {
      // malformed tool call, treat as message
    }
  }

  return {
    type: "message",
    content: fullText || "I need a moment. Try again.",
  };
}

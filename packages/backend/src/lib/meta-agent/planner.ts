import OpenAI from "openai";
import { DEFAULT_META_AGENT_PROMPT } from "./default-prompt";

// ---------------------------------------------------------------------------
// Dependency injection: the planner lives in the NPM-extractable library core,
// so it must not import app server modules. The app resolves these and passes
// them in (see server/planner-deps.ts).
// ---------------------------------------------------------------------------

export interface PlannerDeps {
  /** Resolved LLM config. */
  config: { model: string; openaiApiKey?: string; openaiBaseUrl?: string };
  /** Backend selector: "codex" routes to the Codex subscription path. */
  apiKeySource: string;
  /** Codex subscription auth (used only when apiKeySource === "codex"). */
  codexAccessToken: string | null;
  codexAccountId: string;
  /** Proxy-aware fetch, injected so the core doesn't import server/proxy-fetch. */
  fetchImpl: (
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    },
  ) => Promise<Response>;
}

// ---------------------------------------------------------------------------
// OpenAI SDK client (for Platform API key / env var)
// ---------------------------------------------------------------------------

function openaiClient(config: PlannerDeps["config"]) {
  return new OpenAI({
    apiKey: config.openaiApiKey || undefined,
    baseURL: config.openaiBaseUrl || undefined,
    timeout: 30000,
  });
}

// ---------------------------------------------------------------------------
// Tool definition (shared between both paths)
// ---------------------------------------------------------------------------

const SPAWN_TOOL_DEF = {
  name: "spawn_team",
  description:
    "Spawn a team of agents. Can be a root team or a sub-team of an existing team. Call this when you and the founder have aligned on a team composition.",
  parameters: {
    type: "object" as const,
    properties: {
      team_name: {
        type: "string" as const,
        description:
          "Short, human-friendly team name derived from the company or focus area (e.g., 'Acme Studio', 'Newsletter Ops', 'Indie Launch'). 1-4 words. NOT auto-generated from archetypes.",
      },
      parent_team: {
        type: "string" as const,
        description:
          "Optional. Name of the existing parent team to nest this team under. Omit for a root team.",
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
              description: "Free-form archetype describing the agent's function (e.g. 'bug-hunter', 'content-scheduler', 'deploy-monitor', 'sales-analyst'). Not limited to a preset list.",
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

const MODIFY_AGENT_TOOL_DEF = {
  name: "modify_agent",
  description:
    "Modify an existing agent's configuration. Use this to add/remove tools, update the system prompt, change the schedule, or pause/resume an agent.",
  parameters: {
    type: "object" as const,
    properties: {
      agent_name: {
        type: "string" as const,
        description: "Name of the agent to modify (e.g. 'bug-hunter', 'content-scheduler').",
      },
      team_name: {
        type: "string" as const,
        description: "Team the agent belongs to. Required to disambiguate if the same agent name exists in multiple teams.",
      },
      updates: {
        type: "object" as const,
        properties: {
          tools: {
            type: "array" as const,
            items: { type: "string" as const },
            description: "Replace the agent's full tool list. Include all tools the agent should have, not just the new ones.",
          },
          initial_prompt: {
            type: "string" as const,
            description: "Replace the agent's system prompt.",
          },
          schedule_seconds: {
            type: "number" as const,
            description: "Change how often the agent runs, in seconds.",
          },
          status: {
            type: "string" as const,
            enum: ["running", "paused"],
            description: "Pause or resume the agent.",
          },
          role: {
            type: "string" as const,
            description: "Update the agent's role description.",
          },
          output_contract: {
            type: "object" as const,
            description:
              "JSON Schema defining the agent's expected output structure. " +
              "The agent's report_action payload is validated against this each tick. " +
              'Example: {"type":"object","required":["bugs"],"properties":{"bugs":{"type":"array","items":{"type":"object","required":["file","description","severity"],"properties":{"file":{"type":"string"},"description":{"type":"string"},"severity":{"type":"string"}}}}}}',
          },
        },
      },
    },
    required: ["agent_name", "team_name", "updates"],
  },
};

const REQUEST_CREDENTIAL_TOOL_DEF = {
  name: "request_credential",
  description:
    "Request a credential (API key, token, secret) from the founder. Use this when you identify that the team needs a specific credential to operate. The credential is encrypted and stored in Apollo (the secrets manager). It is never stored in the database or any file agents can access.",
  parameters: {
    type: "object" as const,
    properties: {
      key: {
        type: "string" as const,
        description:
          "Environment variable name (e.g. 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY'). Uppercase with underscores.",
      },
      label: {
        type: "string" as const,
        description: "Human-friendly name (e.g. 'GitHub Personal Access Token').",
      },
      reason: {
        type: "string" as const,
        description: "One sentence explaining why this credential is needed.",
      },
      help_url: {
        type: "string" as const,
        description: "Optional URL where the user can create/find this credential.",
      },
    },
    required: ["key", "label", "reason"],
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
  parent_team?: string;
  cofounder_name?: string;
  agents: SpawnTeamAgent[];
}

export interface ModifyAgentUpdates {
  tools?: string[];
  initial_prompt?: string;
  schedule_seconds?: number;
  status?: "running" | "paused";
  role?: string;
  output_contract?: Record<string, unknown>;
}

export interface ModifyAgentResult {
  agent_name: string;
  team_name: string;
  updates: ModifyAgentUpdates;
}

export interface CredentialRequest {
  key: string;
  label: string;
  reason: string;
  help_url?: string;
}

export type PlannerResult =
  | { type: "message"; content: string }
  | { type: "spawn"; content: string; result: SpawnTeamResult }
  | { type: "modify_agent"; content: string; result: ModifyAgentResult }
  | { type: "request_credential"; content: string; result: CredentialRequest };

// ---------------------------------------------------------------------------
// Public entry point: picks the right backend
// ---------------------------------------------------------------------------

export async function plannerStream(
  messages: PlannerMessage[],
  onToken: (token: string) => void,
  deps: PlannerDeps,
): Promise<PlannerResult> {
  if (deps.apiKeySource === "codex") {
    return codexResponsesStream(messages, onToken, deps);
  }
  return openaiChatStream(messages, onToken, deps);
}

// ---------------------------------------------------------------------------
// Path A: OpenAI Chat Completions (Platform API key / env var)
// ---------------------------------------------------------------------------

async function openaiChatStream(
  messages: PlannerMessage[],
  onToken: (token: string) => void,
  deps: PlannerDeps,
): Promise<PlannerResult> {
  const stream = await openaiClient(deps.config).chat.completions.create({
    model: deps.config.model,
    stream: true,
    messages: [
      { role: "system", content: DEFAULT_META_AGENT_PROMPT },
      ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ],
    tools: [
      { type: "function", function: SPAWN_TOOL_DEF },
      { type: "function", function: MODIFY_AGENT_TOOL_DEF },
      { type: "function", function: REQUEST_CREDENTIAL_TOOL_DEF },
    ],
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

function codexHeaders(deps: PlannerDeps): Record<string, string> {
  const token = deps.codexAccessToken;
  if (!token) throw new Error("No Codex access token available");

  const accountId = deps.codexAccountId || "";

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
  deps: PlannerDeps,
): Promise<PlannerResult> {
  const input = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const body = {
    model: deps.config.model,
    instructions: DEFAULT_META_AGENT_PROMPT,
    input,
    tools: [
      {
        type: "function",
        name: SPAWN_TOOL_DEF.name,
        description: SPAWN_TOOL_DEF.description,
        parameters: SPAWN_TOOL_DEF.parameters,
      },
      {
        type: "function",
        name: MODIFY_AGENT_TOOL_DEF.name,
        description: MODIFY_AGENT_TOOL_DEF.description,
        parameters: MODIFY_AGENT_TOOL_DEF.parameters,
      },
      {
        type: "function",
        name: REQUEST_CREDENTIAL_TOOL_DEF.name,
        description: REQUEST_CREDENTIAL_TOOL_DEF.description,
        parameters: REQUEST_CREDENTIAL_TOOL_DEF.parameters,
      },
    ],
    store: false,
    stream: true,
  };

  const res = await deps.fetchImpl(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: codexHeaders(deps),
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

  if (toolCallName === "modify_agent" && toolCallArgs) {
    try {
      const parsed = JSON.parse(toolCallArgs) as ModifyAgentResult;
      return { type: "modify_agent", content: fullText, result: parsed };
    } catch {
      // malformed tool call, treat as message
    }
  }

  if (toolCallName === "request_credential" && toolCallArgs) {
    try {
      const parsed = JSON.parse(toolCallArgs) as CredentialRequest;
      return { type: "request_credential", content: fullText, result: parsed };
    } catch {
      // malformed tool call, treat as message
    }
  }

  return {
    type: "message",
    content: fullText || "I need a moment. Try again.",
  };
}

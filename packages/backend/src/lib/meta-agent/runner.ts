// ---------------------------------------------------------------------------
// Agent runner — calls the LLM with tools, executes tool calls via a2ax
// ---------------------------------------------------------------------------

import type { A2AXSender, PeerAgent, ToolExecContext, ToolResult } from "./tools";
import { AGENT_TOOL_DEFS, executeTool } from "./tools";

export interface AgentConfig {
  name: string;
  archetype: string;
  tools: string[];
  initialPrompt: string;
  /** Formatted a2ax context block (messages since last tick) */
  a2axContext?: string;
  /** Team + identity context for tool execution */
  teamId: string;
  agentId: string;
  peers: PeerAgent[];
  /** a2ax instance for sending messages */
  a2ax: A2AXSender;
  /** OpenAI-compatible client for LLM calls */
  llm: LLMClient;
  /** Model to use for LLM calls */
  model?: string;
}

export interface AgentRunResult {
  actionType: string;
  payload: Record<string, unknown>;
}

/** Minimal OpenAI-compatible chat client interface */
export interface LLMClient {
  chat: {
    completions: {
      create: (params: Record<string, unknown>) => Promise<LLMResponse>;
    };
  };
}

interface LLMResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
}

const MAX_TOOL_ROUNDS = 3;

export async function runAgent(config: AgentConfig): Promise<AgentRunResult> {
  const systemPrompt = buildSystemPrompt(config);

  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: buildTickPrompt(config) },
  ];

  const toolCtx: ToolExecContext = {
    teamId: config.teamId,
    agentId: config.agentId,
    agentName: config.name,
    peers: config.peers,
  };

  const actions: ToolResult[] = [];

  // Multi-round tool use loop
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await config.llm.chat.completions.create({
      model: config.model || "o4-mini",
      messages,
      tools: AGENT_TOOL_DEFS,
    });

    const choice = response.choices[0];
    if (!choice) break;

    const msg = choice.message;

    // If LLM returned text only (no tool calls), we're done
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // If the LLM just spoke but didn't use tools, log as a noop with the text
      if (actions.length === 0) {
        return {
          actionType: "agent_thought",
          payload: { agent: config.name, thought: msg.content ?? "no output" },
        };
      }
      break;
    }

    // Add assistant message with tool calls to conversation
    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    });

    // Execute each tool call
    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }

      const result = await executeTool(
        { name: tc.function.name, arguments: args },
        toolCtx,
        config.a2ax,
      );

      // Feed result back to LLM
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result.result,
      });

      if (result.action) {
        actions.push(result.action);
      }
    }

    // If finish_reason is "stop" (not "tool_calls"), break
    if (choice.finish_reason === "stop") break;
  }

  // Return the primary action (first one), or aggregate
  if (actions.length === 0) {
    return { actionType: "noop", payload: { agent: config.name } };
  }

  if (actions.length === 1) {
    return {
      actionType: actions[0].actionType,
      payload: { agent: config.name, ...actions[0].payload },
    };
  }

  // Multiple actions: return a summary
  return {
    actionType: "multi_action",
    payload: {
      agent: config.name,
      actions: actions.map((a) => ({ type: a.actionType, ...a.payload })),
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildSystemPrompt(config: AgentConfig): string {
  const peerList = config.peers.map((p) => `- ${p.name} (${p.role})`).join("\n");

  return `${config.initialPrompt}

You are "${config.name}", a ${config.archetype} agent in a team.

Your peers:
${peerList || "No other agents in this team."}

You have these tools available:
- send_message: Send a direct message to a specific peer agent
- broadcast: Send a message to all agents in the team
- report_action: Log an action or finding

Coordinate with your peers when it makes sense. Share relevant findings, ask for help, delegate when appropriate. Be concise in messages.`;
}

function buildTickPrompt(config: AgentConfig): string {
  let prompt = "A new tick has fired. Do your job based on your role and system prompt.";

  if (config.a2axContext) {
    prompt += `\n\n${config.a2axContext}`;
    prompt += "\n\nRespond to any messages that need a reply, then do your regular work.";
  } else {
    prompt += "\n\nNo new messages from other agents.";
  }

  return prompt;
}

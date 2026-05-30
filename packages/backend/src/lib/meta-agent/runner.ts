// ---------------------------------------------------------------------------
// Agent runner — calls the LLM with tools, executes tool calls via the tool
// layer, and (v0.1, T2) suspends for human approval before destructive tools.
//
// Resumable conversation model (D17)
// ----------------------------------
// A tick is a multi-round tool-use loop. When the LLM asks to run a tool the
// runner classifies it via `isDestructive`. Safe tools run inline. The first
// destructive call ends the tick early: the runner SUSPENDS, returning the full
// serialized conversation plus the pending destructive call(s). Nothing
// destructive has run.
//
//   tick 1:  [run safe tools...] → hit destructive tool → SUSPEND
//              └── persist `suspension` (messages so far + pending calls)
//   (human approves/rejects in the UI; tick route stores the verdicts)
//   tick N:  runAgent({ resume: { state, decisions } })
//              ├── approved  → execute the tool, feed result to the LLM
//              └── rejected  → feed a rejection note to the LLM
//              └── continue the loop (may suspend again, or complete)
//
// The conversation (`messages`) is plain JSON, so it round-trips through the DB
// untouched. The runner is the only place that understands the shape; callers
// treat `AgentSuspension` as an opaque blob to persist and hand back.
//
// Backward compat: `AgentRunResult` keeps actionType/payload always present
// (actionType === "suspended" when paused), with an optional typed `suspension`
// field. Existing callers that only read actionType/payload keep working; the
// approval-aware tick route checks `result.suspension`.
// ---------------------------------------------------------------------------

import type { A2AXSender, PeerAgent, ToolExecContext, ToolResult } from "./tools";
import { AGENT_TOOL_DEFS, executeTool } from "./tools";

/** A tool call the LLM asked for, in OpenAI wire shape (args are a JSON string). */
export interface PendingToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments string as emitted by the LLM. */
  arguments: string;
}

/**
 * Opaque-to-callers serialized conversation at the point of suspension.
 * Plain JSON: persist it and hand it back verbatim on resume.
 */
export interface AgentSuspension {
  /** Full OpenAI-format message list up to and including the assistant turn
   *  whose tool calls triggered the suspension. */
  messages: Array<Record<string, unknown>>;
  /** Destructive tool calls awaiting a human decision. */
  pending: PendingToolCall[];
  /** Actions already logged this tick before the suspension (safe tools). */
  actions: ToolResult[];
  /** Loop round at the point of suspension, so resume continues counting. */
  round: number;
}

/** Human decision for one pending tool call, supplied on resume. */
export interface ToolDecision {
  /** Matches PendingToolCall.id. */
  id: string;
  approved: boolean;
  /** Optional note shown to the LLM (e.g. why it was rejected). */
  note?: string;
}

export interface ResumeState {
  suspension: AgentSuspension;
  decisions: ToolDecision[];
}

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
  /**
   * Classifier: does this tool require human approval before it runs? Defaults
   * to "nothing is destructive", which preserves pre-T2 behavior (every tool
   * runs inline). The app passes a classifier backed by the registry's risk
   * labels.
   */
  isDestructive?: (toolName: string) => boolean;
  /**
   * Resume a previously suspended tick. When present, the runner reconstructs
   * the conversation, applies the decisions to the pending calls, then
   * continues the loop instead of starting fresh.
   */
  resume?: ResumeState;
}

export interface AgentRunResult {
  /** "suspended" when the tick paused for approval; otherwise the action type. */
  actionType: string;
  payload: Record<string, unknown>;
  /** Present iff the tick suspended for human approval. */
  suspension?: AgentSuspension;
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
  const isDestructive = config.isDestructive ?? (() => false);

  const toolCtx: ToolExecContext = {
    teamId: config.teamId,
    agentId: config.agentId,
    agentName: config.name,
    peers: config.peers,
  };

  // --- Initialize or restore conversation state -----------------------------
  let messages: Array<Record<string, unknown>>;
  const actions: ToolResult[] = [];
  let startRound = 0;

  if (config.resume) {
    // Resuming a suspended tick: restore the conversation and prior actions,
    // then apply the human decisions to the pending destructive calls.
    const { suspension, decisions } = config.resume;
    messages = suspension.messages;
    actions.push(...suspension.actions);
    startRound = suspension.round;

    const decisionById = new Map(decisions.map((d) => [d.id, d]));
    for (const call of suspension.pending) {
      const decision = decisionById.get(call.id);
      if (decision?.approved) {
        const execResult = await runToolCall(call, toolCtx, config.a2ax, actions);
        messages.push(toolResultMessage(call.id, execResult));
      } else {
        const note = decision?.note ?? "The user rejected this action.";
        messages.push(
          toolMessage(
            call.id,
            `Action not approved: ${note} Do not retry it; continue with other work or stop.`,
          ),
        );
      }
    }
    // After applying decisions, fall through into the loop for another LLM turn
    // (the model reacts to the approval/rejection results).
  } else {
    messages = [
      { role: "system", content: buildSystemPrompt(config) },
      { role: "user", content: buildTickPrompt(config) },
    ];
  }

  // --- Multi-round tool-use loop --------------------------------------------
  for (let round = startRound; round < MAX_TOOL_ROUNDS; round++) {
    const response = await config.llm.chat.completions.create({
      model: config.model || "o4-mini",
      messages,
      tools: AGENT_TOOL_DEFS,
    });

    const choice = response.choices[0];
    if (!choice) break;

    const msg = choice.message;

    // LLM returned text only (no tool calls): we're done this tick.
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      if (actions.length === 0) {
        return {
          actionType: "agent_thought",
          payload: { agent: config.name, thought: msg.content ?? "no output" },
        };
      }
      break;
    }

    // Record the assistant turn (with its tool calls) before executing.
    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    });

    // First pass: any destructive calls? If so, suspend the whole tick BEFORE
    // executing anything in this round — we don't want to half-run a round and
    // then pause (the LLM issued these calls as one batch).
    const destructive = msg.tool_calls.filter((tc) => isDestructive(tc.function.name));
    if (destructive.length > 0) {
      return {
        actionType: "suspended",
        payload: {
          agent: config.name,
          pending: destructive.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
          })),
        },
        suspension: {
          messages,
          pending: destructive.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          })),
          actions,
          // Resume continues from THIS round: the destructive calls become
          // tool results, then the loop does one more LLM turn.
          round,
        },
      };
    }

    // No destructive calls this round: execute them all inline.
    for (const tc of msg.tool_calls) {
      const call: PendingToolCall = {
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      };
      const execResult = await runToolCall(call, toolCtx, config.a2ax, actions);
      messages.push(toolResultMessage(tc.id, execResult));
    }

    if (choice.finish_reason === "stop") break;
  }

  return summarize(config.name, actions);
}

// ---------------------------------------------------------------------------
// Tool execution helpers
// ---------------------------------------------------------------------------

/** Result of running (or failing to parse) one tool call. */
interface RunToolOutcome {
  /** Text result fed back to the LLM as the tool message content. */
  content: string;
}

/**
 * Parse a pending call's JSON args and execute it, pushing any logged action
 * into `actions`. Malformed JSON is returned as an error string (not thrown),
 * so the LLM can self-correct (D10).
 */
async function runToolCall(
  call: PendingToolCall,
  ctx: ToolExecContext,
  a2ax: A2AXSender,
  actions: ToolResult[],
): Promise<RunToolOutcome> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      content: `Error: tool "${call.name}" arguments were not valid JSON (${errMsg}). Retry the call with properly formatted JSON arguments.`,
    };
  }

  const result = await executeTool({ name: call.name, arguments: args }, ctx, a2ax);
  if (result.action) actions.push(result.action);
  return { content: result.result };
}

function toolResultMessage(toolCallId: string, outcome: RunToolOutcome): Record<string, unknown> {
  return toolMessage(toolCallId, outcome.content);
}

function toolMessage(toolCallId: string, content: string): Record<string, unknown> {
  return { role: "tool", tool_call_id: toolCallId, content };
}

/** Collapse accumulated actions into the tick's return value. */
function summarize(agentName: string, actions: ToolResult[]): AgentRunResult {
  if (actions.length === 0) {
    return { actionType: "noop", payload: { agent: agentName } };
  }
  if (actions.length === 1) {
    return {
      actionType: actions[0].actionType,
      payload: { agent: agentName, ...actions[0].payload },
    };
  }
  return {
    actionType: "multi_action",
    payload: {
      agent: agentName,
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

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

import { validateContract, type ValidationResult } from "./contract";
import { createDefaultRegistry } from "./default-tools";
import type { ToolRegistry } from "./registry";
import type {
  A2AXSender,
  PeerAgent,
  ToolResult,
  ToolRunContext,
} from "./tools";

const FALLBACK_TOOL_NAMES = ["send_message", "broadcast", "report_action"];

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
  /** Safe calls from the same assistant turn, deferred so every call gets a result on resume. */
  deferredSafe?: PendingToolCall[];
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
  /** Recent action history (last N ticks) so the agent has working memory. */
  recentHistory?: string;
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
  /** Abort signal propagated from the tick budget so provider calls can cancel. */
  signal?: AbortSignal;
  /**
   * Classifier: does this tool require human approval before it runs? Defaults
   * to the registry's risk labels.
   */
  isDestructive?: (toolName: string, rawArgs?: unknown) => boolean;
  /**
   * Registry for tool definitions and execution. Defaults to the internal
   * message-passing registry; the app passes the full filesystem/shell/network
   * registry.
   */
  toolRegistry?: Pick<ToolRegistry, "execute" | "getOpenAIDefs" | "isDestructive" | "listForAgent">;
  /** Team goal injected into the tick prompt. All agents work toward it. */
  teamGoal?: string;
  /**
   * JSON Schema contract for this agent's expected output. When present, the
   * runner validates the tick result against it and attaches pass/fail.
   */
  outputContract?: Record<string, unknown>;
  /**
   * Recent validation results (e.g. "pass", "fail: missing severity on bug #2")
   * injected into the tick prompt so the agent can self-correct.
   */
  recentValidations?: string;
  /** Recent app events (errors, warnings) for this team. Injected so the agent is aware of system health. */
  appHealthContext?: string;
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
  /** Present when the agent has an output contract. */
  validation?: ValidationResult;
}

/** Minimal OpenAI-compatible chat client interface */
export interface LLMClient {
  chat: {
    completions: {
      create: (
        params: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) => Promise<LLMResponse>;
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
const defaultRegistry = createDefaultRegistry();

export async function runAgent(config: AgentConfig): Promise<AgentRunResult> {
  const registry = config.toolRegistry ?? defaultRegistry;
  const allowedTools = toolAllowlist(config.tools);
  const toolDefs = registry.getOpenAIDefs(allowedTools);
  const toolDescriptions = registry.listForAgent(allowedTools);
  const isDestructive = config.isDestructive ?? registry.isDestructive;

  const toolCtx: ToolRunContext = {
    teamId: config.teamId,
    agentId: config.agentId,
    agentName: config.name,
    peers: config.peers,
    a2ax: config.a2ax,
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
    startRound = suspension.round + 1;

    const decisionById = new Map(decisions.map((d) => [d.id, d]));
    for (const { call, needsApproval } of orderedResumeCalls(suspension)) {
      if (needsApproval) {
        const decision = decisionById.get(call.id);
        if (decision?.approved) {
          const execResult = await runToolCall(call, toolCtx, actions, registry);
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
      } else {
        const execResult = await runToolCall(call, toolCtx, actions, registry);
        messages.push(toolResultMessage(call.id, execResult));
      }
    }
    // After applying decisions, fall through into the loop for another LLM turn
    // (the model reacts to the approval/rejection results).
  } else {
    messages = [
      { role: "system", content: buildSystemPrompt(config, toolDescriptions) },
      { role: "user", content: buildTickPrompt(config) },
    ];
  }

  // --- Multi-round tool-use loop --------------------------------------------
  for (let round = startRound; round < MAX_TOOL_ROUNDS; round++) {
    const response = await config.llm.chat.completions.create({
      model: config.model || "o4-mini",
      messages,
      tools: toolDefs,
    }, {
      signal: config.signal,
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
    const calls = msg.tool_calls.map(toPendingToolCall);
    const destructive = calls.filter((tc) => isDestructive(tc.name, parseToolArgs(tc.arguments)));
    if (destructive.length > 0) {
      const destructiveIds = new Set(destructive.map((tc) => tc.id));
      return {
        actionType: "suspended",
        payload: {
          agent: config.name,
          pending: destructive.map((tc) => ({
            id: tc.id,
            name: tc.name,
          })),
        },
        suspension: {
          messages,
          pending: destructive,
          deferredSafe: calls.filter((tc) => !destructiveIds.has(tc.id)),
          actions,
          // Resume continues from THIS round: the destructive calls become
          // tool results, then the loop does one more LLM turn.
          round,
        },
      };
    }

    // No destructive calls this round: execute them all inline.
    for (const call of calls) {
      const execResult = await runToolCall(call, toolCtx, actions, registry);
      messages.push(toolResultMessage(call.id, execResult));
    }

    if (choice.finish_reason === "stop") break;
  }

  const result = summarize(config.name, actions);

  if (config.outputContract) {
    result.validation = validateContract(result.payload, config.outputContract);
  }

  return result;
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
  ctx: ToolRunContext,
  actions: ToolResult[],
  registry: Pick<ToolRegistry, "execute">,
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

  const result = await registry.execute(call.name, args, ctx);
  if (result.action) actions.push(result.action);
  return { content: result.result };
}

function toolAllowlist(tools: string[]): string[] {
  return [...new Set([...FALLBACK_TOOL_NAMES, ...tools])];
}

function toPendingToolCall(tc: {
  id: string;
  function: { name: string; arguments: string };
}): PendingToolCall {
  return {
    id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
  };
}

function parseToolArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function orderedResumeCalls(
  suspension: AgentSuspension,
): Array<{ call: PendingToolCall; needsApproval: boolean }> {
  const pendingById = new Map(suspension.pending.map((call) => [call.id, call]));
  const safeById = new Map((suspension.deferredSafe ?? []).map((call) => [call.id, call]));
  const ordered: Array<{ call: PendingToolCall; needsApproval: boolean }> = [];
  const seen = new Set<string>();

  const assistant = [...suspension.messages]
    .reverse()
    .find((msg) => Array.isArray(msg.tool_calls));
  const toolCalls = (assistant?.tool_calls ?? []) as Array<{ id: string }>;

  for (const tc of toolCalls) {
    const pending = pendingById.get(tc.id);
    if (pending) {
      ordered.push({ call: pending, needsApproval: true });
      seen.add(tc.id);
      continue;
    }
    const safe = safeById.get(tc.id);
    if (safe) {
      ordered.push({ call: safe, needsApproval: false });
      seen.add(tc.id);
    }
  }

  for (const call of suspension.pending) {
    if (!seen.has(call.id)) ordered.push({ call, needsApproval: true });
  }
  for (const call of suspension.deferredSafe ?? []) {
    if (!seen.has(call.id)) ordered.push({ call, needsApproval: false });
  }

  return ordered;
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

// Agents with any of these tools get the engineering context injected.
// No hardcoded archetype list: if you have code tools, you get code guidance.
const ENGINEERING_TOOLS = new Set([
  "read_file", "write_file", "run_command", "coding_task",
]);

const ENGINEERING_CONTEXT = `
You have access to a project codebase via your tools. Guidelines:
- Use read_file to understand code before modifying it.
- Use run_command with git status/diff/log to understand repo state.
- For complex, multi-step work (implement a feature, investigate a bug, run and fix tests), use coding_task to delegate to the Codex agent. Write a clear, specific task prompt.
- For simple, single-file changes, use write_file directly.
- Destructive actions (write_file, coding_task, git commit/push, etc.) require human approval. You will be paused and the human will approve or reject.
- Be surgical: small, focused changes. Don't rewrite files unnecessarily.
- Report your findings and actions clearly so the team can follow your work.
- Browse .simple-harmonic/skills/ for custom API tools and .simple-harmonic/connectors/ for configured credentials.`;

function buildSystemPrompt(config: AgentConfig, tools: Array<{ name: string; description: string }>): string {
  const peerList = config.peers.map((p) => `- ${p.name} (${p.role})`).join("\n");
  const toolList = tools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");

  const isEngineering = config.tools.some((t) => ENGINEERING_TOOLS.has(t));

  return `${config.initialPrompt}

You are "${config.name}", a ${config.archetype} agent in a team.

Your peers:
${peerList || "No other agents in this team."}

You have these tools available:
${toolList || "- No tools are currently enabled for this agent."}
${isEngineering ? ENGINEERING_CONTEXT : ""}
Coordinate with your peers when it makes sense. Share relevant findings, ask for help, delegate when appropriate. Be concise in messages.

Improvement levels (how to respond to issues you discover):
- agent: your own errors, prompt issues, scheduling problems. Fix these yourself.
- team: team composition, missing agents, coordination gaps. Report to your lead or broadcast to the team.
- tool: a tool is broken, missing a capability, or misconfigured. Report it clearly via broadcast, then work around it. Do not attempt to fix tool code.
- infra: platform, database, deploy, or framework issues. You will never see infra events. If you suspect an infra problem (e.g. all tools timing out, DB unreachable), broadcast a description to the team. The founder handles infra.

When reporting issues, be specific: what broke, what you tried, what the error said. Vague reports waste everyone's time.`;
}

function buildTickPrompt(config: AgentConfig): string {
  let prompt = "A new tick has fired. Do your job based on your role and system prompt.";

  if (config.teamGoal) {
    prompt += `\n\n## Team goal:\n${config.teamGoal}\nAlign your work toward this objective.`;
  }

  if (config.recentHistory) {
    prompt += `\n\n## Your recent actions (for continuity, don't repeat work already done):\n${config.recentHistory}`;
  }

  if (config.recentValidations) {
    prompt += `\n\n## Recent output validation results:\n${config.recentValidations}`;
    prompt += "\nFix any failing validations. Your output must match the expected contract.";
  }

  if (config.outputContract) {
    prompt += `\n\n## Output contract (your deliverable must match this structure):\n${JSON.stringify(config.outputContract, null, 2)}`;
    prompt += "\nUse report_action with a payload matching this schema.";
  }

  if (config.a2axContext) {
    prompt += `\n\n${config.a2axContext}`;
    prompt += "\n\nRespond to any messages that need a reply, then do your regular work.";
  } else {
    prompt += "\n\nNo new messages from other agents.";
  }

  if (config.appHealthContext) {
    prompt += `\n\n## Recent app events (errors and warnings in this system):\n${config.appHealthContext}`;
    prompt += `\nRespond based on the event level:
- [agent] errors in your area: investigate and fix.
- [team] coordination issues: discuss with peers or escalate to lead.
- [tool] tool failures: acknowledge, work around, do not attempt to fix the tool itself.
- "Platform status: DEGRADED/MAINTENANCE": reduce non-essential work, do not retry failed operations.
- "N known tool issue(s) (under review)": the founder is aware. Do not investigate further.
Use observe_app with a level filter to dig deeper into specific categories.`;
  }

  return prompt;
}

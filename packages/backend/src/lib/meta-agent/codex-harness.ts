// ---------------------------------------------------------------------------
// Codex app-server harness — "engine mode" agent execution.
//
// In this mode Codex owns the agent loop (model rounds, reasoning, context)
// and Simple Harmonic owns the hands: every SH tool is registered as a
// dynamic tool on the codex thread, and when the model picks one, codex
// sends an `item/tool/call` request back and BLOCKS until we execute it via
// the tool registry and reply. Contrast with runner.ts, where SH owns the
// loop and codex (via codex-adapter) is just text-in/text-out per round.
//
// The approval gate moves from the loop into the hands:
//   - safe tool call      → execute inline, reply with the result
//   - destructive call    → reply "pausing for human approval", interrupt the
//                           turn, and return a CodexThreadSuspension holding
//                           only { threadId, pending } — codex persists the
//                           conversation itself (threads are resumable).
//   - on resume           → thread/resume, execute approved calls with our
//                           own hands, then start a new turn whose input
//                           reports each decision and outcome to the model.
//
// Calls arrive one at a time (codex blocks per call), so the runner's
// batch-suspension / deferredSafe machinery has no equivalent here.
//
// Token usage arrives via thread/tokenUsage/updated notifications — summing
// each notification's `last` block equals the turn's true API usage, which
// finally gives codex-subscription ticks a real spend ledger entry.
// ---------------------------------------------------------------------------

import {
  type CodexAppServerClient,
  defaultServerRequestResult,
  ensureIsolatedCodexHome,
  spawnCodexAppServer,
} from "./codex-app-server";
import { validateContract } from "./contract";
import { createDefaultRegistry } from "./default-tools";
import type { ToolRegistry } from "./registry";
import {
  type AgentPromptConfig,
  buildSystemPrompt,
  buildTickPrompt,
  type PendingToolCall,
  summarize,
  type ToolDecision,
  toolAllowlist,
} from "./runner";
import type { ValidationResult } from "./contract";
import type { A2AXSender, PeerAgent, ToolResult, ToolRunContext } from "./tools";
import type { TraceEventType, TraceSink } from "./trace";

/** Hard backstop so a wedged turn can't outlive a forgotten abort signal. */
const TURN_HARD_CAP_MS = 600_000;

/**
 * Suspension for a parked codex-thread tick. Unlike the runner's
 * AgentSuspension there is no message transcript here: codex persists the
 * conversation in its thread; we only need the handle and the pending call.
 * The `kind` discriminator is how the tick route tells the two shapes apart.
 */
export interface CodexThreadSuspension {
  kind: "codex-thread";
  threadId: string;
  /** Destructive calls awaiting a human decision (one per pause in practice). */
  pending: PendingToolCall[];
  /** Actions already logged this tick before the pause. */
  actions: ToolResult[];
}

export interface CodexHarnessResult {
  actionType: string;
  payload: Record<string, unknown>;
  suspension?: CodexThreadSuspension;
  validation?: ValidationResult;
  /** Real token usage summed from thread/tokenUsage/updated notifications. */
  usage: { inputTokens: number; outputTokens: number };
}

export interface CodexHarnessConfig extends AgentPromptConfig {
  teamId: string;
  agentId: string;
  peers: PeerAgent[];
  a2ax: A2AXSender;
  model?: string;
  /** Working directory codex's (read-only) native tools see. */
  cwd?: string;
  signal?: AbortSignal;
  isDestructive?: (toolName: string, rawArgs?: unknown) => boolean;
  toolRegistry?: Pick<ToolRegistry, "execute" | "getOpenAIDefs" | "isDestructive" | "listForAgent">;
  trace?: TraceSink;
  resume?: { suspension: CodexThreadSuspension; decisions: ToolDecision[] };
  /** Injected app-server client (tests). Defaults to the shared spawned one. */
  client?: CodexAppServerClient;
}

// ---------------------------------------------------------------------------
// Shared app-server client (one subprocess per Node process)
// ---------------------------------------------------------------------------

let sharedClient: CodexAppServerClient | null = null;
let sharedClientStarting: Promise<CodexAppServerClient> | null = null;

export async function getSharedCodexClient(): Promise<CodexAppServerClient> {
  if (sharedClient && !sharedClient.isClosed) return sharedClient;
  if (sharedClientStarting) return sharedClientStarting;
  sharedClientStarting = (async () => {
    const home = ensureIsolatedCodexHome(`${process.cwd()}/.simple-harmonic`);
    const client = spawnCodexAppServer({ codexHome: home });
    await client.initialize({
      name: "simple-harmonic",
      title: "Simple Harmonic",
      version: "0.1.0",
    });
    sharedClient = client;
    return client;
  })().finally(() => {
    sharedClientStarting = null;
  });
  return sharedClientStarting;
}

/** Test hook. */
export function resetSharedCodexClientForTests(): void {
  sharedClient?.close();
  sharedClient = null;
  sharedClientStarting = null;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const defaultRegistry = createDefaultRegistry();

export async function runCodexAgentTick(config: CodexHarnessConfig): Promise<CodexHarnessResult> {
  const registry = config.toolRegistry ?? defaultRegistry;
  const allowedTools = toolAllowlist(config.tools);
  const toolDefs = registry.getOpenAIDefs(allowedTools);
  const toolDescriptions = registry.listForAgent(allowedTools);
  const isDestructive = config.isDestructive ?? registry.isDestructive;
  const client = config.client ?? (await getSharedCodexClient());

  const toolCtx: ToolRunContext = {
    teamId: config.teamId,
    agentId: config.agentId,
    agentName: config.name,
    peers: config.peers,
    a2ax: config.a2ax,
  };

  const tickStartedAt = Date.now();
  const actions: ToolResult[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };

  const emit = (type: TraceEventType, data: Record<string, unknown>) => {
    try {
      config.trace?.({ type, data });
    } catch {
      // a buggy sink must never break a tick
    }
  };

  emit("tick_started", {
    mode: config.resume ? "resume" : "fresh",
    round: 0,
    runtime: "codex-app-server",
  });

  // --- Establish the thread ------------------------------------------------
  let threadId: string;
  let turnInput: string;

  if (config.resume) {
    const { suspension, decisions } = config.resume;
    threadId = suspension.threadId;
    actions.push(...suspension.actions);

    await client.request("thread/resume", {
      threadId,
      model: config.model ?? "gpt-5.5",
      cwd: config.cwd ?? process.cwd(),
      sandbox: "read-only",
      approvalPolicy: "never",
    });

    // Apply the human decisions with OUR hands, then report outcomes to the
    // model in the resumed turn's input.
    const decisionById = new Map(decisions.map((d) => [d.id, d]));
    const outcomes: string[] = [];
    for (const call of suspension.pending) {
      const decision = decisionById.get(call.id);
      const approved = decision?.approved ?? false;
      emit("decision_applied", {
        toolCallId: call.id,
        tool: call.name,
        approved,
        ...(decision?.note ? { note: decision.note } : {}),
      });
      if (approved) {
        const outcome = await executeToolTraced(call.name, parseArgs(call.arguments), call.id, {
          registry,
          toolCtx,
          actions,
          emit,
        });
        // Don't editorialize success: relay the tool's own result verbatim so
        // a failed-but-approved call can't prime the model to claim success.
        outcomes.push(`- ${call.name}: APPROVED. Tool result: ${outcome}`);
      } else {
        const note = decision?.note ?? "The user rejected this action.";
        outcomes.push(`- ${call.name}: REJECTED — ${note} Do not retry it.`);
      }
    }
    turnInput =
      `[Approval outcomes]\n${outcomes.join("\n")}\n\n` +
      "Continue your work based on these outcomes. If any of your tools are " +
      "unavailable after this resume, summarize what happened and finish.";
  } else {
    const started = await client.request("thread/start", {
      model: config.model ?? "gpt-5.5",
      cwd: config.cwd ?? process.cwd(),
      // Threads must persist so an approval pause can resume later (possibly
      // from a different Node process).
      ephemeral: false,
      // Codex-native tools stay read-only and approval-free: every mutation
      // flows through OUR dynamic tools, where the SH approval gate lives.
      sandbox: "read-only",
      approvalPolicy: "never",
      developerInstructions: buildSystemPrompt(config, toolDescriptions),
      dynamicTools: toolDefs.map((def) => ({
        name: def.function.name,
        description: def.function.description ?? "",
        inputSchema: def.function.parameters ?? { type: "object", properties: {} },
      })),
    });
    const thread = started.thread as { id?: string } | undefined;
    const id = thread?.id ?? (started.threadId as string | undefined);
    if (!id) throw new Error("codex app-server thread/start returned no thread id");
    threadId = id;
    turnInput = buildTickPrompt(config);
  }

  // --- Run one turn, pumping events until completion or park ----------------
  const outcome = await runTurn({
    client,
    threadId,
    input: turnInput,
    model: config.model ?? "gpt-5.5",
    signal: config.signal,
    emit,
    usage,
    handleToolCall: async (call) => {
      const args = call.arguments;
      if (isDestructive(call.tool, args)) {
        return { park: { id: call.callId, name: call.tool, arguments: JSON.stringify(args ?? {}) } };
      }
      const resultText = await executeToolTraced(call.tool, args, call.callId, {
        registry,
        toolCtx,
        actions,
        emit,
      });
      return { resultText };
    },
  });

  if (outcome.parked) {
    emit("approval_requested", {
      round: 0,
      pending: [
        {
          toolCallId: outcome.parked.id,
          tool: outcome.parked.name,
          args: parseArgs(outcome.parked.arguments),
        },
      ],
      deferredSafeCount: 0,
    });
    return {
      actionType: "suspended",
      payload: {
        agent: config.name,
        pending: [{ id: outcome.parked.id, name: outcome.parked.name }],
      },
      suspension: {
        kind: "codex-thread",
        threadId,
        pending: [outcome.parked],
        actions,
      },
      usage,
    };
  }

  if (outcome.error) {
    throw new Error(`codex turn failed: ${outcome.error}`);
  }

  // Text-only turn with no actions mirrors the runner's agent_thought shape.
  const summary = summarize(config.name, actions);
  const result: CodexHarnessResult =
    actions.length === 0
      ? {
          actionType: "agent_thought",
          payload: { agent: config.name, thought: outcome.finalText || "no output" },
          usage,
        }
      : { actionType: summary.actionType, payload: summary.payload, usage };

  if (config.outputContract) {
    result.validation = validateContract(result.payload, config.outputContract);
  }

  emit("tick_finished", {
    actionType: result.actionType,
    actionCount: actions.length,
    durationMs: Date.now() - tickStartedAt,
    ...(result.validation
      ? { validation: { valid: result.validation.valid, issues: result.validation.issues } }
      : {}),
  });
  return result;
}

// ---------------------------------------------------------------------------
// Turn pump
// ---------------------------------------------------------------------------

interface IncomingToolCall {
  callId: string;
  tool: string;
  arguments: unknown;
}

interface TurnOutcome {
  status: string;
  finalText: string;
  parked?: PendingToolCall;
  error?: string;
}

async function runTurn(args: {
  client: CodexAppServerClient;
  threadId: string;
  input: string;
  model: string;
  signal?: AbortSignal;
  emit: (type: TraceEventType, data: Record<string, unknown>) => void;
  usage: { inputTokens: number; outputTokens: number };
  handleToolCall: (
    call: IncomingToolCall,
  ) => Promise<{ resultText: string } | { park: PendingToolCall }>;
}): Promise<TurnOutcome> {
  const { client, threadId, input, signal, emit, usage } = args;

  let turnId: string | undefined;
  let parked: PendingToolCall | undefined;
  let finalText = "";
  let turnError: string | undefined;
  let settled = false;

  const interrupt = () => {
    if (!turnId) return;
    client
      .request("turn/interrupt", { threadId, turnId }, { timeoutMs: 10_000 })
      .catch(() => {});
  };

  return await new Promise<TurnOutcome>((resolve, reject) => {
    const finish = (outcome: TurnOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const hardCap = setTimeout(() => {
      interrupt();
      fail(new Error(`codex turn exceeded the ${TURN_HARD_CAP_MS}ms hard cap`));
    }, TURN_HARD_CAP_MS);

    const onAbort = () => {
      interrupt();
      fail(
        signal?.reason instanceof Error ? signal.reason : new Error("codex turn aborted"),
      );
    };

    const cleanup = () => {
      clearTimeout(hardCap);
      signal?.removeEventListener("abort", onAbort);
      client.unregisterThread(threadId);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    client.registerThread(threadId, {
      onRequest: async (method, params) => {
        if (method !== "item/tool/call") {
          // Native-tool approvals/elicitations should not occur in a
          // read-only, approval-free thread; decline anything that does.
          return defaultServerRequestResult(method);
        }
        const call: IncomingToolCall = {
          callId: String(params.callId ?? ""),
          tool: String(params.tool ?? ""),
          arguments: params.arguments,
        };
        const handled = await args.handleToolCall(call);
        if ("park" in handled) {
          parked = handled.park;
          // Reply first so codex never hangs on the call, then interrupt the
          // turn (macrotask, so the response hits the wire before the
          // interrupt request).
          setTimeout(interrupt, 0);
          return {
            success: false,
            contentItems: [
              {
                type: "inputText",
                text:
                  "This action requires human approval. The turn is pausing now; " +
                  "you will receive the decision when the conversation resumes. " +
                  "Do not retry the action.",
              },
            ],
          };
        }
        return {
          success: true,
          contentItems: [{ type: "inputText", text: handled.resultText }],
        };
      },
      onNotification: (method, params) => {
        if (method === "thread/tokenUsage/updated") {
          const last = (params.tokenUsage as { last?: Record<string, number> } | undefined)?.last;
          if (last) {
            usage.inputTokens += last.inputTokens ?? 0;
            usage.outputTokens += last.outputTokens ?? 0;
          }
          return;
        }
        if (method === "item/completed") {
          const item = params.item as Record<string, unknown> | undefined;
          if (!item) return;
          if (item.type === "agentMessage" && typeof item.text === "string" && item.text) {
            finalText = item.text;
            emit("llm_response", { round: 0, thought: item.text, toolCalls: [], finishReason: "stop" });
          }
          if (item.type === "reasoning") {
            const summaryBlocks = (item.summary as Array<{ text?: string }> | undefined) ?? [];
            const text = summaryBlocks.map((b) => b.text ?? "").join("\n").trim();
            if (text) emit("llm_response", { round: 0, thought: text, toolCalls: [], finishReason: "reasoning" });
          }
          return;
        }
        if (method === "error") {
          turnError = String((params as { message?: unknown }).message ?? "unknown codex error");
          return;
        }
        if (method === "turn/completed") {
          const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined;
          const status = turn?.status ?? "unknown";
          if (turn?.error?.message) turnError = turn.error.message;
          if (parked) {
            finish({ status, finalText, parked });
          } else if (status === "completed") {
            finish({ status, finalText, error: turnError });
          } else {
            finish({
              status,
              finalText,
              error: turnError ?? (status === "interrupted" ? "turn interrupted" : `turn ${status}`),
            });
          }
        }
      },
    });

    emit("llm_request", { round: 0, model: args.model, runtime: "codex-app-server" });
    client
      .request("turn/start", {
        threadId,
        input: [{ type: "text", text: input, text_elements: [] }],
      })
      .then((res) => {
        const turn = res.turn as { id?: string } | undefined;
        turnId = turn?.id;
      })
      .catch(fail);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function executeToolTraced(
  tool: string,
  toolArgs: unknown,
  callId: string,
  deps: {
    registry: Pick<ToolRegistry, "execute">;
    toolCtx: ToolRunContext;
    actions: ToolResult[];
    emit: (type: TraceEventType, data: Record<string, unknown>) => void;
  },
): Promise<string> {
  deps.emit("tool_started", { round: 0, toolCallId: callId, tool, args: toolArgs ?? {} });
  const startedAt = Date.now();
  try {
    const result = await deps.registry.execute(
      tool,
      (toolArgs ?? {}) as Record<string, unknown>,
      deps.toolCtx,
    );
    if (result.action) deps.actions.push(result.action);
    deps.emit("tool_finished", {
      round: 0,
      toolCallId: callId,
      tool,
      result: result.result,
      durationMs: Date.now() - startedAt,
    });
    return result.result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.emit("tool_finished", {
      round: 0,
      toolCallId: callId,
      tool,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    return `Error: tool "${tool}" failed: ${message}`;
  }
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Discriminate the two suspension shapes parked in agents.conversationState. */
export function isCodexThreadSuspension(value: unknown): value is CodexThreadSuspension {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "codex-thread" &&
    typeof (value as { threadId?: unknown }).threadId === "string"
  );
}

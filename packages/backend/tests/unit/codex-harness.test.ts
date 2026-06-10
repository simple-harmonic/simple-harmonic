import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient, ThreadHandlers } from "@/lib/meta-agent/codex-app-server";
import {
  type CodexHarnessConfig,
  type CodexThreadSuspension,
  isCodexThreadSuspension,
  runCodexAgentTick,
} from "@/lib/meta-agent/codex-harness";
import type { TraceStep } from "@/lib/meta-agent/trace";

// ---------------------------------------------------------------------------
// Fake app-server client
//
// Scripts a turn: after turn/start it feeds the harness a sequence of
// item/tool/call requests (awaiting each response), then notifications,
// then turn/completed. Captures everything the harness sends.
// ---------------------------------------------------------------------------

interface ScriptedToolCall {
  callId: string;
  tool: string;
  arguments: unknown;
}

function makeFakeClient(script: {
  threadId?: string;
  toolCalls?: ScriptedToolCall[];
  finalMessage?: string;
  tokenUsages?: Array<{ inputTokens: number; outputTokens: number }>;
  completeStatus?: string;
  /** When true, the fake never completes the turn on its own (abort tests). */
  hang?: boolean;
}) {
  const threadId = script.threadId ?? "thr_1";
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const toolResponses: Array<Record<string, unknown>> = [];
  let handlers: ThreadHandlers | undefined;
  let interrupted = false;
  let unregistered = false;

  const notify = (method: string, params: Record<string, unknown>) => {
    handlers?.onNotification?.(method, { threadId, ...params });
  };

  const driveTurn = async () => {
    for (const tc of script.toolCalls ?? []) {
      const response = await handlers?.onRequest?.("item/tool/call", {
        threadId,
        turnId: "turn_1",
        callId: tc.callId,
        tool: tc.tool,
        arguments: tc.arguments,
      });
      toolResponses.push(response as Record<string, unknown>);
      if (interrupted) break;
    }
    // Real codex keeps the turn open after a tool response; yield a macrotask
    // so the harness's post-response interrupt (park path) can land first.
    await new Promise((r) => setTimeout(r, 10));
    for (const u of script.tokenUsages ?? []) {
      notify("thread/tokenUsage/updated", { tokenUsage: { last: u, total: u } });
    }
    if (script.finalMessage !== undefined && !interrupted) {
      notify("item/completed", {
        item: { type: "agentMessage", text: script.finalMessage },
      });
    }
    if (!script.hang) {
      notify("turn/completed", {
        turn: {
          id: "turn_1",
          status: interrupted ? "interrupted" : (script.completeStatus ?? "completed"),
          error: null,
        },
      });
    }
  };

  const fake = {
    isClosed: false,
    registerThread: (id: string, h: ThreadHandlers) => {
      expect(id).toBe(threadId);
      handlers = h;
    },
    unregisterThread: () => {
      unregistered = true;
    },
    notify: vi.fn(),
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "thread/start" || method === "thread/resume") {
        return { thread: { id: threadId } };
      }
      if (method === "turn/start") {
        setTimeout(() => void driveTurn(), 0);
        return { turn: { id: "turn_1", status: "inProgress" } };
      }
      if (method === "turn/interrupt") {
        interrupted = true;
        setTimeout(
          () =>
            notify("turn/completed", {
              turn: { id: "turn_1", status: "interrupted", error: null },
            }),
          0,
        );
        return {};
      }
      return {};
    }),
  };

  return {
    client: fake as unknown as CodexAppServerClient,
    calls,
    toolResponses,
    wasUnregistered: () => unregistered,
    byMethod: (m: string) => calls.filter((c) => c.method === m),
  };
}

function makeRegistry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    execute: vi.fn().mockResolvedValue({
      toolName: "report_action",
      success: true,
      result: "Action logged: scan",
      action: { actionType: "scan", payload: { summary: "scanned" } },
    }),
    getOpenAIDefs: vi.fn().mockReturnValue([
      {
        type: "function",
        function: {
          name: "report_action",
          description: "Log an action",
          parameters: { type: "object", properties: {} },
        },
      },
    ]),
    listForAgent: vi.fn().mockReturnValue([{ name: "report_action", description: "Log an action" }]),
    isDestructive: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

function makeConfig(
  client: CodexAppServerClient,
  overrides: Partial<CodexHarnessConfig> = {},
): CodexHarnessConfig {
  return {
    name: "Scout",
    archetype: "researcher",
    tools: ["report_action"],
    initialPrompt: "You research things.",
    teamId: "team-1",
    agentId: "agent-1",
    peers: [],
    a2ax: {
      sendDirect: vi.fn().mockResolvedValue(undefined),
      broadcast: vi.fn().mockResolvedValue(undefined),
    },
    toolRegistry: makeRegistry() as never,
    client,
    ...overrides,
  };
}

function collect(): { steps: TraceStep[]; trace: (s: TraceStep) => void } {
  const steps: TraceStep[] = [];
  return { steps, trace: (s) => steps.push(s) };
}

// ---------------------------------------------------------------------------

describe("runCodexAgentTick", () => {
  it("registers tools as dynamicTools and executes safe tool calls via the registry", async () => {
    const fake = makeFakeClient({
      toolCalls: [{ callId: "c1", tool: "report_action", arguments: { summary: "hi" } }],
      finalMessage: "Done.",
      tokenUsages: [
        { inputTokens: 100, outputTokens: 10 },
        { inputTokens: 120, outputTokens: 5 },
      ],
    });
    const registry = makeRegistry();
    const { steps, trace } = collect();
    const config = makeConfig(fake.client, { toolRegistry: registry as never, trace });

    const result = await runCodexAgentTick(config);

    // thread/start carried our tool as a dynamic tool, in engine-safe mode.
    const start = fake.byMethod("thread/start")[0];
    expect(start.params.sandbox).toBe("read-only");
    expect(start.params.approvalPolicy).toBe("never");
    expect(start.params.ephemeral).toBe(false);
    expect(start.params.dynamicTools).toEqual([
      expect.objectContaining({ name: "report_action", inputSchema: expect.any(Object) }),
    ]);
    expect(String(start.params.developerInstructions)).toContain("You research things.");

    // The registry executed the called tool and the result went back to codex.
    expect(registry.execute).toHaveBeenCalledWith(
      "report_action",
      { summary: "hi" },
      expect.objectContaining({ agentId: "agent-1" }),
    );
    expect(fake.toolResponses[0]).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "Action logged: scan" }],
    });

    expect(result.actionType).toBe("scan");
    expect(result.usage).toEqual({ inputTokens: 220, outputTokens: 15 });

    expect(steps.map((s) => s.type)).toEqual([
      "tick_started",
      "llm_request",
      "tool_started",
      "tool_finished",
      "llm_response",
      "tick_finished",
    ]);
  });

  it("parks on a destructive call: declines to codex, interrupts, returns a codex-thread suspension", async () => {
    const fake = makeFakeClient({
      toolCalls: [{ callId: "c9", tool: "write_file", arguments: { path: "x", content: "y" } }],
    });
    const registry = makeRegistry({ isDestructive: vi.fn((t: string) => t === "write_file") });
    const { steps, trace } = collect();
    const config = makeConfig(fake.client, { toolRegistry: registry as never, trace });

    const result = await runCodexAgentTick(config);

    expect(result.actionType).toBe("suspended");
    expect(result.suspension).toBeDefined();
    expect(isCodexThreadSuspension(result.suspension)).toBe(true);
    expect(result.suspension?.threadId).toBe("thr_1");
    expect(result.suspension?.pending).toEqual([
      { id: "c9", name: "write_file", arguments: JSON.stringify({ path: "x", content: "y" }) },
    ]);

    // The tool was never executed; codex got a pause message; the turn was interrupted.
    expect(registry.execute).not.toHaveBeenCalled();
    expect(fake.toolResponses[0].success).toBe(false);
    expect(JSON.stringify(fake.toolResponses[0])).toContain("requires human approval");
    expect(fake.byMethod("turn/interrupt")).toHaveLength(1);

    expect(steps.map((s) => s.type)).toContain("approval_requested");
    expect(steps.map((s) => s.type)).not.toContain("tick_finished");
  });

  it("resume executes approved calls with our hands and reports outcomes in the turn input", async () => {
    const fake = makeFakeClient({ threadId: "thr_9", finalMessage: "Continuing." });
    const registry = makeRegistry();
    const { steps, trace } = collect();
    const suspension: CodexThreadSuspension = {
      kind: "codex-thread",
      threadId: "thr_9",
      pending: [{ id: "c9", name: "write_file", arguments: JSON.stringify({ path: "x" }) }],
      actions: [],
    };
    const config = makeConfig(fake.client, {
      toolRegistry: registry as never,
      trace,
      resume: { suspension, decisions: [{ id: "c9", approved: true }] },
    });

    const result = await runCodexAgentTick(config);

    expect(fake.byMethod("thread/resume")[0].params.threadId).toBe("thr_9");
    expect(fake.byMethod("thread/start")).toHaveLength(0);
    // Approved call executed by the harness itself, before the resumed turn.
    expect(registry.execute).toHaveBeenCalledWith(
      "write_file",
      { path: "x" },
      expect.anything(),
    );
    const input = String(
      (fake.byMethod("turn/start")[0].params.input as Array<{ text: string }>)[0].text,
    );
    expect(input).toContain("APPROVED. Tool result:");
    expect(steps.map((s) => s.type)).toContain("decision_applied");
    // The executed approval produced the tick's action.
    expect(result.actionType).toBe("scan");
  });

  it("resume with a rejection never executes the tool and tells the model why", async () => {
    const fake = makeFakeClient({ threadId: "thr_9", finalMessage: "Understood." });
    const registry = makeRegistry();
    const suspension: CodexThreadSuspension = {
      kind: "codex-thread",
      threadId: "thr_9",
      pending: [{ id: "c9", name: "write_file", arguments: "{}" }],
      actions: [],
    };
    const config = makeConfig(fake.client, {
      toolRegistry: registry as never,
      resume: {
        suspension,
        decisions: [{ id: "c9", approved: false, note: "too risky" }],
      },
    });

    const result = await runCodexAgentTick(config);

    expect(registry.execute).not.toHaveBeenCalled();
    const input = String(
      (fake.byMethod("turn/start")[0].params.input as Array<{ text: string }>)[0].text,
    );
    expect(input).toContain("REJECTED — too risky");
    expect(result.actionType).toBe("agent_thought");
    expect(result.payload.thought).toBe("Understood.");
  });

  it("returns agent_thought for a text-only turn", async () => {
    const fake = makeFakeClient({ finalMessage: "Nothing to do." });
    const config = makeConfig(fake.client);

    const result = await runCodexAgentTick(config);

    expect(result.actionType).toBe("agent_thought");
    expect(result.payload.thought).toBe("Nothing to do.");
  });

  it("throws when the turn fails", async () => {
    const fake = makeFakeClient({ completeStatus: "failed" });
    const config = makeConfig(fake.client);

    await expect(runCodexAgentTick(config)).rejects.toThrow(/codex turn failed/);
    expect(fake.wasUnregistered()).toBe(true);
  });

  it("interrupts the turn and rejects when the abort signal fires", async () => {
    const fake = makeFakeClient({ hang: true });
    const controller = new AbortController();
    const config = makeConfig(fake.client, { signal: controller.signal });

    const p = runCodexAgentTick(config);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort(new Error("tick budget exceeded"));

    await expect(p).rejects.toThrow(/tick budget exceeded/);
    expect(fake.byMethod("turn/interrupt").length).toBeGreaterThanOrEqual(1);
    expect(fake.wasUnregistered()).toBe(true);
  });

  it("validates the output contract when configured", async () => {
    const fake = makeFakeClient({
      toolCalls: [{ callId: "c1", tool: "report_action", arguments: {} }],
      finalMessage: "Done.",
    });
    const config = makeConfig(fake.client, {
      outputContract: {
        type: "object",
        properties: { missing: { type: "string" } },
        required: ["missing"],
      },
    });

    const result = await runCodexAgentTick(config);
    expect(result.validation).toBeDefined();
    expect(result.validation?.valid).toBe(false);
  });
});

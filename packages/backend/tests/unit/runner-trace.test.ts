import { describe, expect, it, vi } from "vitest";
import type { AgentConfig, AgentSuspension, LLMClient } from "@/lib/meta-agent/runner";
import { runAgent } from "@/lib/meta-agent/runner";
import type { TraceStep } from "@/lib/meta-agent/trace";

// ---------------------------------------------------------------------------
// Helpers (mirrors runner.test.ts)
// ---------------------------------------------------------------------------

function makeLLM(responses: Array<{
  content: string | null;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  finish_reason?: string;
}>): LLMClient {
  let callIndex = 0;
  return {
    chat: {
      completions: {
        create: vi.fn().mockImplementation(async () => {
          const res = responses[callIndex] ?? responses[responses.length - 1];
          callIndex++;
          return {
            choices: [{
              message: {
                content: res.content,
                tool_calls: res.tool_calls,
              },
              finish_reason: res.finish_reason ?? (res.tool_calls ? "tool_calls" : "stop"),
            }],
          };
        }),
      },
    },
  };
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    archetype: "ops-monitor",
    tools: ["send_message", "broadcast", "report_action"],
    initialPrompt: "You are a test agent.",
    teamId: "team-1",
    agentId: "agent-1",
    peers: [{ id: "agent-2", name: "content-scheduler", role: "Manages content" }],
    a2ax: {
      sendDirect: vi.fn().mockResolvedValue(undefined),
      broadcast: vi.fn().mockResolvedValue(undefined),
    },
    llm: makeLLM([{ content: "thinking...", tool_calls: undefined }]),
    ...overrides,
  };
}

function collect(): { steps: TraceStep[]; trace: (s: TraceStep) => void } {
  const steps: TraceStep[] = [];
  return { steps, trace: (s) => steps.push(s) };
}

function types(steps: TraceStep[]): string[] {
  return steps.map((s) => s.type);
}

// ---------------------------------------------------------------------------
// Trace emission
// ---------------------------------------------------------------------------

describe("runAgent play-by-play trace", () => {
  it("emits the full step sequence for a thought-only tick", async () => {
    const { steps, trace } = collect();
    const config = makeConfig({
      llm: makeLLM([{ content: "Nothing to do." }]),
      trace,
    });

    await runAgent(config);

    expect(types(steps)).toEqual([
      "tick_started",
      "llm_request",
      "llm_response",
      "tick_finished",
    ]);
    expect(steps[0].data.mode).toBe("fresh");
    expect(steps[1].data.model).toBe("o4-mini");
    expect(steps[1].data.round).toBe(0);
    expect(steps[2].data.thought).toBe("Nothing to do.");
    expect(steps[2].data.durationMs).toEqual(expect.any(Number));
    expect(steps[3].data.actionType).toBe("agent_thought");
    expect(steps[3].data.actionCount).toBe(0);
  });

  it("emits tool_started/tool_finished around every tool call", async () => {
    const { steps, trace } = collect();
    const config = makeConfig({
      trace,
      llm: makeLLM([
        {
          content: null,
          tool_calls: [{
            id: "call_1",
            function: {
              name: "report_action",
              arguments: JSON.stringify({ action_type: "check", summary: "all good" }),
            },
          }],
          finish_reason: "tool_calls",
        },
        { content: "Done.", finish_reason: "stop" },
      ]),
    });

    const result = await runAgent(config);
    expect(result.actionType).toBe("check");

    expect(types(steps)).toEqual([
      "tick_started",
      "llm_request",
      "llm_response",
      "tool_started",
      "tool_finished",
      "llm_request",
      "llm_response",
      "tick_finished",
    ]);

    const started = steps[3].data;
    expect(started.tool).toBe("report_action");
    expect(started.toolCallId).toBe("call_1");
    expect(started.args).toEqual({ action_type: "check", summary: "all good" });

    const finished = steps[4].data;
    expect(finished.tool).toBe("report_action");
    expect(typeof finished.result).toBe("string");
    expect(finished.durationMs).toEqual(expect.any(Number));

    // The LLM decision step lists the tool calls it chose.
    expect(steps[2].data.toolCalls).toEqual([{ toolCallId: "call_1", tool: "report_action" }]);

    expect(steps[7].data.actionType).toBe("check");
    expect(steps[7].data.actionCount).toBe(1);
  });

  it("records the parse error as the tool_finished result for malformed args", async () => {
    const { steps, trace } = collect();
    const config = makeConfig({
      trace,
      llm: makeLLM([
        {
          content: null,
          tool_calls: [{
            id: "call_bad",
            function: { name: "broadcast", arguments: "{not valid json" },
          }],
          finish_reason: "tool_calls",
        },
        { content: "Oh well.", finish_reason: "stop" },
      ]),
    });

    await runAgent(config);

    const finished = steps.find((s) => s.type === "tool_finished");
    expect(finished).toBeDefined();
    expect(String(finished?.data.result)).toMatch(/not valid JSON/i);
  });

  it("emits approval_requested (and no tick_finished) when a tick suspends", async () => {
    const { steps, trace } = collect();
    const config = makeConfig({
      trace,
      isDestructive: (name) => name === "broadcast",
      llm: makeLLM([
        {
          content: null,
          tool_calls: [
            {
              id: "call_d",
              function: { name: "broadcast", arguments: JSON.stringify({ content: "risky" }) },
            },
            {
              id: "call_s",
              function: {
                name: "report_action",
                arguments: JSON.stringify({ action_type: "scan", summary: "ok" }),
              },
            },
          ],
          finish_reason: "tool_calls",
        },
      ]),
    });

    const result = await runAgent(config);
    expect(result.actionType).toBe("suspended");

    expect(types(steps)).toEqual([
      "tick_started",
      "llm_request",
      "llm_response",
      "approval_requested",
    ]);
    const approval = steps[3].data;
    expect(approval.pending).toEqual([
      { toolCallId: "call_d", tool: "broadcast", args: { content: "risky" } },
    ]);
    expect(approval.deferredSafeCount).toBe(1);
    // The deferred safe call must NOT have executed (no tool steps).
    expect(types(steps)).not.toContain("tool_started");
  });

  it("emits decision_applied and deferred-safe tool steps on resume", async () => {
    const { steps, trace } = collect();
    const suspension: AgentSuspension = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "tick" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_d",
              type: "function",
              function: { name: "broadcast", arguments: JSON.stringify({ content: "risky" }) },
            },
            {
              id: "call_s",
              type: "function",
              function: {
                name: "report_action",
                arguments: JSON.stringify({ action_type: "scan", summary: "ok" }),
              },
            },
          ],
        },
      ],
      pending: [
        { id: "call_d", name: "broadcast", arguments: JSON.stringify({ content: "risky" }) },
      ],
      deferredSafe: [
        {
          id: "call_s",
          name: "report_action",
          arguments: JSON.stringify({ action_type: "scan", summary: "ok" }),
        },
      ],
      actions: [],
      round: 0,
    };

    const config = makeConfig({
      trace,
      llm: makeLLM([{ content: "Understood.", finish_reason: "stop" }]),
      resume: {
        suspension,
        decisions: [{ id: "call_d", approved: false, note: "too risky" }],
      },
    });

    const result = await runAgent(config);
    // The deferred safe call produced the only action.
    expect(result.actionType).toBe("scan");

    expect(types(steps)).toEqual([
      "tick_started",
      "decision_applied",
      "tool_started",
      "tool_finished",
      "llm_request",
      "llm_response",
      "tick_finished",
    ]);
    expect(steps[0].data.mode).toBe("resume");
    expect(steps[1].data).toEqual({
      toolCallId: "call_d",
      tool: "broadcast",
      approved: false,
      note: "too risky",
    });
    // Only the safe call ran; the rejected one produced no tool steps.
    expect(steps[2].data.tool).toBe("report_action");
  });

  it("traces the approved destructive call execution on resume", async () => {
    const { steps, trace } = collect();
    const suspension: AgentSuspension = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "tick" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_d",
              type: "function",
              function: { name: "broadcast", arguments: JSON.stringify({ content: "go" }) },
            },
          ],
        },
      ],
      pending: [{ id: "call_d", name: "broadcast", arguments: JSON.stringify({ content: "go" }) }],
      actions: [],
      round: 0,
    };

    const config = makeConfig({
      trace,
      llm: makeLLM([{ content: "Sent.", finish_reason: "stop" }]),
      resume: {
        suspension,
        decisions: [{ id: "call_d", approved: true }],
      },
    });

    const result = await runAgent(config);
    expect(result.actionType).toBe("broadcast_sent");

    expect(types(steps)).toEqual([
      "tick_started",
      "decision_applied",
      "tool_started",
      "tool_finished",
      "llm_request",
      "llm_response",
      "tick_finished",
    ]);
    expect(steps[1].data.approved).toBe(true);
    expect(steps[2].data.tool).toBe("broadcast");
  });

  it("a throwing sink never breaks the tick", async () => {
    const config = makeConfig({
      llm: makeLLM([{ content: "Still fine." }]),
      trace: () => {
        throw new Error("sink exploded");
      },
    });

    const result = await runAgent(config);
    expect(result.actionType).toBe("agent_thought");
    expect(result.payload.thought).toBe("Still fine.");
  });

  it("emits nothing when no sink is configured (smoke)", async () => {
    const config = makeConfig({ llm: makeLLM([{ content: "Quiet." }]) });
    const result = await runAgent(config);
    expect(result.actionType).toBe("agent_thought");
  });
});

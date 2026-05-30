import { describe, expect, it, vi } from "vitest";
import type { AgentConfig, LLMClient } from "@/lib/meta-agent/runner";
import { runAgent } from "@/lib/meta-agent/runner";

// ---------------------------------------------------------------------------
// Helpers
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
    peers: [
      { id: "agent-2", name: "content-scheduler", role: "Manages content" },
    ],
    a2ax: {
      sendDirect: vi.fn().mockResolvedValue(undefined),
      broadcast: vi.fn().mockResolvedValue(undefined),
    },
    llm: makeLLM([{ content: "thinking...", tool_calls: undefined }]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// runAgent
// ---------------------------------------------------------------------------

describe("runAgent", () => {
  it("returns agent_thought when LLM produces text only (no tool calls)", async () => {
    const config = makeConfig({
      llm: makeLLM([{ content: "I have nothing to do right now." }]),
    });

    const result = await runAgent(config);

    expect(result.actionType).toBe("agent_thought");
    expect(result.payload.agent).toBe("test-agent");
    expect(result.payload.thought).toBe("I have nothing to do right now.");
  });

  it("returns agent_thought with fallback when content is null", async () => {
    const config = makeConfig({
      llm: makeLLM([{ content: null }]),
    });

    const result = await runAgent(config);
    expect(result.actionType).toBe("agent_thought");
    expect(result.payload.thought).toBe("no output");
  });

  it("executes a single tool call and returns the action", async () => {
    const config = makeConfig({
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
    expect(result.payload.agent).toBe("test-agent");
    expect(result.payload.summary).toBe("all good");
  });

  it("executes send_message tool call and calls a2ax", async () => {
    const a2ax = {
      sendDirect: vi.fn().mockResolvedValue(undefined),
      broadcast: vi.fn().mockResolvedValue(undefined),
    };

    const config = makeConfig({
      a2ax,
      llm: makeLLM([
        {
          content: null,
          tool_calls: [{
            id: "call_1",
            function: {
              name: "send_message",
              arguments: JSON.stringify({ to_agent: "content-scheduler", content: "sync up?" }),
            },
          }],
          finish_reason: "tool_calls",
        },
        { content: "Sent.", finish_reason: "stop" },
      ]),
    });

    const result = await runAgent(config);

    expect(a2ax.sendDirect).toHaveBeenCalledWith("team-1", "agent-1", "agent-2", "sync up?");
    expect(result.actionType).toBe("message_sent");
  });

  it("handles broadcast tool call", async () => {
    const a2ax = {
      sendDirect: vi.fn().mockResolvedValue(undefined),
      broadcast: vi.fn().mockResolvedValue(undefined),
    };

    const config = makeConfig({
      a2ax,
      llm: makeLLM([
        {
          content: null,
          tool_calls: [{
            id: "call_1",
            function: {
              name: "broadcast",
              arguments: JSON.stringify({ content: "alert everyone" }),
            },
          }],
          finish_reason: "tool_calls",
        },
        { content: "Broadcasted.", finish_reason: "stop" },
      ]),
    });

    const result = await runAgent(config);

    expect(a2ax.broadcast).toHaveBeenCalledWith("team-1", "agent-1", "alert everyone");
    expect(result.actionType).toBe("broadcast_sent");
  });

  it("returns multi_action when multiple tools are called in one round", async () => {
    const a2ax = {
      sendDirect: vi.fn().mockResolvedValue(undefined),
      broadcast: vi.fn().mockResolvedValue(undefined),
    };

    const config = makeConfig({
      a2ax,
      llm: makeLLM([
        {
          content: null,
          tool_calls: [
            {
              id: "call_1",
              function: {
                name: "report_action",
                arguments: JSON.stringify({ action_type: "scan", summary: "scanned" }),
              },
            },
            {
              id: "call_2",
              function: {
                name: "broadcast",
                arguments: JSON.stringify({ content: "update" }),
              },
            },
          ],
          finish_reason: "tool_calls",
        },
        { content: "All done.", finish_reason: "stop" },
      ]),
    });

    const result = await runAgent(config);

    expect(result.actionType).toBe("multi_action");
    expect((result.payload.actions as unknown[]).length).toBe(2);
  });

  it("returns agent_thought when tool calls fail to produce actions and LLM follows up", async () => {
    // Send to an unknown agent: executeTool returns success: false, no action.
    // Then LLM responds with text only in the second round.
    // Since actions is still empty when the second round has no tool_calls,
    // the runner returns agent_thought with the LLM's text.
    const config = makeConfig({
      peers: [],
      llm: makeLLM([
        {
          content: null,
          tool_calls: [{
            id: "call_1",
            function: {
              name: "send_message",
              arguments: JSON.stringify({ to_agent: "nonexistent", content: "hi" }),
            },
          }],
          finish_reason: "tool_calls",
        },
        { content: "Oh well.", finish_reason: "stop" },
      ]),
    });

    const result = await runAgent(config);
    expect(result.actionType).toBe("agent_thought");
    expect(result.payload.agent).toBe("test-agent");
    expect(result.payload.thought).toBe("Oh well.");
  });

  it("returns noop when tool rounds exhaust with no actions and no text follow-up", async () => {
    // All 3 rounds produce tool calls to unknown agents; no actions logged.
    // After MAX_TOOL_ROUNDS the loop exits, actions is empty, returns noop.
    const createFn = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_1",
            function: {
              name: "send_message",
              arguments: JSON.stringify({ to_agent: "nobody", content: "hi" }),
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
    });

    const config = makeConfig({
      peers: [],
      llm: { chat: { completions: { create: createFn } } },
    });

    const result = await runAgent(config);
    expect(result.actionType).toBe("noop");
    expect(result.payload.agent).toBe("test-agent");
  });

  // D10 (v0.1 eng review): malformed tool-call JSON must NOT be silently
  // swallowed into empty args. The runner feeds the parse error back to the
  // LLM as a tool result so the model can self-correct, and never executes
  // the tool with empty inputs.
  it("feeds a parse error back to the LLM when tool arguments are not valid JSON", async () => {
    const a2ax = {
      sendDirect: vi.fn().mockResolvedValue(undefined),
      broadcast: vi.fn().mockResolvedValue(undefined),
    };
    const createFn = vi
      .fn()
      // Round 1: malformed arguments on a broadcast call.
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_bad",
              function: { name: "broadcast", arguments: "{not valid json" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })
      // Round 2: LLM recovers with a well-formed call.
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_good",
              function: {
                name: "broadcast",
                arguments: JSON.stringify({ content: "recovered" }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })
      .mockResolvedValue({
        choices: [{ message: { content: "Done.", tool_calls: undefined }, finish_reason: "stop" }],
      });

    const config = makeConfig({
      a2ax,
      llm: { chat: { completions: { create: createFn } } },
    });

    const result = await runAgent(config);

    // The malformed call must never reach the broadcast sender with empty args;
    // only the recovered, well-formed call should have executed.
    expect(a2ax.broadcast).toHaveBeenCalledTimes(1);
    expect(a2ax.broadcast).toHaveBeenCalledWith("team-1", "agent-1", "recovered");

    // Round 2's message list must carry a tool result for the failed call
    // describing the parse error, so the model knew why to retry.
    const round2Messages = createFn.mock.calls[1][0].messages as Array<Record<string, unknown>>;
    const errResult = round2Messages.find(
      (m) => m.role === "tool" && m.tool_call_id === "call_bad",
    );
    expect(errResult).toBeDefined();
    expect(String(errResult?.content)).toMatch(/not valid JSON/i);

    expect(result.actionType).toBe("broadcast_sent");
  });

  it("respects MAX_TOOL_ROUNDS limit (3 rounds)", async () => {
    const createFn = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_1",
            function: {
              name: "report_action",
              arguments: JSON.stringify({ action_type: "loop", summary: "again" }),
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
    });

    const config = makeConfig({
      llm: { chat: { completions: { create: createFn } } },
    });

    await runAgent(config);

    // Should be called exactly 3 times (MAX_TOOL_ROUNDS = 3)
    expect(createFn).toHaveBeenCalledTimes(3);
  });

  it("includes a2ax context in the tick prompt when provided", async () => {
    const createFn = vi.fn().mockResolvedValue({
      choices: [{
        message: { content: "Noted.", tool_calls: undefined },
        finish_reason: "stop",
      }],
    });

    const config = makeConfig({
      a2axContext: "[DM from content-scheduler]: Need help with drafts",
      llm: { chat: { completions: { create: createFn } } },
    });

    await runAgent(config);

    const callArgs = createFn.mock.calls[0][0];
    const userMessage = callArgs.messages.find((m: Record<string, unknown>) => m.role === "user");
    expect(userMessage.content).toContain("Need help with drafts");
    expect(userMessage.content).toContain("Respond to any messages");
  });

  it("includes 'No new messages' when a2axContext is absent", async () => {
    const createFn = vi.fn().mockResolvedValue({
      choices: [{
        message: { content: "Idle.", tool_calls: undefined },
        finish_reason: "stop",
      }],
    });

    const config = makeConfig({
      a2axContext: undefined,
      llm: { chat: { completions: { create: createFn } } },
    });

    await runAgent(config);

    const callArgs = createFn.mock.calls[0][0];
    const userMessage = callArgs.messages.find((m: Record<string, unknown>) => m.role === "user");
    expect(userMessage.content).toContain("No new messages");
  });

  it("builds system prompt with peer list", async () => {
    const createFn = vi.fn().mockResolvedValue({
      choices: [{
        message: { content: "OK.", tool_calls: undefined },
        finish_reason: "stop",
      }],
    });

    const config = makeConfig({
      llm: { chat: { completions: { create: createFn } } },
    });

    await runAgent(config);

    const callArgs = createFn.mock.calls[0][0];
    const systemMessage = callArgs.messages.find((m: Record<string, unknown>) => m.role === "system");
    expect(systemMessage.content).toContain("content-scheduler");
    expect(systemMessage.content).toContain("Manages content");
    expect(systemMessage.content).toContain("test-agent");
    expect(systemMessage.content).toContain("ops-monitor");
  });

  it("shows 'No other agents' when peers is empty", async () => {
    const createFn = vi.fn().mockResolvedValue({
      choices: [{
        message: { content: "Alone.", tool_calls: undefined },
        finish_reason: "stop",
      }],
    });

    const config = makeConfig({
      peers: [],
      llm: { chat: { completions: { create: createFn } } },
    });

    await runAgent(config);

    const callArgs = createFn.mock.calls[0][0];
    const systemMessage = callArgs.messages.find((m: Record<string, unknown>) => m.role === "system");
    expect(systemMessage.content).toContain("No other agents");
  });

  it("passes model override to LLM", async () => {
    const createFn = vi.fn().mockResolvedValue({
      choices: [{
        message: { content: "OK.", tool_calls: undefined },
        finish_reason: "stop",
      }],
    });

    const config = makeConfig({
      model: "gpt-5.5",
      llm: { chat: { completions: { create: createFn } } },
    });

    await runAgent(config);

    const callArgs = createFn.mock.calls[0][0];
    expect(callArgs.model).toBe("gpt-5.5");
  });

  it("defaults to o4-mini when no model specified", async () => {
    const createFn = vi.fn().mockResolvedValue({
      choices: [{
        message: { content: "OK.", tool_calls: undefined },
        finish_reason: "stop",
      }],
    });

    const config = makeConfig({
      model: undefined,
      llm: { chat: { completions: { create: createFn } } },
    });

    await runAgent(config);

    const callArgs = createFn.mock.calls[0][0];
    expect(callArgs.model).toBe("o4-mini");
  });

  it("breaks loop on stop finish_reason even if tool calls were made", async () => {
    const createFn = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_1",
            function: {
              name: "report_action",
              arguments: JSON.stringify({ action_type: "done", summary: "finished" }),
            },
          }],
        },
        finish_reason: "stop",
      }],
    });

    const config = makeConfig({
      llm: { chat: { completions: { create: createFn } } },
    });

    await runAgent(config);

    // Only 1 LLM call because finish_reason is "stop"
    expect(createFn).toHaveBeenCalledTimes(1);
  });
});

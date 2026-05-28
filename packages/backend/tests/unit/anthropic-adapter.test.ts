import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Anthropic SDK
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  return { default: MockAnthropic };
});

import { createAnthropicClient } from "@/lib/meta-agent/anthropic-adapter";

beforeEach(() => {
  mockCreate.mockReset();
});

describe("createAnthropicClient", () => {
  it("returns an LLMClient-compatible object", () => {
    const client = createAnthropicClient({ apiKey: "test" });
    expect(client.chat).toBeDefined();
    expect(client.chat.completions).toBeDefined();
    expect(typeof client.chat.completions.create).toBe("function");
  });
});

describe("Anthropic adapter message conversion", () => {
  it("converts text response to OpenAI format", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Hello from Anthropic" }],
      stop_reason: "end_turn",
    });

    const client = createAnthropicClient({ apiKey: "test" });
    const result = await client.chat.completions.create({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
      ],
    });

    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].message.content).toBe("Hello from Anthropic");
    expect(result.choices[0].message.tool_calls).toBeUndefined();
    expect(result.choices[0].finish_reason).toBe("stop");
  });

  it("converts tool_use response to OpenAI tool_calls format", async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: "text", text: "Let me send a message" },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "send_message",
          input: { to_agent: "ops", content: "hello" },
        },
      ],
      stop_reason: "tool_use",
    });

    const client = createAnthropicClient({ apiKey: "test" });
    const result = await client.chat.completions.create({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Send a message" }],
      tools: [{
        type: "function",
        function: {
          name: "send_message",
          description: "Send a message",
          parameters: { type: "object", properties: {} },
        },
      }],
    });

    expect(result.choices[0].message.content).toBe("Let me send a message");
    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.choices[0].message.tool_calls![0].id).toBe("toolu_1");
    expect(result.choices[0].message.tool_calls![0].function.name).toBe("send_message");
    expect(JSON.parse(result.choices[0].message.tool_calls![0].function.arguments)).toEqual({
      to_agent: "ops",
      content: "hello",
    });
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });

  it("extracts system message from messages array", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });

    const client = createAnthropicClient({ apiKey: "test" });
    await client.chat.completions.create({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "system", content: "System instructions" },
        { role: "user", content: "User message" },
      ],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toBe("System instructions");
    // System message should not be in the messages array
    expect(callArgs.messages.every((m: { role: string }) => m.role !== "system")).toBe(true);
  });

  it("concatenates multiple system messages", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });

    const client = createAnthropicClient({ apiKey: "test" });
    await client.chat.completions.create({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "system", content: "Part 1" },
        { role: "system", content: "Part 2" },
        { role: "user", content: "Hi" },
      ],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toBe("Part 1\n\nPart 2");
  });

  it("converts tool results to user messages with tool_result blocks", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "got it" }],
      stop_reason: "end_turn",
    });

    const client = createAnthropicClient({ apiKey: "test" });
    await client.chat.completions.create({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            function: { name: "test", arguments: "{}" },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "Tool result" },
      ],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    const toolResultMsg = callArgs.messages.find(
      (m: { role: string; content: unknown }) =>
        m.role === "user" && Array.isArray(m.content),
    );
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg.content[0].type).toBe("tool_result");
    expect(toolResultMsg.content[0].tool_use_id).toBe("call_1");
    expect(toolResultMsg.content[0].content).toBe("Tool result");
  });

  it("converts assistant tool_calls to tool_use content blocks", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });

    const client = createAnthropicClient({ apiKey: "test" });
    await client.chat.completions.create({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "Do something" },
        {
          role: "assistant",
          content: "I'll use a tool",
          tool_calls: [{
            id: "call_1",
            function: { name: "report_action", arguments: '{"action_type":"test"}' },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "done" },
      ],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    const assistantMsg = callArgs.messages.find(
      (m: { role: string; content: unknown }) =>
        m.role === "assistant" && Array.isArray(m.content),
    );
    expect(assistantMsg).toBeDefined();
    // Should have text block + tool_use block
    expect(assistantMsg.content).toHaveLength(2);
    expect(assistantMsg.content[0].type).toBe("text");
    expect(assistantMsg.content[1].type).toBe("tool_use");
    expect(assistantMsg.content[1].name).toBe("report_action");
  });

  it("handles assistant tool_calls with malformed JSON arguments", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });

    const client = createAnthropicClient({ apiKey: "test" });
    await client.chat.completions.create({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "Do something" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            function: { name: "test", arguments: "bad json" },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "done" },
      ],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    const assistantMsg = callArgs.messages.find(
      (m: { role: string; content: unknown }) =>
        m.role === "assistant" && Array.isArray(m.content),
    );
    // Should have tool_use with empty object as input
    expect(assistantMsg.content[0].type).toBe("tool_use");
    expect(assistantMsg.content[0].input).toEqual({});
  });

  it("converts OpenAI tool definitions to Anthropic format", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });

    const client = createAnthropicClient({ apiKey: "test" });
    await client.chat.completions.create({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{
        type: "function",
        function: {
          name: "my_tool",
          description: "Does something",
          parameters: { type: "object", properties: { x: { type: "number" } } },
        },
      }],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.tools).toHaveLength(1);
    expect(callArgs.tools[0].name).toBe("my_tool");
    expect(callArgs.tools[0].description).toBe("Does something");
    expect(callArgs.tools[0].input_schema).toEqual({
      type: "object",
      properties: { x: { type: "number" } },
    });
  });

  it("converts assistant message without tool_calls to plain string", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });

    const client = createAnthropicClient({ apiKey: "test" });
    await client.chat.completions.create({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello back" },
        { role: "user", content: "Follow up" },
      ],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    const assistantMsg = callArgs.messages.find(
      (m: { role: string; content: unknown }) => m.role === "assistant",
    );
    expect(assistantMsg).toBeDefined();
    // Should be a plain string, not array (no tool_calls)
    expect(typeof assistantMsg.content).toBe("string");
    expect(assistantMsg.content).toBe("Hello back");
  });

  it("handles assistant with empty tool_calls array", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });

    const client = createAnthropicClient({ apiKey: "test" });
    await client.chat.completions.create({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "thinking", tool_calls: [] },
        { role: "user", content: "Continue" },
      ],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    const assistantMsg = callArgs.messages.find(
      (m: { role: string; content: unknown }) => m.role === "assistant",
    );
    // Empty tool_calls should produce plain string content
    expect(typeof assistantMsg.content).toBe("string");
  });

  it("handles assistant tool_call with null content", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
    });

    const client = createAnthropicClient({ apiKey: "test" });
    await client.chat.completions.create({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "Do" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            function: { name: "test", arguments: '{"x":1}' },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    const assistantMsg = callArgs.messages.find(
      (m: { role: string; content: unknown }) =>
        m.role === "assistant" && Array.isArray(m.content),
    );
    // null content means no text block, just tool_use
    expect(assistantMsg.content).toHaveLength(1);
    expect(assistantMsg.content[0].type).toBe("tool_use");
  });

  it("handles tool definition without description or parameters", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });

    const client = createAnthropicClient({ apiKey: "test" });
    await client.chat.completions.create({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{
        type: "function",
        function: { name: "bare_tool" },
      }],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.tools[0].name).toBe("bare_tool");
    expect(callArgs.tools[0].description).toBe("");
    expect(callArgs.tools[0].input_schema).toEqual({ type: "object", properties: {} });
  });

  it("handles response with only tool_use blocks (no text)", async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "test",
          input: {},
        },
      ],
      stop_reason: "tool_use",
    });

    const client = createAnthropicClient({ apiKey: "test" });
    const result = await client.chat.completions.create({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Do it" }],
      tools: [{
        type: "function",
        function: { name: "test", parameters: {} },
      }],
    });

    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });

  it("uses default model when not specified in params", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });

    const client = createAnthropicClient({ apiKey: "test" });
    await client.chat.completions.create({
      messages: [{ role: "user", content: "Hi" }],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe("claude-sonnet-4-20250514");
  });

  it("uses default max_tokens when not specified", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });

    const client = createAnthropicClient({ apiKey: "test" });
    await client.chat.completions.create({
      messages: [{ role: "user", content: "Hi" }],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.max_tokens).toBe(1024);
  });

  it("omits tools when none provided", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });

    const client = createAnthropicClient({ apiKey: "test" });
    await client.chat.completions.create({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hi" }],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.tools).toBeUndefined();
  });
});

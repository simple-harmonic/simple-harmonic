import { describe, expect, it, vi } from "vitest";

// Mock node:child_process, node:fs, node:os before importing
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  mkdtempSync: vi.fn().mockReturnValue("/tmp/sh-codex-test"),
  rmSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  tmpdir: vi.fn().mockReturnValue("/tmp"),
}));

import { execFile } from "node:child_process";

const mockExecFile = vi.mocked(execFile);

describe("codex-adapter", () => {
  async function loadAdapter() {
    return await import("@/lib/meta-agent/codex-adapter");
  }

  describe("createCodexClient", () => {
    it("returns an LLMClient-compatible object", async () => {
      const { createCodexClient } = await loadAdapter();
      const client = createCodexClient({ model: "gpt-5.5" });

      expect(client.chat).toBeDefined();
      expect(client.chat.completions).toBeDefined();
      expect(typeof client.chat.completions.create).toBe("function");
    });
  });

  describe("LLM call via codex exec", () => {
    it("returns text response when model outputs plain text", async () => {
      // Simulate codex exec JSONL output. Without tools, the raw text
      // is returned as-is (not parsed as JSON).
      const jsonlOutput = JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "Hello from codex",
        },
      });

      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        (cb as Function)(null, jsonlOutput, "");
        return { stdin: { write: vi.fn(), end: vi.fn() } } as any;
      });

      const { createCodexClient } = await loadAdapter();
      const client = createCodexClient();
      const result = await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [
          { role: "system", content: "Be helpful" },
          { role: "user", content: "Hi" },
        ],
      });

      expect(result.choices).toHaveLength(1);
      expect(result.choices[0].message.content).toBe("Hello from codex");
      expect(result.choices[0].finish_reason).toBe("stop");
    });

    it("returns 'No response from agent' when output is empty", async () => {
      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        (cb as Function)(null, "", "");
        return { stdin: { write: vi.fn(), end: vi.fn() } } as any;
      });

      const { createCodexClient } = await loadAdapter();
      const client = createCodexClient();
      const result = await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.choices[0].message.content).toBe("No response from agent.");
    });

    it("parses tool calls from structured JSON response", async () => {
      const jsonlOutput = JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            content: null,
            tool_calls: [
              { name: "report_action", arguments: { action_type: "test", summary: "done" } },
            ],
          }),
        },
      });

      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        (cb as Function)(null, jsonlOutput, "");
        return { stdin: { write: vi.fn(), end: vi.fn() } } as any;
      });

      const { createCodexClient } = await loadAdapter();
      const client = createCodexClient();
      const result = await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Do something" }],
        tools: [{
          type: "function",
          function: {
            name: "report_action",
            description: "Report an action",
            parameters: { type: "object", properties: {} },
          },
        }],
      });

      expect(result.choices[0].message.tool_calls).toHaveLength(1);
      expect(result.choices[0].message.tool_calls![0].function.name).toBe("report_action");
      expect(result.choices[0].finish_reason).toBe("tool_calls");
    });

    it("handles codex exec failure", async () => {
      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        (cb as Function)(new Error("codex not found"), "", "");
        return { stdin: { write: vi.fn(), end: vi.fn() } } as any;
      });

      const { createCodexClient } = await loadAdapter();
      const client = createCodexClient();

      await expect(
        client.chat.completions.create({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "Hi" }],
        }),
      ).rejects.toThrow("codex exec failed");
    });

    it("handles response wrapped in markdown fences", async () => {
      const jsonlOutput = JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: '```json\n{"content": "fenced response"}\n```',
        },
      });

      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        (cb as Function)(null, jsonlOutput, "");
        return { stdin: { write: vi.fn(), end: vi.fn() } } as any;
      });

      const { createCodexClient } = await loadAdapter();
      const client = createCodexClient();
      const result = await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Hi" }],
        tools: [{
          type: "function",
          function: { name: "test", parameters: {} },
        }],
      });

      expect(result.choices[0].message.content).toBe("fenced response");
    });

    it("treats non-JSON text as plain content when tools provided", async () => {
      const jsonlOutput = JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "Just plain text, not JSON",
        },
      });

      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        (cb as Function)(null, jsonlOutput, "");
        return { stdin: { write: vi.fn(), end: vi.fn() } } as any;
      });

      const { createCodexClient } = await loadAdapter();
      const client = createCodexClient();
      const result = await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Hi" }],
        tools: [{
          type: "function",
          function: { name: "test", parameters: {} },
        }],
      });

      expect(result.choices[0].message.content).toBe("Just plain text, not JSON");
      expect(result.choices[0].message.tool_calls).toBeUndefined();
    });

    it("handles error events in JSONL output gracefully", async () => {
      const jsonlOutput = [
        JSON.stringify({ type: "error", error: { message: "Rate limit exceeded" } }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Recovered response" },
        }),
      ].join("\n");

      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        (cb as Function)(null, jsonlOutput, "");
        return { stdin: { write: vi.fn(), end: vi.fn() } } as any;
      });

      const { createCodexClient } = await loadAdapter();
      const client = createCodexClient();
      const result = await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Hi" }],
      });

      // The last agent_message wins despite the earlier error
      expect(result.choices[0].message.content).toBe("Recovered response");
    });

    it("skips non-JSON lines in JSONL output", async () => {
      const jsonlOutput = [
        "not json",
        "",
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "valid" },
        }),
      ].join("\n");

      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        (cb as Function)(null, jsonlOutput, "");
        return { stdin: { write: vi.fn(), end: vi.fn() } } as any;
      });

      const { createCodexClient } = await loadAdapter();
      const client = createCodexClient();
      const result = await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.choices[0].message.content).toBe("valid");
    });

    it("skips non-agent_message completed items", async () => {
      const jsonlOutput = [
        JSON.stringify({
          type: "item.completed",
          item: { type: "shell_command", command: "ls" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "actual message" },
        }),
      ].join("\n");

      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        (cb as Function)(null, jsonlOutput, "");
        return { stdin: { write: vi.fn(), end: vi.fn() } } as any;
      });

      const { createCodexClient } = await loadAdapter();
      const client = createCodexClient();
      const result = await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.choices[0].message.content).toBe("actual message");
    });

    it("handles JSON response with content but no tool_calls", async () => {
      const jsonlOutput = JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({ content: "Structured text, no tools" }),
        },
      });

      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        (cb as Function)(null, jsonlOutput, "");
        return { stdin: { write: vi.fn(), end: vi.fn() } } as any;
      });

      const { createCodexClient } = await loadAdapter();
      const client = createCodexClient();
      const result = await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Hi" }],
        tools: [{ type: "function", function: { name: "test", parameters: {} } }],
      });

      expect(result.choices[0].message.content).toBe("Structured text, no tools");
      expect(result.choices[0].message.tool_calls).toBeUndefined();
      expect(result.choices[0].finish_reason).toBe("stop");
    });

    it("passes model to codex exec as -c flag", async () => {
      const jsonlOutput = JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "ok" },
      });

      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        (cb as Function)(null, jsonlOutput, "");
        return { stdin: { write: vi.fn(), end: vi.fn() } } as any;
      });

      const { createCodexClient } = await loadAdapter();
      const client = createCodexClient();
      await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Hi" }],
      });

      // The -c model="..." arg should be in the exec args
      const execArgs = mockExecFile.mock.calls[0][1] as string[];
      const modelArg = execArgs.find(a => a.includes("model="));
      expect(modelArg).toBeTruthy();
    });

    it("returns plain text when no tools are provided", async () => {
      const jsonlOutput = JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "Simple response",
        },
      });

      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        (cb as Function)(null, jsonlOutput, "");
        return { stdin: { write: vi.fn(), end: vi.fn() } } as any;
      });

      const { createCodexClient } = await loadAdapter();
      const client = createCodexClient();
      const result = await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.choices[0].message.content).toBe("Simple response");
      expect(result.choices[0].finish_reason).toBe("stop");
    });
  });
});

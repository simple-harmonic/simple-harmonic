import { describe, expect, it, vi } from "vitest";
import type { PlannerDeps, PlannerMessage } from "@/lib/meta-agent/planner";

// Shared mock stream that each test configures
const chunks: unknown[] = [];

vi.mock("openai", () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: vi.fn().mockImplementation(async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        }),
      },
    };
  }
  return { default: MockOpenAI };
});

// The planner is dependency-injected now (no server imports), so tests pass
// deps directly instead of mocking server modules. mockProxyFetch is the
// injected fetchImpl for the codex path.
const mockProxyFetch = vi.fn();

function configDeps(): PlannerDeps {
  return {
    config: {
      model: "gpt-5.4-mini",
      openaiApiKey: "sk-test",
      openaiBaseUrl: "https://api.openai.com/v1",
    },
    apiKeySource: "config",
    codexAccessToken: null,
    codexAccountId: "",
    fetchImpl: mockProxyFetch,
  };
}

function codexDeps(): PlannerDeps {
  return {
    ...configDeps(),
    apiKeySource: "codex",
    codexAccessToken: "test-codex-token",
    codexAccountId: "acc-1",
  };
}

function textChunk(content: string) {
  return { choices: [{ delta: { content, tool_calls: undefined } }] };
}

function toolChunk(id: string | null, name: string | null, args: string) {
  return {
    choices: [
      {
        delta: {
          content: null,
          tool_calls: [
            {
              id,
              function: { name, arguments: args },
            },
          ],
        },
      },
    ],
  };
}

describe("plannerStream", () => {
  it("streams tokens and returns a message on normal response", async () => {
    chunks.length = 0;
    chunks.push(textChunk("Hello"), textChunk(" founder."));

    const { plannerStream } = await import("@/lib/meta-agent/planner");

    const tokens: string[] = [];
    const messages: PlannerMessage[] = [{ role: "user", content: "I run a SaaS startup" }];

    const result = await plannerStream(messages, (token) => tokens.push(token), configDeps());

    expect(result.type).toBe("message");
    expect(result.content).toBe("Hello founder.");
    expect(tokens).toEqual(["Hello", " founder."]);
  });

  it("detects spawn_team tool use and returns spawn result", async () => {
    const spawnInput = {
      agents: [
        {
          name: "inbox-scanner",
          role: "Monitors email for urgent items",
          archetype: "support-responder",
          tools: ["mock-inbox"],
          schedule_seconds: 300,
          initial_prompt: "Scan inbox for urgent items.",
        },
      ],
    };

    chunks.length = 0;
    chunks.push(
      textChunk("Setting up your team."),
      toolChunk("call_1", "spawn_team", JSON.stringify(spawnInput)),
    );

    const { plannerStream } = await import("@/lib/meta-agent/planner");

    const tokens: string[] = [];
    const messages: PlannerMessage[] = [
      { role: "user", content: "I run a SaaS startup" },
      { role: "assistant", content: "What eats your week?" },
      { role: "user", content: "Email and content. Ready to go." },
    ];

    const result = await plannerStream(messages, (token) => tokens.push(token), configDeps());

    expect(result.type).toBe("spawn");
    if (result.type === "spawn") {
      expect(result.result.agents).toHaveLength(1);
      expect(result.result.agents[0].name).toBe("inbox-scanner");
      expect(result.result.agents[0].archetype).toBe("support-responder");
    }
  });

  it("returns fallback content when stream produces no text", async () => {
    chunks.length = 0;

    const { plannerStream } = await import("@/lib/meta-agent/planner");

    const messages: PlannerMessage[] = [{ role: "user", content: "Hello" }];
    const result = await plannerStream(messages, () => {}, configDeps());

    expect(result.type).toBe("message");
    expect(result.content).toBe("I need a moment. Try again.");
  });

  it("handles malformed spawn_team tool call JSON as message", async () => {
    chunks.length = 0;
    chunks.push(
      textChunk("Almost there."),
      toolChunk("call_1", "spawn_team", "not valid json {{{"),
    );

    const { plannerStream } = await import("@/lib/meta-agent/planner");

    const tokens: string[] = [];
    const messages: PlannerMessage[] = [{ role: "user", content: "Let's go" }];

    const result = await plannerStream(messages, (token) => tokens.push(token), configDeps());

    // Malformed JSON falls back to message type
    expect(result.type).toBe("message");
    expect(result.content).toBe("Almost there.");
  });

  it("handles non-spawn tool call name as message", async () => {
    chunks.length = 0;
    chunks.push(
      textChunk("Text response."),
      toolChunk("call_1", "unknown_tool", '{"foo":"bar"}'),
    );

    const { plannerStream } = await import("@/lib/meta-agent/planner");

    const messages: PlannerMessage[] = [{ role: "user", content: "Do something" }];
    const result = await plannerStream(messages, () => {}, configDeps());

    expect(result.type).toBe("message");
    expect(result.content).toBe("Text response.");
  });

  it("detects modify_agent tool use and returns modify result", async () => {
    const modifyInput = {
      agent_name: "bug-hunter",
      team_name: "Acme Studio",
      updates: {
        tools: ["read_file", "run_command", "coding_task", "slack_api"],
        schedule_seconds: 300,
      },
    };

    chunks.length = 0;
    chunks.push(
      textChunk("Adding Slack to the bug-hunter."),
      toolChunk("call_1", "modify_agent", JSON.stringify(modifyInput)),
    );

    const { plannerStream } = await import("@/lib/meta-agent/planner");

    const tokens: string[] = [];
    const messages: PlannerMessage[] = [
      { role: "user", content: "Add slack_api to the bug-hunter" },
    ];

    const result = await plannerStream(messages, (token) => tokens.push(token), configDeps());

    expect(result.type).toBe("modify_agent");
    if (result.type === "modify_agent") {
      expect(result.result.agent_name).toBe("bug-hunter");
      expect(result.result.team_name).toBe("Acme Studio");
      expect(result.result.updates.tools).toContain("slack_api");
      expect(result.result.updates.schedule_seconds).toBe(300);
    }
  });

  it("handles malformed modify_agent JSON as message", async () => {
    chunks.length = 0;
    chunks.push(
      textChunk("Updating."),
      toolChunk("call_1", "modify_agent", "broken json{{{"),
    );

    const { plannerStream } = await import("@/lib/meta-agent/planner");

    const result = await plannerStream(
      [{ role: "user", content: "Modify something" }],
      () => {},
      configDeps(),
    );

    expect(result.type).toBe("message");
    expect(result.content).toBe("Updating.");
  });

  it("handles chunk with no choices", async () => {
    chunks.length = 0;
    chunks.push(
      { choices: [] },
      textChunk("After empty."),
    );

    const { plannerStream } = await import("@/lib/meta-agent/planner");

    const messages: PlannerMessage[] = [{ role: "user", content: "Hi" }];
    const result = await plannerStream(messages, () => {}, configDeps());

    expect(result.type).toBe("message");
    expect(result.content).toBe("After empty.");
  });

  it("accumulates tool call arguments across multiple chunks", async () => {
    const part1 = '{"agents":[{"name":"inbox-scanner","role":"Email"';
    const part2 = ',"archetype":"support-responder","tools":[],"schedule_seconds":300,"initial_prompt":"Scan."}]}';

    chunks.length = 0;
    chunks.push(
      toolChunk("call_1", "spawn_team", part1),
      toolChunk(null, null, part2),
    );

    const { plannerStream } = await import("@/lib/meta-agent/planner");

    const messages: PlannerMessage[] = [{ role: "user", content: "Go" }];
    const result = await plannerStream(messages, () => {}, configDeps());

    expect(result.type).toBe("spawn");
    if (result.type === "spawn") {
      expect(result.result.agents[0].name).toBe("inbox-scanner");
    }
  });

  it("includes team_name and cofounder_name in spawn result", async () => {
    const spawnInput = {
      team_name: "Acme Studio",
      cofounder_name: "Atlas",
      agents: [
        {
          name: "ops-monitor",
          role: "Monitor ops",
          archetype: "ops-monitor",
          tools: [],
          schedule_seconds: 300,
          initial_prompt: "Watch things.",
        },
      ],
    };

    chunks.length = 0;
    chunks.push(toolChunk("call_1", "spawn_team", JSON.stringify(spawnInput)));

    const { plannerStream } = await import("@/lib/meta-agent/planner");

    const messages: PlannerMessage[] = [{ role: "user", content: "Build" }];
    const result = await plannerStream(messages, () => {}, configDeps());

    expect(result.type).toBe("spawn");
    if (result.type === "spawn") {
      expect(result.result.team_name).toBe("Acme Studio");
      expect(result.result.cofounder_name).toBe("Atlas");
    }
  });
});

describe("plannerStream (codex path)", () => {
  // Helper to build a mock SSE stream from events
  function makeSSEStream(events: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(event));
        }
        controller.close();
      },
    });
  }

  function sseEvent(data: Record<string, unknown>): string {
    return `data: ${JSON.stringify(data)}\n\n`;
  }

  it("streams tokens from codex responses endpoint", async () => {
    // Override to "codex" source
    vi.doMock("@/server/config", () => ({
      getConfig: () => ({
        openaiApiKey: "",
        openaiBaseUrl: "https://api.openai.com/v1",
        model: "gpt-5.5",
        databaseUrl: "",
      }),
      getApiKeySource: () => "codex" as const,
    }));
    vi.doMock("@/server/codex-auth", () => ({
      getCodexAccessToken: () => "test-codex-token",
      getCodexAuthStatus: () => ({ found: true, accountId: "acc-1" }),
    }));

    const stream = makeSSEStream([
      sseEvent({ type: "response.output_text.delta", delta: "Hello" }),
      sseEvent({ type: "response.output_text.delta", delta: " world" }),
    ]);

    mockProxyFetch.mockResolvedValue({
      ok: true,
      body: stream,
    });

    // Re-import to pick up mocked getApiKeySource
    vi.resetModules();
    const { plannerStream } = await import("@/lib/meta-agent/planner");

    const tokens: string[] = [];
    const result = await plannerStream(
      [{ role: "user", content: "Hi" }],
      (token) => tokens.push(token),
      codexDeps(),
    );

    expect(result.type).toBe("message");
    expect(result.content).toBe("Hello world");
    expect(tokens).toEqual(["Hello", " world"]);
  });

  it("handles spawn_team via codex responses endpoint", async () => {
    vi.doMock("@/server/config", () => ({
      getConfig: () => ({
        openaiApiKey: "",
        openaiBaseUrl: "https://api.openai.com/v1",
        model: "gpt-5.5",
        databaseUrl: "",
      }),
      getApiKeySource: () => "codex" as const,
    }));
    vi.doMock("@/server/codex-auth", () => ({
      getCodexAccessToken: () => "test-codex-token",
      getCodexAuthStatus: () => ({ found: true, accountId: "acc-1" }),
    }));

    const spawnArgs = JSON.stringify({
      team_name: "Test Team",
      agents: [{ name: "bot", role: "Bot", archetype: "ops-monitor", tools: [], schedule_seconds: 300, initial_prompt: "Go." }],
    });

    const stream = makeSSEStream([
      sseEvent({ type: "response.output_text.delta", delta: "Setting up." }),
      sseEvent({ type: "response.output_item.added", item: { type: "function_call", name: "spawn_team" } }),
      sseEvent({ type: "response.function_call_arguments.delta", delta: spawnArgs }),
    ]);

    mockProxyFetch.mockResolvedValue({ ok: true, body: stream });

    vi.resetModules();
    const { plannerStream } = await import("@/lib/meta-agent/planner");

    const result = await plannerStream(
      [{ role: "user", content: "Go" }],
      () => {},
      codexDeps(),
    );

    expect(result.type).toBe("spawn");
    if (result.type === "spawn") {
      expect(result.result.team_name).toBe("Test Team");
      expect(result.result.agents).toHaveLength(1);
    }
  });

  it("throws on non-ok codex API response", async () => {
    vi.doMock("@/server/config", () => ({
      getConfig: () => ({
        openaiApiKey: "",
        openaiBaseUrl: "https://api.openai.com/v1",
        model: "gpt-5.5",
        databaseUrl: "",
      }),
      getApiKeySource: () => "codex" as const,
    }));
    vi.doMock("@/server/codex-auth", () => ({
      getCodexAccessToken: () => "test-codex-token",
      getCodexAuthStatus: () => ({ found: true, accountId: "acc-1" }),
    }));

    mockProxyFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve("Rate limited"),
    });

    vi.resetModules();
    const { plannerStream } = await import("@/lib/meta-agent/planner");

    await expect(
      plannerStream([{ role: "user", content: "Hi" }], () => {}, codexDeps()),
    ).rejects.toThrow("Codex API error 429");
  });

  it("throws when codex response has no body", async () => {
    vi.doMock("@/server/config", () => ({
      getConfig: () => ({
        openaiApiKey: "",
        openaiBaseUrl: "https://api.openai.com/v1",
        model: "gpt-5.5",
        databaseUrl: "",
      }),
      getApiKeySource: () => "codex" as const,
    }));
    vi.doMock("@/server/codex-auth", () => ({
      getCodexAccessToken: () => "test-codex-token",
      getCodexAuthStatus: () => ({ found: true, accountId: "acc-1" }),
    }));

    mockProxyFetch.mockResolvedValue({
      ok: true,
      body: null,
    });

    vi.resetModules();
    const { plannerStream } = await import("@/lib/meta-agent/planner");

    await expect(
      plannerStream([{ role: "user", content: "Hi" }], () => {}, codexDeps()),
    ).rejects.toThrow("No response body");
  });

  it("skips malformed JSON lines in SSE stream", async () => {
    vi.doMock("@/server/config", () => ({
      getConfig: () => ({
        openaiApiKey: "",
        openaiBaseUrl: "https://api.openai.com/v1",
        model: "gpt-5.5",
        databaseUrl: "",
      }),
      getApiKeySource: () => "codex" as const,
    }));
    vi.doMock("@/server/codex-auth", () => ({
      getCodexAccessToken: () => "test-codex-token",
      getCodexAuthStatus: () => ({ found: true, accountId: "acc-1" }),
    }));

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: not json\n\n"));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`));
        controller.close();
      },
    });

    mockProxyFetch.mockResolvedValue({ ok: true, body: stream });

    vi.resetModules();
    const { plannerStream } = await import("@/lib/meta-agent/planner");

    const result = await plannerStream(
      [{ role: "user", content: "Hi" }],
      () => {},
      codexDeps(),
    );

    expect(result.type).toBe("message");
    expect(result.content).toBe("ok");
  });

  it("handles SSE event: prefix format", async () => {
    vi.doMock("@/server/config", () => ({
      getConfig: () => ({
        openaiApiKey: "",
        openaiBaseUrl: "https://api.openai.com/v1",
        model: "gpt-5.5",
        databaseUrl: "",
      }),
      getApiKeySource: () => "codex" as const,
    }));
    vi.doMock("@/server/codex-auth", () => ({
      getCodexAccessToken: () => "test-codex-token",
      getCodexAuthStatus: () => ({ found: true, accountId: "acc-1" }),
    }));

    const encoder = new TextEncoder();
    // Send both event: and data: lines in one chunk so the line parser
    // can match the event type to the data on the same pass.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "event prefix" })}\n\n`,
        ));
        controller.close();
      },
    });

    mockProxyFetch.mockResolvedValue({ ok: true, body: stream });

    vi.resetModules();
    const { plannerStream } = await import("@/lib/meta-agent/planner");

    const result = await plannerStream(
      [{ role: "user", content: "Hi" }],
      () => {},
      codexDeps(),
    );

    expect(result.content).toBe("event prefix");
  });

  it("returns fallback when codex stream produces no text", async () => {
    vi.doMock("@/server/config", () => ({
      getConfig: () => ({
        openaiApiKey: "",
        openaiBaseUrl: "https://api.openai.com/v1",
        model: "gpt-5.5",
        databaseUrl: "",
      }),
      getApiKeySource: () => "codex" as const,
    }));
    vi.doMock("@/server/codex-auth", () => ({
      getCodexAccessToken: () => "test-codex-token",
      getCodexAuthStatus: () => ({ found: true, accountId: "acc-1" }),
    }));

    const stream = makeSSEStream([]); // empty stream

    mockProxyFetch.mockResolvedValue({ ok: true, body: stream });

    vi.resetModules();
    const { plannerStream } = await import("@/lib/meta-agent/planner");

    const result = await plannerStream(
      [{ role: "user", content: "Hi" }],
      () => {},
      codexDeps(),
    );

    expect(result.type).toBe("message");
    expect(result.content).toBe("I need a moment. Try again.");
  });
});

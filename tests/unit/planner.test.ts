import { describe, expect, it, vi } from "vitest";
import type { PlannerMessage } from "@/lib/meta-agent/planner";

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

// Force the "config" path (not "codex") so tests use the OpenAI Chat Completions mock
vi.mock("@/server/config", () => ({
  getConfig: () => ({
    openaiApiKey: "sk-test",
    openaiBaseUrl: "https://api.openai.com/v1",
    model: "gpt-5.4-mini",
    databaseUrl: "",
  }),
  getApiKeySource: () => "config" as const,
}));

vi.mock("@/server/codex-auth", () => ({
  getCodexAccessToken: () => null,
  getCodexAuthStatus: () => ({ found: false, accountId: null }),
}));

vi.mock("@/server/proxy-fetch", () => ({
  proxyFetch: vi.fn(),
}));

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

    const result = await plannerStream(messages, (token) => tokens.push(token));

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

    const result = await plannerStream(messages, (token) => tokens.push(token));

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
    const result = await plannerStream(messages, () => {});

    expect(result.type).toBe("message");
    expect(result.content).toBe("I need a moment. Try again.");
  });
});

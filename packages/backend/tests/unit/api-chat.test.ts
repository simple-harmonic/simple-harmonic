import { describe, expect, it, vi } from "vitest";

// Mock plannerStream — use inline function to avoid hoisting issues
vi.mock("@/lib/meta-agent", () => ({
  plannerStream: vi.fn(),
}));

// Import after mock setup
import { plannerStream } from "@/lib/meta-agent";
import { POST } from "@/server/api/chat";

const mockPlannerStream = vi.mocked(plannerStream);

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

async function readSSE(response: Response): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: string[] = [];
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      if (part.startsWith("data: ")) {
        events.push(part.slice(6));
      }
    }
  }
  return events;
}

describe("POST /api/chat", () => {
  it("returns 400 when messages is missing", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toContain("messages required");
  });

  it("returns 400 when messages is empty array", async () => {
    const res = await POST(makeReq({ messages: [] }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when messages is not an array", async () => {
    const res = await POST(makeReq({ messages: "not array" }));
    expect(res.status).toBe(400);
  });

  it("streams tokens and returns done event for message result", async () => {
    mockPlannerStream.mockImplementation(async (_msgs, onToken) => {
      onToken("Hello");
      onToken(" world");
      return { type: "message", content: "Hello world" };
    });

    const res = await POST(makeReq({ messages: [{ role: "user", content: "Hi" }] }));

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const events = await readSSE(res);
    expect(events.length).toBeGreaterThanOrEqual(3);

    const tokenEvents = events
      .map((e) => JSON.parse(e))
      .filter((e: { type: string }) => e.type === "token");
    expect(tokenEvents).toHaveLength(2);
    expect(tokenEvents[0].text).toBe("Hello");
    expect(tokenEvents[1].text).toBe(" world");

    const doneEvent = events
      .map((e) => JSON.parse(e))
      .find((e: { type: string }) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent.content).toBe("Hello world");
  });

  it("streams spawn event when planner returns spawn result", async () => {
    mockPlannerStream.mockImplementation(async (_msgs, onToken) => {
      onToken("Setting up");
      return {
        type: "spawn",
        content: "Setting up",
        result: {
          team_name: "Test Team",
          cofounder_name: "Atlas",
          agents: [{ name: "bot", role: "Bot", archetype: "ops-monitor", tools: [], schedule_seconds: 300, initial_prompt: "Go." }],
        },
      };
    });

    const res = await POST(makeReq({ messages: [{ role: "user", content: "Go" }] }));
    const events = await readSSE(res);

    const spawnEvent = events
      .map((e) => JSON.parse(e))
      .find((e: { type: string }) => e.type === "spawn");
    expect(spawnEvent).toBeDefined();
    expect(spawnEvent.teamName).toBe("Test Team");
    expect(spawnEvent.cofounderName).toBe("Atlas");
    expect(spawnEvent.agents).toHaveLength(1);
  });

  it("streams error event when planner throws", async () => {
    mockPlannerStream.mockRejectedValue(new Error("API key invalid"));

    const res = await POST(makeReq({ messages: [{ role: "user", content: "Hi" }] }));
    const events = await readSSE(res);

    const errorEvent = events
      .map((e) => JSON.parse(e))
      .find((e: { type: string }) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toContain("API key invalid");
  });

  it("streams error event with fallback for non-Error throws", async () => {
    mockPlannerStream.mockRejectedValue("string error");

    const res = await POST(makeReq({ messages: [{ role: "user", content: "Hi" }] }));
    const events = await readSSE(res);

    const errorEvent = events
      .map((e) => JSON.parse(e))
      .find((e: { type: string }) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toBe("Unknown error");
  });

  it("returns spawn event with null cofounder_name when not provided", async () => {
    mockPlannerStream.mockImplementation(async () => ({
      type: "spawn",
      content: "",
      result: {
        team_name: "No Cofounder Team",
        agents: [{ name: "bot", role: "Bot", archetype: "ops-monitor", tools: [], schedule_seconds: 300, initial_prompt: "Go." }],
      },
    }));

    const res = await POST(makeReq({ messages: [{ role: "user", content: "Go" }] }));
    const events = await readSSE(res);

    const spawnEvent = events
      .map((e) => JSON.parse(e))
      .find((e: { type: string }) => e.type === "spawn");
    expect(spawnEvent.cofounderName).toBeNull();
  });
});

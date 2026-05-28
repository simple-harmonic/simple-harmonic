import { describe, expect, it, vi } from "vitest";

// Mock db and schema
const mockExecute = vi.fn();
const mockDb = { execute: mockExecute };

vi.mock("@/server/db", () => ({
  db: () => mockDb,
}));

vi.mock("@/server/db/schema", () => ({}));

vi.mock("drizzle-orm", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

vi.mock("@/lib/meta-agent/identity", () => ({
  COFOUNDER_AGENT_ID: "00000000-0000-0000-0000-00000000c0f0",
  USER_AGENT_ID: "00000000-0000-0000-0000-00000000fffe",
  USER_DISPLAY_NAME: "You",
  resolveCofounderName: (name: string | null) => name?.trim() || "Harmon",
}));

import { GET } from "@/app/api/team/[id]/agent-hub/route";

function makeReq(agentId?: string): Request {
  const url = agentId
    ? `http://localhost/api/team/team-1/agent-hub?agentId=${agentId}`
    : "http://localhost/api/team/team-1/agent-hub";
  return new Request(url);
}

function makeParams(id = "team-1") {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/team/[id]/agent-hub", () => {
  it("returns 400 when agentId is missing", async () => {
    const res = await GET(makeReq(), makeParams());
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("agentId");
  });

  it("returns 404 when agent not found in results", async () => {
    mockExecute.mockResolvedValue({
      rows: [{
        data: {
          agents: [{ id: "other-agent", name: "Other", role: "Test", status: "running", schedule_seconds: 300, next_run_at: null, in_flight: false }],
          cofounderName: null,
          actions: [],
          messages: [],
        },
      }],
    });

    const res = await GET(makeReq("missing-agent"), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns agent hub data with timeline", async () => {
    const now = new Date().toISOString();
    mockExecute.mockResolvedValue({
      rows: [{
        data: {
          agents: [
            { id: "agent-1", name: "ops-monitor", role: "Monitors ops", status: "running", schedule_seconds: 300, next_run_at: now, in_flight: false },
            { id: "agent-2", name: "content-scheduler", role: "Content", status: "running", schedule_seconds: 600, next_run_at: null, in_flight: false },
          ],
          cofounderName: "Atlas",
          actions: [
            { id: "act-1", action_type: "scan", payload: { summary: "scanned" }, executed_at: now },
          ],
          messages: [
            { id: "msg-1", channel_type: "broadcast", channel_id: "broadcast:team-1", from_agent_id: "agent-2", kind: "text", content: "Hello", created_at: now },
          ],
        },
      }],
    });

    const res = await GET(makeReq("agent-1"), makeParams());
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.agentId).toBe("agent-1");
    expect(data.agentName).toBe("ops-monitor");
    expect(data.agentRole).toBe("Monitors ops");
    expect(data.agentStatus).toBe("running");
    expect(data.agentSchedule).toBe(300);
    expect(data.nextRunAt).toBe(now);
    expect(data.inFlight).toBe(false);
    expect(data.timeline).toHaveLength(2); // 1 action + 1 broadcast message
  });

  it("filters out messages sent by the agent itself", async () => {
    const now = new Date().toISOString();
    mockExecute.mockResolvedValue({
      rows: [{
        data: {
          agents: [
            { id: "agent-1", name: "bot", role: "Bot", status: "running", schedule_seconds: 300, next_run_at: null, in_flight: false },
          ],
          cofounderName: null,
          actions: [],
          messages: [
            { id: "msg-self", channel_type: "broadcast", channel_id: "broadcast:team-1", from_agent_id: "agent-1", kind: "text", content: "My own msg", created_at: now },
            { id: "msg-other", channel_type: "broadcast", channel_id: "broadcast:team-1", from_agent_id: "agent-2", kind: "text", content: "From other", created_at: now },
          ],
        },
      }],
    });

    const res = await GET(makeReq("agent-1"), makeParams());
    const data = await res.json();

    // Only the broadcast from agent-2 should appear (self messages filtered out)
    const receivedMsgs = data.timeline.filter((t: { type: string }) => t.type === "received");
    expect(receivedMsgs).toHaveLength(1);
    expect(receivedMsgs[0].content).toBe("From other");
  });

  it("includes direct messages to the agent in timeline", async () => {
    const now = new Date().toISOString();
    mockExecute.mockResolvedValue({
      rows: [{
        data: {
          agents: [
            { id: "agent-1", name: "bot", role: "Bot", status: "running", schedule_seconds: 300, next_run_at: null, in_flight: false },
          ],
          cofounderName: null,
          actions: [],
          messages: [
            { id: "msg-dm", channel_type: "direct", channel_id: "dm:agent-2:agent-1", from_agent_id: "agent-2", kind: "text", content: "DM to you", created_at: now },
            { id: "msg-other-dm", channel_type: "direct", channel_id: "dm:agent-2:agent-3", from_agent_id: "agent-2", kind: "text", content: "Not for me", created_at: now },
          ],
        },
      }],
    });

    const res = await GET(makeReq("agent-1"), makeParams());
    const data = await res.json();

    const received = data.timeline.filter((t: { type: string }) => t.type === "received");
    expect(received).toHaveLength(1);
    expect(received[0].content).toBe("DM to you");
  });

  it("resolves cofounder name in message sender names", async () => {
    const now = new Date().toISOString();
    const cofounderId = "00000000-0000-0000-0000-00000000c0f0";
    mockExecute.mockResolvedValue({
      rows: [{
        data: {
          agents: [
            { id: "agent-1", name: "bot", role: "Bot", status: "running", schedule_seconds: 300, next_run_at: null, in_flight: false },
          ],
          cofounderName: "Atlas",
          actions: [],
          messages: [
            { id: "msg-cof", channel_type: "broadcast", channel_id: "broadcast:team-1", from_agent_id: cofounderId, kind: "text", content: "From cofounder", created_at: now },
          ],
        },
      }],
    });

    const res = await GET(makeReq("agent-1"), makeParams());
    const data = await res.json();

    const received = data.timeline.filter((t: { type: string }) => t.type === "received");
    expect(received[0].fromName).toBe("Atlas");
  });

  it("sorts timeline by timestamp ascending", async () => {
    const t1 = "2025-01-01T00:01:00Z";
    const t2 = "2025-01-01T00:02:00Z";
    const t3 = "2025-01-01T00:03:00Z";

    mockExecute.mockResolvedValue({
      rows: [{
        data: {
          agents: [
            { id: "agent-1", name: "bot", role: "Bot", status: "running", schedule_seconds: 300, next_run_at: null, in_flight: false },
          ],
          cofounderName: null,
          // Actions in reverse order
          actions: [
            { id: "act-2", action_type: "late", payload: {}, executed_at: t3 },
            { id: "act-1", action_type: "early", payload: {}, executed_at: t1 },
          ],
          messages: [
            { id: "msg-1", channel_type: "broadcast", channel_id: "broadcast:team-1", from_agent_id: "agent-2", kind: "text", content: "mid", created_at: t2 },
          ],
        },
      }],
    });

    const res = await GET(makeReq("agent-1"), makeParams());
    const data = await res.json();

    expect(data.timeline).toHaveLength(3);
    expect(data.timeline[0].timestamp).toBe(t1);
    expect(data.timeline[1].timestamp).toBe(t2);
    expect(data.timeline[2].timestamp).toBe(t3);
  });

  it("returns null for nextRunAt when agent has none", async () => {
    mockExecute.mockResolvedValue({
      rows: [{
        data: {
          agents: [
            { id: "agent-1", name: "bot", role: "Bot", status: "running", schedule_seconds: 300, next_run_at: null, in_flight: false },
          ],
          cofounderName: null,
          actions: [],
          messages: [],
        },
      }],
    });

    const res = await GET(makeReq("agent-1"), makeParams());
    const data = await res.json();
    expect(data.nextRunAt).toBeNull();
  });
});

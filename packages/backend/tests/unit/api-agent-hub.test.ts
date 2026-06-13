import { describe, expect, it } from "vitest";
import { COFOUNDER_AGENT_ID } from "@/lib/meta-agent/identity";
import { getA2AX } from "@/server/a2ax";
import { actionLog, agents, teams } from "@/server/store";
import { useTempStore } from "../helpers/store";

// GET /api/team/[id]/agent-hub?agentId= returns the agent's fields plus a merged
// timeline of action-log entries and received (and, for the cofounder/user,
// sent) a2ax messages. Run against the real file store: seed a team + agents,
// add actionLog entries and a2ax messages, then assert on the timeline.

function makeReq(teamId: string, agentId?: string): Request {
  const url = agentId
    ? `http://localhost/api/team/${teamId}/agent-hub?agentId=${agentId}`
    : `http://localhost/api/team/${teamId}/agent-hub`;
  return new Request(url);
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function seed(teamOverrides: Record<string, unknown> = {}) {
  const team = await teams.insert({ name: "Test Team", ...teamOverrides });
  const bot = await agents.insert(team.id, {
    name: "ops-monitor",
    role: "Monitors ops",
    archetype: "monitor",
    tools: [],
    scheduleSeconds: 300,
    initialPrompt: "p",
  });
  const other = await agents.insert(team.id, {
    name: "content-scheduler",
    role: "Content",
    archetype: "scheduler",
    tools: [],
    scheduleSeconds: 600,
    initialPrompt: "p",
  });
  return { team, bot, other };
}

describe("GET /api/team/[id]/agent-hub", () => {
  useTempStore();

  it("returns 400 when agentId is missing", async () => {
    const { GET } = await import("@/server/api/team/id/agent-hub");
    const { team } = await seed();

    const res = await GET(makeReq(team.id), makeParams(team.id));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toContain("agentId");
  });

  it("returns 404 when the agent is not found", async () => {
    const { GET } = await import("@/server/api/team/id/agent-hub");
    const { team } = await seed();

    const res = await GET(makeReq(team.id, "missing-agent"), makeParams(team.id));
    expect(res.status).toBe(404);
  });

  it("returns agent fields and a timeline of actions + received messages", async () => {
    const { GET } = await import("@/server/api/team/id/agent-hub");
    const { team, bot, other } = await seed();

    await actionLog.insert(bot.id, {
      actionType: "scan",
      payload: { summary: "scanned" },
    });
    // A broadcast from another agent is "received" by the bot.
    await getA2AX().broadcast(team.id, other.id, "Hello");

    const res = await GET(makeReq(team.id, bot.id), makeParams(team.id));
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      agentId: string;
      agentName: string;
      agentRole: string;
      agentStatus: string;
      agentSchedule: number;
      inFlight: boolean;
      timeline: Array<{ type: string }>;
    };

    expect(data.agentId).toBe(bot.id);
    expect(data.agentName).toBe("ops-monitor");
    expect(data.agentRole).toBe("Monitors ops");
    expect(data.agentStatus).toBe("running");
    expect(data.agentSchedule).toBe(300);
    expect(data.inFlight).toBe(false);
    // 1 action + 1 broadcast.
    expect(data.timeline).toHaveLength(2);
    const types = data.timeline.map((t) => t.type).sort();
    expect(types).toEqual(["action", "received"]);
  });

  it("filters out messages sent by the agent itself", async () => {
    const { GET } = await import("@/server/api/team/id/agent-hub");
    const { team, bot, other } = await seed();

    await getA2AX().broadcast(team.id, bot.id, "My own msg");
    await getA2AX().broadcast(team.id, other.id, "From other");

    const res = await GET(makeReq(team.id, bot.id), makeParams(team.id));
    const data = (await res.json()) as {
      timeline: Array<{ type: string; content?: string }>;
    };

    const received = data.timeline.filter((t) => t.type === "received");
    expect(received).toHaveLength(1);
    expect(received[0].content).toBe("From other");
  });

  it("includes direct messages addressed to the agent and excludes others'", async () => {
    const { GET } = await import("@/server/api/team/id/agent-hub");
    const { team, bot, other } = await seed();
    const thirdParty = "agent-3";

    // DM to the bot (channel id includes the bot's id) -> received.
    await getA2AX().sendDirect(team.id, other.id, bot.id, "DM to you");
    // DM between two other agents (channel id excludes the bot) -> not received.
    await getA2AX().sendDirect(team.id, other.id, thirdParty, "Not for me");

    const res = await GET(makeReq(team.id, bot.id), makeParams(team.id));
    const data = (await res.json()) as {
      timeline: Array<{ type: string; content?: string }>;
    };

    const received = data.timeline.filter((t) => t.type === "received");
    expect(received).toHaveLength(1);
    expect(received[0].content).toBe("DM to you");
  });

  it("resolves the cofounder name in received-message sender names", async () => {
    const { GET } = await import("@/server/api/team/id/agent-hub");
    const { team, bot } = await seed({ cofounderName: "Atlas" });

    await getA2AX().broadcast(team.id, COFOUNDER_AGENT_ID, "From cofounder");

    const res = await GET(makeReq(team.id, bot.id), makeParams(team.id));
    const data = (await res.json()) as {
      timeline: Array<{ type: string; fromName?: string }>;
    };

    const received = data.timeline.filter((t) => t.type === "received");
    expect(received).toHaveLength(1);
    expect(received[0].fromName).toBe("Atlas");
  });

  it("sorts the timeline by timestamp ascending", async () => {
    const { GET } = await import("@/server/api/team/id/agent-hub");
    const { team, bot, other } = await seed();

    // Insert an action, then a message, then another action — out of order in
    // time but the route must return them oldest-first.
    await actionLog.insert(bot.id, { actionType: "early", payload: {} });
    await new Promise((r) => setTimeout(r, 5));
    await getA2AX().broadcast(team.id, other.id, "mid");
    await new Promise((r) => setTimeout(r, 5));
    await actionLog.insert(bot.id, { actionType: "late", payload: {} });

    const res = await GET(makeReq(team.id, bot.id), makeParams(team.id));
    const data = (await res.json()) as {
      timeline: Array<{ timestamp: string; type: string; actionType?: string; content?: string }>;
    };

    expect(data.timeline).toHaveLength(3);
    const timestamps = data.timeline.map((t) => new Date(t.timestamp).getTime());
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    expect(data.timeline[0].actionType).toBe("early");
    expect(data.timeline[1].content).toBe("mid");
    expect(data.timeline[2].actionType).toBe("late");
  });

  it("returns null for nextRunAt when the agent has none", async () => {
    const { GET } = await import("@/server/api/team/id/agent-hub");
    const { team, bot } = await seed();

    const res = await GET(makeReq(team.id, bot.id), makeParams(team.id));
    const data = (await res.json()) as { nextRunAt: string | null };
    expect(data.nextRunAt).toBeNull();
  });

  it("includes the agent's action payload in the timeline", async () => {
    const { GET } = await import("@/server/api/team/id/agent-hub");
    const { team, bot } = await seed();

    await actionLog.insert(bot.id, {
      actionType: "scan",
      payload: { summary: "scanned 3 repos", count: 3 },
    });

    const res = await GET(makeReq(team.id, bot.id), makeParams(team.id));
    const data = (await res.json()) as {
      timeline: Array<{ type: string; actionType?: string; payload?: Record<string, unknown> }>;
    };

    const action = data.timeline.find((t) => t.type === "action");
    expect(action?.actionType).toBe("scan");
    expect(action?.payload).toEqual({ summary: "scanned 3 repos", count: 3 });
  });
});

import { describe, expect, it } from "vitest";
import { COFOUNDER_AGENT_ID, USER_AGENT_ID } from "@/lib/meta-agent/identity";
import { getA2AX } from "@/server/a2ax";
import { agents, teams } from "@/server/store";
import { useTempStore } from "../helpers/store";

// GET /api/team/[id]/conversations groups a2ax messages into per-channel threads
// for a participant's point of view. Run against the real file store: seed a
// team + agents, send messages via getA2AX(), call GET with ?agentId=, and
// assert on the threads/messages in the JSON response.

type ConversationMessage = {
  id: string;
  isSelf: boolean;
  fromAgentId: string;
  fromAgentName: string;
  content: string;
  createdAt: string;
};

type ConversationThread = {
  channelId: string;
  channelType: string;
  peerAgentId: string | null;
  peerAgentName: string | null;
  messages: ConversationMessage[];
};

type ConversationsBody = {
  error?: string;
  agentId: string;
  agentName: string;
  threads: ConversationThread[];
};

function makeReq(teamId: string, agentId?: string): Request {
  const url = agentId
    ? `http://localhost/api/team/${teamId}/conversations?agentId=${agentId}`
    : `http://localhost/api/team/${teamId}/conversations`;
  return new Request(url);
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function seed(teamOverrides: Record<string, unknown> = {}) {
  const team = await teams.insert({ name: "Test Team", ...teamOverrides });
  const researcher = await agents.insert(team.id, {
    name: "Researcher",
    role: "research",
    archetype: "researcher",
    tools: [],
    scheduleSeconds: 10,
    initialPrompt: "p",
  });
  const writer = await agents.insert(team.id, {
    name: "Writer",
    role: "write",
    archetype: "writer",
    tools: [],
    scheduleSeconds: 10,
    initialPrompt: "p",
  });
  return { team, researcher, writer };
}

describe("GET /api/team/[id]/conversations", () => {
  useTempStore();

  it("returns 400 when agentId is missing", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team } = await seed();

    const res = await GET(makeReq(team.id), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    expect(res.status).toBe(400);
    expect(body.error).toBe("agentId query param required");
  });

  it("returns empty threads when no messages exist", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team, researcher } = await seed();

    const res = await GET(makeReq(team.id, researcher.id), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    expect(res.status).toBe(200);
    expect(body.agentId).toBe(researcher.id);
    expect(body.threads).toEqual([]);
  });

  it("translates 'cofounder' agentId and marks the cofounder's messages isSelf", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team, researcher } = await seed();

    await getA2AX().sendDirect(team.id, COFOUNDER_AGENT_ID, researcher.id, "hi from cofounder");

    const res = await GET(makeReq(team.id, "cofounder"), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    expect(res.status).toBe(200);
    expect(body.agentId).toBe("cofounder");
    expect(body.agentName).toBe("Harmon");
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].messages[0].isSelf).toBe(true);
  });

  it("translates 'user' agentId and resolves the display name", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team, researcher } = await seed();

    await getA2AX().sendDirect(team.id, USER_AGENT_ID, researcher.id, "hi from user");

    const res = await GET(makeReq(team.id, "user"), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    expect(res.status).toBe(200);
    expect(body.agentName).toBe("You");
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].messages[0].isSelf).toBe(true);
  });

  it("'team' agentId shows all messages with isSelf false", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team, researcher, writer } = await seed();
    const a2ax = getA2AX();

    await a2ax.broadcast(team.id, researcher.id, "all hands");
    await a2ax.sendDirect(team.id, researcher.id, writer.id, "direct note");

    const res = await GET(makeReq(team.id, "team"), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    expect(res.status).toBe(200);
    expect(body.agentName).toBe("Team Overview");
    expect(body.threads).toHaveLength(2);
    for (const thread of body.threads) {
      for (const m of thread.messages) {
        expect(m.isSelf).toBe(false);
      }
    }
  });

  it("team overview shows both names for direct channels", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team, researcher, writer } = await seed();

    await getA2AX().sendDirect(team.id, researcher.id, writer.id, "direct note");

    const res = await GET(makeReq(team.id, "team"), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    const thread = body.threads[0];
    // Names appear in sorted-id order; assert both are present around the arrow.
    expect(thread.peerAgentName).toContain("Researcher");
    expect(thread.peerAgentName).toContain("Writer");
    expect(thread.peerAgentName).toContain("↔");
  });

  it("specific agent sees peer name and peer id in direct channels", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team, researcher, writer } = await seed();

    await getA2AX().sendDirect(team.id, researcher.id, writer.id, "hi writer");

    const res = await GET(makeReq(team.id, researcher.id), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    const thread = body.threads[0];
    expect(thread.peerAgentId).toBe(writer.id);
    expect(thread.peerAgentName).toBe("Writer");
  });

  it("broadcast threads have peerAgentName 'Team Broadcast'", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team, researcher, writer } = await seed();

    await getA2AX().broadcast(team.id, researcher.id, "all hands");

    // Broadcast is visible to any participant.
    const res = await GET(makeReq(team.id, writer.id), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].peerAgentName).toBe("Team Broadcast");
    expect(body.threads[0].channelType).toBe("broadcast");
  });

  it("group threads have peerAgentName 'Group Chat'", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team, researcher, writer } = await seed();
    const a2ax = getA2AX();

    const { channelId } = await a2ax.createGroup(team.id, "Dev Team", [
      researcher.id,
      writer.id,
    ]);
    await a2ax.sendToGroup(team.id, channelId, researcher.id, "group ping");

    // Group channel ids are opaque (group:<uuid>), so they only surface in the
    // team overview (which sees every channel), not a specific agent's filter.
    const res = await GET(makeReq(team.id, "team"), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    const groupThread = body.threads.find((t) => t.channelType === "group");
    expect(groupThread).toBeDefined();
    expect(groupThread?.peerAgentName).toBe("Group Chat");
  });

  it("task threads resolve to the task title", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team, researcher, writer } = await seed();
    const a2ax = getA2AX();

    await a2ax.createTask({
      teamId: team.id,
      requestorId: researcher.id,
      assigneeId: writer.id,
      title: "Research Q4 trends",
      description: "d",
    });

    const res = await GET(makeReq(team.id, "team"), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    const taskThread = body.threads.find((t) => t.channelType === "task");
    expect(taskThread).toBeDefined();
    expect(taskThread?.peerAgentName).toBe("Research Q4 trends");
  });

  it("filters messages for a specific agent (non-team)", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team, researcher, writer } = await seed();
    const a2ax = getA2AX();
    const stranger = "cccc-3333";

    // Direct between stranger and writer (NOT visible to researcher).
    await a2ax.sendDirect(team.id, stranger, writer.id, "between others");
    // Broadcast (always visible).
    await a2ax.broadcast(team.id, writer.id, "all hands");
    // Direct involving the researcher (visible).
    await a2ax.sendDirect(team.id, researcher.id, writer.id, "for researcher");

    const res = await GET(makeReq(team.id, researcher.id), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    // Researcher sees broadcast + their own direct, NOT the stranger↔writer one.
    expect(body.threads).toHaveLength(2);
    const channelTypes = body.threads.map((t) => t.channelType);
    expect(channelTypes).toContain("broadcast");
    expect(channelTypes).toContain("direct");
  });

  it("groups multiple messages into the same thread by channelId", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team, researcher, writer } = await seed();
    const a2ax = getA2AX();

    const m1 = await a2ax.sendDirect(team.id, researcher.id, writer.id, "first");
    const m2 = await a2ax.sendDirect(team.id, writer.id, researcher.id, "second");

    const res = await GET(makeReq(team.id, researcher.id), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    expect(body.threads).toHaveLength(1);
    const ids = body.threads[0].messages.map((m) => m.id);
    expect(ids).toEqual([m1.id, m2.id]);
  });

  it("sorts threads by last message timestamp descending", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team, researcher, writer } = await seed();
    const a2ax = getA2AX();

    // Broadcast first (older), then a direct message (newer last activity).
    await a2ax.broadcast(team.id, writer.id, "older broadcast");
    await new Promise((r) => setTimeout(r, 5));
    await a2ax.sendDirect(team.id, researcher.id, writer.id, "newer direct");

    const res = await GET(makeReq(team.id, researcher.id), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    expect(body.threads).toHaveLength(2);
    expect(body.threads[0].channelType).toBe("direct");
    expect(body.threads[1].channelType).toBe("broadcast");
  });

  it("isSelf is true only for messages from the participant", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team, researcher, writer } = await seed();
    const a2ax = getA2AX();

    const fromSelf = await a2ax.sendDirect(team.id, researcher.id, writer.id, "mine");
    const fromPeer = await a2ax.sendDirect(team.id, writer.id, researcher.id, "theirs");

    const res = await GET(makeReq(team.id, researcher.id), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    const byId = Object.fromEntries(
      body.threads[0].messages.map((m) => [m.id, m]),
    );
    expect(byId[fromSelf.id].isSelf).toBe(true);
    expect(byId[fromPeer.id].isSelf).toBe(false);
  });

  it("resolves fromAgentName from the name map", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team, researcher } = await seed();

    await getA2AX().broadcast(team.id, researcher.id, "all hands");

    const res = await GET(makeReq(team.id, researcher.id), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    expect(body.threads[0].messages[0].fromAgentName).toBe("Researcher");
  });

  it("falls back to the raw fromAgentId when the name is unknown", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team } = await seed();

    const unknownId = "unknown-agent-9999";
    await getA2AX().broadcast(team.id, unknownId, "all hands");

    const res = await GET(makeReq(team.id, "team"), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    expect(body.threads[0].messages[0].fromAgentName).toBe(unknownId);
  });

  it("uses a custom cofounder name from the team row", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team } = await seed({ cofounderName: "Ada" });

    await getA2AX().broadcast(team.id, COFOUNDER_AGENT_ID, "from cofounder");

    const res = await GET(makeReq(team.id, "cofounder"), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    expect(body.agentName).toBe("Ada");
    expect(body.threads[0].messages[0].fromAgentName).toBe("Ada");
  });

  it("serializes message createdAt as an ISO string", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team, researcher } = await seed();

    await getA2AX().broadcast(team.id, researcher.id, "all hands");

    const res = await GET(makeReq(team.id, "team"), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    const createdAt = body.threads[0].messages[0].createdAt;
    expect(new Date(createdAt).toISOString()).toBe(createdAt);
  });

  it("surfaces a task thread to a participating agent", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team, researcher, writer } = await seed();

    // createTask emits a task.create message authored by the requestor, so the
    // requesting agent sees the task thread in their conversation view.
    await getA2AX().createTask({
      teamId: team.id,
      requestorId: researcher.id,
      assigneeId: writer.id,
      title: "Joint task",
      description: "d",
    });

    const res = await GET(makeReq(team.id, researcher.id), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    const taskThread = body.threads.find((t) => t.channelType === "task");
    expect(taskThread).toBeDefined();
    expect(taskThread?.peerAgentName).toBe("Joint task");
  });

  it("displayName falls back to the participant id when not in the name map", async () => {
    const { GET } = await import("@/server/api/team/id/conversations");
    const { team } = await seed();

    const unknownAgentId = "unknown-id-xyz";
    const res = await GET(makeReq(team.id, unknownAgentId), makeParams(team.id));
    const body = (await res.json()) as ConversationsBody;

    expect(body.agentName).toBe(unknownAgentId);
  });
});

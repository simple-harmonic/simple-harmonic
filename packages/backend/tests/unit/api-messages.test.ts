import { describe, expect, it } from "vitest";
import { COFOUNDER_AGENT_ID, USER_AGENT_ID } from "@/lib/meta-agent/identity";
import { getA2AX } from "@/server/a2ax";
import { agents, teams } from "@/server/store";
import { useTempStore } from "../helpers/store";

// GET /api/team/[id]/messages returns getAgentContext messages enriched with
// sender names. POST sends a message via a2ax. Both run against the real file
// store: seed a team + agents, exercise the route, assert on the JSON response
// and the resulting store state.

function makeGetReq(teamId: string, agentId?: string): Request {
  const url = agentId
    ? `http://localhost/api/team/${teamId}/messages?agentId=${agentId}`
    : `http://localhost/api/team/${teamId}/messages`;
  return new Request(url);
}

function makePostReq(teamId: string, body: Record<string, unknown>): Request {
  return new Request(`http://localhost/api/team/${teamId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function seed() {
  const team = await teams.insert({ name: "Test Team" });
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

// ===========================================================================
// GET /api/team/[id]/messages
// ===========================================================================

describe("GET /api/team/[id]/messages", () => {
  useTempStore();

  it("returns 400 when agentId is missing", async () => {
    const { GET } = await import("@/server/api/team/id/messages");
    const { team } = await seed();

    const res = await GET(makeGetReq(team.id), makeParams(team.id));
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("agentId query param required");
  });

  it("returns enriched messages with agent names", async () => {
    const { GET } = await import("@/server/api/team/id/messages");
    const { team, researcher, writer } = await seed();
    const a2ax = getA2AX();

    // The writer's context: a direct message from the researcher to the writer.
    await a2ax.sendDirect(team.id, researcher.id, writer.id, "hello writer");

    const res = await GET(makeGetReq(team.id, writer.id), makeParams(team.id));
    const body = (await res.json()) as Array<{
      content: string;
      fromAgentId: string;
      fromAgentName: string;
    }>;

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].content).toBe("hello writer");
    expect(body[0].fromAgentId).toBe(researcher.id);
    expect(body[0].fromAgentName).toBe("Researcher");
  });

  it("falls back to fromAgentId when name not found", async () => {
    const { GET } = await import("@/server/api/team/id/messages");
    const { team, writer } = await seed();
    const a2ax = getA2AX();

    const strangerId = "stranger-agent-xyz";
    await a2ax.sendDirect(team.id, strangerId, writer.id, "from stranger");

    const res = await GET(makeGetReq(team.id, writer.id), makeParams(team.id));
    const body = (await res.json()) as Array<{ fromAgentName: string }>;

    expect(body[0].fromAgentName).toBe(strangerId);
  });

  it("scopes context to the requested agent", async () => {
    const { GET } = await import("@/server/api/team/id/messages");
    const { team, researcher, writer } = await seed();
    const a2ax = getA2AX();

    // Message to the writer; the researcher should not see it in their context.
    await a2ax.sendDirect(team.id, researcher.id, writer.id, "for writer only");

    const res = await GET(makeGetReq(team.id, researcher.id), makeParams(team.id));
    const body = (await res.json()) as unknown[];

    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });

  it("returns empty array when no messages exist", async () => {
    const { GET } = await import("@/server/api/team/id/messages");
    const { team, researcher } = await seed();

    const res = await GET(makeGetReq(team.id, researcher.id), makeParams(team.id));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });

  it("serializes createdAt as an ISO string and includes all message fields", async () => {
    const { GET } = await import("@/server/api/team/id/messages");
    const { team, researcher, writer } = await seed();
    const a2ax = getA2AX();

    // Broadcast reaches any other agent's context.
    await a2ax.broadcast(team.id, researcher.id, "hey all");

    const res = await GET(makeGetReq(team.id, writer.id), makeParams(team.id));
    const body = (await res.json()) as Array<{
      id: string;
      channelType: string;
      channelId: string;
      kind: string;
      content: string;
      status: string;
      createdAt: string;
    }>;

    expect(body).toHaveLength(1);
    const m = body[0];
    expect(m.channelType).toBe("broadcast");
    expect(m.kind).toBe("text");
    expect(m.content).toBe("hey all");
    expect(m.status).toBe("pending");
    // ISO-8601 round-trips back to the same instant.
    expect(new Date(m.createdAt).toISOString()).toBe(m.createdAt);
  });
});

// ===========================================================================
// POST /api/team/[id]/messages
// ===========================================================================

describe("POST /api/team/[id]/messages", () => {
  useTempStore();

  it("returns 400 when fromAgentId is missing", async () => {
    const { POST } = await import("@/server/api/team/id/messages");
    const { team } = await seed();

    const res = await POST(makePostReq(team.id, { content: "hello" }), makeParams(team.id));
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("fromAgentId and content required");
  });

  it("returns 400 when content is missing", async () => {
    const { POST } = await import("@/server/api/team/id/messages");
    const { team, researcher } = await seed();

    const res = await POST(
      makePostReq(team.id, { fromAgentId: researcher.id }),
      makeParams(team.id),
    );
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("fromAgentId and content required");
  });

  it("sends a broadcast message and persists it to the store", async () => {
    const { POST } = await import("@/server/api/team/id/messages");
    const { team, researcher } = await seed();

    const res = await POST(
      makePostReq(team.id, {
        fromAgentId: researcher.id,
        content: "hello all",
        channelType: "broadcast",
      }),
      makeParams(team.id),
    );
    const body = (await res.json()) as { channelType: string; fromAgentId: string };

    expect(res.status).toBe(201);
    expect(body.channelType).toBe("broadcast");
    expect(body.fromAgentId).toBe(researcher.id);

    const stored = await getA2AX().listMessages(team.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe("hello all");
    expect(stored[0].channelType).toBe("broadcast");
  });

  it("sends a direct message with toAgentId and persists it", async () => {
    const { POST } = await import("@/server/api/team/id/messages");
    const { team, researcher, writer } = await seed();

    const res = await POST(
      makePostReq(team.id, {
        fromAgentId: researcher.id,
        toAgentId: writer.id,
        content: "hi there",
        channelType: "direct",
      }),
      makeParams(team.id),
    );
    const body = (await res.json()) as { channelType: string };

    expect(res.status).toBe(201);
    expect(body.channelType).toBe("direct");

    const stored = await getA2AX().listMessages(team.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].fromAgentId).toBe(researcher.id);
    // The direct channel includes both participants.
    expect(stored[0].channelId).toContain(researcher.id);
    expect(stored[0].channelId).toContain(writer.id);
  });

  it("returns 400 for group message without channelId", async () => {
    const { POST } = await import("@/server/api/team/id/messages");
    const { team, researcher } = await seed();

    const res = await POST(
      makePostReq(team.id, {
        fromAgentId: researcher.id,
        content: "team update",
        channelType: "group",
      }),
      makeParams(team.id),
    );
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("channelId required for group messages");
  });

  it("returns 400 for direct message without toAgentId", async () => {
    const { POST } = await import("@/server/api/team/id/messages");
    const { team, researcher } = await seed();

    const res = await POST(
      makePostReq(team.id, {
        fromAgentId: researcher.id,
        content: "hi",
        channelType: "direct",
      }),
      makeParams(team.id),
    );
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("toAgentId required for direct messages");
  });

  it("defaults to direct when channelType is not specified", async () => {
    const { POST } = await import("@/server/api/team/id/messages");
    const { team, researcher, writer } = await seed();

    const res = await POST(
      makePostReq(team.id, {
        fromAgentId: researcher.id,
        toAgentId: writer.id,
        content: "default channel",
      }),
      makeParams(team.id),
    );
    const body = (await res.json()) as { channelType: string };

    expect(res.status).toBe(201);
    expect(body.channelType).toBe("direct");
  });

  it("translates 'cofounder' POV sentinel to COFOUNDER_AGENT_ID", async () => {
    const { POST } = await import("@/server/api/team/id/messages");
    const { team, researcher } = await seed();

    const res = await POST(
      makePostReq(team.id, {
        fromAgentId: "cofounder",
        toAgentId: researcher.id,
        content: "from cofounder",
        channelType: "direct",
      }),
      makeParams(team.id),
    );

    expect(res.status).toBe(201);
    const stored = await getA2AX().listMessages(team.id);
    expect(stored[0].fromAgentId).toBe(COFOUNDER_AGENT_ID);
  });

  it("translates 'user' POV sentinel to USER_AGENT_ID", async () => {
    const { POST } = await import("@/server/api/team/id/messages");
    const { team, writer } = await seed();

    const res = await POST(
      makePostReq(team.id, {
        fromAgentId: "user",
        toAgentId: writer.id,
        content: "from user",
        channelType: "direct",
      }),
      makeParams(team.id),
    );

    expect(res.status).toBe(201);
    const stored = await getA2AX().listMessages(team.id);
    expect(stored[0].fromAgentId).toBe(USER_AGENT_ID);
  });

  it("translates toAgentId POV sentinels as well", async () => {
    const { POST } = await import("@/server/api/team/id/messages");
    const { team, researcher } = await seed();

    const res = await POST(
      makePostReq(team.id, {
        fromAgentId: researcher.id,
        toAgentId: "cofounder",
        content: "to cofounder",
        channelType: "direct",
      }),
      makeParams(team.id),
    );

    expect(res.status).toBe(201);
    const stored = await getA2AX().listMessages(team.id);
    // Direct channel id is built from both participant ids (sorted).
    expect(stored[0].channelId).toContain(COFOUNDER_AGENT_ID);
    expect(stored[0].channelId).toContain(researcher.id);
  });
});

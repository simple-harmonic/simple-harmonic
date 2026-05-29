import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLimit = vi.fn().mockResolvedValue([]);
const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

const mockDb = {
  query: {
    teams: { findFirst: vi.fn() },
    agents: { findMany: vi.fn() },
  },
  select: mockSelect,
  from: mockFrom,
  where: mockWhere,
  orderBy: mockOrderBy,
  limit: mockLimit,
};

vi.mock("@/server/db", () => ({
  db: () => mockDb,
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ _eq: val })),
}));

vi.mock("@/server/db/schema", () => ({
  teams: { id: "teams.id" },
  agents: { teamId: "agents.teamId" },
  a2axMessages: {
    teamId: "a2axMessages.teamId",
    createdAt: "a2axMessages.createdAt",
  },
  a2axTasks: {
    id: "a2axTasks.id",
    title: "a2axTasks.title",
    teamId: "a2axTasks.teamId",
  },
}));

vi.mock("@/lib/meta-agent/identity", () => ({
  COFOUNDER_AGENT_ID: "00000000-0000-0000-0000-00000000c0f0",
  COFOUNDER_POV: "cofounder",
  USER_AGENT_ID: "00000000-0000-0000-0000-00000000fffe",
  USER_DISPLAY_NAME: "You",
  USER_POV: "user",
  resolveCofounderName: (name: string | null | undefined) =>
    name?.trim() || "Harmon",
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = "team-1";
const COFOUNDER_AGENT_ID = "00000000-0000-0000-0000-00000000c0f0";
const USER_AGENT_ID = "00000000-0000-0000-0000-00000000fffe";
const AGENT_A_ID = "aaaa-1111";
const AGENT_B_ID = "bbbb-2222";

const teamRow = {
  id: TEAM_ID,
  name: "Test Team",
  cofounderName: null,
};

const agentRows = [
  { id: AGENT_A_ID, name: "Researcher", teamId: TEAM_ID },
  { id: AGENT_B_ID, name: "Writer", teamId: TEAM_ID },
];

function makeMsg(overrides: Record<string, unknown>) {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 6)}`,
    teamId: TEAM_ID,
    channelType: "direct",
    channelId: `direct:${AGENT_A_ID}:${AGENT_B_ID}`,
    fromAgentId: AGENT_A_ID,
    content: "hello",
    kind: "text",
    status: "delivered",
    urgent: false,
    createdAt: new Date("2026-05-20T10:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(agentId?: string): Request {
  const url = agentId
    ? `http://localhost/api/team/team-1/conversations?agentId=${agentId}`
    : "http://localhost/api/team/team-1/conversations";
  return new Request(url);
}

function makeParams(id = "team-1") {
  return { params: Promise.resolve({ id }) };
}

// We need separate mock chains for the two select() calls (messages + tasks).
// The first select call fetches messages, the second fetches task titles.
let selectCallCount: number;

function setupSelectChains(
  messagesResult: unknown[],
  tasksResult: unknown[] = [],
) {
  selectCallCount = 0;

  const messagesLimit = vi.fn().mockResolvedValue(messagesResult);
  const messagesOrderBy = vi.fn().mockReturnValue({ limit: messagesLimit });
  const messagesWhere = vi
    .fn()
    .mockReturnValue({ orderBy: messagesOrderBy });
  const messagesFrom = vi.fn().mockReturnValue({ where: messagesWhere });

  const tasksWhere = vi.fn().mockResolvedValue(tasksResult);
  const tasksFrom = vi.fn().mockReturnValue({ where: tasksWhere });

  mockSelect.mockImplementation(() => {
    selectCallCount++;
    if (selectCallCount === 1) {
      return { from: messagesFrom };
    }
    // Second select: task titles (select({ id, title }))
    return { from: tasksFrom };
  });
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  selectCallCount = 0;
});

// ===========================================================================
// GET /api/team/[id]/conversations
// ===========================================================================

describe("GET /api/team/[id]/conversations", () => {
  it("returns 400 when agentId is missing", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );

    const res = await GET(makeReq(), makeParams());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("agentId query param required");
  });

  it("returns empty threads when no messages exist", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);
    setupSelectChains([], []);

    const res = await GET(makeReq(AGENT_A_ID), makeParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.agentId).toBe(AGENT_A_ID);
    expect(body.threads).toEqual([]);
  });

  it("translates 'cofounder' agentId to COFOUNDER_AGENT_ID", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);

    const msg = makeMsg({
      channelType: "direct",
      channelId: `direct:${COFOUNDER_AGENT_ID}:${AGENT_A_ID}`,
      fromAgentId: COFOUNDER_AGENT_ID,
    });
    setupSelectChains([msg], []);

    const res = await GET(makeReq("cofounder"), makeParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.agentId).toBe("cofounder");
    expect(body.agentName).toBe("Harmon");
    expect(body.threads).toHaveLength(1);
    // Message should have isSelf=true since cofounder sent it
    expect(body.threads[0].messages[0].isSelf).toBe(true);
  });

  it("translates 'user' agentId to USER_AGENT_ID", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);

    const msg = makeMsg({
      channelType: "direct",
      channelId: `direct:${USER_AGENT_ID}:${AGENT_A_ID}`,
      fromAgentId: USER_AGENT_ID,
    });
    setupSelectChains([msg], []);

    const res = await GET(makeReq("user"), makeParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.agentName).toBe("You");
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].messages[0].isSelf).toBe(true);
  });

  it("'team' agentId shows all messages (team overview)", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);

    const msg1 = makeMsg({
      id: "m1",
      channelType: "broadcast",
      channelId: "broadcast:team-1",
      fromAgentId: AGENT_A_ID,
    });
    const msg2 = makeMsg({
      id: "m2",
      channelType: "direct",
      channelId: `direct:${AGENT_A_ID}:${AGENT_B_ID}`,
      fromAgentId: AGENT_A_ID,
    });
    setupSelectChains([msg1, msg2], []);

    const res = await GET(makeReq("team"), makeParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.agentName).toBe("Team Overview");
    expect(body.threads).toHaveLength(2);
    // isSelf should be false for all messages in team overview
    for (const thread of body.threads) {
      for (const m of thread.messages) {
        expect(m.isSelf).toBe(false);
      }
    }
  });

  it("team overview shows both names for direct channels", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);

    const msg = makeMsg({
      channelType: "direct",
      channelId: `direct:${AGENT_A_ID}:${AGENT_B_ID}`,
      fromAgentId: AGENT_A_ID,
    });
    setupSelectChains([msg], []);

    const res = await GET(makeReq("team"), makeParams());
    const body = await res.json();

    const thread = body.threads[0];
    expect(thread.peerAgentName).toBe("Researcher ↔ Writer");
  });

  it("specific agent sees peer name in direct channels", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);

    const msg = makeMsg({
      channelType: "direct",
      channelId: `direct:${AGENT_A_ID}:${AGENT_B_ID}`,
      fromAgentId: AGENT_A_ID,
    });
    setupSelectChains([msg], []);

    const res = await GET(makeReq(AGENT_A_ID), makeParams());
    const body = await res.json();

    const thread = body.threads[0];
    // AGENT_A is the participant, so peer should be AGENT_B
    expect(thread.peerAgentId).toBe(AGENT_B_ID);
    expect(thread.peerAgentName).toBe("Writer");
  });

  it("broadcast messages have peerAgentName 'Team Broadcast'", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);

    const msg = makeMsg({
      channelType: "broadcast",
      channelId: "broadcast:team-1",
      fromAgentId: AGENT_A_ID,
    });
    setupSelectChains([msg], []);

    // Broadcast is always visible to any participant
    const res = await GET(makeReq(AGENT_B_ID), makeParams());
    const body = await res.json();

    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].peerAgentName).toBe("Team Broadcast");
    expect(body.threads[0].channelType).toBe("broadcast");
  });

  it("group messages have peerAgentName 'Group Chat'", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);

    const msg = makeMsg({
      channelType: "group",
      channelId: `group:${AGENT_A_ID}:${AGENT_B_ID}`,
      fromAgentId: AGENT_A_ID,
    });
    setupSelectChains([msg], []);

    const res = await GET(makeReq(AGENT_A_ID), makeParams());
    const body = await res.json();

    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].peerAgentName).toBe("Group Chat");
    expect(body.threads[0].channelType).toBe("group");
  });

  it("task channels resolve to task title", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);

    const taskId = "task-uuid-1";
    const msg = makeMsg({
      channelType: "task",
      channelId: `task:${taskId}`,
      fromAgentId: AGENT_A_ID,
    });
    setupSelectChains([msg], [{ id: taskId, title: "Research Q4 trends" }]);

    const res = await GET(makeReq("team"), makeParams());
    const body = await res.json();

    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].peerAgentName).toBe("Research Q4 trends");
  });

  it("task channel falls back to channelId when no title found", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);

    const msg = makeMsg({
      channelType: "task",
      channelId: "task:unknown-task-id",
      fromAgentId: AGENT_A_ID,
    });
    setupSelectChains([msg], []);

    const res = await GET(makeReq("team"), makeParams());
    const body = await res.json();

    expect(body.threads[0].peerAgentName).toBe("task:unknown-task-id");
  });

  it("filters messages for a specific agent (non-team)", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);

    const AGENT_C_ID = "cccc-3333";

    // Messages involving only C and B (not A)
    const msg1 = makeMsg({
      id: "m1",
      channelType: "direct",
      channelId: `direct:${AGENT_C_ID}:${AGENT_B_ID}`,
      fromAgentId: AGENT_C_ID,
    });
    // Broadcast is always visible
    const msg2 = makeMsg({
      id: "m2",
      channelType: "broadcast",
      channelId: "broadcast:team-1",
      fromAgentId: AGENT_B_ID,
    });
    // A message from A (visible to A)
    const msg3 = makeMsg({
      id: "m3",
      channelType: "direct",
      channelId: `direct:${AGENT_A_ID}:${AGENT_B_ID}`,
      fromAgentId: AGENT_A_ID,
    });
    setupSelectChains([msg1, msg2, msg3], []);

    const res = await GET(makeReq(AGENT_A_ID), makeParams());
    const body = await res.json();

    // A should see: broadcast + direct with A. NOT C-B direct.
    expect(body.threads).toHaveLength(2);
    const channelTypes = body.threads.map(
      (t: { channelType: string }) => t.channelType,
    );
    expect(channelTypes).toContain("broadcast");
    expect(channelTypes).toContain("direct");
  });

  it("groups multiple messages into the same thread by channelId", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);

    const channelId = `direct:${AGENT_A_ID}:${AGENT_B_ID}`;
    const msg1 = makeMsg({
      id: "m1",
      channelId,
      fromAgentId: AGENT_A_ID,
      createdAt: new Date("2026-05-20T10:00:00Z"),
    });
    const msg2 = makeMsg({
      id: "m2",
      channelId,
      fromAgentId: AGENT_B_ID,
      createdAt: new Date("2026-05-20T10:01:00Z"),
    });
    setupSelectChains([msg1, msg2], []);

    const res = await GET(makeReq(AGENT_A_ID), makeParams());
    const body = await res.json();

    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].messages).toHaveLength(2);
    expect(body.threads[0].messages[0].id).toBe("m1");
    expect(body.threads[0].messages[1].id).toBe("m2");
  });

  it("sorts threads by last message timestamp descending", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);

    const olderMsg = makeMsg({
      id: "m-old",
      channelType: "broadcast",
      channelId: "broadcast:team-1",
      createdAt: new Date("2026-05-20T08:00:00Z"),
    });
    const newerMsg = makeMsg({
      id: "m-new",
      channelType: "direct",
      channelId: `direct:${AGENT_A_ID}:${AGENT_B_ID}`,
      fromAgentId: AGENT_A_ID,
      createdAt: new Date("2026-05-20T12:00:00Z"),
    });
    setupSelectChains([olderMsg, newerMsg], []);

    const res = await GET(makeReq(AGENT_A_ID), makeParams());
    const body = await res.json();

    expect(body.threads).toHaveLength(2);
    // Newer thread should come first
    expect(body.threads[0].channelType).toBe("direct");
    expect(body.threads[1].channelType).toBe("broadcast");
  });

  it("isSelf flag is true when the message is from the participant", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);

    const channelId = `direct:${AGENT_A_ID}:${AGENT_B_ID}`;
    const fromSelf = makeMsg({
      id: "m1",
      channelId,
      fromAgentId: AGENT_A_ID,
    });
    const fromPeer = makeMsg({
      id: "m2",
      channelId,
      fromAgentId: AGENT_B_ID,
    });
    setupSelectChains([fromSelf, fromPeer], []);

    const res = await GET(makeReq(AGENT_A_ID), makeParams());
    const body = await res.json();

    const msgs = body.threads[0].messages;
    expect(msgs[0].isSelf).toBe(true);
    expect(msgs[1].isSelf).toBe(false);
  });

  it("resolves fromAgentName from nameMap", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);

    const msg = makeMsg({
      channelType: "broadcast",
      channelId: "broadcast:team-1",
      fromAgentId: AGENT_A_ID,
    });
    setupSelectChains([msg], []);

    const res = await GET(makeReq(AGENT_A_ID), makeParams());
    const body = await res.json();

    expect(body.threads[0].messages[0].fromAgentName).toBe("Researcher");
  });

  it("falls back to raw fromAgentId if name unknown", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);

    const unknownId = "unknown-agent-9999";
    const msg = makeMsg({
      channelType: "broadcast",
      channelId: "broadcast:team-1",
      fromAgentId: unknownId,
    });
    setupSelectChains([msg], []);

    const res = await GET(makeReq("team"), makeParams());
    const body = await res.json();

    expect(body.threads[0].messages[0].fromAgentName).toBe(unknownId);
  });

  it("uses custom cofounder name from team row", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce({
      ...teamRow,
      cofounderName: "Ada",
    });

    const msg = makeMsg({
      channelType: "broadcast",
      channelId: "broadcast:team-1",
      fromAgentId: COFOUNDER_AGENT_ID,
    });
    setupSelectChains([msg], []);

    const res = await GET(makeReq("cofounder"), makeParams());
    const body = await res.json();

    expect(body.agentName).toBe("Ada");
    expect(body.threads[0].messages[0].fromAgentName).toBe("Ada");
  });

  it("message createdAt is serialized as ISO string", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);

    const msg = makeMsg({
      channelType: "broadcast",
      channelId: "broadcast:team-1",
      createdAt: new Date("2026-05-20T15:30:00Z"),
    });
    setupSelectChains([msg], []);

    const res = await GET(makeReq("team"), makeParams());
    const body = await res.json();

    expect(body.threads[0].messages[0].createdAt).toBe(
      "2026-05-20T15:30:00.000Z",
    );
  });

  it("agent filters include task channel messages containing participantId", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);

    const taskChannelId = `task:some-task:${AGENT_A_ID}:${AGENT_B_ID}`;
    const msg = makeMsg({
      channelType: "task",
      channelId: taskChannelId,
      fromAgentId: AGENT_B_ID,
    });
    setupSelectChains([msg], []);

    const res = await GET(makeReq(AGENT_A_ID), makeParams());
    const body = await res.json();

    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].channelType).toBe("task");
  });

  it("displayName falls back to participantId when not in nameMap", async () => {
    const { GET } = await import(
      "@/app/api/team/[id]/conversations/route"
    );
    mockDb.query.agents.findMany.mockResolvedValueOnce([]);
    mockDb.query.teams.findFirst.mockResolvedValueOnce(teamRow);

    const unknownAgentId = "unknown-id-xyz";
    setupSelectChains([], []);

    const res = await GET(makeReq(unknownAgentId), makeParams());
    const body = await res.json();

    // The participant is not in nameMap (aside from sentinel IDs), so displayName = participantId
    expect(body.agentName).toBe(unknownAgentId);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockBroadcast = vi.fn();
const mockSendToGroup = vi.fn();
const mockSendDirect = vi.fn();
const mockGetAgentContext = vi.fn();

vi.mock("@/server/a2ax", () => ({
  getA2AX: () => ({
    getAgentContext: mockGetAgentContext,
    broadcast: mockBroadcast,
    sendToGroup: mockSendToGroup,
    sendDirect: mockSendDirect,
  }),
}));

const mockDb = {
  query: {
    agents: { findMany: vi.fn() },
  },
};

vi.mock("@/server/db", () => ({
  db: () => mockDb,
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ _eq: val })),
}));

vi.mock("@/server/db/schema", () => ({
  agents: { teamId: "agents.teamId" },
}));

vi.mock("@/lib/meta-agent/identity", () => ({
  COFOUNDER_AGENT_ID: "00000000-0000-0000-0000-00000000c0f0",
  COFOUNDER_POV: "cofounder",
  USER_AGENT_ID: "00000000-0000-0000-0000-00000000fffe",
  USER_POV: "user",
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = "team-1";
const COFOUNDER_AGENT_ID = "00000000-0000-0000-0000-00000000c0f0";
const USER_AGENT_ID = "00000000-0000-0000-0000-00000000fffe";
const AGENT_A_ID = "aaaa-1111";
const AGENT_B_ID = "bbbb-2222";

const agentRows = [
  { id: AGENT_A_ID, name: "Researcher", teamId: TEAM_ID },
  { id: AGENT_B_ID, name: "Writer", teamId: TEAM_ID },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGetReq(agentId?: string): Request {
  const url = agentId
    ? `http://localhost/api/team/team-1/messages?agentId=${agentId}`
    : "http://localhost/api/team/team-1/messages";
  return new Request(url);
}

function makePostReq(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/team/team-1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeParams(id = "team-1") {
  return { params: Promise.resolve({ id }) };
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    channelType: "direct",
    channelId: `direct:${AGENT_A_ID}:${AGENT_B_ID}`,
    fromAgentId: AGENT_A_ID,
    kind: "text",
    content: "hello",
    status: "delivered",
    urgent: false,
    createdAt: new Date("2026-05-20T10:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// GET /api/team/[id]/messages
// ===========================================================================

describe("GET /api/team/[id]/messages", () => {
  it("returns 400 when agentId is missing", async () => {
    const { GET } = await import("@/server/api/team/id/messages");

    const res = await GET(makeGetReq(), makeParams());
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("agentId query param required");
  });

  it("returns enriched messages with agent names", async () => {
    const { GET } = await import("@/server/api/team/id/messages");

    const msgs = [
      makeMessage({ id: "m1", fromAgentId: AGENT_A_ID }),
      makeMessage({ id: "m2", fromAgentId: AGENT_B_ID }),
    ];
    mockGetAgentContext.mockResolvedValueOnce({ messages: msgs });
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);

    const res = await GET(makeGetReq(AGENT_A_ID), makeParams());
    const body = (await res.json()) as Array<{ fromAgentName?: string }>;

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0].fromAgentName).toBe("Researcher");
    expect(body[1].fromAgentName).toBe("Writer");
  });

  it("falls back to fromAgentId when name not found", async () => {
    const { GET } = await import("@/server/api/team/id/messages");

    const unknownId = "unknown-agent-xyz";
    const msgs = [makeMessage({ fromAgentId: unknownId })];
    mockGetAgentContext.mockResolvedValueOnce({ messages: msgs });
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);

    const res = await GET(makeGetReq(AGENT_A_ID), makeParams());
    const body = (await res.json()) as Array<{ fromAgentName?: string }>;

    expect(body[0].fromAgentName).toBe(unknownId);
  });

  it("passes agentId to getAgentContext", async () => {
    const { GET } = await import("@/server/api/team/id/messages");

    mockGetAgentContext.mockResolvedValueOnce({ messages: [] });
    mockDb.query.agents.findMany.mockResolvedValueOnce([]);

    await GET(makeGetReq("my-agent"), makeParams("t-99"));

    expect(mockGetAgentContext).toHaveBeenCalledWith("t-99", "my-agent");
  });

  it("serializes createdAt as ISO string", async () => {
    const { GET } = await import("@/server/api/team/id/messages");

    const msgs = [
      makeMessage({ createdAt: new Date("2026-05-20T15:30:00Z") }),
    ];
    mockGetAgentContext.mockResolvedValueOnce({ messages: msgs });
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);

    const res = await GET(makeGetReq(AGENT_A_ID), makeParams());
    const body = (await res.json()) as Array<{ createdAt?: string }>;

    expect(body[0].createdAt).toBe("2026-05-20T15:30:00.000Z");
  });

  it("returns empty array when no messages", async () => {
    const { GET } = await import("@/server/api/team/id/messages");

    mockGetAgentContext.mockResolvedValueOnce({ messages: [] });
    mockDb.query.agents.findMany.mockResolvedValueOnce([]);

    const res = await GET(makeGetReq(AGENT_A_ID), makeParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });

  it("includes all expected message fields in enriched output", async () => {
    const { GET } = await import("@/server/api/team/id/messages");

    const msgs = [
      makeMessage({
        id: "m-full",
        channelType: "broadcast",
        channelId: "broadcast:team-1",
        kind: "notification",
        content: "hey all",
        status: "pending",
        urgent: true,
      }),
    ];
    mockGetAgentContext.mockResolvedValueOnce({ messages: msgs });
    mockDb.query.agents.findMany.mockResolvedValueOnce(agentRows);

    const res = await GET(makeGetReq(AGENT_A_ID), makeParams());
    const body = (await res.json()) as Array<{
      id?: string;
      channelType?: string;
      channelId?: string;
      kind?: string;
      content?: string;
      status?: string;
      urgent?: boolean;
    }>;

    const m = body[0];
    expect(m.id).toBe("m-full");
    expect(m.channelType).toBe("broadcast");
    expect(m.channelId).toBe("broadcast:team-1");
    expect(m.kind).toBe("notification");
    expect(m.content).toBe("hey all");
    expect(m.status).toBe("pending");
    expect(m.urgent).toBe(true);
  });
});

// ===========================================================================
// POST /api/team/[id]/messages
// ===========================================================================

describe("POST /api/team/[id]/messages", () => {
  it("returns 400 when fromAgentId is missing", async () => {
    const { POST } = await import("@/server/api/team/id/messages");

    const res = await POST(
      makePostReq({ content: "hello" }),
      makeParams(),
    );
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("fromAgentId and content required");
  });

  it("returns 400 when content is missing", async () => {
    const { POST } = await import("@/server/api/team/id/messages");

    const res = await POST(
      makePostReq({ fromAgentId: AGENT_A_ID }),
      makeParams(),
    );
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("fromAgentId and content required");
  });

  it("returns 400 when both fromAgentId and content are missing", async () => {
    const { POST } = await import("@/server/api/team/id/messages");

    const res = await POST(makePostReq({}), makeParams());
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("fromAgentId and content required");
  });

  it("sends broadcast message", async () => {
    const { POST } = await import("@/server/api/team/id/messages");

    const sentMsg = makeMessage({ channelType: "broadcast" });
    mockBroadcast.mockResolvedValueOnce(sentMsg);

    const res = await POST(
      makePostReq({
        fromAgentId: AGENT_A_ID,
        content: "hello all",
        channelType: "broadcast",
      }),
      makeParams(),
    );
    const body = (await res.json()) as { channelType?: string };

    expect(res.status).toBe(201);
    expect(mockBroadcast).toHaveBeenCalledWith(
      TEAM_ID,
      AGENT_A_ID,
      "hello all",
    );
    expect(body.channelType).toBe("broadcast");
  });

  it("sends group message with channelId", async () => {
    const { POST } = await import("@/server/api/team/id/messages");

    const sentMsg = makeMessage({ channelType: "group" });
    mockSendToGroup.mockResolvedValueOnce(sentMsg);

    const res = await POST(
      makePostReq({
        fromAgentId: AGENT_A_ID,
        content: "team update",
        channelType: "group",
        channelId: "group:dev-team",
      }),
      makeParams(),
    );
    const body = (await res.json()) as { channelType?: string };

    expect(res.status).toBe(201);
    expect(mockSendToGroup).toHaveBeenCalledWith(
      TEAM_ID,
      "group:dev-team",
      AGENT_A_ID,
      "team update",
    );
    expect(body.channelType).toBe("group");
  });

  it("returns 400 for group message without channelId", async () => {
    const { POST } = await import("@/server/api/team/id/messages");

    const res = await POST(
      makePostReq({
        fromAgentId: AGENT_A_ID,
        content: "team update",
        channelType: "group",
      }),
      makeParams(),
    );
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("channelId required for group messages");
  });

  it("sends direct message with toAgentId", async () => {
    const { POST } = await import("@/server/api/team/id/messages");

    const sentMsg = makeMessage({ channelType: "direct" });
    mockSendDirect.mockResolvedValueOnce(sentMsg);

    const res = await POST(
      makePostReq({
        fromAgentId: AGENT_A_ID,
        toAgentId: AGENT_B_ID,
        content: "hi there",
        channelType: "direct",
      }),
      makeParams(),
    );
    const body = (await res.json()) as { channelType?: string };

    expect(res.status).toBe(201);
    expect(mockSendDirect).toHaveBeenCalledWith(
      TEAM_ID,
      AGENT_A_ID,
      AGENT_B_ID,
      "hi there",
    );
    expect(body.channelType).toBe("direct");
  });

  it("returns 400 for direct message without toAgentId", async () => {
    const { POST } = await import("@/server/api/team/id/messages");

    const res = await POST(
      makePostReq({
        fromAgentId: AGENT_A_ID,
        content: "hi",
        channelType: "direct",
      }),
      makeParams(),
    );
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("toAgentId required for direct messages");
  });

  it("defaults to direct when channelType is not specified", async () => {
    const { POST } = await import("@/server/api/team/id/messages");

    const sentMsg = makeMessage();
    mockSendDirect.mockResolvedValueOnce(sentMsg);

    const res = await POST(
      makePostReq({
        fromAgentId: AGENT_A_ID,
        toAgentId: AGENT_B_ID,
        content: "default channel",
      }),
      makeParams(),
    );

    expect(res.status).toBe(201);
    expect(mockSendDirect).toHaveBeenCalledWith(
      TEAM_ID,
      AGENT_A_ID,
      AGENT_B_ID,
      "default channel",
    );
  });

  it("returns 400 when default direct is used without toAgentId", async () => {
    const { POST } = await import("@/server/api/team/id/messages");

    const res = await POST(
      makePostReq({
        fromAgentId: AGENT_A_ID,
        content: "no recipient",
        // no channelType => defaults to direct, no toAgentId
      }),
      makeParams(),
    );
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("toAgentId required for direct messages");
  });

  it("translates 'cofounder' POV sentinel to COFOUNDER_AGENT_ID", async () => {
    const { POST } = await import("@/server/api/team/id/messages");

    const sentMsg = makeMessage();
    mockSendDirect.mockResolvedValueOnce(sentMsg);

    const res = await POST(
      makePostReq({
        fromAgentId: "cofounder",
        toAgentId: AGENT_A_ID,
        content: "from cofounder",
        channelType: "direct",
      }),
      makeParams(),
    );

    expect(res.status).toBe(201);
    expect(mockSendDirect).toHaveBeenCalledWith(
      TEAM_ID,
      COFOUNDER_AGENT_ID,
      AGENT_A_ID,
      "from cofounder",
    );
  });

  it("translates 'user' POV sentinel to USER_AGENT_ID", async () => {
    const { POST } = await import("@/server/api/team/id/messages");

    const sentMsg = makeMessage();
    mockSendDirect.mockResolvedValueOnce(sentMsg);

    const res = await POST(
      makePostReq({
        fromAgentId: "user",
        toAgentId: AGENT_B_ID,
        content: "from user",
        channelType: "direct",
      }),
      makeParams(),
    );

    expect(res.status).toBe(201);
    expect(mockSendDirect).toHaveBeenCalledWith(
      TEAM_ID,
      USER_AGENT_ID,
      AGENT_B_ID,
      "from user",
    );
  });

  it("translates toAgentId POV sentinels as well", async () => {
    const { POST } = await import("@/server/api/team/id/messages");

    const sentMsg = makeMessage();
    mockSendDirect.mockResolvedValueOnce(sentMsg);

    const res = await POST(
      makePostReq({
        fromAgentId: AGENT_A_ID,
        toAgentId: "cofounder",
        content: "to cofounder",
        channelType: "direct",
      }),
      makeParams(),
    );

    expect(res.status).toBe(201);
    expect(mockSendDirect).toHaveBeenCalledWith(
      TEAM_ID,
      AGENT_A_ID,
      COFOUNDER_AGENT_ID,
      "to cofounder",
    );
  });

  it("uses correct teamId from route params", async () => {
    const { POST } = await import("@/server/api/team/id/messages");

    const sentMsg = makeMessage();
    mockBroadcast.mockResolvedValueOnce(sentMsg);

    await POST(
      makePostReq({
        fromAgentId: AGENT_A_ID,
        content: "hello",
        channelType: "broadcast",
      }),
      makeParams("custom-team-42"),
    );

    expect(mockBroadcast).toHaveBeenCalledWith(
      "custom-team-42",
      AGENT_A_ID,
      "hello",
    );
  });
});

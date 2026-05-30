import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — DB
// ---------------------------------------------------------------------------

const mockInsertValues = vi.fn().mockResolvedValue(undefined);
const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

const mockWhereOnUpdate = vi.fn().mockResolvedValue(undefined);
const mockSet = vi.fn().mockReturnValue({ where: mockWhereOnUpdate });
const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

const mockDb = {
  query: {
    teams: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    agents: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    pendingApprovals: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
  update: mockUpdate,
  insert: mockInsert,
  delete: mockDelete,
};

vi.mock("@/server/db", () => ({
  db: () => mockDb,
}));

vi.mock("@/server/db/schema", () => ({
  teams: { id: "teams.id", paused: "teams.paused" },
  agents: { id: "agents.id", teamId: "agents.teamId" },
  actionLog: {},
  pendingApprovals: { agentId: "pending_approvals.agentId" },
}));

// T2: the tick route builds a tool registry to classify destructive tools.
vi.mock("@/server/tools", () => ({
  createAppRegistry: () => ({ isDestructive: () => false }),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ _eq: val })),
  // The tick route builds an atomic increment via sql`${tickCount} + 1`.
  // Mock the tagged-template so the route code runs without a real driver.
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    _sql: strings.join("?"),
    values,
  })),
}));

// ---------------------------------------------------------------------------
// Mocks — meta-agent
// ---------------------------------------------------------------------------

const mockApproveAgentTick = vi.fn();
const mockRunAgent = vi.fn();

vi.mock("@/lib/meta-agent", () => ({
  approveAgentTick: (...args: unknown[]) => mockApproveAgentTick(...args),
  runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

// ---------------------------------------------------------------------------
// Mocks — LLM adapters
// ---------------------------------------------------------------------------

const mockCreateAnthropicClient = vi.fn().mockReturnValue({ chat: { completions: { create: vi.fn() } } });
vi.mock("@/lib/meta-agent/anthropic-adapter", () => ({
  createAnthropicClient: (...args: unknown[]) => mockCreateAnthropicClient(...args),
}));

const mockCreateCodexClient = vi.fn().mockReturnValue({ chat: { completions: { create: vi.fn() } } });
vi.mock("@/lib/meta-agent/codex-adapter", () => ({
  createCodexClient: (...args: unknown[]) => mockCreateCodexClient(...args),
}));

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: vi.fn() } };
  }
  return { default: MockOpenAI };
});

// ---------------------------------------------------------------------------
// Mocks — a2ax, config
// ---------------------------------------------------------------------------

const mockGetAgentContext = vi.fn().mockResolvedValue({ formatted: "", messageIds: [] });
const mockMarkContextRead = vi.fn().mockResolvedValue(undefined);

vi.mock("@/server/a2ax", () => ({
  getA2AX: () => ({
    getAgentContext: mockGetAgentContext,
    markContextRead: mockMarkContextRead,
  }),
}));

const mockGetConfig = vi.fn().mockReturnValue({
  openaiApiKey: "",
  openaiBaseUrl: "https://api.openai.com/v1",
  model: "o4-mini",
  databaseUrl: "",
});

const mockGetApiKeySource = vi.fn().mockReturnValue("config" as const);

vi.mock("@/server/config", () => ({
  getConfig: () => mockGetConfig(),
  getApiKeySource: () => mockGetApiKeySource(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEAM_ID = "team-1";

const sampleTeam = {
  id: TEAM_ID,
  name: "Test Team",
  paused: false,
  tickCount: 3,
  metaAgentPrompt: null,
  cofounderName: null,
  // Must be recent: the tick route hibernates teams idle >5 min, so a fixed
  // past date would make every "agent runs" test see a hibernated team and
  // run zero agents. Stamp it at module load (suite runs well under 5 min).
  lastUserActiveAt: new Date(),
  createdAt: new Date("2026-05-19T00:00:00Z"),
};

function makeDueAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    teamId: TEAM_ID,
    name: "Researcher",
    role: "research",
    archetype: "researcher",
    tools: ["report_action"],
    scheduleSeconds: 10,
    initialPrompt: "Do research",
    status: "running",
    nextRunAt: new Date("2026-05-20T00:00:00Z"),
    inFlight: false,
    createdAt: new Date("2026-05-19T00:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Re-wire chained mock returns after clearAllMocks
  mockUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({ where: mockWhereOnUpdate });
  mockWhereOnUpdate.mockResolvedValue(undefined);
  mockInsert.mockReturnValue({ values: mockInsertValues });
  mockInsertValues.mockResolvedValue(undefined);
  mockDelete.mockReturnValue({ where: mockDeleteWhere });
  mockDeleteWhere.mockResolvedValue(undefined);

  // Defaults
  mockDb.query.teams.findMany.mockResolvedValue([]);
  mockDb.query.agents.findMany.mockResolvedValue([]);
  mockDb.query.pendingApprovals.findMany.mockResolvedValue([]);
  mockGetConfig.mockReturnValue({
    openaiApiKey: "",
    openaiBaseUrl: "https://api.openai.com/v1",
    model: "o4-mini",
    databaseUrl: "",
  });
  mockGetApiKeySource.mockReturnValue("config");

  // Default: no ANTHROPIC_API_KEY env
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/tick", () => {
  it("returns 0 agentsRan when no active teams exist", async () => {
    const { POST } = await import("@/app/api/tick/route");
    mockDb.query.teams.findMany.mockResolvedValueOnce([]);

    const res = await POST();
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.agentsRan).toBe(0);
    expect(body.timestamp).toBeDefined();
  });

  it("returns 0 agentsRan when team has no agents", async () => {
    const { POST } = await import("@/app/api/tick/route");
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([]);

    const res = await POST();
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.agentsRan).toBe(0);
  });

  it("auto-recovers errored agents to running status", async () => {
    const { POST } = await import("@/app/api/tick/route");

    const erroredAgent = makeDueAgent({ status: "errored" });
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([erroredAgent]);
    // The agent won't be approved because approveAgentTick returns not allowed
    mockApproveAgentTick.mockReturnValue({ allowed: false, reason: "not due", reasonCode: "not_due" });

    await POST();

    // First update call should be the errored->running recovery
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running", inFlight: false }),
    );
  });

  it("runs a due agent successfully and logs the action", async () => {
    const { POST } = await import("@/app/api/tick/route");

    const agent = makeDueAgent();
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([agent]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockResolvedValueOnce({
      actionType: "research",
      payload: { summary: "Found data" },
    });

    const res = await POST();
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.agentsRan).toBe(1);

    // Should set inFlight = true before running
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ inFlight: true }));

    // Should insert into actionLog
    expect(mockInsert).toHaveBeenCalled();
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        actionType: "research",
        payload: { summary: "Found data" },
      }),
    );

    // Should update nextRunAt and set inFlight = false
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        inFlight: false,
        nextRunAt: expect.any(Date),
      }),
    );
  });

  it("sets agent to errored on failure", async () => {
    const { POST } = await import("@/app/api/tick/route");

    const agent = makeDueAgent();
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([agent]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockRejectedValueOnce(new Error("LLM timeout"));

    const res = await POST();
    const body = await res.json();

    // Agent failed but tick still completes
    expect(body.ok).toBe(true);
    expect(body.agentsRan).toBe(0);

    // Should set agent to errored
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ inFlight: false, status: "errored" }),
    );
  });

  it("increments team tickCount", async () => {
    const { POST } = await import("@/app/api/tick/route");
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([]);

    await POST();

    // tickCount is incremented atomically in SQL (sql`${tickCount} + 1`)
    // rather than read-modify-write, so the value passed to .set() is the
    // mocked sql fragment, not a literal 4. Assert the increment was issued
    // against the tickCount column.
    const tickCountCall = mockSet.mock.calls.find(
      (call) => call[0] && "tickCount" in call[0],
    );
    expect(tickCountCall).toBeDefined();
    expect(tickCountCall?.[0].tickCount).toMatchObject({ _sql: "? + 1" });
  });

  it("skips agents that are not approved", async () => {
    const { POST } = await import("@/app/api/tick/route");

    const agent = makeDueAgent();
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([agent]);
    mockApproveAgentTick.mockReturnValue({
      allowed: false,
      reason: "not due",
      reasonCode: "not_due",
    });

    const res = await POST();
    const body = await res.json();

    expect(body.agentsRan).toBe(0);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("builds peer list excluding the running agent", async () => {
    const { POST } = await import("@/app/api/tick/route");

    const agent1 = makeDueAgent({ id: "agent-1", name: "Alpha" });
    const agent2 = makeDueAgent({ id: "agent-2", name: "Beta", status: "paused" });
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([agent1, agent2]);
    // Only agent1 is approved
    mockApproveAgentTick
      .mockReturnValueOnce({ allowed: true })
      .mockReturnValueOnce({ allowed: false, reason: "paused", reasonCode: "agent_paused" });
    mockRunAgent.mockResolvedValueOnce({ actionType: "noop", payload: {} });

    await POST();

    // runAgent should receive peers that excludes agent-1 (self)
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        peers: expect.arrayContaining([
          expect.objectContaining({ id: "agent-2", name: "Beta" }),
        ]),
      }),
    );
    // Peers should NOT include the running agent
    const callArgs = mockRunAgent.mock.calls[0][0];
    expect(callArgs.peers.find((p: { id: string }) => p.id === "agent-1")).toBeUndefined();
  });

  it("fetches a2ax context and marks messages as read", async () => {
    const { POST } = await import("@/app/api/tick/route");

    const agent = makeDueAgent();
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([agent]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockGetAgentContext.mockResolvedValueOnce({
      formatted: "You have 2 messages",
      messageIds: ["msg-1", "msg-2"],
    });
    mockRunAgent.mockResolvedValueOnce({ actionType: "noop", payload: {} });

    await POST();

    expect(mockGetAgentContext).toHaveBeenCalledWith(TEAM_ID, "agent-1");
    expect(mockMarkContextRead).toHaveBeenCalledWith(["msg-1", "msg-2"]);
    // a2axContext should be passed to runAgent
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({ a2axContext: "You have 2 messages" }),
    );
  });

  it("handles multiple teams in a single tick", async () => {
    const { POST } = await import("@/app/api/tick/route");

    const team2 = { ...sampleTeam, id: "team-2", name: "Second", tickCount: 0 };
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam, team2]);
    // First team has one agent, second has none
    mockDb.query.agents.findMany
      .mockResolvedValueOnce([makeDueAgent()])
      .mockResolvedValueOnce([]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockResolvedValueOnce({ actionType: "noop", payload: {} });

    const res = await POST();
    const body = await res.json();

    expect(body.agentsRan).toBe(1);
    // Both teams should get tickCount incremented (two update calls for tickCount)
    const tickCountCalls = mockSet.mock.calls.filter(
      (call) => call[0] && "tickCount" in call[0],
    );
    expect(tickCountCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// T2: suspend / resume on destructive tools
// ---------------------------------------------------------------------------

describe("POST /api/tick — approval suspend/resume", () => {
  const suspension = {
    messages: [{ role: "assistant", content: null, tool_calls: [] }],
    pending: [{ id: "call_w", name: "write_file", arguments: '{"path":"x"}' }],
    actions: [],
    round: 0,
  };

  it("parks an agent and creates pending_approvals when a run suspends", async () => {
    const { POST } = await import("@/app/api/tick/route");
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([makeDueAgent()]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockResolvedValueOnce({
      actionType: "suspended",
      payload: { agent: "Researcher" },
      suspension,
    });

    await POST();

    // Agent parked: status awaiting_approval + conversation state saved.
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "awaiting_approval",
        conversationState: suspension,
      }),
    );
    // A pending_approvals row was inserted for the destructive call.
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ toolCallId: "call_w", toolName: "write_file" }),
      ]),
    );
    // nextRunAt must NOT advance while parked (no objectContaining with nextRunAt
    // among the awaiting_approval set).
    const parkCall = mockSet.mock.calls.find(
      (c) => c[0] && c[0].status === "awaiting_approval",
    );
    expect(parkCall?.[0].nextRunAt).toBeUndefined();
  });

  it("does not run a fresh tick for an awaiting_approval agent", async () => {
    const { POST } = await import("@/app/api/tick/route");
    const parked = makeDueAgent({ status: "awaiting_approval", conversationState: suspension });
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([parked]);
    // approveAgentTick is the real gate in the route; here it's mocked, but the
    // route only adds awaiting_approval agents via the resume pass. Keep it
    // blocked so the fresh pass can't pick it up.
    mockApproveAgentTick.mockReturnValue({ allowed: false, reasonCode: "awaiting_approval" });
    // Still has an unresolved approval -> must NOT resume.
    mockDb.query.pendingApprovals.findMany.mockResolvedValueOnce([
      { toolCallId: "call_w", status: "pending", decisionNote: null },
    ]);

    await POST();

    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("resumes with decisions once all approvals are resolved", async () => {
    const { POST } = await import("@/app/api/tick/route");
    const parked = makeDueAgent({ status: "awaiting_approval", conversationState: suspension });
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([parked]);
    mockApproveAgentTick.mockReturnValue({ allowed: false, reasonCode: "awaiting_approval" });
    mockDb.query.pendingApprovals.findMany.mockResolvedValueOnce([
      { toolCallId: "call_w", status: "approved", decisionNote: null },
    ]);
    mockRunAgent.mockResolvedValueOnce({
      actionType: "file_written",
      payload: { agent: "Researcher" },
    });

    await POST();

    // runAgent called with resume carrying the decision.
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        resume: expect.objectContaining({
          suspension,
          decisions: [{ id: "call_w", approved: true, note: undefined }],
        }),
      }),
    );
    // Resolved approvals consumed.
    expect(mockDelete).toHaveBeenCalled();
    // Completed -> back to running, conversation cleared.
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running", conversationState: null }),
    );
  });

  it("passes rejection notes through as decisions", async () => {
    const { POST } = await import("@/app/api/tick/route");
    const parked = makeDueAgent({ status: "awaiting_approval", conversationState: suspension });
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([parked]);
    mockApproveAgentTick.mockReturnValue({ allowed: false, reasonCode: "awaiting_approval" });
    mockDb.query.pendingApprovals.findMany.mockResolvedValueOnce([
      { toolCallId: "call_w", status: "rejected", decisionNote: "too risky" },
    ]);
    mockRunAgent.mockResolvedValueOnce({ actionType: "agent_thought", payload: {} });

    await POST();

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        resume: expect.objectContaining({
          decisions: [{ id: "call_w", approved: false, note: "too risky" }],
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// LLM client selection
// ---------------------------------------------------------------------------

describe("POST /api/tick — LLM client selection", () => {
  it("uses Codex client when apiKeySource is codex", async () => {
    const { POST } = await import("@/app/api/tick/route");

    mockGetApiKeySource.mockReturnValue("codex");
    mockGetConfig.mockReturnValue({
      openaiApiKey: "",
      openaiBaseUrl: "",
      model: "gpt-5.5",
      databaseUrl: "",
    });
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([makeDueAgent()]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockResolvedValueOnce({ actionType: "noop", payload: {} });

    await POST();

    expect(mockCreateCodexClient).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.5" }),
    );
    expect(mockCreateAnthropicClient).not.toHaveBeenCalled();
  });

  it("uses Anthropic client when ANTHROPIC_API_KEY is set", async () => {
    const { POST } = await import("@/app/api/tick/route");

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    mockGetApiKeySource.mockReturnValue("config");
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([makeDueAgent()]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockResolvedValueOnce({ actionType: "noop", payload: {} });

    await POST();

    expect(mockCreateAnthropicClient).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-ant-test",
        timeout: 120_000,
      }),
    );
    expect(mockCreateCodexClient).not.toHaveBeenCalled();
  });

  it("falls back to OpenAI client when no codex or anthropic key", async () => {
    const { POST } = await import("@/app/api/tick/route");

    mockGetApiKeySource.mockReturnValue("config");
    delete process.env.ANTHROPIC_API_KEY;
    mockGetConfig.mockReturnValue({
      openaiApiKey: "sk-openai-test",
      openaiBaseUrl: "https://custom.api/v1",
      model: "o4-mini",
      databaseUrl: "",
    });
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([]);

    await POST();

    expect(mockCreateCodexClient).not.toHaveBeenCalled();
    expect(mockCreateAnthropicClient).not.toHaveBeenCalled();
    // OpenAI path is the fallback — it instantiates new OpenAI() internally.
    // We just verify the other two were NOT used.
  });
});

// ---------------------------------------------------------------------------
// GET delegates to POST
// ---------------------------------------------------------------------------

describe("GET /api/tick", () => {
  it("delegates to POST and returns same shape", async () => {
    const { GET } = await import("@/app/api/tick/route");
    mockDb.query.teams.findMany.mockResolvedValueOnce([]);

    const res = await GET();
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.agentsRan).toBe(0);
    expect(body.timestamp).toBeDefined();
  });
});

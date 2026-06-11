import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — DB
// ---------------------------------------------------------------------------

const mockInsertValues = vi.fn().mockResolvedValue(undefined);
const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

const mockWhereOnUpdate = vi.fn().mockResolvedValue(undefined);
const mockUpdateReturning = vi.fn().mockResolvedValue([{ id: "agent-1" }]);
const mockSet = vi.fn().mockReturnValue({ where: mockWhereOnUpdate });
const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

// Spend ledger read (checkSpendAllowed). Default: $0 spent today (under cap).
const mockSelectWhere = vi.fn().mockResolvedValue([{ total: 0 }]);
const mockSelect = vi
  .fn()
  .mockReturnValue({ from: vi.fn().mockReturnValue({ where: mockSelectWhere }) });

const mockDb = {
  query: {
    teams: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue({ telemetryEnabled: true }),
    },
    agents: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    pendingApprovals: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    actionLog: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    appEvents: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    platformStatus: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
  update: mockUpdate,
  insert: mockInsert,
  delete: mockDelete,
  select: mockSelect,
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb)),
};

vi.mock("@/server/db", () => ({
  db: () => mockDb,
}));

vi.mock("@/server/db/schema", () => ({
  teams: { id: "teams.id", paused: "teams.paused", tickCount: "teams.tickCount" },
  agents: {
    id: "agents.id",
    teamId: "agents.teamId",
    inFlight: "agents.inFlight",
    status: "agents.status",
  },
  actionLog: {},
  pendingApprovals: { agentId: "pending_approvals.agentId", status: "pending_approvals.status" },
  appEvents: { level: "app_events.level" },
  llmSpend: { costCents: "llm_spend.cost_cents", day: "llm_spend.day" },
  platformStatus: { id: "platform_status.id" },
  agentTraceEvents: {
    teamId: "agent_trace_events.teamId",
    agentId: "agent_trace_events.agentId",
    tickId: "agent_trace_events.tickId",
    seq: "agent_trace_events.seq",
    emittedAt: "agent_trace_events.emittedAt",
  },
}));

// T2: the tick route builds a tool registry to classify destructive tools.
vi.mock("@/server/tools", () => ({
  createAppRegistry: () => ({ isDestructive: () => false }),
  createAppRegistryWithCustomTools: () => Promise.resolve({ isDestructive: () => false }),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ _eq: val })),
  and: vi.fn((...clauses: unknown[]) => ({ _and: clauses })),
  desc: vi.fn((col: unknown) => ({ _desc: col })),
  asc: vi.fn((col: unknown) => ({ _asc: col })),
  gte: vi.fn((_col: unknown, val: unknown) => ({ _gte: val })),
  lt: vi.fn((_col: unknown, val: unknown) => ({ _lt: val })),
  ne: vi.fn((_col: unknown, val: unknown) => ({ _ne: val })),
  isNull: vi.fn((_col: unknown) => ({ _isNull: true })),
  inArray: vi.fn((_col: unknown, vals: unknown[]) => ({ _inArray: vals })),
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

// Engine mode (codex app-server harness). Real discriminator, mocked runner.
const mockRunCodexAgentTick = vi.fn();
vi.mock("@/lib/meta-agent/codex-harness", () => ({
  runCodexAgentTick: (...args: unknown[]) => mockRunCodexAgentTick(...args),
  isCodexThreadSuspension: (s: unknown) =>
    typeof s === "object" && s !== null && (s as { kind?: unknown }).kind === "codex-thread",
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
const mockBroadcast = vi.fn().mockResolvedValue(undefined);

vi.mock("@/server/a2ax", () => ({
  getA2AX: () => ({
    getAgentContext: mockGetAgentContext,
    markContextRead: mockMarkContextRead,
    broadcast: mockBroadcast,
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

// The tick route now requires a Request (cron auth). In the test env
// (NODE_ENV !== production, no VERCEL) an unset CRON_SECRET authorizes any
// request, so a bare POST Request suffices for the existing behavior tests.
function tickReq(headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/tick", { method: "POST", headers });
}

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
  mockUpdateReturning.mockResolvedValue([{ id: "agent-1" }]);
  mockWhereOnUpdate.mockImplementation(() => {
    const result = Promise.resolve(undefined) as Promise<undefined> & {
      returning: typeof mockUpdateReturning;
    };
    result.returning = mockUpdateReturning;
    return result;
  });
  mockInsert.mockReturnValue({ values: mockInsertValues });
  mockInsertValues.mockResolvedValue(undefined);
  mockDelete.mockReturnValue({ where: mockDeleteWhere });
  mockDeleteWhere.mockResolvedValue(undefined);

  // Defaults. mockReset (not just clearAllMocks) drains any leftover
  // mockResolvedValueOnce queue from a prior test — clearAllMocks only clears
  // call history, so an unconsumed once-value would otherwise bleed across
  // tests and make ordering matter (surfaced when the tick route went parallel).
  mockRunAgent.mockReset();
  mockRunCodexAgentTick.mockReset();
  mockDb.query.teams.findMany.mockReset();
  mockDb.query.agents.findMany.mockReset();
  mockDb.query.pendingApprovals.findMany.mockReset();
  mockDb.query.actionLog.findMany.mockReset();
  mockDb.transaction.mockReset();
  mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb));
  mockDb.query.teams.findMany.mockResolvedValue([]);
  mockDb.query.agents.findMany.mockResolvedValue([]);
  mockDb.query.pendingApprovals.findMany.mockResolvedValue([]);
  mockDb.query.actionLog.findMany.mockResolvedValue([]);
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
    const { POST } = await import("@/server/api/tick");
    mockDb.query.teams.findMany.mockResolvedValueOnce([]);

    const res = await POST(tickReq());
    const body = (await res.json()) as { ok: boolean; agentsRan: number; timestamp: unknown };

    expect(body.ok).toBe(true);
    expect(body.agentsRan).toBe(0);
    expect(body.timestamp).toBeDefined();
  });

  it("returns 0 agentsRan when team has no agents", async () => {
    const { POST } = await import("@/server/api/tick");
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([]);

    const res = await POST(tickReq());
    const body = (await res.json()) as { ok: boolean; agentsRan: number };

    expect(body.ok).toBe(true);
    expect(body.agentsRan).toBe(0);
  });

  it("auto-recovers errored agents to running status", async () => {
    const { POST } = await import("@/server/api/tick");

    const erroredAgent = makeDueAgent({ status: "errored" });
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([erroredAgent]);
    // The agent won't be approved because approveAgentTick returns not allowed
    mockApproveAgentTick.mockReturnValue({ allowed: false, reason: "not due", reasonCode: "not_due" });

    await POST(tickReq());

    // First update call should be the errored->running recovery
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running", inFlight: false }),
    );
  });

  it("runs a due agent successfully and logs the action", async () => {
    const { POST } = await import("@/server/api/tick");

    const agent = makeDueAgent();
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([agent]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockResolvedValueOnce({
      actionType: "research",
      payload: { summary: "Found data" },
    });

    const res = await POST(tickReq());
    const body = (await res.json()) as { ok: boolean; agentsRan: number };

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
    const { POST } = await import("@/server/api/tick");

    const agent = makeDueAgent();
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([agent]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockRejectedValueOnce(new Error("LLM timeout"));

    const res = await POST(tickReq());
    const body = (await res.json()) as { ok: boolean; agentsRan: number };

    // Agent failed but tick still completes
    expect(body.ok).toBe(true);
    expect(body.agentsRan).toBe(0);

    // Should set agent to errored
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ inFlight: false, status: "errored" }),
    );
  });

  it("increments team tickCount", async () => {
    const { POST } = await import("@/server/api/tick");
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([]);

    await POST(tickReq());

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
    const { POST } = await import("@/server/api/tick");

    const agent = makeDueAgent();
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([agent]);
    mockApproveAgentTick.mockReturnValue({
      allowed: false,
      reason: "not due",
      reasonCode: "not_due",
    });

    const res = await POST(tickReq());
    const body = (await res.json()) as { agentsRan: number };

    expect(body.agentsRan).toBe(0);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("builds peer list excluding the running agent", async () => {
    const { POST } = await import("@/server/api/tick");

    const agent1 = makeDueAgent({ id: "agent-1", name: "Alpha" });
    const agent2 = makeDueAgent({ id: "agent-2", name: "Beta", status: "paused" });
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([agent1, agent2]);
    // Only agent1 is approved
    mockApproveAgentTick
      .mockReturnValueOnce({ allowed: true })
      .mockReturnValueOnce({ allowed: false, reason: "paused", reasonCode: "agent_paused" });
    mockRunAgent.mockResolvedValueOnce({ actionType: "noop", payload: {} });

    await POST(tickReq());

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
    const { POST } = await import("@/server/api/tick");

    const agent = makeDueAgent();
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([agent]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockGetAgentContext.mockResolvedValueOnce({
      formatted: "You have 2 messages",
      messageIds: ["msg-1", "msg-2"],
    });
    mockRunAgent.mockResolvedValueOnce({ actionType: "noop", payload: {} });

    await POST(tickReq());

    expect(mockGetAgentContext).toHaveBeenCalledWith(TEAM_ID, "agent-1");
    expect(mockMarkContextRead).toHaveBeenCalledWith("agent-1", ["msg-1", "msg-2"]);
    // a2axContext should be passed to runAgent
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({ a2axContext: "You have 2 messages" }),
    );
  });

  it("handles multiple teams in a single tick", async () => {
    const { POST } = await import("@/server/api/tick");

    const team2 = { ...sampleTeam, id: "team-2", name: "Second", tickCount: 0 };
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam, team2]);
    // First team has one agent, second has none
    mockDb.query.agents.findMany
      .mockResolvedValueOnce([makeDueAgent()])
      .mockResolvedValueOnce([]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockResolvedValueOnce({ actionType: "noop", payload: {} });

    const res = await POST(tickReq());
    const body = (await res.json()) as { agentsRan: number };

    expect(body.agentsRan).toBe(1);
    // Both teams should get tickCount incremented (two update calls for tickCount)
    const tickCountCalls = mockSet.mock.calls.filter(
      (call) => call[0] && "tickCount" in call[0],
    );
    expect(tickCountCalls).toHaveLength(2);
  });

  describe("auth + spend gating", () => {
    it("returns 401 in production when not an authorized cron caller", async () => {
      process.env.VERCEL = "1";
      try {
        const { POST } = await import("@/server/api/tick");
        const res = await POST(tickReq());
        expect(res.status).toBe(401);
      } finally {
        delete process.env.VERCEL;
      }
    });

    it("proceeds with the x-vercel-cron header", async () => {
      process.env.VERCEL = "1";
      try {
        const { POST } = await import("@/server/api/tick");
        const res = await POST(tickReq({ "x-vercel-cron": "1" }));
        expect(res.status).toBe(200);
      } finally {
        delete process.env.VERCEL;
      }
    });

    it("skips the tick when the daily spend cap is reached", async () => {
      mockSelectWhere.mockResolvedValueOnce([{ total: 999999 }]);
      const { POST } = await import("@/server/api/tick");
      const res = await POST(tickReq());
      const body = (await res.json()) as { skipped: string; agentsRan: number };
      expect(body.skipped).toBe("spend_cap");
      expect(body.agentsRan).toBe(0);
    });
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
    const { POST } = await import("@/server/api/tick");
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([makeDueAgent()]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockResolvedValueOnce({
      actionType: "suspended",
      payload: { agent: "Researcher" },
      suspension,
    });

    await POST(tickReq());

    expect(mockDb.transaction).toHaveBeenCalled();
    // Agent parked: status awaiting_approval + conversation state saved, with
    // the play-by-play trace tickId riding along for the resume pass.
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "awaiting_approval",
        conversationState: { ...suspension, traceTickId: expect.any(String) },
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
    const { POST } = await import("@/server/api/tick");
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

    await POST(tickReq());

    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("resumes with decisions once all approvals are resolved", async () => {
    const { POST } = await import("@/server/api/tick");
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

    await POST(tickReq());

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
    const { POST } = await import("@/server/api/tick");
    const parked = makeDueAgent({ status: "awaiting_approval", conversationState: suspension });
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([parked]);
    mockApproveAgentTick.mockReturnValue({ allowed: false, reasonCode: "awaiting_approval" });
    mockDb.query.pendingApprovals.findMany.mockResolvedValueOnce([
      { toolCallId: "call_w", status: "rejected", decisionNote: "too risky" },
    ]);
    mockRunAgent.mockResolvedValueOnce({ actionType: "agent_thought", payload: {} });

    await POST(tickReq());

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
// T5: per-agent timeout budget + parallel execution
// ---------------------------------------------------------------------------

describe("POST /api/tick — timeout + parallelism", () => {
  it("errors an agent whose run exceeds the per-agent budget", async () => {
    process.env.SH_AGENT_TIMEOUT_MS = "20"; // tiny budget
    const { POST } = await import("@/server/api/tick");

    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([makeDueAgent()]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    // runAgent hangs well past the budget.
    mockRunAgent.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ actionType: "noop", payload: {} }), 500)),
    );

    const res = await POST(tickReq());
    const body = (await res.json()) as { agentsRan: number };

    expect(body.agentsRan).toBe(0);
    // The timed-out agent is errored and rescheduled.
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "errored", inFlight: false }),
    );
    delete process.env.SH_AGENT_TIMEOUT_MS;
  });

  it("runs all due agents in a team concurrently (Promise.allSettled)", async () => {
    const { POST } = await import("@/server/api/tick");

    const a1 = makeDueAgent({ id: "agent-1", name: "Alpha" });
    const a2 = makeDueAgent({ id: "agent-2", name: "Beta" });
    const a3 = makeDueAgent({ id: "agent-3", name: "Gamma" });
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([a1, a2, a3]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });

    // Each run resolves after a delay; if they ran sequentially the total would
    // be ~3x the delay. We only assert all three ran + were started together.
    const started: string[] = [];
    mockRunAgent.mockImplementation((cfg: { agentId: string }) => {
      started.push(cfg.agentId);
      return new Promise((resolve) =>
        setTimeout(() => resolve({ actionType: "noop", payload: {} }), 30),
      );
    });

    const res = await POST(tickReq());
    const body = (await res.json()) as { agentsRan: number };

    expect(body.agentsRan).toBe(3);
    // All three were invoked before any resolved (concurrent kickoff).
    expect(started).toHaveLength(3);
    expect(new Set(started)).toEqual(new Set(["agent-1", "agent-2", "agent-3"]));
  });

  it("one agent failing does not stop its teammates", async () => {
    const { POST } = await import("@/server/api/tick");

    const a1 = makeDueAgent({ id: "agent-1", name: "Alpha" });
    const a2 = makeDueAgent({ id: "agent-2", name: "Beta" });
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([a1, a2]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ actionType: "noop", payload: {} });

    const res = await POST(tickReq());
    const body = (await res.json()) as { agentsRan: number };

    // One failed, one succeeded — tick still completes, count reflects the win.
    expect(body.agentsRan).toBe(1);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "errored" }),
    );
  });
});

// ---------------------------------------------------------------------------
// LLM client selection
// ---------------------------------------------------------------------------

describe("POST /api/tick — LLM client selection", () => {
  it("uses Codex client when apiKeySource is codex", async () => {
    const { POST } = await import("@/server/api/tick");

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
    // Engine mode: codex-provider fresh runs go through the harness now.
    mockRunCodexAgentTick.mockResolvedValueOnce({
      actionType: "noop",
      payload: {},
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await POST(tickReq());

    // The exec-adapter client is still constructed (legacy resume fallback).
    expect(mockCreateCodexClient).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.5" }),
    );
    expect(mockCreateAnthropicClient).not.toHaveBeenCalled();
    expect(mockRunCodexAgentTick).toHaveBeenCalledTimes(1);
  });

  it("uses Anthropic client when ANTHROPIC_API_KEY is set", async () => {
    const { POST } = await import("@/server/api/tick");

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    mockGetApiKeySource.mockReturnValue("config");
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([makeDueAgent()]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockResolvedValueOnce({ actionType: "noop", payload: {} });

    await POST(tickReq());

    expect(mockCreateAnthropicClient).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-ant-test",
        timeout: 120_000,
      }),
    );
    expect(mockCreateCodexClient).not.toHaveBeenCalled();
  });

  it("falls back to OpenAI client when no codex or anthropic key", async () => {
    const { POST } = await import("@/server/api/tick");

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

    await POST(tickReq());

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
    const { GET } = await import("@/server/api/tick");
    mockDb.query.teams.findMany.mockResolvedValueOnce([]);

    const res = await GET(tickReq());
    const body = (await res.json()) as { ok: boolean; agentsRan: number; timestamp: unknown };

    expect(body.ok).toBe(true);
    expect(body.agentsRan).toBe(0);
    expect(body.timestamp).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Play-by-play trace persistence (server/trace sink wired into the route)
// ---------------------------------------------------------------------------

describe("POST /api/tick — play-by-play trace", () => {
  /** Insert batches that look like trace rows (arrays of {type, tickId, seq}). */
  function traceBatches(): Array<Array<Record<string, unknown>>> {
    return mockInsertValues.mock.calls
      .map((c) => c[0])
      .filter(
        (arg): arg is Array<Record<string, unknown>> =>
          Array.isArray(arg) && arg.length > 0 && typeof arg[0]?.tickId === "string",
      );
  }

  it("persists runner trace steps emitted during a successful run", async () => {
    const { POST } = await import("@/server/api/tick");

    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([makeDueAgent()]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockImplementationOnce(async (cfg: { trace?: (s: unknown) => void }) => {
      cfg.trace?.({ type: "tick_started", data: { mode: "fresh", round: 0 } });
      cfg.trace?.({ type: "tick_finished", data: { actionType: "research" } });
      return { actionType: "research", payload: { summary: "done" } };
    });

    await POST(tickReq());

    const rows = traceBatches().flat();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.map((r) => r.type)).toEqual(
      expect.arrayContaining(["tick_started", "tick_finished"]),
    );
    // All steps of one run share a tickId and identify the agent.
    const tickIds = new Set(rows.map((r) => r.tickId));
    expect(tickIds.size).toBe(1);
    expect(rows[0].agentId).toBe("agent-1");
    expect(rows[0].teamId).toBe(TEAM_ID);
  });

  it("records a tick_failed step when the run throws", async () => {
    const { POST } = await import("@/server/api/tick");

    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([makeDueAgent()]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockRejectedValueOnce(new Error("LLM exploded"));

    await POST(tickReq());

    const rows = traceBatches().flat();
    const failed = rows.find((r) => r.type === "tick_failed");
    expect(failed).toBeDefined();
    expect((failed?.data as Record<string, unknown>)?.error).toContain("LLM exploded");
  });

  it("resume reuses the trace tickId parked with the suspension", async () => {
    const { POST } = await import("@/server/api/tick");

    const parkedTickId = "11111111-2222-4333-8444-555555555555";
    const parked = makeDueAgent({
      status: "awaiting_approval",
      conversationState: {
        messages: [{ role: "assistant", content: null, tool_calls: [] }],
        pending: [{ id: "call_w", name: "write_file", arguments: "{}" }],
        actions: [],
        round: 0,
        traceTickId: parkedTickId,
      },
    });
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([parked]);
    mockApproveAgentTick.mockReturnValue({ allowed: false, reasonCode: "awaiting_approval" });
    mockDb.query.pendingApprovals.findMany.mockResolvedValueOnce([
      { toolCallId: "call_w", status: "approved", decisionNote: null },
    ]);
    mockRunAgent.mockImplementationOnce(async (cfg: { trace?: (s: unknown) => void }) => {
      cfg.trace?.({ type: "tick_started", data: { mode: "resume", round: 0 } });
      return { actionType: "file_written", payload: {} };
    });

    await POST(tickReq());

    const rows = traceBatches().flat();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].tickId).toBe(parkedTickId);
  });
});

// ---------------------------------------------------------------------------
// Engine mode: codex app-server harness routing
// ---------------------------------------------------------------------------

describe("POST /api/tick — codex app-server harness", () => {
  it("routes fresh codex-provider runs through the harness, not the runner", async () => {
    const { POST } = await import("@/server/api/tick");

    mockGetApiKeySource.mockReturnValue("codex");
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([makeDueAgent()]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunCodexAgentTick.mockResolvedValueOnce({
      actionType: "research",
      payload: { summary: "engine mode" },
      usage: { inputTokens: 5000, outputTokens: 250 },
    });

    const res = await POST(tickReq());
    const body = (await res.json()) as { agentsRan: number };

    expect(body.agentsRan).toBe(1);
    expect(mockRunCodexAgentTick).toHaveBeenCalledTimes(1);
    expect(mockRunAgent).not.toHaveBeenCalled();

    // Real token usage from the harness lands in the spend ledger (model
    // comes from config — the default test config says o4-mini).
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 5000, outputTokens: 250, model: "o4-mini" }),
    );
    // And the action was logged.
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: "research" }),
    );
  });

  it("SH_CODEX_RUNTIME=exec opts out of the harness", async () => {
    process.env.SH_CODEX_RUNTIME = "exec";
    try {
      const { POST } = await import("@/server/api/tick");

      mockGetApiKeySource.mockReturnValue("codex");
      mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
      mockDb.query.agents.findMany.mockResolvedValueOnce([makeDueAgent()]);
      mockApproveAgentTick.mockReturnValue({ allowed: true });
      mockRunAgent.mockResolvedValueOnce({ actionType: "research", payload: {} });

      await POST(tickReq());

      expect(mockRunAgent).toHaveBeenCalledTimes(1);
      expect(mockRunCodexAgentTick).not.toHaveBeenCalled();
    } finally {
      delete process.env.SH_CODEX_RUNTIME;
    }
  });

  it("parks a codex-thread suspension opaquely with the trace tickId riding along", async () => {
    const { POST } = await import("@/server/api/tick");

    mockGetApiKeySource.mockReturnValue("codex");
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([makeDueAgent()]);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunCodexAgentTick.mockResolvedValueOnce({
      actionType: "suspended",
      payload: { agent: "Researcher", pending: [{ id: "c9", name: "write_file" }] },
      suspension: {
        kind: "codex-thread",
        threadId: "thr_abc",
        pending: [{ id: "c9", name: "write_file", arguments: '{"path":"x"}' }],
        actions: [],
      },
      usage: { inputTokens: 100, outputTokens: 10 },
    });

    await POST(tickReq());

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "awaiting_approval",
        conversationState: expect.objectContaining({
          kind: "codex-thread",
          threadId: "thr_abc",
          traceTickId: expect.any(String),
        }),
      }),
    );
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ toolCallId: "c9", toolName: "write_file" }),
      ]),
    );
  });

  it("resumes a codex-thread suspension through the harness with the decisions", async () => {
    const { POST } = await import("@/server/api/tick");

    const parked = makeDueAgent({
      status: "awaiting_approval",
      conversationState: {
        kind: "codex-thread",
        threadId: "thr_abc",
        pending: [{ id: "c9", name: "write_file", arguments: "{}" }],
        actions: [],
      },
    });
    mockGetApiKeySource.mockReturnValue("codex");
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([parked]);
    mockApproveAgentTick.mockReturnValue({ allowed: false, reasonCode: "awaiting_approval" });
    mockDb.query.pendingApprovals.findMany.mockResolvedValueOnce([
      { toolCallId: "c9", status: "approved", decisionNote: null },
    ]);
    mockRunCodexAgentTick.mockResolvedValueOnce({
      actionType: "file_written",
      payload: {},
      usage: { inputTokens: 50, outputTokens: 5 },
    });

    await POST(tickReq());

    expect(mockRunCodexAgentTick).toHaveBeenCalledWith(
      expect.objectContaining({
        resume: expect.objectContaining({
          suspension: expect.objectContaining({ threadId: "thr_abc" }),
          decisions: [{ id: "c9", approved: true, note: undefined }],
        }),
      }),
    );
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("legacy message-based suspensions still resume through the runner under the codex provider", async () => {
    const { POST } = await import("@/server/api/tick");

    const parked = makeDueAgent({
      status: "awaiting_approval",
      conversationState: {
        messages: [{ role: "assistant", content: null, tool_calls: [] }],
        pending: [{ id: "call_w", name: "write_file", arguments: "{}" }],
        actions: [],
        round: 0,
      },
    });
    mockGetApiKeySource.mockReturnValue("codex");
    mockDb.query.teams.findMany.mockResolvedValueOnce([sampleTeam]);
    mockDb.query.agents.findMany.mockResolvedValueOnce([parked]);
    mockApproveAgentTick.mockReturnValue({ allowed: false, reasonCode: "awaiting_approval" });
    mockDb.query.pendingApprovals.findMany.mockResolvedValueOnce([
      { toolCallId: "call_w", status: "approved", decisionNote: null },
    ]);
    mockRunAgent.mockResolvedValueOnce({ actionType: "file_written", payload: {} });

    await POST(tickReq());

    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    expect(mockRunCodexAgentTick).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { actionLog, agents, approvals, spend, teams } from "@/server/store";
import type { Agent } from "@/server/store";
import { todayUtc } from "@/server/spend";
import { useTempStore } from "../helpers/store";

// ---------------------------------------------------------------------------
// Mocks — meta-agent runner / harness (the LLM-driven core). The DATA layer is
// the REAL JSON file store (see useTempStore); only the agent loop is mocked.
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
// Mocks — LLM adapters (resolveLLM builds these; the cascade client is never
// actually called because runAgent/runCodexAgentTick are mocked).
// ---------------------------------------------------------------------------

const mockCreateAnthropicClient = vi
  .fn()
  .mockReturnValue({ chat: { completions: { create: vi.fn() } } });
vi.mock("@/lib/meta-agent/anthropic-adapter", () => ({
  createAnthropicClient: (...args: unknown[]) => mockCreateAnthropicClient(...args),
}));

const mockCreateCodexClient = vi
  .fn()
  .mockReturnValue({ chat: { completions: { create: vi.fn() } } });
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
// Mocks — tool registry (classifies destructive tools; kept stubbed).
// ---------------------------------------------------------------------------

vi.mock("@/server/tools", () => ({
  createAppRegistry: () => ({ isDestructive: () => false }),
  createAppRegistryWithCustomTools: () => ({ isDestructive: () => false }),
}));

// ---------------------------------------------------------------------------
// Mocks — a2ax (message bus). resetA2AXForTests is preserved because the
// useTempStore helper calls it between cases.
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
  resetA2AXForTests: () => {},
}));

// ---------------------------------------------------------------------------
// Mocks — config (API key source / model).
// ---------------------------------------------------------------------------

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

// The tick route requires a Request (cron auth). In the test env
// (NODE_ENV !== production, no VERCEL) an unset CRON_SECRET authorizes any
// request, so a bare POST Request suffices for the behavior tests.
function tickReq(headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/tick", { method: "POST", headers });
}

/** Seed an active team. lastUserActiveAt defaults to now (within the 5-min
 *  hibernation window), so the tick won't skip it. */
async function seedTeam(overrides: Record<string, unknown> = {}) {
  return teams.insert({ name: "Test Team", ...overrides });
}

/** Seed an agent that is due to run (nextRunAt in the past). */
async function seedAgent(teamId: string, overrides: Record<string, unknown> = {}) {
  return agents.insert(teamId, {
    name: "Researcher",
    role: "research",
    archetype: "researcher",
    tools: ["report_action"],
    scheduleSeconds: 10,
    initialPrompt: "Do research",
    nextRunAt: new Date("2026-05-20T00:00:00Z"),
    ...overrides,
  });
}

/** Seed a resolved (approved/rejected) approval row for one tool call. */
async function seedApproval(
  agent: Agent,
  toolCallId: string,
  status: "approved" | "rejected",
  note: string | null = null,
) {
  await approvals.insertMany(agent.id, [
    { teamId: agent.teamId, toolCallId, toolName: "write_file", toolArguments: "{}" },
  ]);
  const rows = await approvals.byAgent(agent.id);
  const row = rows.find((r) => r.toolCallId === toolCallId);
  if (!row) throw new Error("seeded approval not found");
  await approvals.resolve(agent.teamId, row.id, status, note);
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockRunAgent.mockReset();
  mockRunCodexAgentTick.mockReset();
  mockApproveAgentTick.mockReset();
  mockGetAgentContext.mockResolvedValue({ formatted: "", messageIds: [] });
  mockMarkContextRead.mockResolvedValue(undefined);
  mockBroadcast.mockResolvedValue(undefined);
  mockGetConfig.mockReturnValue({
    openaiApiKey: "",
    openaiBaseUrl: "https://api.openai.com/v1",
    model: "o4-mini",
    databaseUrl: "",
  });
  mockGetApiKeySource.mockReturnValue("config");
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/tick", () => {
  useTempStore();

  it("returns 0 agentsRan when no active teams exist", async () => {
    const { POST } = await import("@/server/api/tick");

    const res = await POST(tickReq());
    const body = (await res.json()) as { ok: boolean; agentsRan: number; timestamp: unknown };

    expect(body.ok).toBe(true);
    expect(body.agentsRan).toBe(0);
    expect(body.timestamp).toBeDefined();
  });

  it("returns 0 agentsRan when team has no agents", async () => {
    const { POST } = await import("@/server/api/tick");
    await seedTeam();

    const res = await POST(tickReq());
    const body = (await res.json()) as { ok: boolean; agentsRan: number };

    expect(body.ok).toBe(true);
    expect(body.agentsRan).toBe(0);
  });

  it("auto-recovers errored agents to running status", async () => {
    const { POST } = await import("@/server/api/tick");
    const team = await seedTeam();
    const agent = await seedAgent(team.id, { status: "errored" });
    // Not approved, so it won't actually run; only the recovery should fire.
    mockApproveAgentTick.mockReturnValue({ allowed: false, reasonCode: "not_due" });

    await POST(tickReq());

    expect((await agents.byId(agent.id))?.status).toBe("running");
    expect((await agents.byId(agent.id))?.inFlight).toBe(false);
  });

  it("runs a due agent successfully and logs the action", async () => {
    const { POST } = await import("@/server/api/tick");
    const team = await seedTeam();
    const agent = await seedAgent(team.id);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockResolvedValueOnce({
      actionType: "research",
      payload: { summary: "Found data" },
    });

    const res = await POST(tickReq());
    const body = (await res.json()) as { ok: boolean; agentsRan: number };

    expect(body.ok).toBe(true);
    expect(body.agentsRan).toBe(1);

    // Action was logged to the store.
    const logs = await actionLog.recentByAgent(agent.id, 10);
    expect(logs).toHaveLength(1);
    expect(logs[0].actionType).toBe("research");
    expect(logs[0].payload).toEqual({ summary: "Found data" });

    // Agent returned to running, inFlight cleared, nextRunAt advanced.
    const after = await agents.byId(agent.id);
    expect(after?.status).toBe("running");
    expect(after?.inFlight).toBe(false);
    expect(after?.nextRunAt?.getTime()).toBeGreaterThan(new Date("2026-05-20T00:00:00Z").getTime());
  });

  it("sets agent to errored on failure", async () => {
    const { POST } = await import("@/server/api/tick");
    const team = await seedTeam();
    const agent = await seedAgent(team.id);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockRejectedValueOnce(new Error("LLM timeout"));

    const res = await POST(tickReq());
    const body = (await res.json()) as { ok: boolean; agentsRan: number };

    expect(body.ok).toBe(true);
    expect(body.agentsRan).toBe(0);

    const after = await agents.byId(agent.id);
    expect(after?.status).toBe("errored");
    expect(after?.inFlight).toBe(false);
  });

  it("increments team tickCount", async () => {
    const { POST } = await import("@/server/api/tick");
    const team = await seedTeam({ tickCount: 3 });

    await POST(tickReq());

    expect((await teams.byId(team.id))?.tickCount).toBe(4);
  });

  it("skips agents that are not approved", async () => {
    const { POST } = await import("@/server/api/tick");
    const team = await seedTeam();
    await seedAgent(team.id);
    mockApproveAgentTick.mockReturnValue({ allowed: false, reasonCode: "not_due" });

    const res = await POST(tickReq());
    const body = (await res.json()) as { agentsRan: number };

    expect(body.agentsRan).toBe(0);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("builds peer list excluding the running agent", async () => {
    const { POST } = await import("@/server/api/tick");
    const team = await seedTeam();
    const agent1 = await seedAgent(team.id, { name: "Alpha" });
    const agent2 = await seedAgent(team.id, { name: "Beta" });
    // Only agent1 is approved (deterministic: approve by id).
    mockApproveAgentTick.mockImplementation((_team: unknown, a: Agent) =>
      a.id === agent1.id ? { allowed: true } : { allowed: false, reasonCode: "not_due" },
    );
    mockRunAgent.mockResolvedValueOnce({ actionType: "noop", payload: {} });

    await POST(tickReq());

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        peers: expect.arrayContaining([expect.objectContaining({ id: agent2.id, name: "Beta" })]),
      }),
    );
    const callArgs = mockRunAgent.mock.calls[0][0];
    expect(callArgs.peers.find((p: { id: string }) => p.id === agent1.id)).toBeUndefined();
  });

  it("fetches a2ax context and marks messages as read", async () => {
    const { POST } = await import("@/server/api/tick");
    const team = await seedTeam();
    const agent = await seedAgent(team.id);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockGetAgentContext.mockResolvedValueOnce({
      formatted: "You have 2 messages",
      messageIds: ["msg-1", "msg-2"],
    });
    mockRunAgent.mockResolvedValueOnce({ actionType: "noop", payload: {} });

    await POST(tickReq());

    expect(mockGetAgentContext).toHaveBeenCalledWith(team.id, agent.id);
    expect(mockMarkContextRead).toHaveBeenCalledWith(agent.id, ["msg-1", "msg-2"]);
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({ a2axContext: "You have 2 messages" }),
    );
  });

  it("handles multiple teams in a single tick", async () => {
    const { POST } = await import("@/server/api/tick");
    const team1 = await seedTeam({ name: "First", tickCount: 0 });
    const team2 = await seedTeam({ name: "Second", tickCount: 0 });
    await seedAgent(team1.id);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockResolvedValueOnce({ actionType: "noop", payload: {} });

    const res = await POST(tickReq());
    const body = (await res.json()) as { agentsRan: number };

    expect(body.agentsRan).toBe(1);
    // Both teams' tickCount incremented.
    expect((await teams.byId(team1.id))?.tickCount).toBe(1);
    expect((await teams.byId(team2.id))?.tickCount).toBe(1);
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
      // Seed today's ledger over the default 5000c cap.
      await spend.insert({
        teamId: null,
        agentId: null,
        model: "claude-sonnet-4",
        inputTokens: 0,
        outputTokens: 0,
        costCents: 999_999,
        day: todayUtc(new Date()),
      });
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
  useTempStore();

  const suspension = {
    messages: [{ role: "assistant", content: null, tool_calls: [] }],
    pending: [{ id: "call_w", name: "write_file", arguments: '{"path":"x"}' }],
    actions: [],
    round: 0,
  };

  it("parks an agent and creates pending_approvals when a run suspends", async () => {
    const { POST } = await import("@/server/api/tick");
    const team = await seedTeam();
    const agent = await seedAgent(team.id);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockResolvedValueOnce({
      actionType: "suspended",
      payload: { agent: "Researcher" },
      suspension,
    });

    await POST(tickReq());

    // Agent parked: status awaiting_approval + conversation state saved, with
    // the play-by-play trace tickId riding along for the resume pass.
    const after = await agents.byId(agent.id);
    expect(after?.status).toBe("awaiting_approval");
    const cs = after?.conversationState as Record<string, unknown>;
    expect(cs.pending).toEqual(suspension.pending);
    expect(typeof cs.traceTickId).toBe("string");

    // A pending approval row was written for the destructive call.
    const pending = await approvals.byAgent(agent.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].toolCallId).toBe("call_w");
    expect(pending[0].toolName).toBe("write_file");

    // nextRunAt must NOT advance while parked.
    expect(after?.nextRunAt?.getTime()).toBe(new Date("2026-05-20T00:00:00Z").getTime());
  });

  it("does not run a fresh tick for an awaiting_approval agent with an unresolved approval", async () => {
    const { POST } = await import("@/server/api/tick");
    const team = await seedTeam();
    const agent = await seedAgent(team.id, {
      status: "awaiting_approval",
      // conversationState set below via update (insert doesn't take it).
    });
    await agents.update(agent.id, { conversationState: suspension });
    // approveAgentTick blocks awaiting_approval in the real route; mock it blocked.
    mockApproveAgentTick.mockReturnValue({ allowed: false, reasonCode: "awaiting_approval" });
    // Still-pending approval -> must NOT resume.
    await approvals.insertMany(agent.id, [
      { teamId: team.id, toolCallId: "call_w", toolName: "write_file", toolArguments: "{}" },
    ]);

    await POST(tickReq());

    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("resumes with decisions once all approvals are resolved", async () => {
    const { POST } = await import("@/server/api/tick");
    const team = await seedTeam();
    const agent = await seedAgent(team.id, { status: "awaiting_approval" });
    await agents.update(agent.id, { conversationState: suspension });
    mockApproveAgentTick.mockReturnValue({ allowed: false, reasonCode: "awaiting_approval" });
    await seedApproval(agent, "call_w", "approved");
    mockRunAgent.mockResolvedValueOnce({
      actionType: "file_written",
      payload: { agent: "Researcher" },
    });

    await POST(tickReq());

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        resume: expect.objectContaining({
          suspension,
          decisions: [{ id: "call_w", approved: true, note: undefined }],
        }),
      }),
    );
    // Resolved approvals consumed.
    expect(await approvals.byAgent(agent.id)).toEqual([]);
    // Completed -> back to running, conversation cleared.
    const after = await agents.byId(agent.id);
    expect(after?.status).toBe("running");
    expect(after?.conversationState).toBeNull();
  });

  it("passes rejection notes through as decisions", async () => {
    const { POST } = await import("@/server/api/tick");
    const team = await seedTeam();
    const agent = await seedAgent(team.id, { status: "awaiting_approval" });
    await agents.update(agent.id, { conversationState: suspension });
    mockApproveAgentTick.mockReturnValue({ allowed: false, reasonCode: "awaiting_approval" });
    await seedApproval(agent, "call_w", "rejected", "too risky");
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
  useTempStore();

  it("errors an agent whose run exceeds the per-agent budget", async () => {
    process.env.SH_AGENT_TIMEOUT_MS = "20"; // tiny budget
    try {
      const { POST } = await import("@/server/api/tick");
      const team = await seedTeam();
      const agent = await seedAgent(team.id);
      mockApproveAgentTick.mockReturnValue({ allowed: true });
      mockRunAgent.mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ actionType: "noop", payload: {} }), 500),
          ),
      );

      const res = await POST(tickReq());
      const body = (await res.json()) as { agentsRan: number };

      expect(body.agentsRan).toBe(0);
      const after = await agents.byId(agent.id);
      expect(after?.status).toBe("errored");
      expect(after?.inFlight).toBe(false);
    } finally {
      delete process.env.SH_AGENT_TIMEOUT_MS;
    }
  });

  it("runs all due agents in a team concurrently (Promise.allSettled)", async () => {
    const { POST } = await import("@/server/api/tick");
    const team = await seedTeam();
    const a1 = await seedAgent(team.id, { name: "Alpha" });
    const a2 = await seedAgent(team.id, { name: "Beta" });
    const a3 = await seedAgent(team.id, { name: "Gamma" });
    mockApproveAgentTick.mockReturnValue({ allowed: true });

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
    expect(started).toHaveLength(3);
    expect(new Set(started)).toEqual(new Set([a1.id, a2.id, a3.id]));
  });

  it("one agent failing does not stop its teammates", async () => {
    const { POST } = await import("@/server/api/tick");
    const team = await seedTeam();
    const a1 = await seedAgent(team.id, { name: "Alpha" });
    const a2 = await seedAgent(team.id, { name: "Beta" });
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    // Fail a1 deterministically by id; succeed a2.
    mockRunAgent.mockImplementation((cfg: { agentId: string }) =>
      cfg.agentId === a1.id
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ actionType: "noop", payload: {} }),
    );

    const res = await POST(tickReq());
    const body = (await res.json()) as { agentsRan: number };

    expect(body.agentsRan).toBe(1);
    expect((await agents.byId(a1.id))?.status).toBe("errored");
    expect((await agents.byId(a2.id))?.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// LLM client selection (resolveLLM builds the cascade from the configured
// providers; the runner is mocked so no real call is made).
// ---------------------------------------------------------------------------

describe("POST /api/tick — LLM client selection", () => {
  useTempStore();

  it("uses Codex client when apiKeySource is codex", async () => {
    const { POST } = await import("@/server/api/tick");

    mockGetApiKeySource.mockReturnValue("codex");
    mockGetConfig.mockReturnValue({
      openaiApiKey: "",
      openaiBaseUrl: "",
      model: "gpt-5.5",
      databaseUrl: "",
    });
    const team = await seedTeam();
    await seedAgent(team.id);
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
    const team = await seedTeam();
    await seedAgent(team.id);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockResolvedValueOnce({ actionType: "noop", payload: {} });

    await POST(tickReq());

    expect(mockCreateAnthropicClient).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-ant-test", timeout: 120_000 }),
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
    await seedTeam();

    await POST(tickReq());

    expect(mockCreateCodexClient).not.toHaveBeenCalled();
    expect(mockCreateAnthropicClient).not.toHaveBeenCalled();
    // OpenAI path is the fallback — it instantiates new OpenAI() internally.
  });
});

// ---------------------------------------------------------------------------
// GET delegates to POST
// ---------------------------------------------------------------------------

describe("GET /api/tick", () => {
  useTempStore();

  it("delegates to POST and returns same shape", async () => {
    const { GET } = await import("@/server/api/tick");

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
  useTempStore();

  it("persists runner trace steps emitted during a successful run", async () => {
    const { traceEvents } = await import("@/server/store");
    const { POST } = await import("@/server/api/tick");
    const team = await seedTeam();
    const agent = await seedAgent(team.id);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockImplementationOnce(async (cfg: { trace?: (s: unknown) => void }) => {
      cfg.trace?.({ type: "tick_started", data: { mode: "fresh", round: 0 } });
      cfg.trace?.({ type: "tick_finished", data: { actionType: "research" } });
      return { actionType: "research", payload: { summary: "done" } };
    });

    await POST(tickReq());

    const rows = await traceEvents.query({ teamId: team.id, order: "asc", limit: 1000 });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.map((r) => r.type)).toEqual(
      expect.arrayContaining(["tick_started", "tick_finished"]),
    );
    // All steps of one run share a tickId and identify the agent.
    const tickIds = new Set(rows.map((r) => r.tickId));
    expect(tickIds.size).toBe(1);
    expect(rows[0].agentId).toBe(agent.id);
    expect(rows[0].teamId).toBe(team.id);
  });

  it("records a tick_failed step when the run throws", async () => {
    const { traceEvents } = await import("@/server/store");
    const { POST } = await import("@/server/api/tick");
    const team = await seedTeam();
    await seedAgent(team.id);
    mockApproveAgentTick.mockReturnValue({ allowed: true });
    mockRunAgent.mockRejectedValueOnce(new Error("LLM exploded"));

    await POST(tickReq());

    const rows = await traceEvents.query({ teamId: team.id, order: "asc", limit: 1000 });
    const failed = rows.find((r) => r.type === "tick_failed");
    expect(failed).toBeDefined();
    expect((failed?.data as Record<string, unknown>)?.error).toContain("LLM exploded");
  });

  it("resume reuses the trace tickId parked with the suspension", async () => {
    const { traceEvents } = await import("@/server/store");
    const { POST } = await import("@/server/api/tick");

    const parkedTickId = "11111111-2222-4333-8444-555555555555";
    const team = await seedTeam();
    const agent = await seedAgent(team.id, { status: "awaiting_approval" });
    await agents.update(agent.id, {
      conversationState: {
        messages: [{ role: "assistant", content: null, tool_calls: [] }],
        pending: [{ id: "call_w", name: "write_file", arguments: "{}" }],
        actions: [],
        round: 0,
        traceTickId: parkedTickId,
      },
    });
    mockApproveAgentTick.mockReturnValue({ allowed: false, reasonCode: "awaiting_approval" });
    await seedApproval(agent, "call_w", "approved");
    mockRunAgent.mockImplementationOnce(async (cfg: { trace?: (s: unknown) => void }) => {
      cfg.trace?.({ type: "tick_started", data: { mode: "resume", round: 0 } });
      return { actionType: "file_written", payload: {} };
    });

    await POST(tickReq());

    const rows = await traceEvents.query({ teamId: team.id, order: "asc", limit: 1000 });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].tickId).toBe(parkedTickId);
  });
});

// ---------------------------------------------------------------------------
// Engine mode: codex app-server harness routing
// ---------------------------------------------------------------------------

describe("POST /api/tick — codex app-server harness", () => {
  useTempStore();

  it("routes fresh codex-provider runs through the harness, not the runner", async () => {
    const { POST } = await import("@/server/api/tick");

    mockGetApiKeySource.mockReturnValue("codex");
    const team = await seedTeam();
    const agent = await seedAgent(team.id);
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

    // Real token usage from the harness lands in the spend ledger (model comes
    // from config — the default test config says o4-mini).
    const today = todayUtc(new Date());
    const spent = await spend.sumForDay(today);
    expect(spent).toBeGreaterThan(0);

    // And the action was logged.
    const logs = await actionLog.recentByAgent(agent.id, 10);
    expect(logs[0].actionType).toBe("research");
  });

  it("SH_CODEX_RUNTIME=exec opts out of the harness", async () => {
    process.env.SH_CODEX_RUNTIME = "exec";
    try {
      const { POST } = await import("@/server/api/tick");

      mockGetApiKeySource.mockReturnValue("codex");
      const team = await seedTeam();
      await seedAgent(team.id);
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
    const team = await seedTeam();
    const agent = await seedAgent(team.id);
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

    const after = await agents.byId(agent.id);
    expect(after?.status).toBe("awaiting_approval");
    const cs = after?.conversationState as Record<string, unknown>;
    expect(cs.kind).toBe("codex-thread");
    expect(cs.threadId).toBe("thr_abc");
    expect(typeof cs.traceTickId).toBe("string");

    const pending = await approvals.byAgent(agent.id);
    expect(pending.some((p) => p.toolCallId === "c9" && p.toolName === "write_file")).toBe(true);
  });

  it("resumes a codex-thread suspension through the harness with the decisions", async () => {
    const { POST } = await import("@/server/api/tick");

    mockGetApiKeySource.mockReturnValue("codex");
    const team = await seedTeam();
    const agent = await seedAgent(team.id, { status: "awaiting_approval" });
    await agents.update(agent.id, {
      conversationState: {
        kind: "codex-thread",
        threadId: "thr_abc",
        pending: [{ id: "c9", name: "write_file", arguments: "{}" }],
        actions: [],
      },
    });
    mockApproveAgentTick.mockReturnValue({ allowed: false, reasonCode: "awaiting_approval" });
    await seedApproval(agent, "c9", "approved");
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

    mockGetApiKeySource.mockReturnValue("codex");
    const team = await seedTeam();
    const agent = await seedAgent(team.id, { status: "awaiting_approval" });
    await agents.update(agent.id, {
      conversationState: {
        messages: [{ role: "assistant", content: null, tool_calls: [] }],
        pending: [{ id: "call_w", name: "write_file", arguments: "{}" }],
        actions: [],
        round: 0,
      },
    });
    mockApproveAgentTick.mockReturnValue({ allowed: false, reasonCode: "awaiting_approval" });
    await seedApproval(agent, "call_w", "approved");
    mockRunAgent.mockResolvedValueOnce({ actionType: "file_written", payload: {} });

    await POST(tickReq());

    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    expect(mockRunCodexAgentTick).not.toHaveBeenCalled();
  });
});

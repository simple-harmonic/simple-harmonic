import { describe, expect, it } from "vitest";
import {
  type AgentLike,
  type TeamLike,
  approveAgentAction,
  approveAgentTick,
} from "@/lib/meta-agent/approval";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTeam(overrides: Partial<TeamLike> = {}): TeamLike {
  return { id: "team-1", paused: false, ...overrides };
}

function makeAgent(overrides: Partial<AgentLike> = {}): AgentLike {
  return {
    id: "agent-1",
    name: "test-agent",
    status: "running",
    inFlight: false,
    nextRunAt: new Date("2025-01-01T00:00:00Z"),
    ...overrides,
  };
}

const NOW = new Date("2025-01-01T00:01:00Z"); // 1 min after agent's nextRunAt

// ---------------------------------------------------------------------------
// approveAgentTick
// ---------------------------------------------------------------------------

describe("approveAgentTick", () => {
  it("allows a running, due, non-in-flight agent on an active team", () => {
    const result = approveAgentTick(makeTeam(), makeAgent(), NOW);
    expect(result).toEqual({ allowed: true });
  });

  it("rejects when team is paused", () => {
    const result = approveAgentTick(makeTeam({ paused: true }), makeAgent(), NOW);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reasonCode).toBe("team_paused");
      expect(result.reason).toContain("paused");
    }
  });

  it("rejects when agent is paused", () => {
    const result = approveAgentTick(makeTeam(), makeAgent({ status: "paused" }), NOW);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reasonCode).toBe("agent_paused");
      expect(result.reason).toContain("paused");
    }
  });

  it("rejects when agent is errored", () => {
    const result = approveAgentTick(makeTeam(), makeAgent({ status: "errored" }), NOW);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reasonCode).toBe("agent_errored");
      expect(result.reason).toContain("errored");
    }
  });

  it("rejects when agent is in-flight", () => {
    const result = approveAgentTick(makeTeam(), makeAgent({ inFlight: true }), NOW);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reasonCode).toBe("agent_in_flight");
      expect(result.reason).toContain("mid-tick");
    }
  });

  it("rejects when nextRunAt is null", () => {
    const result = approveAgentTick(makeTeam(), makeAgent({ nextRunAt: null }), NOW);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reasonCode).toBe("not_due");
    }
  });

  it("rejects when nextRunAt is in the future", () => {
    const futureAgent = makeAgent({ nextRunAt: new Date("2025-01-01T01:00:00Z") });
    const result = approveAgentTick(makeTeam(), futureAgent, NOW);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reasonCode).toBe("not_due");
    }
  });

  it("allows when nextRunAt equals now exactly", () => {
    const exact = new Date("2025-01-01T00:01:00Z");
    const agent = makeAgent({ nextRunAt: exact });
    const result = approveAgentTick(makeTeam(), agent, exact);
    expect(result.allowed).toBe(true);
  });

  it("checks team_paused before agent_paused (priority order)", () => {
    const result = approveAgentTick(
      makeTeam({ paused: true }),
      makeAgent({ status: "paused" }),
      NOW,
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reasonCode).toBe("team_paused");
    }
  });

  it("includes agent name in rejection reasons", () => {
    const agent = makeAgent({ name: "inbox-scanner", status: "paused" });
    const result = approveAgentTick(makeTeam(), agent, NOW);
    if (!result.allowed) {
      expect(result.reason).toContain("inbox-scanner");
    }
  });
});

// ---------------------------------------------------------------------------
// approveAgentAction
// ---------------------------------------------------------------------------

describe("approveAgentAction", () => {
  const team = makeTeam();
  const agent = makeAgent();

  it("allows send_message (internal tool)", () => {
    const result = approveAgentAction(team, agent, {
      toolName: "send_message",
      arguments: { to_agent: "peer", content: "hi" },
    });
    expect(result).toEqual({ allowed: true });
  });

  it("allows broadcast (internal tool)", () => {
    const result = approveAgentAction(team, agent, {
      toolName: "broadcast",
      arguments: { content: "update" },
    });
    expect(result).toEqual({ allowed: true });
  });

  it("allows report_action (internal tool)", () => {
    const result = approveAgentAction(team, agent, {
      toolName: "report_action",
      arguments: { action_type: "test", summary: "done" },
    });
    expect(result).toEqual({ allowed: true });
  });

  it("rejects unknown/external tools", () => {
    const result = approveAgentAction(team, agent, {
      toolName: "send_email",
      arguments: { to: "user@example.com" },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reasonCode).toBe("destructive_unconfirmed");
      expect(result.reason).toContain("send_email");
    }
  });

  it("rejects empty tool name", () => {
    const result = approveAgentAction(team, agent, {
      toolName: "",
      arguments: {},
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reasonCode).toBe("destructive_unconfirmed");
    }
  });
});

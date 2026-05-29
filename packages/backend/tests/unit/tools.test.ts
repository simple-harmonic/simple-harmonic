import { describe, expect, it, vi } from "vitest";
import {
  AGENT_TOOL_DEFS,
  type A2AXSender,
  type PeerAgent,
  type ToolExecContext,
  executeTool,
} from "@/lib/meta-agent/tools";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockA2AX(): A2AXSender {
  return {
    sendDirect: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCtx(overrides: Partial<ToolExecContext> = {}): ToolExecContext {
  return {
    teamId: "team-1",
    agentId: "agent-1",
    agentName: "test-agent",
    peers: [
      { id: "agent-2", name: "content-scheduler", role: "Manages content" },
      { id: "agent-3", name: "ops-monitor", role: "Monitors operations" },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AGENT_TOOL_DEFS
// ---------------------------------------------------------------------------

describe("AGENT_TOOL_DEFS", () => {
  it("defines exactly 3 tools", () => {
    expect(AGENT_TOOL_DEFS).toHaveLength(3);
  });

  it("includes send_message, broadcast, report_action", () => {
    const names = AGENT_TOOL_DEFS.map((t) => t.function.name);
    expect(names).toContain("send_message");
    expect(names).toContain("broadcast");
    expect(names).toContain("report_action");
  });

  it("all tools have type function", () => {
    for (const t of AGENT_TOOL_DEFS) {
      expect(t.type).toBe("function");
    }
  });

  it("all tools have required fields in parameters", () => {
    for (const t of AGENT_TOOL_DEFS) {
      expect(t.function.parameters.type).toBe("object");
      expect(t.function.parameters.required).toBeInstanceOf(Array);
      expect(t.function.parameters.required.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// executeTool: send_message
// ---------------------------------------------------------------------------

describe("executeTool: send_message", () => {
  it("sends a direct message to a known peer", async () => {
    const a2ax = mockA2AX();
    const ctx = makeCtx();

    const result = await executeTool(
      { name: "send_message", arguments: { to_agent: "content-scheduler", content: "hello" } },
      ctx,
      a2ax,
    );

    expect(result.toolName).toBe("send_message");
    expect(result.success).toBe(true);
    expect(result.result).toContain("content-scheduler");
    expect(a2ax.sendDirect).toHaveBeenCalledWith("team-1", "agent-1", "agent-2", "hello");
    expect(result.action).toBeDefined();
    expect(result.action!.actionType).toBe("message_sent");
    expect(result.action!.payload).toEqual({
      to: "content-scheduler",
      toId: "agent-2",
      content: "hello",
    });
  });

  it("is case-insensitive on agent name", async () => {
    const a2ax = mockA2AX();
    const ctx = makeCtx();

    const result = await executeTool(
      { name: "send_message", arguments: { to_agent: "Content-Scheduler", content: "hi" } },
      ctx,
      a2ax,
    );

    expect(result.success).toBe(true);
    expect(a2ax.sendDirect).toHaveBeenCalled();
  });

  it("fails when peer is not found", async () => {
    const a2ax = mockA2AX();
    const ctx = makeCtx();

    const result = await executeTool(
      { name: "send_message", arguments: { to_agent: "unknown-agent", content: "hi" } },
      ctx,
      a2ax,
    );

    expect(result.success).toBe(false);
    expect(result.result).toContain("unknown-agent");
    expect(result.result).toContain("content-scheduler");
    expect(result.result).toContain("ops-monitor");
    expect(a2ax.sendDirect).not.toHaveBeenCalled();
    expect(result.action).toBeUndefined();
  });

  it("fails with empty peer list", async () => {
    const a2ax = mockA2AX();
    const ctx = makeCtx({ peers: [] });

    const result = await executeTool(
      { name: "send_message", arguments: { to_agent: "anyone", content: "hi" } },
      ctx,
      a2ax,
    );

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeTool: broadcast
// ---------------------------------------------------------------------------

describe("executeTool: broadcast", () => {
  it("broadcasts a message to the team", async () => {
    const a2ax = mockA2AX();
    const ctx = makeCtx();

    const result = await executeTool(
      { name: "broadcast", arguments: { content: "status update" } },
      ctx,
      a2ax,
    );

    expect(result.toolName).toBe("broadcast");
    expect(result.success).toBe(true);
    expect(result.result).toContain("2 peers");
    expect(a2ax.broadcast).toHaveBeenCalledWith("team-1", "agent-1", "status update");
    expect(result.action).toBeDefined();
    expect(result.action!.actionType).toBe("broadcast_sent");
    expect(result.action!.payload).toEqual({ content: "status update", peerCount: 2 });
  });

  it("works with zero peers", async () => {
    const a2ax = mockA2AX();
    const ctx = makeCtx({ peers: [] });

    const result = await executeTool(
      { name: "broadcast", arguments: { content: "hello" } },
      ctx,
      a2ax,
    );

    expect(result.success).toBe(true);
    expect(result.result).toContain("0 peers");
  });
});

// ---------------------------------------------------------------------------
// executeTool: report_action
// ---------------------------------------------------------------------------

describe("executeTool: report_action", () => {
  it("logs an action with type and summary", async () => {
    const a2ax = mockA2AX();
    const ctx = makeCtx();

    const result = await executeTool(
      {
        name: "report_action",
        arguments: { action_type: "research_summary", summary: "Found 5 articles" },
      },
      ctx,
      a2ax,
    );

    expect(result.toolName).toBe("report_action");
    expect(result.success).toBe(true);
    expect(result.result).toContain("research_summary");
    expect(result.action).toBeDefined();
    expect(result.action!.actionType).toBe("research_summary");
    expect(result.action!.payload.summary).toBe("Found 5 articles");
  });

  it("merges extra details into payload", async () => {
    const a2ax = mockA2AX();
    const ctx = makeCtx();

    const result = await executeTool(
      {
        name: "report_action",
        arguments: {
          action_type: "metrics_check",
          summary: "All clear",
          details: { cpu: 42, memory: 80 },
        },
      },
      ctx,
      a2ax,
    );

    expect(result.action!.payload).toEqual({
      summary: "All clear",
      cpu: 42,
      memory: 80,
    });
  });

  it("handles missing details gracefully", async () => {
    const a2ax = mockA2AX();
    const ctx = makeCtx();

    const result = await executeTool(
      {
        name: "report_action",
        arguments: { action_type: "noop", summary: "nothing" },
      },
      ctx,
      a2ax,
    );

    expect(result.success).toBe(true);
    expect(result.action!.payload).toEqual({ summary: "nothing" });
  });
});

// ---------------------------------------------------------------------------
// executeTool: unknown tool
// ---------------------------------------------------------------------------

describe("executeTool: unknown tool", () => {
  it("returns failure for unrecognized tool names", async () => {
    const a2ax = mockA2AX();
    const ctx = makeCtx();

    const result = await executeTool(
      { name: "delete_everything", arguments: {} },
      ctx,
      a2ax,
    );

    expect(result.toolName).toBe("delete_everything");
    expect(result.success).toBe(false);
    expect(result.result).toContain("Unknown tool");
    expect(result.action).toBeUndefined();
  });
});

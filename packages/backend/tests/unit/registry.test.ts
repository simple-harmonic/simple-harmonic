import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ToolRegistry, schemaToParameters } from "@/lib/meta-agent/registry";
import { createDefaultRegistry } from "@/lib/meta-agent/default-tools";
import type { ToolRunContext } from "@/lib/meta-agent/tools";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    teamId: "team-1",
    agentId: "agent-1",
    agentName: "test-agent",
    peers: [
      { id: "agent-2", name: "content-scheduler", role: "Manages content" },
      { id: "agent-3", name: "ops-monitor", role: "Monitors operations" },
    ],
    a2ax: {
      sendDirect: vi.fn().mockResolvedValue(undefined),
      broadcast: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

const echoSchema = z.object({
  msg: z.string().describe("a message"),
  times: z.number().optional(),
});

// ---------------------------------------------------------------------------
// schemaToParameters
// ---------------------------------------------------------------------------

describe("schemaToParameters", () => {
  it("converts a Zod object to JSON Schema with descriptions and required", () => {
    const params = schemaToParameters(echoSchema);
    expect(params.type).toBe("object");
    const props = params.properties as Record<string, { description?: string }>;
    expect(props.msg.description).toBe("a message");
    expect(params.required).toEqual(["msg"]);
  });

  it("strips the $schema meta key (LLM tool params reject it)", () => {
    const params = schemaToParameters(echoSchema);
    expect(params.$schema).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ToolRegistry — registration
// ---------------------------------------------------------------------------

describe("ToolRegistry.register", () => {
  it("registers a tool and reports it via has/get", () => {
    const r = new ToolRegistry();
    r.register(
      { name: "echo", description: "echoes", category: "internal", risk: "safe", schema: echoSchema },
      async (args) => ({ toolName: "echo", success: true, result: args.msg }),
    );
    expect(r.has("echo")).toBe(true);
    expect(r.get("echo")?.name).toBe("echo");
    expect(r.get("echo")?.risk).toBe("safe");
  });

  it("throws on duplicate registration (no silent shadowing)", () => {
    const r = new ToolRegistry();
    const def = {
      name: "echo",
      description: "echoes",
      category: "internal" as const,
      risk: "safe" as const,
      schema: echoSchema,
    };
    const impl = async (args: z.infer<typeof echoSchema>) => ({
      toolName: "echo",
      success: true,
      result: args.msg,
    });
    r.register(def, impl);
    expect(() => r.register(def, impl)).toThrow(/already registered/);
  });

  it("has() returns false for unknown tools", () => {
    const r = new ToolRegistry();
    expect(r.has("nope")).toBe(false);
    expect(r.get("nope")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ToolRegistry — listing + OpenAI defs
// ---------------------------------------------------------------------------

describe("ToolRegistry.listForAgent / getOpenAIDefs", () => {
  function loaded(): ToolRegistry {
    const r = new ToolRegistry();
    r.register(
      { name: "a", description: "tool a", category: "internal", risk: "safe", schema: echoSchema },
      async () => ({ toolName: "a", success: true, result: "" }),
    );
    r.register(
      { name: "b", description: "tool b", category: "filesystem", risk: "destructive", schema: echoSchema },
      async () => ({ toolName: "b", success: true, result: "" }),
    );
    return r;
  }

  it("lists all tools when no allowlist is given", () => {
    const names = loaded().listForAgent().map((d) => d.name).sort();
    expect(names).toEqual(["a", "b"]);
  });

  it("filters to the allowlist", () => {
    const names = loaded().listForAgent(["a"]).map((d) => d.name);
    expect(names).toEqual(["a"]);
  });

  it("ignores unknown names in the allowlist", () => {
    const names = loaded().listForAgent(["a", "ghost"]).map((d) => d.name);
    expect(names).toEqual(["a"]);
  });

  it("getOpenAIDefs emits OpenAI function shape, allowlist-filtered", () => {
    const defs = loaded().getOpenAIDefs(["b"]);
    expect(defs).toHaveLength(1);
    expect(defs[0].type).toBe("function");
    expect(defs[0].function.name).toBe("b");
    expect(defs[0].function.description).toBe("tool b");
    expect(defs[0].function.parameters?.type).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// ToolRegistry — execute (validation + dispatch)
// ---------------------------------------------------------------------------

describe("ToolRegistry.execute", () => {
  function withEcho(): ToolRegistry {
    const r = new ToolRegistry();
    r.register(
      { name: "echo", description: "echoes", category: "internal", risk: "safe", schema: echoSchema },
      async (args) => ({
        toolName: "echo",
        success: true,
        result: `got: ${args.msg}`,
      }),
    );
    return r;
  }

  it("validates args then calls the impl with parsed data", async () => {
    const res = await withEcho().execute("echo", { msg: "hi" }, makeCtx());
    expect(res.success).toBe(true);
    expect(res.result).toBe("got: hi");
  });

  it("returns an error result for an unknown tool (does not throw)", async () => {
    const res = await withEcho().execute("ghost", {}, makeCtx());
    expect(res.success).toBe(false);
    expect(res.result).toContain("Unknown tool: ghost");
  });

  it("returns a schema-validation error result naming the bad field", async () => {
    // msg is required and must be a string; pass a number.
    const res = await withEcho().execute("echo", { msg: 123 }, makeCtx());
    expect(res.success).toBe(false);
    expect(res.result).toContain("Invalid arguments for echo");
    expect(res.result).toContain("msg");
  });

  it("rejects missing required fields", async () => {
    const res = await withEcho().execute("echo", {}, makeCtx());
    expect(res.success).toBe(false);
    expect(res.result).toContain("Invalid arguments for echo");
  });

  it("does not call the impl when validation fails", async () => {
    const r = new ToolRegistry();
    const impl = vi.fn().mockResolvedValue({ toolName: "echo", success: true, result: "" });
    r.register(
      { name: "echo", description: "x", category: "internal", risk: "safe", schema: echoSchema },
      impl,
    );
    await r.execute("echo", { msg: 5 }, makeCtx());
    expect(impl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createDefaultRegistry — the internal tools
// ---------------------------------------------------------------------------

describe("createDefaultRegistry", () => {
  it("registers exactly the three internal tools, all safe", () => {
    const r = createDefaultRegistry();
    const defs = r.listForAgent();
    expect(defs.map((d) => d.name).sort()).toEqual([
      "broadcast",
      "report_action",
      "send_message",
    ]);
    expect(defs.every((d) => d.risk === "safe")).toBe(true);
    expect(defs.every((d) => d.category === "internal")).toBe(true);
  });

  it("send_message routes to the named peer via a2ax", async () => {
    const r = createDefaultRegistry();
    const ctx = makeCtx();
    const res = await r.execute(
      "send_message",
      { to_agent: "content-scheduler", content: "hello" },
      ctx,
    );
    expect(res.success).toBe(true);
    expect(ctx.a2ax.sendDirect).toHaveBeenCalledWith(
      "team-1",
      "agent-1",
      "agent-2",
      "hello",
    );
    expect(res.action?.actionType).toBe("message_sent");
  });

  it("send_message fails for an unknown peer without calling a2ax", async () => {
    const r = createDefaultRegistry();
    const ctx = makeCtx();
    const res = await r.execute(
      "send_message",
      { to_agent: "ghost", content: "hi" },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.result).toContain("ghost");
    expect(ctx.a2ax.sendDirect).not.toHaveBeenCalled();
  });

  it("broadcast sends to the bus and reports peer count", async () => {
    const r = createDefaultRegistry();
    const ctx = makeCtx();
    const res = await r.execute("broadcast", { content: "all hands" }, ctx);
    expect(res.success).toBe(true);
    expect(ctx.a2ax.broadcast).toHaveBeenCalledWith("team-1", "agent-1", "all hands");
    expect(res.action?.payload).toMatchObject({ content: "all hands", peerCount: 2 });
  });

  it("report_action logs with merged details", async () => {
    const r = createDefaultRegistry();
    const res = await r.execute(
      "report_action",
      { action_type: "scan", summary: "done", details: { count: 3 } },
      makeCtx(),
    );
    expect(res.success).toBe(true);
    expect(res.action?.actionType).toBe("scan");
    expect(res.action?.payload).toMatchObject({ summary: "done", count: 3 });
  });

  it("report_action works without optional details", async () => {
    const r = createDefaultRegistry();
    const res = await r.execute(
      "report_action",
      { action_type: "ping", summary: "ok" },
      makeCtx(),
    );
    expect(res.success).toBe(true);
    expect(res.action?.payload).toMatchObject({ summary: "ok" });
  });
});

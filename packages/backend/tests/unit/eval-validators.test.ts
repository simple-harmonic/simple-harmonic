import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  summarize,
  validateSpawnResult,
  validateToolUse,
} from "@/lib/meta-agent/eval/validators";
import type { SpawnTeamResult } from "@/lib/meta-agent/planner";
import { VISION_INPUTS, TOOL_USE_SCENARIOS } from "@/lib/meta-agent/eval/fixtures";

const KNOWN_TOOLS = new Set([
  "send_message",
  "broadcast",
  "report_action",
  "read_file",
  "write_file",
  "run_command",
  "http_fetch",
  "github_api",
]);

function goodAgent(overrides: Record<string, unknown> = {}) {
  return {
    name: "Researcher",
    role: "Market research",
    archetype: "researcher",
    tools: ["report_action", "http_fetch"],
    schedule_seconds: 300,
    initial_prompt: "Research the competitive landscape and report findings.",
    ...overrides,
  };
}

function goodSpawn(overrides: Partial<SpawnTeamResult> = {}): SpawnTeamResult {
  return {
    team_name: "Growth Team",
    agents: [goodAgent(), goodAgent({ name: "Writer", archetype: "writer" })],
    ...overrides,
  } as SpawnTeamResult;
}

// ---------------------------------------------------------------------------
// validateSpawnResult
// ---------------------------------------------------------------------------

describe("validateSpawnResult", () => {
  it("passes a well-formed team", () => {
    const r = validateSpawnResult(goodSpawn(), KNOWN_TOOLS);
    expect(r.passed).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it("fails an empty team", () => {
    const r = validateSpawnResult(goodSpawn({ agents: [] }), KNOWN_TOOLS);
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.code === "no_agents")).toBe(true);
  });

  it("fails a team with no name", () => {
    const r = validateSpawnResult(goodSpawn({ team_name: "  " }), KNOWN_TOOLS);
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.code === "team_name_empty")).toBe(true);
  });

  it("fails on duplicate agent names (case-insensitive)", () => {
    const r = validateSpawnResult(
      goodSpawn({ agents: [goodAgent({ name: "Bot" }), goodAgent({ name: "bot" })] }),
      KNOWN_TOOLS,
    );
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.code === "duplicate_agent_name")).toBe(true);
  });

  it("fails on more than six agents", () => {
    const agents = Array.from({ length: 7 }, (_, i) => goodAgent({ name: `A${i}` }));
    const r = validateSpawnResult(goodSpawn({ agents }), KNOWN_TOOLS);
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.code === "too_many_agents")).toBe(true);
  });

  it("fails a schedule below the minimum", () => {
    const r = validateSpawnResult(
      goodSpawn({ agents: [goodAgent({ schedule_seconds: 2 })] }),
      KNOWN_TOOLS,
    );
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.code === "schedule_too_fast")).toBe(true);
  });

  it("fails a thin initial prompt", () => {
    const r = validateSpawnResult(
      goodSpawn({ agents: [goodAgent({ initial_prompt: "go" })] }),
      KNOWN_TOOLS,
    );
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.code === "agent_prompt_thin")).toBe(true);
  });

  it("fails an unknown tool reference", () => {
    const r = validateSpawnResult(
      goodSpawn({ agents: [goodAgent({ tools: ["read_file", "delete_universe"] })] }),
      KNOWN_TOOLS,
    );
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.code === "unknown_tool")).toBe(true);
  });

  it("skips tool-name checks when no known set is given", () => {
    const r = validateSpawnResult(goodSpawn({ agents: [goodAgent({ tools: ["anything"] })] }));
    expect(r.issues.some((i) => i.code === "unknown_tool")).toBe(false);
  });

  it("warns (not errors) on a missing role", () => {
    const r = validateSpawnResult(
      goodSpawn({ agents: [goodAgent({ role: "" })] }),
      KNOWN_TOOLS,
    );
    expect(r.passed).toBe(true); // warn doesn't fail
    expect(r.issues.some((i) => i.code === "agent_role_empty" && i.severity === "warn")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateToolUse
// ---------------------------------------------------------------------------

describe("validateToolUse", () => {
  // A tiny registry-like lookup with a couple of real-ish schemas.
  const lookup = {
    get(name: string) {
      const schemas: Record<string, z.ZodType> = {
        read_file: z.object({ path: z.string() }),
        broadcast: z.object({ content: z.string() }),
      };
      const schema = schemas[name];
      return schema ? { schema } : undefined;
    },
  };

  it("passes a correct tool + valid args + matching expectation", () => {
    const r = validateToolUse(
      { toolName: "read_file", args: { path: "a.ts" }, expectedTool: "read_file" },
      lookup,
    );
    expect(r.passed).toBe(true);
  });

  it("fails an unknown tool", () => {
    const r = validateToolUse({ toolName: "nope", args: {} }, lookup);
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.code === "tool_not_found")).toBe(true);
  });

  it("fails args that don't match the schema", () => {
    const r = validateToolUse({ toolName: "read_file", args: { path: 123 } }, lookup);
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.code === "args_invalid")).toBe(true);
  });

  it("fails when the wrong tool was chosen", () => {
    const r = validateToolUse(
      { toolName: "broadcast", args: { content: "hi" }, expectedTool: "read_file" },
      lookup,
    );
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.code === "wrong_tool")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// summarize + fixtures
// ---------------------------------------------------------------------------

describe("summarize", () => {
  it("computes pass rate", () => {
    const s = summarize([
      { passed: true, issues: [] },
      { passed: false, issues: [] },
      { passed: true, issues: [] },
    ]);
    expect(s).toEqual({ total: 3, passed: 2, failed: 1, passRate: 2 / 3 });
  });

  it("treats an empty set as fully passing", () => {
    expect(summarize([]).passRate).toBe(1);
  });
});

describe("fixtures", () => {
  it("ships 10 diverse vision inputs with unique ids", () => {
    expect(VISION_INPUTS).toHaveLength(10);
    expect(new Set(VISION_INPUTS.map((v) => v.id)).size).toBe(10);
  });

  it("tool-use scenarios reference only known tools", () => {
    for (const s of TOOL_USE_SCENARIOS) {
      expect(KNOWN_TOOLS.has(s.expectedTool)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Eval validators (T10 / D13).
//
// Pure, deterministic checks that grade planner and agent-tool-use output. The
// live eval runner (run-eval.ts) feeds real LLM output through these; the unit
// tests feed fixtures. Keeping the judgement here (not in the runner) is what
// makes the eval suite testable without an API key and reusable as a guard
// against prompt regressions.
//
// No I/O, no SDK. Tool knowledge is injected (known tool names / a schema
// lookup), mirroring how the approval gate injects its destructive classifier.
// ---------------------------------------------------------------------------

import type { z } from "zod";
import type { SpawnTeamResult, SpawnTeamAgent } from "../planner";

/** A single problem found in graded output. severity drives pass/fail. */
export interface EvalIssue {
  severity: "error" | "warn";
  code: string;
  message: string;
}

export interface EvalReport {
  passed: boolean; // true iff no "error" issues
  issues: EvalIssue[];
}

// Sane bounds for an agent's tick cadence. Below 10s slams the LLM API; above a
// day means the agent effectively never runs.
const MIN_SCHEDULE_SECONDS = 10;
const MAX_SCHEDULE_SECONDS = 24 * 60 * 60;
const MAX_AGENTS = 6; // CLAUDE.md voice: "six is more than you'll supervise."

function err(code: string, message: string): EvalIssue {
  return { severity: "error", code, message };
}
function warn(code: string, message: string): EvalIssue {
  return { severity: "warn", code, message };
}

/**
 * Validate a planner spawn result for schema validity and role coherence.
 *
 * @param spawn        the planner's proposed team
 * @param knownTools   the set of tool names an agent may be assigned. When
 *                     provided, an agent referencing an unknown tool is an
 *                     error. Omit to skip tool-name checking.
 */
export function validateSpawnResult(
  spawn: SpawnTeamResult,
  knownTools?: Set<string>,
): EvalReport {
  const issues: EvalIssue[] = [];

  if (!spawn.teamName || spawn.teamName.trim().length === 0) {
    issues.push(err("team_name_empty", "Team has no name."));
  }

  const agents = spawn.agents ?? [];
  if (agents.length === 0) {
    issues.push(err("no_agents", "Team has zero agents."));
  }
  if (agents.length > MAX_AGENTS) {
    issues.push(
      err(
        "too_many_agents",
        `Team has ${agents.length} agents; more than ${MAX_AGENTS} is more than a founder can supervise.`,
      ),
    );
  }

  // Duplicate-name detection (case-insensitive — two "Researcher"s confuse
  // routing and the graph view).
  const seen = new Map<string, number>();
  for (const a of agents) {
    const key = (a.name ?? "").trim().toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) {
      issues.push(err("duplicate_agent_name", `Agent name "${key}" appears ${count} times.`));
    }
  }

  for (const a of agents) {
    issues.push(...validateAgent(a, knownTools));
  }

  return { passed: !issues.some((i) => i.severity === "error"), issues };
}

function validateAgent(a: SpawnTeamAgent, knownTools?: Set<string>): EvalIssue[] {
  const issues: EvalIssue[] = [];
  const label = a.name?.trim() || "(unnamed)";

  if (!a.name || a.name.trim().length === 0) {
    issues.push(err("agent_name_empty", "An agent has no name."));
  }
  if (!a.role || a.role.trim().length === 0) {
    issues.push(warn("agent_role_empty", `${label} has no role.`));
  }
  if (!a.archetype || a.archetype.trim().length === 0) {
    issues.push(warn("agent_archetype_empty", `${label} has no archetype.`));
  }
  if (!a.initial_prompt || a.initial_prompt.trim().length < 10) {
    issues.push(
      err("agent_prompt_thin", `${label} has a missing or trivially short initial prompt.`),
    );
  }

  const sched = a.schedule_seconds;
  if (typeof sched !== "number" || Number.isNaN(sched)) {
    issues.push(err("schedule_invalid", `${label} has a non-numeric schedule.`));
  } else if (sched < MIN_SCHEDULE_SECONDS) {
    issues.push(
      err("schedule_too_fast", `${label} ticks every ${sched}s; min is ${MIN_SCHEDULE_SECONDS}s.`),
    );
  } else if (sched > MAX_SCHEDULE_SECONDS) {
    issues.push(
      warn("schedule_too_slow", `${label} ticks every ${sched}s; that's over a day.`),
    );
  }

  const tools = a.tools ?? [];
  if (!Array.isArray(tools) || tools.length === 0) {
    issues.push(warn("agent_no_tools", `${label} has no tools assigned.`));
  } else if (knownTools) {
    for (const t of tools) {
      if (!knownTools.has(t)) {
        issues.push(err("unknown_tool", `${label} references unknown tool "${t}".`));
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Tool-use eval
// ---------------------------------------------------------------------------

/** Minimal view of a tool the validator needs: its name + args schema. */
export interface ToolSchemaLookup {
  get(name: string): { schema: z.ZodType } | undefined;
}

/** One agent tool-use attempt to grade. */
export interface ToolUseAttempt {
  /** The tool the agent chose. */
  toolName: string;
  /** The args it supplied (already JSON-parsed). */
  args: unknown;
  /** Optional: the tool the scenario expected, for selection grading. */
  expectedTool?: string;
}

/**
 * Grade a single tool-use attempt: the chosen tool must exist, its args must
 * pass the tool's Zod schema, and (if an expectation is given) it must be the
 * expected tool. This is what catches "agent calls write_file when it should
 * read_file" and "agent emits args that don't match the schema" regressions.
 */
export function validateToolUse(
  attempt: ToolUseAttempt,
  registry: ToolSchemaLookup,
): EvalReport {
  const issues: EvalIssue[] = [];

  const tool = registry.get(attempt.toolName);
  if (!tool) {
    issues.push(err("tool_not_found", `Chose unknown tool "${attempt.toolName}".`));
    // Can't validate args against a missing schema; selection check still runs.
  } else {
    const parsed = tool.schema.safeParse(attempt.args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      issues.push(err("args_invalid", `Args for "${attempt.toolName}" failed schema: ${detail}`));
    }
  }

  if (attempt.expectedTool && attempt.toolName !== attempt.expectedTool) {
    issues.push(
      err(
        "wrong_tool",
        `Chose "${attempt.toolName}" but the scenario expected "${attempt.expectedTool}".`,
      ),
    );
  }

  return { passed: !issues.some((i) => i.severity === "error"), issues };
}

/** Aggregate many reports into a pass-rate summary for the runner. */
export function summarize(reports: EvalReport[]): {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
} {
  const total = reports.length;
  const passed = reports.filter((r) => r.passed).length;
  return {
    total,
    passed,
    failed: total - passed,
    passRate: total === 0 ? 1 : passed / total,
  };
}

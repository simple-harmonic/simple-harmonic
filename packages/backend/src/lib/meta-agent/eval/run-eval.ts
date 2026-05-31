// ---------------------------------------------------------------------------
// Live eval runner (T10 / D13).
//
// Feeds the fixtures through the REAL planner / agent runner and grades the
// output with the validators. Requires a live LLM (ANTHROPIC_API_KEY), so it is
// NOT part of the unit suite — run it manually before shipping a prompt change:
//
//   ANTHROPIC_API_KEY=... npx tsx packages/backend/src/lib/meta-agent/eval/run-eval.ts
//
// The validators it depends on ARE unit-tested (eval-validators.test.ts); this
// file is the harness that points them at real model output. Kept dependency-
// light and side-effect-free on import (only main() does I/O) so importing the
// fixtures/validators elsewhere never triggers an LLM call.
// ---------------------------------------------------------------------------

import { createAnthropicClient } from "../anthropic-adapter";
import { plannerStream } from "../planner";
import { VISION_INPUTS } from "./fixtures";
import { type EvalReport, summarize, validateSpawnResult } from "./validators";

// The tool names an agent may be assigned (the full app tool set). Kept as a
// literal here so the library eval doesn't import the app's server/ registry.
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

async function runPlannerEval(): Promise<EvalReport[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — cannot run the live planner eval.");
    return [];
  }
  const llm = createAnthropicClient({ apiKey });
  const reports: EvalReport[] = [];

  for (const input of VISION_INPUTS) {
    process.stdout.write(`\n[${input.id}] `);
    try {
      const result = await plannerStream(
        [{ role: "user", content: input.vision }],
        () => {}, // ignore streamed tokens
        { llm, model: "claude-sonnet-4-20250514" },
      );

      if (!result.spawn) {
        reports.push({
          passed: false,
          issues: [{ severity: "error", code: "no_spawn", message: "Planner produced no team." }],
        });
        console.log("FAIL — no team produced");
        continue;
      }

      const report = validateSpawnResult(result.spawn, KNOWN_TOOLS);
      reports.push(report);
      const n = result.spawn.agents.length;
      const [lo, hi] = input.expectAgentsBetween;
      const sizeNote = n >= lo && n <= hi ? "" : ` (size ${n}, expected ${lo}-${hi})`;
      console.log(report.passed ? `PASS — ${n} agents${sizeNote}` : "FAIL");
      for (const i of report.issues) console.log(`   ${i.severity}: ${i.code} — ${i.message}`);
    } catch (e) {
      reports.push({
        passed: false,
        issues: [{ severity: "error", code: "threw", message: e instanceof Error ? e.message : String(e) }],
      });
      console.log("FAIL — threw");
    }
  }
  return reports;
}

async function main(): Promise<void> {
  console.log("=== Planner eval (10 vision inputs) ===");
  const planner = await runPlannerEval();
  const s = summarize(planner);
  console.log(`\nPlanner: ${s.passed}/${s.total} passed (${Math.round(s.passRate * 100)}%)`);

  // Tool-use eval is left to a follow-up: it needs the agent runner wired to a
  // live LLM with the full app registry, which pulls server/ into this library
  // file. The validators (validateToolUse) are ready and unit-tested; wiring is
  // tracked in TODOS.
  process.exit(s.failed > 0 ? 1 : 0);
}

// Only run when executed directly, never on import.
if (process.argv[1] && process.argv[1].endsWith("run-eval.ts")) {
  void main();
}

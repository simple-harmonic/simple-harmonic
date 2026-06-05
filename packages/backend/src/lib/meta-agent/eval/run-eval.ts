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

import { type PlannerDeps, plannerStream } from "../planner";
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
  // plannerStream picks its backend from config (getApiKeySource): Codex CLI if
  // logged in, else the OpenAI-compatible key. It does NOT take an injected
  // client, so we just need *a* configured provider in the environment.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    console.error("No LLM provider configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY).");
    return [];
  }
  const reports: EvalReport[] = [];

  // The library eval stays server-free: build PlannerDeps from env directly
  // (the OpenAI-compatible path). The codex path isn't exercised here.
  const deps: PlannerDeps = {
    config: {
      model: process.env.OPENAI_MODEL || "o4-mini",
      openaiApiKey: process.env.OPENAI_API_KEY,
      openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    },
    apiKeySource: "env",
    codexAccessToken: null,
    codexAccountId: "",
    fetchImpl: (url, init) => fetch(url, init as RequestInit),
  };

  for (const input of VISION_INPUTS) {
    process.stdout.write(`\n[${input.id}] `);
    try {
      const result = await plannerStream(
        [{ role: "user", content: input.vision }],
        () => {}, // ignore streamed tokens
        deps,
      );

      // PlannerResult is a union: only the "spawn" variant carries a team.
      if (result.type !== "spawn") {
        reports.push({
          passed: false,
          issues: [{ severity: "error", code: "no_spawn", message: "Planner did not produce a team (returned a message)." }],
        });
        console.log("FAIL — no team produced");
        continue;
      }

      const report = validateSpawnResult(result.result, KNOWN_TOOLS);
      reports.push(report);
      const n = result.result.agents.length;
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
  if (planner.length === 0) {
    console.log("\nPlanner: 0/0 passed (no provider configured)");
    process.exit(1);
  }
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

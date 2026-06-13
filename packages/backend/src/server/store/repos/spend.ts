// ---------------------------------------------------------------------------
// LLM spend ledger repo — one global append-only JSONL (system/spend.jsonl),
// day-keyed. The daily cap sums costCents for the current UTC day.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { spendLogPath } from "../data-dir";
import { appendJsonl, readJsonl } from "../fs-store";
import type { LlmSpendEntry } from "../types";

export interface NewSpend {
  teamId: string | null;
  agentId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  day: string; // UTC YYYY-MM-DD
}

export const spend = {
  async insert(e: NewSpend): Promise<void> {
    const row: LlmSpendEntry = {
      id: randomUUID(),
      teamId: e.teamId,
      agentId: e.agentId,
      model: e.model,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      costCents: e.costCents,
      day: e.day,
      createdAt: new Date(),
    };
    appendJsonl(spendLogPath(), row);
  },

  /** Total costCents recorded for a given UTC day. */
  async sumForDay(day: string): Promise<number> {
    const rows = readJsonl<{ day?: string; costCents?: number }>(spendLogPath());
    let total = 0;
    for (const r of rows) {
      if (r.day === day) total += r.costCents ?? 0;
    }
    return total;
  },
};

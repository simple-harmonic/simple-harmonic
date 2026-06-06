import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/server/db/schema", () => ({
  llmSpend: { costCents: "cost_cents", day: "day" },
}));
vi.mock("drizzle-orm", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    _sql: strings.join("?"),
    values,
  }),
}));

import {
  checkSpendAllowed,
  costCents,
  dailyCapCents,
  makeCountingLLM,
  recordSpend,
  todayUtc,
} from "../../src/server/spend";

function fakeDb(total: number | Error) {
  return {
    select: () => ({
      from: () => ({
        where: () =>
          total instanceof Error
            ? Promise.reject(total)
            : Promise.resolve([{ total }]),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    // biome-ignore lint/suspicious/noExplicitAny: test double
  } as any;
}

describe("spend", () => {
  const savedCap = process.env.SH_DAILY_SPEND_CAP_CENTS;
  afterEach(() => {
    if (savedCap === undefined) delete process.env.SH_DAILY_SPEND_CAP_CENTS;
    else process.env.SH_DAILY_SPEND_CAP_CENTS = savedCap;
  });

  it("costCents uses claude-sonnet rates and rounds up", () => {
    // 1M in @ 300c + 1M out @ 1500c = 1800c
    expect(costCents("claude-sonnet-4-20250514", 1_000_000, 1_000_000)).toBe(1800);
    // 1000 in @ 300c/M = 0.3c -> ceil 1
    expect(costCents("claude-sonnet-4", 1000, 0)).toBe(1);
  });

  it("costCents uses the expensive fallback for an unknown model", () => {
    expect(costCents("mystery-model", 1_000_000, 0)).toBe(1500);
  });

  it("dailyCapCents defaults to 5000 and is overridable", () => {
    delete process.env.SH_DAILY_SPEND_CAP_CENTS;
    expect(dailyCapCents()).toBe(5000);
    process.env.SH_DAILY_SPEND_CAP_CENTS = "1234";
    expect(dailyCapCents()).toBe(1234);
  });

  it("todayUtc returns YYYY-MM-DD", () => {
    expect(todayUtc(new Date("2026-06-05T23:30:00Z"))).toBe("2026-06-05");
  });

  it("checkSpendAllowed: under cap allowed, at/over cap blocked", async () => {
    process.env.SH_DAILY_SPEND_CAP_CENTS = "5000";
    const now = new Date("2026-06-05T00:00:00Z");
    expect((await checkSpendAllowed(fakeDb(100), now)).allowed).toBe(true);
    expect((await checkSpendAllowed(fakeDb(5000), now)).allowed).toBe(false);
    expect((await checkSpendAllowed(fakeDb(9999), now)).allowed).toBe(false);
  });

  it("checkSpendAllowed fails OPEN (unknown) on a ledger read error", async () => {
    const res = await checkSpendAllowed(
      fakeDb(new Error("relation llm_spend does not exist")),
      new Date(),
    );
    expect(res.allowed).toBe(true);
    expect(res.unknown).toBe(true);
  });

  it("recordSpend skips zero-usage and inserts non-zero usage", async () => {
    const db = fakeDb(0);
    await recordSpend(db, new Date(), {
      model: "claude-sonnet-4",
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(db.insert).not.toHaveBeenCalled();
    await recordSpend(db, new Date(), {
      model: "claude-sonnet-4",
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("makeCountingLLM accumulates token usage across calls", async () => {
    const base = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValue({ choices: [], usage: { input_tokens: 10, output_tokens: 4 } }),
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: test double
    } as any;
    const { llm, usage } = makeCountingLLM(base, "claude-sonnet-4");
    await llm.chat.completions.create({ model: "claude-sonnet-4", messages: [] });
    await llm.chat.completions.create({ model: "claude-sonnet-4", messages: [] });
    expect(usage.inputTokens).toBe(20);
    expect(usage.outputTokens).toBe(8);
  });
});

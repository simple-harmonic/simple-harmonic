import { afterEach, describe, expect, it, vi } from "vitest";
import { spend } from "@/server/store";
import {
  checkSpendAllowed,
  costCents,
  dailyCapCents,
  makeCountingLLM,
  recordSpend,
  todayUtc,
} from "@/server/spend";
import { useTempStore } from "../helpers/store";

describe("spend", () => {
  useTempStore();

  const savedCap = process.env.SH_DAILY_SPEND_CAP_CENTS;
  afterEach(() => {
    if (savedCap === undefined) delete process.env.SH_DAILY_SPEND_CAP_CENTS;
    else process.env.SH_DAILY_SPEND_CAP_CENTS = savedCap;
    vi.restoreAllMocks();
  });

  function seed(costCentsValue: number, day: string) {
    return spend.insert({
      teamId: null,
      agentId: null,
      model: "claude-sonnet-4",
      inputTokens: 1,
      outputTokens: 1,
      costCents: costCentsValue,
      day,
    });
  }

  it("costCents uses claude-sonnet rates and rounds up", () => {
    // 1M in @ 300c + 1M out @ 1500c = 1800c
    expect(costCents("claude-sonnet-4-20250514", 1_000_000, 1_000_000)).toBe(1800);
    // 1000 in @ 300c/M = 0.3c -> ceil 1
    expect(costCents("claude-sonnet-4", 1000, 0)).toBe(1);
  });

  it("costCents uses the expensive fallback for an unknown model", () => {
    expect(costCents("mystery-model", 1_000_000, 0)).toBe(1500);
  });

  it("costCents strips OpenRouter vendor namespaces before rate matching", () => {
    expect(costCents("anthropic/claude-sonnet-4", 1_000_000, 1_000_000)).toBe(1800);
    expect(costCents("openai/gpt-5.5", 1_000_000, 0)).toBe(125);
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
    const day = todayUtc(now);

    await seed(100, day); // total 100
    expect((await checkSpendAllowed(now)).allowed).toBe(true);

    await seed(4900, day); // total 5000 (>= cap)
    expect((await checkSpendAllowed(now)).allowed).toBe(false);

    await seed(4999, day); // total 9999
    expect((await checkSpendAllowed(now)).allowed).toBe(false);
  });

  it("checkSpendAllowed fails OPEN (unknown) on a ledger read error", async () => {
    vi.spyOn(spend, "sumForDay").mockRejectedValueOnce(new Error("ledger unreadable"));
    const res = await checkSpendAllowed(new Date());
    expect(res.allowed).toBe(true);
    expect(res.unknown).toBe(true);
  });

  it("recordSpend skips zero-usage and inserts non-zero usage", async () => {
    const insertSpy = vi.spyOn(spend, "insert");
    await recordSpend(new Date(), {
      model: "claude-sonnet-4",
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(insertSpy).not.toHaveBeenCalled();
    await recordSpend(new Date(), {
      model: "claude-sonnet-4",
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(insertSpy).toHaveBeenCalledTimes(1);
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

  it("makeCountingLLM attributes spend to the serving model over the requested one", async () => {
    const base = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [],
            // The cascade stamps the model that actually served the call.
            model: "openrouter-served/gpt-5.5",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: test double
    } as any;
    const { llm, usage } = makeCountingLLM(base, "claude-sonnet-4");
    await llm.chat.completions.create({ model: "claude-sonnet-4", messages: [] });
    expect(usage.model).toBe("openrouter-served/gpt-5.5");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { codingEnv, scrubbedEnv } from "../../src/server/tools/sandbox";

describe("codingEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("forwards only named provider keys, never other secrets", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-xxx");
    vi.stubEnv("DATABASE_URL", "postgres://secret");
    vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
    vi.stubEnv("OPENAI_API_KEY", "sk-openai");

    const env = codingEnv(["ANTHROPIC_API_KEY"]) as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    // Base allowlist preserved (needed for the CLI to run + find credentials).
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("with no extra keys equals scrubbedEnv", () => {
    expect(Object.keys(codingEnv()).sort()).toEqual(Object.keys(scrubbedEnv()).sort());
  });

  it("ignores invalid/lowercase/traversal key names", () => {
    vi.stubEnv("lowercase_key", "x");
    const env = codingEnv(["lowercase_key", "BAD-KEY", "../escape"]) as Record<string, string>;
    expect(env.lowercase_key).toBeUndefined();
    expect(env["BAD-KEY"]).toBeUndefined();
  });

  it("skips a named key that is not set in the environment", () => {
    const env = codingEnv(["DEFINITELY_NOT_SET_KEY"]) as Record<string, string>;
    expect(env.DEFINITELY_NOT_SET_KEY).toBeUndefined();
  });
});

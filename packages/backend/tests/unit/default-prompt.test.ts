import { describe, expect, it } from "vitest";
import { DEFAULT_META_AGENT_PROMPT } from "@/lib/meta-agent/default-prompt";

describe("DEFAULT_META_AGENT_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof DEFAULT_META_AGENT_PROMPT).toBe("string");
    expect(DEFAULT_META_AGENT_PROMPT.length).toBeGreaterThan(100);
  });

  it("contains the cofounder identity", () => {
    expect(DEFAULT_META_AGENT_PROMPT).toContain("Harmon");
    expect(DEFAULT_META_AGENT_PROMPT).toContain("cofounder");
  });

  it("contains voice rules", () => {
    expect(DEFAULT_META_AGENT_PROMPT).toContain("Calm authority");
    expect(DEFAULT_META_AGENT_PROMPT).toContain("No filler");
  });

  it("references the spawn_team tool", () => {
    expect(DEFAULT_META_AGENT_PROMPT).toContain("spawn_team");
  });

  it("lists all agent archetypes", () => {
    const archetypes = [
      "support-responder",
      "content-scheduler",
      "sales-followup",
      "ops-monitor",
      "research-summarizer",
    ];
    for (const archetype of archetypes) {
      expect(DEFAULT_META_AGENT_PROMPT).toContain(archetype);
    }
  });

  it("includes schedule guidance", () => {
    expect(DEFAULT_META_AGENT_PROMPT).toContain("300");
    expect(DEFAULT_META_AGENT_PROMPT).toContain("600");
    expect(DEFAULT_META_AGENT_PROMPT).toContain("1800");
  });

  it("warns against daily schedules", () => {
    expect(DEFAULT_META_AGENT_PROMPT).toContain("86400");
  });

  it("mentions no em dashes in voice rules", () => {
    expect(DEFAULT_META_AGENT_PROMPT).toContain("em dash");
  });
});

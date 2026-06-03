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

  it("references the modify_agent tool", () => {
    expect(DEFAULT_META_AGENT_PROMPT).toContain("modify_agent");
  });

  it("does not hardcode archetype enums", () => {
    expect(DEFAULT_META_AGENT_PROMPT).not.toContain("Available agent archetypes:");
    expect(DEFAULT_META_AGENT_PROMPT).toContain("not limited to a preset list");
  });

  it("lists available tools", () => {
    for (const tool of ["read_file", "write_file", "run_command", "coding_task", "github_api", "http_fetch"]) {
      expect(DEFAULT_META_AGENT_PROMPT).toContain(tool);
    }
  });

  it("documents custom tools and connectors", () => {
    expect(DEFAULT_META_AGENT_PROMPT).toContain(".simple-harmonic/connectors/");
    expect(DEFAULT_META_AGENT_PROMPT).toContain(".simple-harmonic/skills/");
  });

  it("documents output contracts", () => {
    expect(DEFAULT_META_AGENT_PROMPT).toContain("output_contract");
  });

  it("documents team hierarchy and leadership", () => {
    expect(DEFAULT_META_AGENT_PROMPT).toContain("spawn_sub_team");
    expect(DEFAULT_META_AGENT_PROMPT).toContain("Leadership is fluid");
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

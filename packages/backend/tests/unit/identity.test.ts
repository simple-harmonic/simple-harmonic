import { describe, expect, it } from "vitest";
import {
  COFOUNDER_AGENT_ID,
  COFOUNDER_POV,
  DEFAULT_COFOUNDER_NAME,
  PRIMARY_USER_AGENT_ID,
  PRIMARY_USER_DISPLAY_NAME,
  USER_AGENT_ID,
  USER_DISPLAY_NAME,
  USER_POV,
  getTeamHumans,
  resolveCofounderName,
} from "@/lib/meta-agent/identity";

describe("identity constants", () => {
  it("exports sentinel UUIDs with recognizable tails", () => {
    expect(COFOUNDER_AGENT_ID).toBe("00000000-0000-0000-0000-00000000c0f0");
    expect(PRIMARY_USER_AGENT_ID).toBe("00000000-0000-0000-0000-00000000fffe");
  });

  it("exports back-compat aliases that match primary constants", () => {
    expect(USER_AGENT_ID).toBe(PRIMARY_USER_AGENT_ID);
    expect(USER_DISPLAY_NAME).toBe(PRIMARY_USER_DISPLAY_NAME);
  });

  it("has POV sentinels for messaging view", () => {
    expect(COFOUNDER_POV).toBe("cofounder");
    expect(USER_POV).toBe("user");
  });

  it("has default cofounder name", () => {
    expect(DEFAULT_COFOUNDER_NAME).toBe("Harmon");
  });
});

describe("resolveCofounderName", () => {
  it("returns the team name when provided", () => {
    expect(resolveCofounderName("Atlas")).toBe("Atlas");
  });

  it("trims whitespace from the team name", () => {
    expect(resolveCofounderName("  Atlas  ")).toBe("Atlas");
  });

  it("falls back to default when null", () => {
    expect(resolveCofounderName(null)).toBe(DEFAULT_COFOUNDER_NAME);
  });

  it("falls back to default when undefined", () => {
    expect(resolveCofounderName(undefined)).toBe(DEFAULT_COFOUNDER_NAME);
  });

  it("falls back to default when empty string", () => {
    expect(resolveCofounderName("")).toBe(DEFAULT_COFOUNDER_NAME);
  });

  it("falls back to default when whitespace-only", () => {
    expect(resolveCofounderName("   ")).toBe(DEFAULT_COFOUNDER_NAME);
  });
});

describe("getTeamHumans", () => {
  it("returns a singleton array with the primary user", () => {
    const humans = getTeamHumans("any-team-id");
    expect(humans).toHaveLength(1);
    expect(humans[0].id).toBe(PRIMARY_USER_AGENT_ID);
    expect(humans[0].name).toBe(PRIMARY_USER_DISPLAY_NAME);
  });

  it("ignores the teamId argument (v0.0 behavior)", () => {
    const a = getTeamHumans("team-1");
    const b = getTeamHumans("team-2");
    expect(a).toEqual(b);
  });
});

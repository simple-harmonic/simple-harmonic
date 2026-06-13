import { describe, expect, it } from "vitest";
import { agents, teams } from "@/server/store";
import { useTempStore } from "../helpers/store";

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/spawn", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function validAgent(overrides: Record<string, unknown> = {}) {
  return {
    name: "Researcher",
    role: "research",
    archetype: "researcher",
    tools: ["report_action"],
    schedule_seconds: 300,
    initial_prompt: "Do research.",
    ...overrides,
  };
}

describe("POST /api/spawn", () => {
  useTempStore();

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  it("returns 400 when agents is missing", async () => {
    const { POST } = await import("@/server/api/spawn");
    const res = await POST(makeReq({}));
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("agents required");
  });

  it("returns 400 when agents is not an array", async () => {
    const { POST } = await import("@/server/api/spawn");
    const res = await POST(makeReq({ agents: "not-an-array" }));
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("agents required");
  });

  it("returns 400 when agents is an empty array", async () => {
    const { POST } = await import("@/server/api/spawn");
    const res = await POST(makeReq({ agents: [] }));
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("agents required");
  });

  it("returns 400 when agents is null", async () => {
    const { POST } = await import("@/server/api/spawn");
    const res = await POST(makeReq({ agents: null }));
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("agents required");
  });

  // -------------------------------------------------------------------------
  // Team + agent creation (chat sessions were removed — none expected)
  // -------------------------------------------------------------------------

  it("creates the team and its agents on success", async () => {
    const { POST } = await import("@/server/api/spawn");
    const res = await POST(makeReq({ agents: [validAgent()], teamName: "My Team" }));
    const body = (await res.json()) as { teamId?: string; parentTeamId?: string | null };

    expect(res.status).toBe(200);
    expect(body.teamId).toBeTruthy();
    expect(body.parentTeamId).toBeNull();

    const team = await teams.byId(body.teamId!);
    expect(team?.name).toBe("My Team");

    const teamAgents = await agents.byTeam(body.teamId!);
    // One user agent + auto-spawned Harmon on a root team.
    expect(teamAgents.map((a) => a.name)).toContain("Researcher");
  });

  it("uses teamName when provided", async () => {
    const { POST } = await import("@/server/api/spawn");
    const res = await POST(makeReq({ agents: [validAgent()], teamName: "  Custom Name  " }));
    const { teamId } = (await res.json()) as { teamId: string };

    expect((await teams.byId(teamId))?.name).toBe("Custom Name");
  });

  it("falls back to archetype-based name when teamName is missing", async () => {
    const { POST } = await import("@/server/api/spawn");
    const res = await POST(
      makeReq({
        agents: [validAgent({ archetype: "researcher" }), validAgent({ archetype: "writer", name: "Writer" })],
      }),
    );
    const { teamId } = (await res.json()) as { teamId: string };

    expect((await teams.byId(teamId))?.name).toBe("researcher-writer");
  });

  it("falls back to archetype join when teamName is whitespace", async () => {
    const { POST } = await import("@/server/api/spawn");
    const res = await POST(makeReq({ agents: [validAgent({ archetype: "ops" })], teamName: "   " }));
    const { teamId } = (await res.json()) as { teamId: string };

    expect((await teams.byId(teamId))?.name).toBe("ops");
  });

  it("caps a fallback team name at 50 characters", async () => {
    const { POST } = await import("@/server/api/spawn");
    const longAgents = Array.from({ length: 10 }, (_, i) =>
      validAgent({ archetype: `long-archetype-name-${i}`, name: `Agent-${i}` }),
    );
    const res = await POST(makeReq({ agents: longAgents }));
    const { teamId } = (await res.json()) as { teamId: string };

    const team = await teams.byId(teamId);
    expect(team!.name.length).toBeLessThanOrEqual(50);
  });

  // -------------------------------------------------------------------------
  // Agent field mapping + scheduling
  // -------------------------------------------------------------------------

  it("maps snake_case payload fields to camelCase agent columns", async () => {
    const { POST } = await import("@/server/api/spawn");
    const res = await POST(
      makeReq({
        agents: [validAgent({ schedule_seconds: 600, initial_prompt: "Start scanning." })],
        noHarmon: true,
      }),
    );
    const { teamId } = (await res.json()) as { teamId: string };

    const [agent] = await agents.byTeam(teamId);
    expect(agent.scheduleSeconds).toBe(600);
    expect(agent.initialPrompt).toBe("Start scanning.");
  });

  it("schedules the first agent at now + scheduleSeconds and staggers later ones by 2s", async () => {
    const { POST } = await import("@/server/api/spawn");
    const before = Date.now();
    const res = await POST(
      makeReq({
        agents: [
          validAgent({ name: "A", schedule_seconds: 300 }),
          validAgent({ name: "B", schedule_seconds: 300 }),
          validAgent({ name: "C", schedule_seconds: 300 }),
        ],
        noHarmon: true,
      }),
    );
    const after = Date.now();
    const { teamId } = (await res.json()) as { teamId: string };

    const byName = new Map((await agents.byTeam(teamId)).map((a) => [a.name, a]));
    const a = byName.get("A")!;
    const b = byName.get("B")!;
    const c = byName.get("C")!;

    const scheduleMs = 300 * 1000;
    expect(a.nextRunAt!.getTime()).toBeGreaterThanOrEqual(before + scheduleMs);
    expect(a.nextRunAt!.getTime()).toBeLessThanOrEqual(after + scheduleMs);
    // Each later agent's first run is offset by an extra 2s.
    expect(b.nextRunAt!.getTime() - a.nextRunAt!.getTime()).toBe(2000);
    expect(c.nextRunAt!.getTime() - a.nextRunAt!.getTime()).toBe(4000);
  });

  // -------------------------------------------------------------------------
  // Harmon auto-spawn + cofounderName
  // -------------------------------------------------------------------------

  it("auto-spawns Harmon as a meta-agent on a root team", async () => {
    const { POST } = await import("@/server/api/spawn");
    const res = await POST(
      makeReq({ agents: [validAgent({ name: "Alpha" }), validAgent({ name: "Beta" })] }),
    );
    const { teamId } = (await res.json()) as { teamId: string };

    const teamAgents = await agents.byTeam(teamId);
    // 2 user agents + 1 auto-spawned Harmon.
    expect(teamAgents).toHaveLength(3);
    const harmon = teamAgents.find((a) => a.archetype === "meta-agent");
    expect(harmon).toBeDefined();
    expect(harmon?.name).toBe("harmon");
  });

  it("does not auto-spawn Harmon when noHarmon is set", async () => {
    const { POST } = await import("@/server/api/spawn");
    const res = await POST(makeReq({ agents: [validAgent()], noHarmon: true }));
    const { teamId } = (await res.json()) as { teamId: string };

    const teamAgents = await agents.byTeam(teamId);
    expect(teamAgents).toHaveLength(1);
    expect(teamAgents.some((a) => a.archetype === "meta-agent")).toBe(false);
  });

  it("does not auto-spawn Harmon on a sub-team (non-root)", async () => {
    const { POST } = await import("@/server/api/spawn");
    const parent = await teams.insert({ name: "Parent" });

    const res = await POST(makeReq({ agents: [validAgent()], parentTeamId: parent.id }));
    const { teamId, parentTeamId } = (await res.json()) as {
      teamId: string;
      parentTeamId: string | null;
    };

    expect(parentTeamId).toBe(parent.id);
    const child = await teams.byId(teamId);
    expect(child?.parentTeamId).toBe(parent.id);

    const teamAgents = await agents.byTeam(teamId);
    expect(teamAgents.some((a) => a.archetype === "meta-agent")).toBe(false);
  });

  it("resolves a parent team by name", async () => {
    const { POST } = await import("@/server/api/spawn");
    const parent = await teams.insert({ name: "Engineering" });

    const res = await POST(makeReq({ agents: [validAgent()], parentTeam: "Engineering" }));
    const { teamId, parentTeamId } = (await res.json()) as {
      teamId: string;
      parentTeamId: string | null;
    };

    expect(parentTeamId).toBe(parent.id);
    expect((await teams.byId(teamId))?.parentTeamId).toBe(parent.id);
  });

  it("400s when a named parent team cannot be resolved", async () => {
    const { POST } = await import("@/server/api/spawn");
    const res = await POST(makeReq({ agents: [validAgent()], parentTeam: "Ghost Team" }));
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toContain("Ghost Team");
  });

  it("applies cofounderName to the team and the Harmon agent name", async () => {
    const { POST } = await import("@/server/api/spawn");
    const res = await POST(makeReq({ agents: [validAgent()], cofounderName: "  Atlas  " }));
    const { teamId } = (await res.json()) as { teamId: string };

    expect((await teams.byId(teamId))?.cofounderName).toBe("Atlas");
    const harmon = (await agents.byTeam(teamId)).find((a) => a.archetype === "meta-agent");
    expect(harmon?.name).toBe("atlas");
  });

  it("defaults cofounderName to Harmon when not provided", async () => {
    const { POST } = await import("@/server/api/spawn");
    const res = await POST(makeReq({ agents: [validAgent()] }));
    const { teamId } = (await res.json()) as { teamId: string };

    expect((await teams.byId(teamId))?.cofounderName).toBe("Harmon");
  });
});

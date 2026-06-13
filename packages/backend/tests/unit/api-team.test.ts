import { describe, expect, it } from "vitest";
import { agents, teams } from "@/server/store";
import { useTempStore } from "../helpers/store";

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function patchRequest(id: string, body: Record<string, unknown>) {
  return new Request(`http://localhost/api/team/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedTeam(overrides: Record<string, unknown> = {}) {
  return teams.insert({ name: "Test Team", ...overrides });
}

describe("api-team", () => {
  useTempStore();

  // =========================================================================
  // GET /api/teams
  // =========================================================================
  describe("GET /api/teams", () => {
    it("returns all teams", async () => {
      const { GET } = await import("@/server/api/teams");
      const a = await seedTeam({ name: "First" });
      const b = await seedTeam({ name: "Second" });

      const res = await GET();
      const body = (await res.json()) as Array<{ id: string }>;

      expect(res.status).toBe(200);
      expect(body).toHaveLength(2);
      expect(body.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    });

    it("returns empty array when no teams exist", async () => {
      const { GET } = await import("@/server/api/teams");
      const res = await GET();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });
  });

  // =========================================================================
  // GET /api/team/[id]
  // =========================================================================
  describe("GET /api/team/[id]", () => {
    it("returns team and agents when team exists", async () => {
      const { GET } = await import("@/server/api/team/id/index");
      const team = await seedTeam();
      await agents.insert(team.id, {
        name: "Researcher",
        role: "research",
        archetype: "researcher",
        tools: [],
        scheduleSeconds: 10,
        initialPrompt: "Do research",
      });

      const res = await GET(new Request("http://localhost"), makeParams(team.id));
      const body = (await res.json()) as {
        team: { id: string };
        agents: Array<{ id: string; name: string }>;
        childTeams: unknown[];
        childAgents: unknown[];
      };

      expect(res.status).toBe(200);
      expect(body.team.id).toBe(team.id);
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].name).toBe("Researcher");
      expect(body.childTeams).toEqual([]);
      expect(body.childAgents).toEqual([]);
    });

    it("includes sub-teams and their agents", async () => {
      const { GET } = await import("@/server/api/team/id/index");
      const root = await seedTeam({ name: "Root" });
      const sub = await teams.insert({ name: "Sub", parentTeamId: root.id });
      await agents.insert(sub.id, {
        name: "Sub Agent",
        role: "r",
        archetype: "a",
        tools: [],
        scheduleSeconds: 10,
        initialPrompt: "p",
      });

      const res = await GET(new Request("http://localhost"), makeParams(root.id));
      const body = (await res.json()) as {
        childTeams: Array<{ id: string }>;
        childAgents: Array<{ id: string }>;
      };

      expect(body.childTeams.map((t) => t.id)).toEqual([sub.id]);
      expect(body.childAgents).toHaveLength(1);
    });

    it("returns 404 when team not found", async () => {
      const { GET } = await import("@/server/api/team/id/index");
      const res = await GET(new Request("http://localhost"), makeParams("nonexistent"));
      const body = (await res.json()) as { error?: string };
      expect(res.status).toBe(404);
      expect(body.error).toBe("not found");
    });
  });

  // =========================================================================
  // PATCH /api/team/[id]
  // =========================================================================
  describe("PATCH /api/team/[id]", () => {
    it("updates name and persists it", async () => {
      const { PATCH } = await import("@/server/api/team/id/index");
      const team = await seedTeam();

      const res = await PATCH(patchRequest(team.id, { name: "Renamed" }), makeParams(team.id));
      const body = (await res.json()) as { name?: string };

      expect(res.status).toBe(200);
      expect(body.name).toBe("Renamed");
      expect((await teams.byId(team.id))?.name).toBe("Renamed");
    });

    it("updates metaAgentPrompt and cofounderName", async () => {
      const { PATCH } = await import("@/server/api/team/id/index");
      const team = await seedTeam();

      await PATCH(
        patchRequest(team.id, { metaAgentPrompt: "New prompt", cofounderName: "Ada" }),
        makeParams(team.id),
      );

      const stored = await teams.byId(team.id);
      expect(stored?.metaAgentPrompt).toBe("New prompt");
      expect(stored?.cofounderName).toBe("Ada");
    });

    it("ignores disallowed fields", async () => {
      const { PATCH } = await import("@/server/api/team/id/index");
      const team = await seedTeam();

      await PATCH(
        patchRequest(team.id, { name: "Good", paused: true, tickCount: 999 }),
        makeParams(team.id),
      );

      const stored = await teams.byId(team.id);
      expect(stored?.name).toBe("Good");
      expect(stored?.paused).toBe(false);
      expect(stored?.tickCount).toBe(0);
    });

    it("returns 400 when no valid fields provided", async () => {
      const { PATCH } = await import("@/server/api/team/id/index");
      const team = await seedTeam();
      const res = await PATCH(
        patchRequest(team.id, { paused: true, tickCount: 5 }),
        makeParams(team.id),
      );
      const body = (await res.json()) as { error?: string };
      expect(res.status).toBe(400);
      expect(body.error).toBe("no valid fields");
    });

    it("returns 404 when team to update not found", async () => {
      const { PATCH } = await import("@/server/api/team/id/index");
      const res = await PATCH(
        patchRequest("nonexistent", { name: "Ghost" }),
        makeParams("nonexistent"),
      );
      const body = (await res.json()) as { error?: string };
      expect(res.status).toBe(404);
      expect(body.error).toBe("not found");
    });
  });

  // =========================================================================
  // POST /api/team/[id]/heartbeat
  // =========================================================================
  describe("POST /api/team/[id]/heartbeat", () => {
    it("updates lastUserActiveAt and returns ok", async () => {
      const { POST } = await import("@/server/api/team/id/heartbeat");
      const team = await seedTeam();
      const before = (await teams.byId(team.id))!.lastUserActiveAt.getTime();
      await new Promise((r) => setTimeout(r, 5));

      const res = await POST(
        new Request("http://localhost", { method: "POST" }),
        makeParams(team.id),
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect((await teams.byId(team.id))!.lastUserActiveAt.getTime()).toBeGreaterThanOrEqual(before);
    });
  });

  // =========================================================================
  // POST /api/team/[id]/pause
  // =========================================================================
  describe("POST /api/team/[id]/pause", () => {
    it("toggles paused from false to true and back", async () => {
      const { POST } = await import("@/server/api/team/id/pause");
      const team = await seedTeam({ paused: false });

      const res1 = await POST(
        new Request("http://localhost", { method: "POST" }),
        makeParams(team.id),
      );
      expect(((await res1.json()) as { paused?: boolean }).paused).toBe(true);
      expect((await teams.byId(team.id))?.paused).toBe(true);

      const res2 = await POST(
        new Request("http://localhost", { method: "POST" }),
        makeParams(team.id),
      );
      expect(((await res2.json()) as { paused?: boolean }).paused).toBe(false);
      expect((await teams.byId(team.id))?.paused).toBe(false);
    });

    it("returns 404 when team not found", async () => {
      const { POST } = await import("@/server/api/team/id/pause");
      const res = await POST(
        new Request("http://localhost", { method: "POST" }),
        makeParams("ghost"),
      );
      const body = (await res.json()) as { error?: string };
      expect(res.status).toBe(404);
      expect(body.error).toBe("not found");
    });
  });
});

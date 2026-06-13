import { describe, expect, it } from "vitest";
import { agents, teams } from "@/server/store";
import { useTempStore } from "../helpers/store";

// ---------------------------------------------------------------------------
// The seed route builds a mock team + 4 agents + a2ax messages/tasks directly
// through the file store. It uses small setTimeout delays so messages sort
// chronologically, which makes a full run take ~1.3s — raise the per-test
// timeout accordingly.
// ---------------------------------------------------------------------------

const TEAM_NAME = "Simple Harmonic v0.0 Launch";
const AGENT_NAMES = ["Scout", "Relay", "Chisel", "Pulse"];

describe("POST /api/seed", () => {
  useTempStore();

  it(
    "creates the mock team with its agents",
    async () => {
      const { POST } = await import("@/server/api/seed");
      const res = await POST();
      const body = (await res.json()) as {
        teamId: string;
        agents: Array<{ id: string; name: string }>;
        messageCount: number;
        taskCount: number;
      };

      expect(res.status).toBe(200);
      expect(body.teamId).toBeTruthy();
      expect(body.agents).toHaveLength(4);
      expect(body.agents.map((a) => a.name)).toEqual(AGENT_NAMES);
      expect(body.messageCount).toBe(27);
      expect(body.taskCount).toBe(9);

      // The team was persisted to the store.
      const all = await teams.all();
      expect(all).toHaveLength(1);
      const team = all[0];
      expect(team.id).toBe(body.teamId);
      expect(team.name).toBe(TEAM_NAME);
      expect(team.cofounderName).toBe("Harmon");

      // Its agents were persisted under the team.
      const teamAgents = await agents.byTeam(team.id);
      expect(teamAgents.map((a) => a.name).sort()).toEqual([...AGENT_NAMES].sort());
    },
    10_000,
  );

  it(
    "returns 409 when the mock team already exists",
    async () => {
      const { POST } = await import("@/server/api/seed");

      const first = await POST();
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { teamId: string };

      const second = await POST();
      const body = (await second.json()) as { error: string; teamId: string };

      expect(second.status).toBe(409);
      expect(body.error).toBe("Mock team already exists");
      expect(body.teamId).toBe(firstBody.teamId);

      // No duplicate team was created.
      expect(await teams.all()).toHaveLength(1);
    },
    15_000,
  );
});

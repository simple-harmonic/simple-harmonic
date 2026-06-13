import { describe, expect, it } from "vitest";
import { agents, teams } from "@/server/store";
import type { AgentStatus } from "@/server/store";
import { useTempStore } from "../helpers/store";

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function patchRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/agent", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedAgent(overrides: { status?: AgentStatus } = {}) {
  const team = await teams.insert({ name: "Test Team" });
  const agent = await agents.insert(team.id, {
    name: "Original",
    role: "dev",
    archetype: "researcher",
    tools: [],
    scheduleSeconds: 10,
    initialPrompt: "Do work",
    status: overrides.status,
  });
  return { team, agent };
}

describe("PATCH /api/agent/[id]", () => {
  useTempStore();

  it("updates a valid field and persists it", async () => {
    const { PATCH } = await import("@/server/api/agent/id");
    const { agent } = await seedAgent();

    const res = await PATCH(patchRequest({ name: "renamed" }), makeParams(agent.id));
    const json = (await res.json()) as { name?: string };

    expect(res.status).toBe(200);
    expect(json.name).toBe("renamed");
    expect((await agents.byId(agent.id))?.name).toBe("renamed");
  });

  it("updates multiple allowed fields and ignores disallowed ones", async () => {
    const { PATCH } = await import("@/server/api/agent/id");
    const { agent } = await seedAgent();

    await PATCH(
      patchRequest({
        role: "research",
        scheduleSeconds: 99,
        // disallowed fields should be dropped
        teamId: "elsewhere",
        inFlight: true,
      }),
      makeParams(agent.id),
    );

    const stored = await agents.byId(agent.id);
    expect(stored?.role).toBe("research");
    expect(stored?.scheduleSeconds).toBe(99);
    expect(stored?.teamId).toBe(agent.teamId);
    expect(stored?.inFlight).toBe(false);
  });

  it("sets nextRunAt and status=running when wake=true", async () => {
    const { PATCH } = await import("@/server/api/agent/id");
    const { agent } = await seedAgent({ status: "paused" });

    const before = Date.now();
    const res = await PATCH(patchRequest({ wake: true }), makeParams(agent.id));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { status?: string; nextRunAt?: string };
    expect(json.status).toBe("running");

    const stored = await agents.byId(agent.id);
    expect(stored?.status).toBe("running");
    expect(stored?.nextRunAt).toBeInstanceOf(Date);
    expect(stored!.nextRunAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("respects an explicit status alongside wake=true", async () => {
    const { PATCH } = await import("@/server/api/agent/id");
    const { agent } = await seedAgent({ status: "running" });

    const res = await PATCH(
      patchRequest({ wake: true, status: "paused" }),
      makeParams(agent.id),
    );

    expect(res.status).toBe(200);
    const stored = await agents.byId(agent.id);
    expect(stored?.status).toBe("paused");
    expect(stored?.nextRunAt).toBeInstanceOf(Date);
  });

  it("returns 400 when no valid fields are provided", async () => {
    const { PATCH } = await import("@/server/api/agent/id");
    const { agent } = await seedAgent();

    const res = await PATCH(patchRequest({ bogus: "value" }), makeParams(agent.id));
    const json = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(json.error).toBe("no valid fields");
    // The agent must be untouched.
    expect((await agents.byId(agent.id))?.name).toBe("Original");
  });

  it("returns 400 for a protected/invalid status write", async () => {
    const { PATCH } = await import("@/server/api/agent/id");
    const { agent } = await seedAgent();

    const res = await PATCH(
      patchRequest({ status: "awaiting_approval" }),
      makeParams(agent.id),
    );
    const json = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(json.error).toBe("invalid status");
    expect((await agents.byId(agent.id))?.status).toBe("running");
  });

  it("blocks wake/status changes while awaiting approval", async () => {
    const { PATCH } = await import("@/server/api/agent/id");
    const { agent } = await seedAgent({ status: "awaiting_approval" });

    const res = await PATCH(patchRequest({ wake: true }), makeParams(agent.id));

    expect(res.status).toBe(409);
    // Still parked: status unchanged, no nextRunAt scheduled.
    const stored = await agents.byId(agent.id);
    expect(stored?.status).toBe("awaiting_approval");
    expect(stored?.nextRunAt).toBeNull();
  });

  it("returns 404 when the agent is not found", async () => {
    const { PATCH } = await import("@/server/api/agent/id");

    const res = await PATCH(patchRequest({ name: "ghost" }), makeParams("no-such-id"));
    const json = (await res.json()) as { error?: string };

    expect(res.status).toBe(404);
    expect(json.error).toBe("not found");
  });
});

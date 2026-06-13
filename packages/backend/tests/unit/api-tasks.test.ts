import { describe, expect, it } from "vitest";
import { COFOUNDER_AGENT_ID, USER_AGENT_ID } from "@/lib/meta-agent/identity";
import { getA2AX } from "@/server/a2ax";
import { agents, teams } from "@/server/store";
import { useTempStore } from "../helpers/store";

// GET /api/team/[id]/tasks returns a2ax tasks enriched with requestor/assignee
// names. Run against the real file store: seed a team + agents, create tasks via
// getA2AX().createTask, call GET with ?agentId=team or a participant, and assert
// on the enriched JSON response.

function makeReq(teamId: string, agentId?: string): Request {
  const url = agentId
    ? `http://localhost/api/team/${teamId}/tasks?agentId=${agentId}`
    : `http://localhost/api/team/${teamId}/tasks`;
  return new Request(url);
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function seed(teamOverrides: Record<string, unknown> = {}) {
  const team = await teams.insert({ name: "Test Team", ...teamOverrides });
  const researcher = await agents.insert(team.id, {
    name: "Researcher",
    role: "research",
    archetype: "researcher",
    tools: [],
    scheduleSeconds: 10,
    initialPrompt: "p",
  });
  const writer = await agents.insert(team.id, {
    name: "Writer",
    role: "write",
    archetype: "writer",
    tools: [],
    scheduleSeconds: 10,
    initialPrompt: "p",
  });
  return { team, researcher, writer };
}

describe("GET /api/team/[id]/tasks", () => {
  useTempStore();

  it("returns 400 when agentId is missing", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");
    const { team } = await seed();

    const res = await GET(makeReq(team.id), makeParams(team.id));
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("agentId query param required");
  });

  it("returns empty array when no tasks exist", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");
    const { team, researcher } = await seed();

    const res = await GET(makeReq(team.id, researcher.id), makeParams(team.id));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });

  it("'team' agentId returns all tasks for the team", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");
    const { team, researcher, writer } = await seed();
    const a2ax = getA2AX();

    await a2ax.createTask({
      teamId: team.id,
      requestorId: researcher.id,
      assigneeId: writer.id,
      title: "Task one",
      description: "d1",
    });
    await a2ax.createTask({
      teamId: team.id,
      requestorId: writer.id,
      assigneeId: researcher.id,
      title: "Task two",
      description: "d2",
    });

    const res = await GET(makeReq(team.id, "team"), makeParams(team.id));
    const body = (await res.json()) as unknown[];

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
  });

  it("enriches tasks with requestorName and assigneeName", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");
    const { team, researcher, writer } = await seed();
    const a2ax = getA2AX();

    await a2ax.createTask({
      teamId: team.id,
      requestorId: researcher.id,
      assigneeId: writer.id,
      title: "Research market trends",
      description: "Analyze Q4 data",
    });

    const res = await GET(makeReq(team.id, "team"), makeParams(team.id));
    const body = (await res.json()) as Array<{
      title: string;
      description: string;
      state: string;
      requestorId: string;
      requestorName: string;
      assigneeId: string;
      assigneeName: string;
      createdAt: string;
      updatedAt: string;
    }>;

    expect(body).toHaveLength(1);
    const t = body[0];
    expect(t.title).toBe("Research market trends");
    expect(t.description).toBe("Analyze Q4 data");
    expect(t.state).toBe("submitted");
    expect(t.requestorId).toBe(researcher.id);
    expect(t.requestorName).toBe("Researcher");
    expect(t.assigneeId).toBe(writer.id);
    expect(t.assigneeName).toBe("Writer");
    // Timestamps serialized as ISO strings.
    expect(new Date(t.createdAt).toISOString()).toBe(t.createdAt);
    expect(new Date(t.updatedAt).toISOString()).toBe(t.updatedAt);
  });

  it("falls back to raw ID when agent name is not in the name map", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");
    const { team } = await seed();
    const a2ax = getA2AX();

    const unknownRequestorId = "unknown-req-xxx";
    const unknownAssigneeId = "unknown-asgn-yyy";
    await a2ax.createTask({
      teamId: team.id,
      requestorId: unknownRequestorId,
      assigneeId: unknownAssigneeId,
      title: "Mystery task",
      description: "d",
    });

    const res = await GET(makeReq(team.id, "team"), makeParams(team.id));
    const body = (await res.json()) as Array<{
      requestorName: string;
      assigneeName: string;
    }>;

    expect(body[0].requestorName).toBe(unknownRequestorId);
    expect(body[0].assigneeName).toBe(unknownAssigneeId);
  });

  it("translates 'cofounder' agentId and resolves the cofounder name", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");
    const { team, researcher } = await seed();
    const a2ax = getA2AX();

    await a2ax.createTask({
      teamId: team.id,
      requestorId: COFOUNDER_AGENT_ID,
      assigneeId: researcher.id,
      title: "Cofounder task",
      description: "d",
    });

    const res = await GET(makeReq(team.id, "cofounder"), makeParams(team.id));
    const body = (await res.json()) as Array<{ requestorName: string }>;

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].requestorName).toBe("Harmon");
  });

  it("uses a custom cofounder name from the team row", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");
    const { team, researcher } = await seed({ cofounderName: "Ada" });
    const a2ax = getA2AX();

    await a2ax.createTask({
      teamId: team.id,
      requestorId: COFOUNDER_AGENT_ID,
      assigneeId: researcher.id,
      title: "Cofounder task",
      description: "d",
    });

    const res = await GET(makeReq(team.id, "team"), makeParams(team.id));
    const body = (await res.json()) as Array<{ requestorName: string }>;

    expect(body[0].requestorName).toBe("Ada");
  });

  it("translates 'user' agentId and resolves USER name to 'You'", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");
    const { team, researcher } = await seed();
    const a2ax = getA2AX();

    await a2ax.createTask({
      teamId: team.id,
      requestorId: USER_AGENT_ID,
      assigneeId: researcher.id,
      title: "User task",
      description: "d",
    });

    const res = await GET(makeReq(team.id, "user"), makeParams(team.id));
    const body = (await res.json()) as Array<{ requestorName: string }>;

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].requestorName).toBe("You");
  });

  it("filters tasks to a specific participant agent", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");
    const { team, researcher, writer } = await seed();
    const a2ax = getA2AX();

    // Task involving the researcher.
    await a2ax.createTask({
      teamId: team.id,
      requestorId: researcher.id,
      assigneeId: writer.id,
      title: "For researcher",
      description: "d",
    });
    // Task that does NOT involve the researcher.
    const stranger = "stranger-agent";
    await a2ax.createTask({
      teamId: team.id,
      requestorId: writer.id,
      assigneeId: stranger,
      title: "Not for researcher",
      description: "d",
    });

    const res = await GET(makeReq(team.id, researcher.id), makeParams(team.id));
    const body = (await res.json()) as Array<{ title: string; requestorId: string }>;

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].title).toBe("For researcher");
    expect(body[0].requestorId).toBe(researcher.id);
  });

  it("returns multiple enriched tasks across participants", async () => {
    const { GET } = await import("@/server/api/team/id/tasks");
    const { team, researcher, writer } = await seed();
    const a2ax = getA2AX();

    await a2ax.createTask({
      teamId: team.id,
      requestorId: researcher.id,
      assigneeId: writer.id,
      title: "Task 1",
      description: "d",
    });
    await a2ax.createTask({
      teamId: team.id,
      requestorId: writer.id,
      assigneeId: researcher.id,
      title: "Task 2",
      description: "d",
    });
    await a2ax.createTask({
      teamId: team.id,
      requestorId: COFOUNDER_AGENT_ID,
      assigneeId: USER_AGENT_ID,
      title: "Task 3",
      description: "d",
    });

    const res = await GET(makeReq(team.id, "team"), makeParams(team.id));
    const body = (await res.json()) as Array<{
      title: string;
      requestorName: string;
      assigneeName: string;
    }>;

    expect(body).toHaveLength(3);
    const byTitle = Object.fromEntries(body.map((t) => [t.title, t]));
    expect(byTitle["Task 1"].requestorName).toBe("Researcher");
    expect(byTitle["Task 1"].assigneeName).toBe("Writer");
    expect(byTitle["Task 2"].requestorName).toBe("Writer");
    expect(byTitle["Task 2"].assigneeName).toBe("Researcher");
    expect(byTitle["Task 3"].requestorName).toBe("Harmon");
    expect(byTitle["Task 3"].assigneeName).toBe("You");
  });
});

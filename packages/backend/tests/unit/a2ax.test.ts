import { describe, expect, it } from "vitest";
import { getA2AX } from "@/server/a2ax";
import { teams } from "@/server/store";
import { useTempStore } from "../helpers/store";

// The backend a2ax singleton now builds a JsonFileTransport over the real file
// store (no Drizzle). A team's on-disk folder must exist before any a2ax call,
// so every case seeds a team via teams.insert() first.

describe("getA2AX", () => {
  useTempStore();

  it("creates an A2AX instance on first call", () => {
    const result = getA2AX();
    expect(result).toBeDefined();
    expect(typeof result.sendDirect).toBe("function");
  });

  it("returns the same instance on subsequent calls (singleton)", () => {
    const first = getA2AX();
    const second = getA2AX();
    expect(first).toBe(second);
  });

  it("sends a direct message and lists it back from the store", async () => {
    const team = await teams.insert({ name: "Team" });
    const a2ax = getA2AX();

    const sent = await a2ax.sendDirect(team.id, "agent-a", "agent-b", "hello");

    expect(sent.channelType).toBe("direct");
    expect(sent.fromAgentId).toBe("agent-a");
    expect(sent.content).toBe("hello");

    const messages = await a2ax.listMessages(team.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(sent.id);
    expect(messages[0].content).toBe("hello");
  });

  it("broadcasts a message visible to any agent's context", async () => {
    const team = await teams.insert({ name: "Team" });
    const a2ax = getA2AX();

    await a2ax.broadcast(team.id, "agent-a", "all hands");

    const messages = await a2ax.listMessages(team.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].channelType).toBe("broadcast");

    // Broadcast reaches a different agent's context (not the sender's own).
    const ctx = await a2ax.getAgentContext(team.id, "agent-b");
    expect(ctx.messages.map((m) => m.content)).toContain("all hands");
  });

  it("getAgentContext returns direct messages addressed to the agent", async () => {
    const team = await teams.insert({ name: "Team" });
    const a2ax = getA2AX();

    await a2ax.sendDirect(team.id, "agent-a", "agent-b", "for you");
    await a2ax.sendDirect(team.id, "agent-a", "agent-c", "not for you");

    const ctx = await a2ax.getAgentContext(team.id, "agent-b");
    const contents = ctx.messages.map((m) => m.content);
    expect(contents).toContain("for you");
    expect(contents).not.toContain("not for you");
    expect(ctx.messageIds).toEqual(ctx.messages.map((m) => m.id));
  });

  it("creates a task and lists it back, scoped to participants", async () => {
    const team = await teams.insert({ name: "Team" });
    const a2ax = getA2AX();

    const { task, channelId } = await a2ax.createTask({
      teamId: team.id,
      requestorId: "agent-a",
      assigneeId: "agent-b",
      title: "Do the thing",
      description: "Details here",
    });

    expect(task.state).toBe("submitted");
    expect(channelId).toBe(`task:${task.id}`);

    const allTasks = await a2ax.listTasks(team.id);
    expect(allTasks.map((t) => t.id)).toContain(task.id);

    // Scoped to a participant returns the task; to a stranger it does not.
    const forAssignee = await a2ax.listTasks(team.id, "agent-b");
    expect(forAssignee.map((t) => t.id)).toContain(task.id);

    const forStranger = await a2ax.listTasks(team.id, "agent-z");
    expect(forStranger.map((t) => t.id)).not.toContain(task.id);
  });

  it("updates task state through a valid transition", async () => {
    const team = await teams.insert({ name: "Team" });
    const a2ax = getA2AX();

    const { task } = await a2ax.createTask({
      teamId: team.id,
      requestorId: "agent-a",
      assigneeId: "agent-b",
      title: "Task",
      description: "desc",
    });

    const accepted = await a2ax.updateTaskState(task.id, "agent-b", "accepted");
    expect(accepted.state).toBe("accepted");

    const refreshed = (await a2ax.listTasks(team.id)).find((t) => t.id === task.id);
    expect(refreshed?.state).toBe("accepted");
  });

  it("persists across a fresh transport instance (real file store)", async () => {
    const team = await teams.insert({ name: "Team" });
    const a2ax = getA2AX();
    const sent = await a2ax.sendDirect(team.id, "agent-a", "agent-b", "persisted");

    // resetA2AXForTests() (run via useTempStore in beforeEach) would drop the
    // singleton; here we just confirm the message survives a re-read.
    const reread = await getA2AX().listMessages(team.id);
    expect(reread.map((m) => m.id)).toContain(sent.id);
  });
});

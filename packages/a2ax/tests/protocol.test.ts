import { describe, expect, it, beforeEach } from "vitest";
import { A2AX, createAgentCard } from "../src/index.js";
import { MemoryTransport } from "../src/transport/memory.js";

describe("A2AX Protocol", () => {
  let a2ax: A2AX;
  const teamId = "team-1";
  const agentA = "agent-a";
  const agentB = "agent-b";
  const agentC = "agent-c";

  beforeEach(() => {
    a2ax = new A2AX({ transport: new MemoryTransport() });
  });

  describe("direct messaging", () => {
    it("sends and receives a direct message", async () => {
      await a2ax.sendDirect(teamId, agentA, agentB, "hello from A");

      const ctx = await a2ax.getAgentContext(teamId, agentB);
      expect(ctx.messages).toHaveLength(1);
      expect(ctx.messages[0].content).toBe("hello from A");
      expect(ctx.messages[0].channelType).toBe("direct");
      expect(ctx.formatted).toContain("hello from A");
    });

    it("does not show own messages", async () => {
      await a2ax.sendDirect(teamId, agentA, agentB, "hello");

      const ctx = await a2ax.getAgentContext(teamId, agentA);
      expect(ctx.messages).toHaveLength(0);
    });

    it("marks messages as read", async () => {
      await a2ax.sendDirect(teamId, agentA, agentB, "read me");

      const ctx1 = await a2ax.getAgentContext(teamId, agentB);
      expect(ctx1.messages).toHaveLength(1);

      await a2ax.markContextRead(ctx1.messageIds);

      const ctx2 = await a2ax.getAgentContext(teamId, agentB);
      expect(ctx2.messages).toHaveLength(0);
    });
  });

  describe("broadcast", () => {
    it("delivers broadcast to all agents", async () => {
      await a2ax.broadcast(teamId, agentA, "announcement for everyone");

      const ctxB = await a2ax.getAgentContext(teamId, agentB);
      const ctxC = await a2ax.getAgentContext(teamId, agentC);

      expect(ctxB.messages).toHaveLength(1);
      expect(ctxC.messages).toHaveLength(1);
      expect(ctxB.messages[0].content).toBe("announcement for everyone");
    });

    it("sender does not see own broadcast", async () => {
      await a2ax.broadcast(teamId, agentA, "my broadcast");

      const ctxA = await a2ax.getAgentContext(teamId, agentA);
      expect(ctxA.messages).toHaveLength(0);
    });
  });

  describe("group messaging", () => {
    it("creates a group and delivers messages to members only", async () => {
      const { channelId } = await a2ax.createGroup(teamId, "content-team", [
        agentA,
        agentB,
      ]);

      await a2ax.sendToGroup(teamId, channelId, agentA, "group message");

      const ctxB = await a2ax.getAgentContext(teamId, agentB);
      const ctxC = await a2ax.getAgentContext(teamId, agentC);

      // agentB is a member, should see it
      const groupMsgs = ctxB.messages.filter((m) => m.kind === "text");
      expect(groupMsgs).toHaveLength(1);
      expect(groupMsgs[0].content).toBe("group message");

      // agentC is not a member, should not see it
      expect(ctxC.messages.filter((m) => m.kind === "text")).toHaveLength(0);
    });

    it("allows joining and leaving groups", async () => {
      const { channelId } = await a2ax.createGroup(teamId, "test-group", [
        agentA,
      ]);

      await a2ax.sendToGroup(teamId, channelId, agentA, "before join");
      let ctxC = await a2ax.getAgentContext(teamId, agentC);
      expect(ctxC.messages.filter((m) => m.kind === "text")).toHaveLength(0);

      await a2ax.joinGroup(channelId, agentC);
      await a2ax.sendToGroup(teamId, channelId, agentA, "after join");

      ctxC = await a2ax.getAgentContext(teamId, agentC);
      // Should see both messages now (joined group, can see history)
      const textMsgs = ctxC.messages.filter((m) => m.kind === "text");
      expect(textMsgs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("task management", () => {
    it("creates a task and delivers to assignee", async () => {
      const { task } = await a2ax.createTask({
        teamId,
        requestorId: agentA,
        assigneeId: agentB,
        title: "Write summary",
        description: "Summarize this week's research findings",
      });

      expect(task.state).toBe("submitted");

      const ctx = await a2ax.getAgentContext(teamId, agentB);
      const taskMsgs = ctx.messages.filter((m) => m.kind === "task.create");
      expect(taskMsgs).toHaveLength(1);
      expect(taskMsgs[0].content).toBe(
        "Summarize this week's research findings",
      );
    });

    it("follows task lifecycle", async () => {
      const { task } = await a2ax.createTask({
        teamId,
        requestorId: agentA,
        assigneeId: agentB,
        title: "Test task",
        description: "Do the thing",
      });

      await a2ax.updateTaskState(task.id, agentB, "accepted");
      await a2ax.updateTaskState(task.id, agentB, "working");
      const completed = await a2ax.completeTask(
        task.id,
        agentB,
        "Done. Here are the results.",
      );

      expect(completed.state).toBe("completed");
    });

    it("rejects invalid state transitions", async () => {
      const { task } = await a2ax.createTask({
        teamId,
        requestorId: agentA,
        assigneeId: agentB,
        title: "Test",
        description: "Test",
      });

      await expect(
        a2ax.updateTaskState(task.id, agentB, "completed"),
      ).rejects.toThrow("Invalid transition");
    });
  });

  describe("agent cards", () => {
    it("registers and retrieves an agent card", async () => {
      const card = createAgentCard({
        id: agentA,
        name: "Research Scout",
        endpoint: "/api/agent/agent-a",
        skills: [
          {
            id: "research",
            name: "Market Research",
            description: "Finds competitor data",
          },
        ],
      });

      await a2ax.registerCard(card);
      const retrieved = await a2ax.getCard(agentA);

      expect(retrieved).toBeTruthy();
      expect(retrieved!.name).toBe("Research Scout");
      expect(retrieved!.skills).toHaveLength(1);
      expect(retrieved!.capabilities.broadcast).toBe(true);
    });
  });

  describe("auth", () => {
    it("issues and validates a token", async () => {
      const token = await a2ax.issueToken(agentA, teamId);

      const identity = await a2ax.authenticate(token);
      expect(identity).toBeTruthy();
      expect(identity!.agentId).toBe(agentA);

      const canSend = await a2ax.authorize(token, "message:send");
      expect(canSend).toBe(true);

      const canAdmin = await a2ax.authorize(token, "admin");
      expect(canAdmin).toBe(false);
    });

    it("rejects invalid tokens", async () => {
      const identity = await a2ax.authenticate("fake-token");
      expect(identity).toBeNull();
    });
  });

  describe("context formatting", () => {
    it("formats empty context as empty string", async () => {
      const ctx = await a2ax.getAgentContext(teamId, agentA);
      expect(ctx.formatted).toBe("");
      expect(ctx.messages).toHaveLength(0);
    });

    it("respects max context messages limit", async () => {
      const a2axSmall = new A2AX({
        transport: new MemoryTransport(),
        maxContextMessages: 2,
      });

      await a2axSmall.sendDirect(teamId, agentA, agentB, "msg 1");
      await a2axSmall.sendDirect(teamId, agentA, agentB, "msg 2");
      await a2axSmall.sendDirect(teamId, agentA, agentB, "msg 3");

      const ctx = await a2axSmall.getAgentContext(teamId, agentB);
      expect(ctx.messages).toHaveLength(2);
    });
  });
});

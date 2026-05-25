// ---------------------------------------------------------------------------
// A2AX Protocol — the main API surface
// ---------------------------------------------------------------------------

import type { AgentCard } from "../types/agent-card.js";
import type { Scope } from "../types/auth.js";
import { generateToken, hasScope } from "../types/auth.js";
import {
  broadcastChannelId,
  directChannelId,
  groupChannelId,
  taskChannelId,
} from "../types/channel.js";
import type { CreateMessageInput, Message, MessageKind, Part } from "../types/message.js";
import type { CreateTaskInput, Task, TaskState } from "../types/task.js";
import { isValidTransition } from "../types/task.js";
import type { MessageQuery, Transport } from "./transport.js";

/** Options for creating an A2AX instance */
export interface A2AXOptions {
  transport: Transport;
  /** Max messages injected into agent context per tick */
  maxContextMessages?: number;
  /** Default message expiry in milliseconds (default: 7 days) */
  defaultExpiryMs?: number;
}

/** Context block ready to inject into an agent's prompt */
export interface AgentContext {
  messages: Message[];
  formatted: string;
  messageIds: string[];
}

/**
 * A2AX Protocol — the primary interface for agent communication.
 *
 * Usage:
 * ```ts
 * const a2ax = new A2AX({ transport: myTransport });
 * await a2ax.sendDirect(fleetId, fromId, toId, "hello");
 * ```
 */
export class A2AX {
  private transport: Transport;
  private maxContextMessages: number;
  private defaultExpiryMs: number;

  constructor(opts: A2AXOptions) {
    this.transport = opts.transport;
    this.maxContextMessages = opts.maxContextMessages ?? 20;
    this.defaultExpiryMs = opts.defaultExpiryMs ?? 7 * 24 * 60 * 60 * 1000;
  }

  // -------------------------------------------------------------------------
  // Direct messaging (1:1)
  // -------------------------------------------------------------------------

  async sendDirect(
    fleetId: string,
    fromAgentId: string,
    toAgentId: string,
    content: string,
    opts?: { kind?: MessageKind; parts?: Part[]; payload?: Record<string, unknown>; urgent?: boolean },
  ): Promise<Message> {
    const channelId = directChannelId(fromAgentId, toAgentId);

    // Ensure channel exists
    await this.ensureChannel(channelId, fleetId, "direct");

    return this.transport.insertMessage({
      fleetId,
      channelType: "direct",
      channelId,
      fromAgentId,
      kind: opts?.kind ?? "text",
      content,
      parts: opts?.parts,
      payload: opts?.payload,
      urgent: opts?.urgent,
      expiresAt: new Date(Date.now() + this.defaultExpiryMs),
    });
  }

  // -------------------------------------------------------------------------
  // Broadcast (one-to-all)
  // -------------------------------------------------------------------------

  async broadcast(
    fleetId: string,
    fromAgentId: string,
    content: string,
    opts?: { kind?: MessageKind; parts?: Part[]; payload?: Record<string, unknown> },
  ): Promise<Message> {
    const channelId = broadcastChannelId(fleetId);

    await this.ensureChannel(channelId, fleetId, "broadcast", "fleet-broadcast");

    return this.transport.insertMessage({
      fleetId,
      channelType: "broadcast",
      channelId,
      fromAgentId,
      kind: opts?.kind ?? "text",
      content,
      parts: opts?.parts,
      payload: opts?.payload,
      expiresAt: new Date(Date.now() + this.defaultExpiryMs),
    });
  }

  // -------------------------------------------------------------------------
  // Group messaging
  // -------------------------------------------------------------------------

  async createGroup(
    fleetId: string,
    name: string,
    memberIds: string[],
  ): Promise<{ channelId: string }> {
    const groupId = crypto.randomUUID();
    const channelId = groupChannelId(groupId);

    await this.transport.createChannel({
      id: channelId,
      fleetId,
      channelType: "group",
      name,
    });

    for (const agentId of memberIds) {
      await this.transport.addMember(channelId, agentId);
    }

    // System message
    await this.transport.insertMessage({
      fleetId,
      channelType: "group",
      channelId,
      fromAgentId: memberIds[0],
      role: "system",
      kind: "system.created",
      content: `Group "${name}" created with ${memberIds.length} members`,
    });

    return { channelId };
  }

  async sendToGroup(
    fleetId: string,
    channelId: string,
    fromAgentId: string,
    content: string,
    opts?: { kind?: MessageKind; parts?: Part[]; payload?: Record<string, unknown> },
  ): Promise<Message> {
    return this.transport.insertMessage({
      fleetId,
      channelType: "group",
      channelId,
      fromAgentId,
      kind: opts?.kind ?? "text",
      content,
      parts: opts?.parts,
      payload: opts?.payload,
      expiresAt: new Date(Date.now() + this.defaultExpiryMs),
    });
  }

  async joinGroup(channelId: string, agentId: string): Promise<void> {
    const channel = await this.transport.getChannel(channelId);
    if (!channel || channel.channelType !== "group") {
      throw new Error(`Channel ${channelId} is not a group`);
    }
    await this.transport.addMember(channelId, agentId);
  }

  async leaveGroup(channelId: string, agentId: string): Promise<void> {
    await this.transport.removeMember(channelId, agentId);
  }

  // -------------------------------------------------------------------------
  // Task management
  // -------------------------------------------------------------------------

  async createTask(input: CreateTaskInput): Promise<{ task: Task; channelId: string }> {
    const task = await this.transport.createTask(input);
    const channelId = taskChannelId(task.id);

    await this.transport.createChannel({
      id: channelId,
      fleetId: input.fleetId,
      channelType: "task",
      name: input.title,
    });

    // Initial task.create message
    await this.transport.insertMessage({
      fleetId: input.fleetId,
      channelType: "task",
      channelId,
      fromAgentId: input.requestorId,
      kind: "task.create",
      content: input.description,
      payload: { title: input.title, assigneeId: input.assigneeId },
      urgent: true,
    });

    return { task, channelId };
  }

  async updateTaskState(
    taskId: string,
    agentId: string,
    newState: TaskState,
    content?: string,
  ): Promise<Task> {
    const task = await this.transport.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    if (!isValidTransition(task.state, newState)) {
      throw new Error(`Invalid transition: ${task.state} -> ${newState}`);
    }

    const updated = await this.transport.updateTask(taskId, { state: newState });
    const channelId = taskChannelId(taskId);

    await this.transport.insertMessage({
      fleetId: task.fleetId,
      channelType: "task",
      channelId,
      fromAgentId: agentId,
      kind: "task.status",
      content: content ?? `Task moved to ${newState}`,
      payload: { state: newState },
    });

    return updated;
  }

  async completeTask(
    taskId: string,
    agentId: string,
    content: string,
    opts?: { parts?: Part[]; payload?: Record<string, unknown> },
  ): Promise<Task> {
    const task = await this.transport.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const updated = await this.transport.updateTask(taskId, { state: "completed" });
    const channelId = taskChannelId(taskId);

    await this.transport.insertMessage({
      fleetId: task.fleetId,
      channelType: "task",
      channelId,
      fromAgentId: agentId,
      kind: "task.result",
      content,
      parts: opts?.parts,
      payload: opts?.payload,
    });

    return updated;
  }

  // -------------------------------------------------------------------------
  // Agent context (for tick injection)
  // -------------------------------------------------------------------------

  async getAgentContext(fleetId: string, agentId: string): Promise<AgentContext> {
    // 1. Direct messages to this agent
    const directMsgs = await this.transport.queryMessages({
      fleetId,
      agentId,
      unreadOnly: true,
      channelType: "direct",
      limit: this.maxContextMessages,
    });

    // 2. Broadcast messages
    const broadcastMsgs = await this.transport.queryMessages({
      fleetId,
      agentId,
      unreadOnly: true,
      channelType: "broadcast",
      limit: this.maxContextMessages,
    });

    // 3. Group messages (agent must be a member)
    const groupMsgs = await this.transport.queryMessages({
      fleetId,
      agentId,
      unreadOnly: true,
      channelType: "group",
      limit: this.maxContextMessages,
    });

    // 4. Task messages (agent is requestor or assignee)
    const taskMsgs = await this.transport.queryMessages({
      fleetId,
      agentId,
      unreadOnly: true,
      channelType: "task",
      limit: this.maxContextMessages,
    });

    const allMessages = [...directMsgs, ...broadcastMsgs, ...groupMsgs, ...taskMsgs]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, this.maxContextMessages);

    const messageIds = allMessages.map((m) => m.id);
    const formatted = this.formatContext(allMessages);

    return { messages: allMessages, formatted, messageIds };
  }

  async markContextRead(messageIds: string[]): Promise<void> {
    if (messageIds.length > 0) {
      await this.transport.markRead(messageIds);
    }
  }

  // -------------------------------------------------------------------------
  // Agent Cards
  // -------------------------------------------------------------------------

  async registerCard(card: AgentCard): Promise<AgentCard> {
    return this.transport.upsertCard(card);
  }

  async getCard(agentId: string): Promise<AgentCard | null> {
    return this.transport.getCard(agentId);
  }

  async discoverAgents(fleetId: string): Promise<AgentCard[]> {
    return this.transport.listCards(fleetId);
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  async issueToken(agentId: string, fleetId: string, scopes?: Scope[]): Promise<string> {
    const token = generateToken();
    await this.transport.createToken({
      agentId,
      fleetId,
      token,
      scopes: scopes ?? [
        "message:send",
        "message:read",
        "task:create",
        "task:update",
        "broadcast:send",
        "group:join",
        "group:send",
        "card:read",
      ],
      createdAt: new Date(),
    });
    return token;
  }

  async authenticate(token: string): Promise<{ agentId: string; fleetId: string } | null> {
    const t = await this.transport.getToken(token);
    if (!t) return null;
    if (t.expiresAt && t.expiresAt < new Date()) return null;
    return { agentId: t.agentId, fleetId: t.fleetId };
  }

  async authorize(token: string, scope: Scope): Promise<boolean> {
    const t = await this.transport.getToken(token);
    if (!t) return false;
    if (t.expiresAt && t.expiresAt < new Date()) return false;
    return hasScope(t, scope);
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  async expireMessages(): Promise<number> {
    return this.transport.markExpired(new Date());
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async ensureChannel(
    channelId: string,
    fleetId: string,
    channelType: CreateMessageInput["channelType"],
    name?: string,
  ): Promise<void> {
    const existing = await this.transport.getChannel(channelId);
    if (!existing) {
      await this.transport.createChannel({ id: channelId, fleetId, channelType, name });
    }
  }

  private formatContext(messages: Message[]): string {
    if (messages.length === 0) return "";

    const lines = messages.map((m) => {
      const prefix = this.formatPrefix(m);
      return `${prefix}\n${m.content}`;
    });

    return `--- Messages since last tick ---\n\n${lines.join("\n\n")}\n---`;
  }

  private formatPrefix(m: Message): string {
    switch (m.channelType) {
      case "direct":
        return `[direct from ${m.fromAgentId}]:`;
      case "broadcast":
        return `[broadcast from ${m.fromAgentId}]:`;
      case "group":
        return `[${m.channelId} from ${m.fromAgentId}]:`;
      case "task":
        return `[${m.channelId} from ${m.fromAgentId}] (${m.kind}):`;
      default:
        return `[${m.fromAgentId}]:`;
    }
  }
}

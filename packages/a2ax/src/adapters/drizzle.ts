// ---------------------------------------------------------------------------
// Drizzle transport adapter for a2ax
// ---------------------------------------------------------------------------

import { and, eq, lt, ne, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { AgentCard } from "../types/agent-card.js";
import type { AgentToken } from "../types/auth.js";
import type { Channel, ChannelMember } from "../types/channel.js";
import { directChannelId } from "../types/channel.js";
import type {
  CreateMessageInput,
  Message,
  MessageRole,
  MessageStatus,
} from "../types/message.js";
import type {
  CreateTaskInput,
  Task,
  TaskState,
  UpdateTaskInput,
} from "../types/task.js";
import type { MessageQuery, Transport } from "../core/transport.js";
import {
  a2axAgentCards,
  a2axChannelMembers,
  a2axChannels,
  a2axMessageReads,
  a2axMessages,
  a2axTasks,
  a2axTokens,
} from "./drizzle-schema.js";

type DB = PgDatabase<any, any, any>;

export class DrizzleTransport implements Transport {
  constructor(private db: DB) {}

  // --- Messages ---

  async insertMessage(input: CreateMessageInput): Promise<Message> {
    const [row] = await this.db
      .insert(a2axMessages)
      .values({
        teamId: input.teamId,
        channelType: input.channelType,
        channelId: input.channelId,
        fromAgentId: input.fromAgentId,
        role: input.role ?? "agent",
        kind: input.kind,
        content: input.content,
        parts: input.parts as unknown[],
        artifacts: input.artifacts as unknown[],
        payload: input.payload,
        replyTo: input.replyTo,
        urgent: input.urgent ?? false,
        expiresAt: input.expiresAt,
      })
      .returning();
    return this.toMessage(row);
  }

  async queryMessages(query: MessageQuery): Promise<Message[]> {
    // Build conditions
    const conditions = [eq(a2axMessages.teamId, query.teamId)];

    if (query.unreadOnly) {
      conditions.push(ne(a2axMessages.status, "expired"));
      // Per-recipient unread: exclude messages this agent has already read.
      conditions.push(
        sql`NOT EXISTS (SELECT 1 FROM ${a2axMessageReads} r WHERE r.message_id = ${a2axMessages.id} AND r.agent_id = ${query.agentId})`,
      );
    }

    if (query.channelType) {
      conditions.push(eq(a2axMessages.channelType, query.channelType as any));
    }

    // Exclude messages from the querying agent
    conditions.push(sql`${a2axMessages.fromAgentId} != ${query.agentId}`);

    const rows = await this.db
      .select()
      .from(a2axMessages)
      .where(and(...conditions))
      .orderBy(a2axMessages.createdAt)
      .limit(query.limit ?? 100);

    // Post-filter by agent relevance (channel membership, task involvement, etc.)
    const memberships = await this.getMemberships(query.agentId);
    const memberChannelIds = new Set(memberships.map((m) => m.channelId));

    const tasks = await this.db
      .select()
      .from(a2axTasks)
      .where(
        and(
          eq(a2axTasks.teamId, query.teamId),
          or(
            eq(a2axTasks.assigneeId, query.agentId),
            eq(a2axTasks.requestorId, query.agentId),
          ),
        ),
      );
    const taskChannelIds = new Set(tasks.map((t) => `task:${t.id}`));

    const filtered = rows.filter((row) => {
      switch (row.channelType) {
        case "direct": {
          // Check if this agent is part of the direct channel
          const expected = directChannelId(query.agentId, row.fromAgentId);
          return row.channelId === expected;
        }
        case "broadcast":
          return true;
        case "group":
          return memberChannelIds.has(row.channelId);
        case "task":
          return taskChannelIds.has(row.channelId);
        default:
          return false;
      }
    });

    return filtered.map((r) => this.toMessage(r));
  }

  async markRead(agentId: string, messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    await this.db
      .insert(a2axMessageReads)
      .values(messageIds.map((messageId) => ({ messageId, agentId })))
      .onConflictDoNothing();
  }

  async markExpired(before: Date): Promise<number> {
    const result = await this.db
      .update(a2axMessages)
      .set({ status: "expired" })
      .where(
        and(
          lt(a2axMessages.expiresAt, before),
          or(
            eq(a2axMessages.status, "pending"),
            eq(a2axMessages.status, "delivered"),
          ),
        ),
      )
      .returning();
    return result.length;
  }

  // --- Channels ---

  async getChannel(channelId: string): Promise<Channel | null> {
    const [row] = await this.db
      .select()
      .from(a2axChannels)
      .where(eq(a2axChannels.id, channelId))
      .limit(1);
    return row ? this.toChannel(row) : null;
  }

  async createChannel(channel: Omit<Channel, "createdAt">): Promise<Channel> {
    const [row] = await this.db
      .insert(a2axChannels)
      .values({
        id: channel.id,
        teamId: channel.teamId,
        channelType: channel.channelType,
        name: channel.name,
        metadata: channel.metadata,
      })
      .returning();
    return this.toChannel(row);
  }

  async listChannels(teamId: string): Promise<Channel[]> {
    const rows = await this.db
      .select()
      .from(a2axChannels)
      .where(eq(a2axChannels.teamId, teamId));
    return rows.map((r) => this.toChannel(r));
  }

  async addMember(channelId: string, agentId: string): Promise<ChannelMember> {
    const [row] = await this.db
      .insert(a2axChannelMembers)
      .values({ channelId, agentId })
      .onConflictDoNothing()
      .returning();
    return row ?? { channelId, agentId, joinedAt: new Date() };
  }

  async removeMember(channelId: string, agentId: string): Promise<void> {
    await this.db
      .delete(a2axChannelMembers)
      .where(
        and(
          eq(a2axChannelMembers.channelId, channelId),
          eq(a2axChannelMembers.agentId, agentId),
        ),
      );
  }

  async getMembers(channelId: string): Promise<ChannelMember[]> {
    const rows = await this.db
      .select()
      .from(a2axChannelMembers)
      .where(eq(a2axChannelMembers.channelId, channelId));
    return rows.map((r) => ({
      channelId: r.channelId,
      agentId: r.agentId,
      joinedAt: r.joinedAt,
    }));
  }

  async getMemberships(agentId: string): Promise<ChannelMember[]> {
    const rows = await this.db
      .select()
      .from(a2axChannelMembers)
      .where(eq(a2axChannelMembers.agentId, agentId));
    return rows.map((r) => ({
      channelId: r.channelId,
      agentId: r.agentId,
      joinedAt: r.joinedAt,
    }));
  }

  // --- Tasks ---

  async createTask(input: CreateTaskInput): Promise<Task> {
    const id = crypto.randomUUID();
    const [row] = await this.db
      .insert(a2axTasks)
      .values({
        id,
        teamId: input.teamId,
        channelId: `task:${id}`,
        requestorId: input.requestorId,
        assigneeId: input.assigneeId,
        title: input.title,
        description: input.description,
        metadata: input.metadata,
      })
      .returning();
    return this.toTask(row);
  }

  async getTask(taskId: string): Promise<Task | null> {
    const [row] = await this.db
      .select()
      .from(a2axTasks)
      .where(eq(a2axTasks.id, taskId))
      .limit(1);
    return row ? this.toTask(row) : null;
  }

  async updateTask(taskId: string, input: UpdateTaskInput): Promise<Task> {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.state) updates.state = input.state;
    if (input.metadata) updates.metadata = input.metadata;

    const [row] = await this.db
      .update(a2axTasks)
      .set(updates)
      .where(eq(a2axTasks.id, taskId))
      .returning();
    if (!row) throw new Error(`Task ${taskId} not found`);
    return this.toTask(row);
  }

  async listTasks(teamId: string, agentId?: string): Promise<Task[]> {
    const conditions = [eq(a2axTasks.teamId, teamId)];
    if (agentId) {
      conditions.push(
        or(
          eq(a2axTasks.assigneeId, agentId),
          eq(a2axTasks.requestorId, agentId),
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(a2axTasks)
      .where(and(...conditions))
      .orderBy(a2axTasks.createdAt);
    return rows.map((r) => this.toTask(r));
  }

  // --- Agent Cards ---

  async getCard(agentId: string): Promise<AgentCard | null> {
    const [row] = await this.db
      .select()
      .from(a2axAgentCards)
      .where(eq(a2axAgentCards.id, agentId))
      .limit(1);
    return row ? this.toAgentCard(row) : null;
  }

  async upsertCard(card: AgentCard): Promise<AgentCard> {
    const [row] = await this.db
      .insert(a2axAgentCards)
      .values({
        id: card.id,
        name: card.name,
        description: card.description,
        endpoint: card.endpoint,
        capabilities: card.capabilities as unknown as Record<string, unknown>,
        skills: card.skills as unknown[],
        securitySchemes: card.securitySchemes as Record<string, unknown>,
        security: card.security as unknown[],
        signature: card.signature as unknown as Record<string, unknown>,
        provider: card.provider as unknown as Record<string, unknown>,
        metadata: card.metadata,
      })
      .onConflictDoUpdate({
        target: a2axAgentCards.id,
        set: {
          name: card.name,
          description: card.description,
          endpoint: card.endpoint,
          capabilities: card.capabilities as unknown as Record<string, unknown>,
          skills: card.skills as unknown[],
          securitySchemes: card.securitySchemes as Record<string, unknown>,
          security: card.security as unknown[],
          signature: card.signature as unknown as Record<string, unknown>,
          provider: card.provider as unknown as Record<string, unknown>,
          metadata: card.metadata,
          updatedAt: new Date(),
        },
      })
      .returning();
    return this.toAgentCard(row);
  }

  async listCards(teamId: string): Promise<AgentCard[]> {
    // teamId is stored in card metadata; filter strictly so cards never leak
    // across teams (the previous filter let through cards with no teamId).
    const rows = await this.db.select().from(a2axAgentCards);
    return rows
      .filter(
        (r) => (r.metadata as Record<string, unknown> | null)?.teamId === teamId,
      )
      .map((r) => this.toAgentCard(r));
  }

  // --- Auth ---

  async createToken(token: AgentToken): Promise<AgentToken> {
    const [row] = await this.db
      .insert(a2axTokens)
      .values({
        token: token.token,
        agentId: token.agentId,
        teamId: token.teamId,
        scopes: token.scopes,
        expiresAt: token.expiresAt,
      })
      .returning();
    return {
      agentId: row.agentId,
      teamId: row.teamId,
      token: row.token,
      scopes: row.scopes,
      expiresAt: row.expiresAt ?? undefined,
      createdAt: row.createdAt,
    };
  }

  async getToken(token: string): Promise<AgentToken | null> {
    const [row] = await this.db
      .select()
      .from(a2axTokens)
      .where(eq(a2axTokens.token, token))
      .limit(1);
    if (!row) return null;
    return {
      agentId: row.agentId,
      teamId: row.teamId,
      token: row.token,
      scopes: row.scopes,
      expiresAt: row.expiresAt ?? undefined,
      createdAt: row.createdAt,
    };
  }

  async revokeToken(token: string): Promise<void> {
    await this.db.delete(a2axTokens).where(eq(a2axTokens.token, token));
  }

  // --- Row mappers ---

  private toMessage(row: typeof a2axMessages.$inferSelect): Message {
    return {
      id: row.id,
      teamId: row.teamId,
      channelType: row.channelType,
      channelId: row.channelId,
      fromAgentId: row.fromAgentId,
      role: row.role as MessageRole,
      kind: row.kind as Message["kind"],
      content: row.content,
      parts: row.parts as Message["parts"],
      artifacts: row.artifacts as Message["artifacts"],
      payload: row.payload ?? undefined,
      replyTo: row.replyTo ?? undefined,
      status: row.status as MessageStatus,
      urgent: row.urgent,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  }

  private toChannel(row: typeof a2axChannels.$inferSelect): Channel {
    return {
      id: row.id,
      teamId: row.teamId,
      channelType: row.channelType,
      name: row.name ?? undefined,
      metadata: row.metadata ?? undefined,
      createdAt: row.createdAt,
    };
  }

  private toTask(row: typeof a2axTasks.$inferSelect): Task {
    return {
      id: row.id,
      teamId: row.teamId,
      channelId: row.channelId,
      requestorId: row.requestorId,
      assigneeId: row.assigneeId,
      title: row.title,
      description: row.description,
      state: row.state as TaskState,
      metadata: row.metadata ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toAgentCard(row: typeof a2axAgentCards.$inferSelect): AgentCard {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      endpoint: row.endpoint,
      capabilities: row.capabilities as unknown as AgentCard["capabilities"],
      skills: (row.skills ?? []) as unknown as AgentCard["skills"],
      securitySchemes:
        row.securitySchemes as unknown as AgentCard["securitySchemes"],
      security: row.security as unknown as AgentCard["security"],
      signature: (row.signature ??
        undefined) as unknown as AgentCard["signature"],
      provider: (row.provider ?? undefined) as unknown as AgentCard["provider"],
      metadata: (row.metadata ?? undefined) as AgentCard["metadata"],
    };
  }
}

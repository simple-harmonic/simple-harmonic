// ---------------------------------------------------------------------------
// Transport interface — storage-agnostic API that adapters implement
// ---------------------------------------------------------------------------

import type { AgentCard } from "../types/agent-card.js";
import type { AgentToken } from "../types/auth.js";
import type { Channel, ChannelMember } from "../types/channel.js";
import type { CreateMessageInput, Message } from "../types/message.js";
import type { CreateTaskInput, Task, UpdateTaskInput } from "../types/task.js";

/** Query filter for fetching messages */
export interface MessageQuery {
  teamId: string;
  agentId: string;
  /** Only unread (pending/delivered) */
  unreadOnly?: boolean;
  /** Max messages to return */
  limit?: number;
  /** Channel type filter */
  channelType?: string;
}

/**
 * Transport defines the storage layer for a2ax.
 * Implement this interface for your database (Drizzle, Prisma, in-memory, etc.)
 */
export interface Transport {
  // --- Messages ---
  insertMessage(input: CreateMessageInput): Promise<Message>;
  queryMessages(query: MessageQuery): Promise<Message[]>;
  /** Mark messages read FOR a specific agent (per-recipient, not global). */
  markRead(agentId: string, messageIds: string[]): Promise<void>;
  markExpired(before: Date): Promise<number>;

  // --- Channels ---
  getChannel(channelId: string): Promise<Channel | null>;
  createChannel(channel: Omit<Channel, "createdAt">): Promise<Channel>;
  listChannels(teamId: string): Promise<Channel[]>;
  addMember(channelId: string, agentId: string): Promise<ChannelMember>;
  removeMember(channelId: string, agentId: string): Promise<void>;
  getMembers(channelId: string): Promise<ChannelMember[]>;
  getMemberships(agentId: string): Promise<ChannelMember[]>;

  // --- Tasks ---
  createTask(input: CreateTaskInput): Promise<Task>;
  getTask(taskId: string): Promise<Task | null>;
  updateTask(taskId: string, input: UpdateTaskInput): Promise<Task>;
  listTasks(teamId: string, agentId?: string): Promise<Task[]>;

  // --- Agent Cards ---
  getCard(agentId: string): Promise<AgentCard | null>;
  upsertCard(card: AgentCard): Promise<AgentCard>;
  listCards(teamId: string): Promise<AgentCard[]>;

  // --- Auth ---
  createToken(token: AgentToken): Promise<AgentToken>;
  getToken(token: string): Promise<AgentToken | null>;
  revokeToken(token: string): Promise<void>;
}

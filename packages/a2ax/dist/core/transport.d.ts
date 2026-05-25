import type { AgentCard } from "../types/agent-card.js";
import type { AgentToken } from "../types/auth.js";
import type { Channel, ChannelMember } from "../types/channel.js";
import type { CreateMessageInput, Message } from "../types/message.js";
import type { CreateTaskInput, Task, UpdateTaskInput } from "../types/task.js";
/** Query filter for fetching messages */
export interface MessageQuery {
    fleetId: string;
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
    insertMessage(input: CreateMessageInput): Promise<Message>;
    queryMessages(query: MessageQuery): Promise<Message[]>;
    markRead(messageIds: string[]): Promise<void>;
    markExpired(before: Date): Promise<number>;
    getChannel(channelId: string): Promise<Channel | null>;
    createChannel(channel: Omit<Channel, "createdAt">): Promise<Channel>;
    listChannels(fleetId: string): Promise<Channel[]>;
    addMember(channelId: string, agentId: string): Promise<ChannelMember>;
    removeMember(channelId: string, agentId: string): Promise<void>;
    getMembers(channelId: string): Promise<ChannelMember[]>;
    getMemberships(agentId: string): Promise<ChannelMember[]>;
    createTask(input: CreateTaskInput): Promise<Task>;
    getTask(taskId: string): Promise<Task | null>;
    updateTask(taskId: string, input: UpdateTaskInput): Promise<Task>;
    listTasks(fleetId: string, agentId?: string): Promise<Task[]>;
    getCard(agentId: string): Promise<AgentCard | null>;
    upsertCard(card: AgentCard): Promise<AgentCard>;
    listCards(fleetId: string): Promise<AgentCard[]>;
    createToken(token: AgentToken): Promise<AgentToken>;
    getToken(token: string): Promise<AgentToken | null>;
    revokeToken(token: string): Promise<void>;
}
//# sourceMappingURL=transport.d.ts.map
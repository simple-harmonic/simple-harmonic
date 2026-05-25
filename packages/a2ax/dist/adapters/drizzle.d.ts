import type { PgDatabase } from "drizzle-orm/pg-core";
import type { AgentCard } from "../types/agent-card.js";
import type { AgentToken } from "../types/auth.js";
import type { Channel, ChannelMember } from "../types/channel.js";
import type { CreateMessageInput, Message } from "../types/message.js";
import type { CreateTaskInput, Task, UpdateTaskInput } from "../types/task.js";
import type { MessageQuery, Transport } from "../core/transport.js";
type DB = PgDatabase<any, any, any>;
export declare class DrizzleTransport implements Transport {
    private db;
    constructor(db: DB);
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
    private toMessage;
    private toChannel;
    private toTask;
    private toAgentCard;
}
export {};
//# sourceMappingURL=drizzle.d.ts.map
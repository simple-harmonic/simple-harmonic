import type { Transport, MessageQuery } from "../core/transport.js";
import type { AgentCard } from "../types/agent-card.js";
import type { AgentToken } from "../types/auth.js";
import type { Channel, ChannelMember } from "../types/channel.js";
import type { CreateMessageInput, Message } from "../types/message.js";
import type { CreateTaskInput, Task, UpdateTaskInput } from "../types/task.js";
export declare class JsonFileTransport implements Transport {
    private teamsRoot;
    private messages;
    private reads;
    private channels;
    private members;
    private tasks;
    private cards;
    private tokens;
    private teamDirs;
    private loaded;
    private hydrated;
    /** @param teamsRoot Absolute path to <dataDir>/teams. */
    constructor(teamsRoot: string);
    private hydrate;
    private loadDir;
    /** Resolve a team's messages dir, re-walking once if it appeared post-hydrate. */
    private dirForTeam;
    private persistChannels;
    private persistMembers;
    private persistTasks;
    private persistCards;
    private persistTokens;
    insertMessage(input: CreateMessageInput): Promise<Message>;
    queryMessages(query: MessageQuery): Promise<Message[]>;
    /** All messages for a team, chronological (for the conversation/hub views). */
    listTeamMessages(teamId: string, limit?: number): Promise<Message[]>;
    markRead(agentId: string, messageIds: string[]): Promise<void>;
    markExpired(before: Date): Promise<number>;
    getChannel(channelId: string): Promise<Channel | null>;
    createChannel(channel: Omit<Channel, "createdAt">): Promise<Channel>;
    listChannels(teamId: string): Promise<Channel[]>;
    addMember(channelId: string, agentId: string): Promise<ChannelMember>;
    removeMember(channelId: string, agentId: string): Promise<void>;
    getMembers(channelId: string): Promise<ChannelMember[]>;
    getMemberships(agentId: string): Promise<ChannelMember[]>;
    createTask(input: CreateTaskInput): Promise<Task>;
    getTask(taskId: string): Promise<Task | null>;
    updateTask(taskId: string, input: UpdateTaskInput): Promise<Task>;
    listTasks(teamId: string, agentId?: string): Promise<Task[]>;
    getCard(agentId: string): Promise<AgentCard | null>;
    upsertCard(card: AgentCard): Promise<AgentCard>;
    listCards(teamId: string): Promise<AgentCard[]>;
    createToken(token: AgentToken): Promise<AgentToken>;
    getToken(token: string): Promise<AgentToken | null>;
    revokeToken(token: string): Promise<void>;
}
//# sourceMappingURL=json-file.d.ts.map
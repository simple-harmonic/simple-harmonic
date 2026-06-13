import type { AgentCard } from "../types/agent-card.js";
import type { Scope } from "../types/auth.js";
import type { Message, MessageKind, Part } from "../types/message.js";
import type { CreateTaskInput, Task, TaskState } from "../types/task.js";
import type { Transport } from "./transport.js";
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
 * await a2ax.sendDirect(teamId, fromId, toId, "hello");
 * ```
 */
export declare class A2AX {
    private transport;
    private maxContextMessages;
    private defaultExpiryMs;
    constructor(opts: A2AXOptions);
    sendDirect(teamId: string, fromAgentId: string, toAgentId: string, content: string, opts?: {
        kind?: MessageKind;
        parts?: Part[];
        payload?: Record<string, unknown>;
        urgent?: boolean;
    }): Promise<Message>;
    broadcast(teamId: string, fromAgentId: string, content: string, opts?: {
        kind?: MessageKind;
        parts?: Part[];
        payload?: Record<string, unknown>;
    }): Promise<Message>;
    createGroup(teamId: string, name: string, memberIds: string[]): Promise<{
        channelId: string;
    }>;
    sendToGroup(teamId: string, channelId: string, fromAgentId: string, content: string, opts?: {
        kind?: MessageKind;
        parts?: Part[];
        payload?: Record<string, unknown>;
    }): Promise<Message>;
    joinGroup(channelId: string, agentId: string): Promise<void>;
    leaveGroup(channelId: string, agentId: string): Promise<void>;
    createTask(input: CreateTaskInput): Promise<{
        task: Task;
        channelId: string;
    }>;
    updateTaskState(taskId: string, agentId: string, newState: TaskState, content?: string): Promise<Task>;
    completeTask(taskId: string, agentId: string, content: string, opts?: {
        parts?: Part[];
        payload?: Record<string, unknown>;
    }): Promise<Task>;
    getAgentContext(teamId: string, agentId: string): Promise<AgentContext>;
    markContextRead(agentId: string, messageIds: string[]): Promise<void>;
    /** All messages for a team, chronological. */
    listMessages(teamId: string, limit?: number): Promise<Message[]>;
    /** All tasks for a team, optionally narrowed to a participant. */
    listTasks(teamId: string, agentId?: string): Promise<Task[]>;
    registerCard(card: AgentCard): Promise<AgentCard>;
    getCard(agentId: string): Promise<AgentCard | null>;
    discoverAgents(teamId: string): Promise<AgentCard[]>;
    issueToken(agentId: string, teamId: string, scopes?: Scope[]): Promise<string>;
    authenticate(token: string): Promise<{
        agentId: string;
        teamId: string;
    } | null>;
    authorize(token: string, scope: Scope): Promise<boolean>;
    expireMessages(): Promise<number>;
    private ensureChannel;
    private formatContext;
    private formatPrefix;
}
//# sourceMappingURL=protocol.d.ts.map
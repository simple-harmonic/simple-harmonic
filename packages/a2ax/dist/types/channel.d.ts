import type { ChannelType } from "./message.js";
/** A communication channel */
export interface Channel {
    id: string;
    teamId: string;
    channelType: ChannelType;
    name?: string;
    metadata?: Record<string, unknown>;
    createdAt: Date;
}
/** Channel membership (for group channels) */
export interface ChannelMember {
    channelId: string;
    agentId: string;
    joinedAt: Date;
}
/** Generate a deterministic direct channel ID from two agent IDs */
export declare function directChannelId(agentA: string, agentB: string): string;
/** Generate a broadcast channel ID for a team */
export declare function broadcastChannelId(teamId: string): string;
/** Generate a group channel ID */
export declare function groupChannelId(groupId: string): string;
/** Generate a task channel ID */
export declare function taskChannelId(taskId: string): string;
//# sourceMappingURL=channel.d.ts.map
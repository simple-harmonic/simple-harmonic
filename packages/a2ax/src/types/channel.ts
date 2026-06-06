// ---------------------------------------------------------------------------
// Channel types — a2ax extension over A2A
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Channel ID helpers
// ---------------------------------------------------------------------------

/** Generate a deterministic direct channel ID from two agent IDs */
export function directChannelId(agentA: string, agentB: string): string {
  const sorted = [agentA, agentB].sort();
  return `direct:${sorted[0]}:${sorted[1]}`;
}

/** Generate a broadcast channel ID for a team */
export function broadcastChannelId(teamId: string): string {
  return `team:${teamId}`;
}

/** Generate a group channel ID */
export function groupChannelId(groupId: string): string {
  return `group:${groupId}`;
}

/** Generate a task channel ID */
export function taskChannelId(taskId: string): string {
  return `task:${taskId}`;
}

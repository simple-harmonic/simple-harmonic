// ---------------------------------------------------------------------------
// Channel types — a2ax extension over A2A
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Channel ID helpers
// ---------------------------------------------------------------------------
/** Generate a deterministic direct channel ID from two agent IDs */
export function directChannelId(agentA, agentB) {
    const sorted = [agentA, agentB].sort();
    return `direct:${sorted[0]}:${sorted[1]}`;
}
/** Generate a broadcast channel ID for a fleet */
export function broadcastChannelId(fleetId) {
    return `fleet:${fleetId}`;
}
/** Generate a group channel ID */
export function groupChannelId(groupId) {
    return `group:${groupId}`;
}
/** Generate a task channel ID */
export function taskChannelId(taskId) {
    return `task:${taskId}`;
}
//# sourceMappingURL=channel.js.map
// ---------------------------------------------------------------------------
// Agent Card — A2A spec compliant + a2ax extensions
// ---------------------------------------------------------------------------
/** Create a minimal agent card with sensible defaults */
export function createAgentCard(opts) {
    return {
        capabilities: {
            streaming: false,
            pushNotifications: false,
            extendedAgentCard: false,
            broadcast: true,
            groups: true,
            tasks: true,
        },
        skills: [],
        ...opts,
    };
}
//# sourceMappingURL=agent-card.js.map
// ---------------------------------------------------------------------------
// In-memory transport — for testing and prototyping
// ---------------------------------------------------------------------------
import { directChannelId } from "../types/channel.js";
export class MemoryTransport {
    messages = [];
    // Per-recipient read tracking, keyed `${messageId}:${agentId}`. A broadcast or
    // group message is a single row, so reads MUST be per-agent — otherwise one
    // reader hides it from everyone else.
    reads = new Set();
    channels = new Map();
    members = [];
    tasks = new Map();
    cards = new Map();
    tokens = new Map();
    // --- Messages ---
    async insertMessage(input) {
        const msg = {
            id: crypto.randomUUID(),
            teamId: input.teamId,
            channelType: input.channelType,
            channelId: input.channelId,
            fromAgentId: input.fromAgentId,
            role: input.role ?? "agent",
            kind: input.kind,
            content: input.content,
            parts: input.parts,
            artifacts: input.artifacts,
            payload: input.payload,
            replyTo: input.replyTo,
            status: "pending",
            urgent: input.urgent,
            expiresAt: input.expiresAt ?? null,
            createdAt: new Date(),
        };
        this.messages.push(msg);
        return msg;
    }
    async queryMessages(query) {
        let results = this.messages.filter((m) => m.teamId === query.teamId);
        if (query.unreadOnly) {
            results = results.filter((m) => m.status !== "expired" &&
                !this.reads.has(`${m.id}:${query.agentId}`));
        }
        if (query.channelType) {
            results = results.filter((m) => m.channelType === query.channelType);
        }
        // Filter by agent relevance
        results = results.filter((m) => {
            if (m.fromAgentId === query.agentId)
                return false; // Don't show own messages
            switch (m.channelType) {
                case "direct": {
                    const expected = directChannelId(query.agentId, m.fromAgentId);
                    return m.channelId === expected;
                }
                case "broadcast":
                    return true;
                case "group":
                    return this.members.some((mb) => mb.channelId === m.channelId && mb.agentId === query.agentId);
                case "task":
                    // Check if agent is involved in this task
                    for (const t of this.tasks.values()) {
                        if (m.channelId === `task:${t.id}` &&
                            (t.assigneeId === query.agentId ||
                                t.requestorId === query.agentId)) {
                            return true;
                        }
                    }
                    return false;
                default:
                    return false;
            }
        });
        results.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        if (query.limit) {
            results = results.slice(0, query.limit);
        }
        return results;
    }
    async markRead(agentId, messageIds) {
        for (const id of messageIds) {
            this.reads.add(`${id}:${agentId}`);
        }
    }
    async markExpired(before) {
        let count = 0;
        for (const m of this.messages) {
            if (m.expiresAt && m.expiresAt < before && m.status !== "expired") {
                m.status = "expired";
                count++;
            }
        }
        return count;
    }
    // --- Channels ---
    async getChannel(channelId) {
        return this.channels.get(channelId) ?? null;
    }
    async createChannel(channel) {
        const full = { ...channel, createdAt: new Date() };
        this.channels.set(channel.id, full);
        return full;
    }
    async listChannels(teamId) {
        return [...this.channels.values()].filter((c) => c.teamId === teamId);
    }
    async addMember(channelId, agentId) {
        const existing = this.members.find((m) => m.channelId === channelId && m.agentId === agentId);
        if (existing)
            return existing;
        const member = { channelId, agentId, joinedAt: new Date() };
        this.members.push(member);
        return member;
    }
    async removeMember(channelId, agentId) {
        this.members = this.members.filter((m) => !(m.channelId === channelId && m.agentId === agentId));
    }
    async getMembers(channelId) {
        return this.members.filter((m) => m.channelId === channelId);
    }
    async getMemberships(agentId) {
        return this.members.filter((m) => m.agentId === agentId);
    }
    // --- Tasks ---
    async createTask(input) {
        const task = {
            id: crypto.randomUUID(),
            teamId: input.teamId,
            channelId: `task:${crypto.randomUUID()}`,
            requestorId: input.requestorId,
            assigneeId: input.assigneeId,
            title: input.title,
            description: input.description,
            state: "submitted",
            metadata: input.metadata,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        // Fix channelId to match task id
        task.channelId = `task:${task.id}`;
        this.tasks.set(task.id, task);
        return task;
    }
    async getTask(taskId) {
        return this.tasks.get(taskId) ?? null;
    }
    async updateTask(taskId, input) {
        const task = this.tasks.get(taskId);
        if (!task)
            throw new Error(`Task ${taskId} not found`);
        if (input.state)
            task.state = input.state;
        if (input.metadata)
            task.metadata = { ...task.metadata, ...input.metadata };
        task.updatedAt = new Date();
        return task;
    }
    async listTasks(teamId, agentId) {
        let results = [...this.tasks.values()].filter((t) => t.teamId === teamId);
        if (agentId) {
            results = results.filter((t) => t.assigneeId === agentId || t.requestorId === agentId);
        }
        return results;
    }
    // --- Agent Cards ---
    async getCard(agentId) {
        return this.cards.get(agentId) ?? null;
    }
    async upsertCard(card) {
        this.cards.set(card.id, card);
        return card;
    }
    async listCards(teamId) {
        // teamId is stored in metadata. Filter strictly so cards never leak across
        // teams (the previous `|| true` returned every card regardless of team).
        return [...this.cards.values()].filter((c) => c.metadata?.teamId === teamId);
    }
    // --- Auth ---
    async createToken(token) {
        this.tokens.set(token.token, token);
        return token;
    }
    async getToken(token) {
        return this.tokens.get(token) ?? null;
    }
    async revokeToken(token) {
        this.tokens.delete(token);
    }
}
//# sourceMappingURL=memory.js.map
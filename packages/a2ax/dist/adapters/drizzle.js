// ---------------------------------------------------------------------------
// Drizzle transport adapter for a2ax
// ---------------------------------------------------------------------------
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { directChannelId } from "../types/channel.js";
import { a2axAgentCards, a2axChannelMembers, a2axChannels, a2axMessages, a2axTasks, a2axTokens, } from "./drizzle-schema.js";
export class DrizzleTransport {
    db;
    constructor(db) {
        this.db = db;
    }
    // --- Messages ---
    async insertMessage(input) {
        const [row] = await this.db
            .insert(a2axMessages)
            .values({
            fleetId: input.fleetId,
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
            urgent: input.urgent ?? false,
            expiresAt: input.expiresAt,
        })
            .returning();
        return this.toMessage(row);
    }
    async queryMessages(query) {
        // Build conditions
        const conditions = [eq(a2axMessages.fleetId, query.fleetId)];
        if (query.unreadOnly) {
            conditions.push(or(eq(a2axMessages.status, "pending"), eq(a2axMessages.status, "delivered")));
        }
        if (query.channelType) {
            conditions.push(eq(a2axMessages.channelType, query.channelType));
        }
        // Exclude messages from the querying agent
        conditions.push(sql `${a2axMessages.fromAgentId} != ${query.agentId}`);
        const rows = await this.db
            .select()
            .from(a2axMessages)
            .where(and(...conditions))
            .orderBy(a2axMessages.createdAt)
            .limit(query.limit ?? 100);
        // Post-filter by agent relevance (channel membership, task involvement, etc.)
        const memberships = await this.getMemberships(query.agentId);
        const memberChannelIds = new Set(memberships.map((m) => m.channelId));
        const tasks = await this.db
            .select()
            .from(a2axTasks)
            .where(and(eq(a2axTasks.fleetId, query.fleetId), or(eq(a2axTasks.assigneeId, query.agentId), eq(a2axTasks.requestorId, query.agentId))));
        const taskChannelIds = new Set(tasks.map((t) => `task:${t.id}`));
        const filtered = rows.filter((row) => {
            switch (row.channelType) {
                case "direct": {
                    // Check if this agent is part of the direct channel
                    const expected = directChannelId(query.agentId, row.fromAgentId);
                    return row.channelId === expected;
                }
                case "broadcast":
                    return true;
                case "group":
                    return memberChannelIds.has(row.channelId);
                case "task":
                    return taskChannelIds.has(row.channelId);
                default:
                    return false;
            }
        });
        return filtered.map((r) => this.toMessage(r));
    }
    async markRead(messageIds) {
        if (messageIds.length === 0)
            return;
        await this.db
            .update(a2axMessages)
            .set({ status: "read" })
            .where(inArray(a2axMessages.id, messageIds));
    }
    async markExpired(before) {
        const result = await this.db
            .update(a2axMessages)
            .set({ status: "expired" })
            .where(and(lt(a2axMessages.expiresAt, before), or(eq(a2axMessages.status, "pending"), eq(a2axMessages.status, "delivered"))))
            .returning();
        return result.length;
    }
    // --- Channels ---
    async getChannel(channelId) {
        const [row] = await this.db
            .select()
            .from(a2axChannels)
            .where(eq(a2axChannels.id, channelId))
            .limit(1);
        return row ? this.toChannel(row) : null;
    }
    async createChannel(channel) {
        const [row] = await this.db
            .insert(a2axChannels)
            .values({
            id: channel.id,
            fleetId: channel.fleetId,
            channelType: channel.channelType,
            name: channel.name,
            metadata: channel.metadata,
        })
            .returning();
        return this.toChannel(row);
    }
    async listChannels(fleetId) {
        const rows = await this.db
            .select()
            .from(a2axChannels)
            .where(eq(a2axChannels.fleetId, fleetId));
        return rows.map((r) => this.toChannel(r));
    }
    async addMember(channelId, agentId) {
        const [row] = await this.db
            .insert(a2axChannelMembers)
            .values({ channelId, agentId })
            .onConflictDoNothing()
            .returning();
        return row ?? { channelId, agentId, joinedAt: new Date() };
    }
    async removeMember(channelId, agentId) {
        await this.db
            .delete(a2axChannelMembers)
            .where(and(eq(a2axChannelMembers.channelId, channelId), eq(a2axChannelMembers.agentId, agentId)));
    }
    async getMembers(channelId) {
        const rows = await this.db
            .select()
            .from(a2axChannelMembers)
            .where(eq(a2axChannelMembers.channelId, channelId));
        return rows.map((r) => ({
            channelId: r.channelId,
            agentId: r.agentId,
            joinedAt: r.joinedAt,
        }));
    }
    async getMemberships(agentId) {
        const rows = await this.db
            .select()
            .from(a2axChannelMembers)
            .where(eq(a2axChannelMembers.agentId, agentId));
        return rows.map((r) => ({
            channelId: r.channelId,
            agentId: r.agentId,
            joinedAt: r.joinedAt,
        }));
    }
    // --- Tasks ---
    async createTask(input) {
        const id = crypto.randomUUID();
        const [row] = await this.db
            .insert(a2axTasks)
            .values({
            id,
            fleetId: input.fleetId,
            channelId: `task:${id}`,
            requestorId: input.requestorId,
            assigneeId: input.assigneeId,
            title: input.title,
            description: input.description,
            metadata: input.metadata,
        })
            .returning();
        return this.toTask(row);
    }
    async getTask(taskId) {
        const [row] = await this.db
            .select()
            .from(a2axTasks)
            .where(eq(a2axTasks.id, taskId))
            .limit(1);
        return row ? this.toTask(row) : null;
    }
    async updateTask(taskId, input) {
        const updates = { updatedAt: new Date() };
        if (input.state)
            updates.state = input.state;
        if (input.metadata)
            updates.metadata = input.metadata;
        const [row] = await this.db
            .update(a2axTasks)
            .set(updates)
            .where(eq(a2axTasks.id, taskId))
            .returning();
        if (!row)
            throw new Error(`Task ${taskId} not found`);
        return this.toTask(row);
    }
    async listTasks(fleetId, agentId) {
        const conditions = [eq(a2axTasks.fleetId, fleetId)];
        if (agentId) {
            conditions.push(or(eq(a2axTasks.assigneeId, agentId), eq(a2axTasks.requestorId, agentId)));
        }
        const rows = await this.db
            .select()
            .from(a2axTasks)
            .where(and(...conditions))
            .orderBy(a2axTasks.createdAt);
        return rows.map((r) => this.toTask(r));
    }
    // --- Agent Cards ---
    async getCard(agentId) {
        const [row] = await this.db
            .select()
            .from(a2axAgentCards)
            .where(eq(a2axAgentCards.id, agentId))
            .limit(1);
        return row ? this.toAgentCard(row) : null;
    }
    async upsertCard(card) {
        const [row] = await this.db
            .insert(a2axAgentCards)
            .values({
            id: card.id,
            name: card.name,
            description: card.description,
            endpoint: card.endpoint,
            capabilities: card.capabilities,
            skills: card.skills,
            securitySchemes: card.securitySchemes,
            security: card.security,
            signature: card.signature,
            provider: card.provider,
            metadata: card.metadata,
        })
            .onConflictDoUpdate({
            target: a2axAgentCards.id,
            set: {
                name: card.name,
                description: card.description,
                endpoint: card.endpoint,
                capabilities: card.capabilities,
                skills: card.skills,
                securitySchemes: card.securitySchemes,
                security: card.security,
                signature: card.signature,
                provider: card.provider,
                metadata: card.metadata,
                updatedAt: new Date(),
            },
        })
            .returning();
        return this.toAgentCard(row);
    }
    async listCards(fleetId) {
        // Cards don't have a direct fleetId; filter by metadata if needed
        const rows = await this.db.select().from(a2axAgentCards);
        return rows
            .filter((r) => {
            const meta = r.metadata;
            return !fleetId || meta?.fleetId === fleetId || !meta?.fleetId;
        })
            .map((r) => this.toAgentCard(r));
    }
    // --- Auth ---
    async createToken(token) {
        const [row] = await this.db
            .insert(a2axTokens)
            .values({
            token: token.token,
            agentId: token.agentId,
            fleetId: token.fleetId,
            scopes: token.scopes,
            expiresAt: token.expiresAt,
        })
            .returning();
        return {
            agentId: row.agentId,
            fleetId: row.fleetId,
            token: row.token,
            scopes: row.scopes,
            expiresAt: row.expiresAt ?? undefined,
            createdAt: row.createdAt,
        };
    }
    async getToken(token) {
        const [row] = await this.db
            .select()
            .from(a2axTokens)
            .where(eq(a2axTokens.token, token))
            .limit(1);
        if (!row)
            return null;
        return {
            agentId: row.agentId,
            fleetId: row.fleetId,
            token: row.token,
            scopes: row.scopes,
            expiresAt: row.expiresAt ?? undefined,
            createdAt: row.createdAt,
        };
    }
    async revokeToken(token) {
        await this.db.delete(a2axTokens).where(eq(a2axTokens.token, token));
    }
    // --- Row mappers ---
    toMessage(row) {
        return {
            id: row.id,
            fleetId: row.fleetId,
            channelType: row.channelType,
            channelId: row.channelId,
            fromAgentId: row.fromAgentId,
            role: row.role,
            kind: row.kind,
            content: row.content,
            parts: row.parts,
            artifacts: row.artifacts,
            payload: row.payload ?? undefined,
            replyTo: row.replyTo ?? undefined,
            status: row.status,
            urgent: row.urgent,
            expiresAt: row.expiresAt,
            createdAt: row.createdAt,
        };
    }
    toChannel(row) {
        return {
            id: row.id,
            fleetId: row.fleetId,
            channelType: row.channelType,
            name: row.name ?? undefined,
            metadata: row.metadata ?? undefined,
            createdAt: row.createdAt,
        };
    }
    toTask(row) {
        return {
            id: row.id,
            fleetId: row.fleetId,
            channelId: row.channelId,
            requestorId: row.requestorId,
            assigneeId: row.assigneeId,
            title: row.title,
            description: row.description,
            state: row.state,
            metadata: row.metadata ?? undefined,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }
    toAgentCard(row) {
        return {
            id: row.id,
            name: row.name,
            description: row.description ?? undefined,
            endpoint: row.endpoint,
            capabilities: row.capabilities,
            skills: (row.skills ?? []),
            securitySchemes: row.securitySchemes,
            security: row.security,
            signature: (row.signature ?? undefined),
            provider: (row.provider ?? undefined),
            metadata: (row.metadata ?? undefined),
        };
    }
}
//# sourceMappingURL=drizzle.js.map
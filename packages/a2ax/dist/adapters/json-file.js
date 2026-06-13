// ---------------------------------------------------------------------------
// JSON-file transport adapter for a2ax.
//
// Stores each team's communication state under that team's folder in the
// recursive data tree:
//
//   <teamDir>/messages/
//   ├─ log.jsonl      messages (append; rewritten on bulk expiry)
//   ├─ reads.jsonl    per-recipient read receipts (append)
//   ├─ channels.json  members.json  tasks.json   (rewritten on change)
//   └─ cards.json     tokens.json
//
// Query/relevance logic is identical to MemoryTransport: the adapter holds the
// state in memory (hydrated once by walking the team tree) so the methods that
// arrive without a teamId — markRead, getTask, getToken, … — resolve in O(1),
// and writes are mirrored through to the owning team's files. Single-process,
// single-writer, like the rest of the file store.
// ---------------------------------------------------------------------------
import { join } from "node:path";
import { directChannelId } from "../types/channel.js";
import { appendJsonl, discoverTeamMessageDirs, readJson, readJsonl, rewriteJsonl, writeJson, } from "../storage/file-store.js";
const d = (v) => new Date(v);
const dOrNull = (v) => (v == null ? null : new Date(v));
export class JsonFileTransport {
    teamsRoot;
    messages = [];
    reads = new Set(); // `${messageId}:${agentId}`
    channels = new Map();
    members = [];
    tasks = new Map();
    cards = new Map();
    tokens = new Map();
    teamDirs = new Map(); // teamId → messages dir
    loaded = new Set(); // dirs already read into memory
    hydrated = false;
    /** @param teamsRoot Absolute path to <dataDir>/teams. */
    constructor(teamsRoot) {
        this.teamsRoot = teamsRoot;
    }
    // --- Hydration + path resolution -----------------------------------------
    hydrate() {
        if (this.hydrated)
            return;
        this.teamDirs = discoverTeamMessageDirs(this.teamsRoot);
        for (const dir of this.teamDirs.values())
            this.loadDir(dir);
        this.hydrated = true;
    }
    loadDir(dir) {
        if (this.loaded.has(dir))
            return;
        this.loaded.add(dir);
        for (const m of readJsonl(join(dir, "log.jsonl"))) {
            m.createdAt = d(m.createdAt);
            m.expiresAt = dOrNull(m.expiresAt);
            this.messages.push(m);
        }
        for (const r of readJsonl(join(dir, "reads.jsonl"))) {
            this.reads.add(`${r.messageId}:${r.agentId}`);
        }
        for (const c of readJson(join(dir, "channels.json"), [])) {
            c.createdAt = d(c.createdAt);
            this.channels.set(c.id, c);
        }
        for (const mb of readJson(join(dir, "members.json"), [])) {
            mb.joinedAt = d(mb.joinedAt);
            this.members.push(mb);
        }
        for (const t of readJson(join(dir, "tasks.json"), [])) {
            t.createdAt = d(t.createdAt);
            t.updatedAt = d(t.updatedAt);
            this.tasks.set(t.id, t);
        }
        for (const c of readJson(join(dir, "cards.json"), [])) {
            this.cards.set(c.id, c);
        }
        for (const t of readJson(join(dir, "tokens.json"), [])) {
            t.createdAt = d(t.createdAt);
            t.expiresAt = t.expiresAt ? d(t.expiresAt) : undefined;
            this.tokens.set(t.token, t);
        }
    }
    /** Resolve a team's messages dir, re-walking once if it appeared post-hydrate. */
    dirForTeam(teamId) {
        let dir = this.teamDirs.get(teamId);
        if (!dir) {
            this.teamDirs = discoverTeamMessageDirs(this.teamsRoot);
            dir = this.teamDirs.get(teamId);
            if (dir)
                this.loadDir(dir);
        }
        if (!dir)
            throw new Error(`a2ax: team ${teamId} folder not found under ${this.teamsRoot}`);
        return dir;
    }
    // --- Per-collection persistence (filter memory by team, rewrite file) -----
    persistChannels(teamId) {
        writeJson(join(this.dirForTeam(teamId), "channels.json"), [...this.channels.values()].filter((c) => c.teamId === teamId));
    }
    persistMembers(teamId) {
        writeJson(join(this.dirForTeam(teamId), "members.json"), this.members.filter((m) => this.channels.get(m.channelId)?.teamId === teamId));
    }
    persistTasks(teamId) {
        writeJson(join(this.dirForTeam(teamId), "tasks.json"), [...this.tasks.values()].filter((t) => t.teamId === teamId));
    }
    persistCards(teamId) {
        writeJson(join(this.dirForTeam(teamId), "cards.json"), [...this.cards.values()].filter((c) => c.metadata?.teamId === teamId));
    }
    persistTokens(teamId) {
        writeJson(join(this.dirForTeam(teamId), "tokens.json"), [...this.tokens.values()].filter((t) => t.teamId === teamId));
    }
    // --- Messages ------------------------------------------------------------
    async insertMessage(input) {
        this.hydrate();
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
        appendJsonl(join(this.dirForTeam(input.teamId), "log.jsonl"), msg);
        return msg;
    }
    async queryMessages(query) {
        this.hydrate();
        let results = this.messages.filter((m) => m.teamId === query.teamId);
        if (query.unreadOnly) {
            results = results.filter((m) => m.status !== "expired" && !this.reads.has(`${m.id}:${query.agentId}`));
        }
        if (query.channelType) {
            results = results.filter((m) => m.channelType === query.channelType);
        }
        results = results.filter((m) => {
            if (m.fromAgentId === query.agentId)
                return false;
            switch (m.channelType) {
                case "direct":
                    return m.channelId === directChannelId(query.agentId, m.fromAgentId);
                case "broadcast":
                    return true;
                case "group":
                    return this.members.some((mb) => mb.channelId === m.channelId && mb.agentId === query.agentId);
                case "task":
                    for (const t of this.tasks.values()) {
                        if (m.channelId === `task:${t.id}` &&
                            (t.assigneeId === query.agentId || t.requestorId === query.agentId)) {
                            return true;
                        }
                    }
                    return false;
                default:
                    return false;
            }
        });
        results.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return query.limit ? results.slice(0, query.limit) : results;
    }
    /** All messages for a team, chronological (for the conversation/hub views). */
    async listTeamMessages(teamId, limit) {
        this.hydrate();
        const rows = this.messages
            .filter((m) => m.teamId === teamId)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return limit ? rows.slice(0, limit) : rows;
    }
    async markRead(agentId, messageIds) {
        this.hydrate();
        for (const id of messageIds) {
            const key = `${id}:${agentId}`;
            if (this.reads.has(key))
                continue;
            this.reads.add(key);
            const msg = this.messages.find((m) => m.id === id);
            if (msg) {
                appendJsonl(join(this.dirForTeam(msg.teamId), "reads.jsonl"), {
                    messageId: id,
                    agentId,
                    readAt: new Date(),
                });
            }
        }
    }
    async markExpired(before) {
        this.hydrate();
        const affected = new Set();
        let count = 0;
        for (const m of this.messages) {
            if (m.expiresAt && m.expiresAt < before && m.status !== "expired") {
                m.status = "expired";
                affected.add(m.teamId);
                count++;
            }
        }
        for (const teamId of affected) {
            rewriteJsonl(join(this.dirForTeam(teamId), "log.jsonl"), this.messages.filter((m) => m.teamId === teamId));
        }
        return count;
    }
    // --- Channels ------------------------------------------------------------
    async getChannel(channelId) {
        this.hydrate();
        return this.channels.get(channelId) ?? null;
    }
    async createChannel(channel) {
        this.hydrate();
        const full = { ...channel, createdAt: new Date() };
        this.channels.set(channel.id, full);
        this.persistChannels(channel.teamId);
        return full;
    }
    async listChannels(teamId) {
        this.hydrate();
        return [...this.channels.values()].filter((c) => c.teamId === teamId);
    }
    async addMember(channelId, agentId) {
        this.hydrate();
        const existing = this.members.find((m) => m.channelId === channelId && m.agentId === agentId);
        if (existing)
            return existing;
        const member = { channelId, agentId, joinedAt: new Date() };
        this.members.push(member);
        const ch = this.channels.get(channelId);
        if (ch)
            this.persistMembers(ch.teamId);
        return member;
    }
    async removeMember(channelId, agentId) {
        this.hydrate();
        const ch = this.channels.get(channelId);
        this.members = this.members.filter((m) => !(m.channelId === channelId && m.agentId === agentId));
        if (ch)
            this.persistMembers(ch.teamId);
    }
    async getMembers(channelId) {
        this.hydrate();
        return this.members.filter((m) => m.channelId === channelId);
    }
    async getMemberships(agentId) {
        this.hydrate();
        return this.members.filter((m) => m.agentId === agentId);
    }
    // --- Tasks ---------------------------------------------------------------
    async createTask(input) {
        this.hydrate();
        const id = crypto.randomUUID();
        const now = new Date();
        const task = {
            id,
            teamId: input.teamId,
            channelId: `task:${id}`,
            requestorId: input.requestorId,
            assigneeId: input.assigneeId,
            title: input.title,
            description: input.description,
            state: "submitted",
            metadata: input.metadata,
            createdAt: now,
            updatedAt: now,
        };
        this.tasks.set(id, task);
        this.persistTasks(input.teamId);
        return task;
    }
    async getTask(taskId) {
        this.hydrate();
        return this.tasks.get(taskId) ?? null;
    }
    async updateTask(taskId, input) {
        this.hydrate();
        const task = this.tasks.get(taskId);
        if (!task)
            throw new Error(`Task ${taskId} not found`);
        if (input.state)
            task.state = input.state;
        if (input.metadata)
            task.metadata = { ...task.metadata, ...input.metadata };
        task.updatedAt = new Date();
        this.persistTasks(task.teamId);
        return task;
    }
    async listTasks(teamId, agentId) {
        this.hydrate();
        let results = [...this.tasks.values()].filter((t) => t.teamId === teamId);
        if (agentId) {
            results = results.filter((t) => t.assigneeId === agentId || t.requestorId === agentId);
        }
        return results;
    }
    // --- Agent Cards ---------------------------------------------------------
    async getCard(agentId) {
        this.hydrate();
        return this.cards.get(agentId) ?? null;
    }
    async upsertCard(card) {
        this.hydrate();
        this.cards.set(card.id, card);
        const teamId = card.metadata?.teamId;
        if (typeof teamId === "string")
            this.persistCards(teamId);
        return card;
    }
    async listCards(teamId) {
        this.hydrate();
        return [...this.cards.values()].filter((c) => c.metadata?.teamId === teamId);
    }
    // --- Auth ----------------------------------------------------------------
    async createToken(token) {
        this.hydrate();
        this.tokens.set(token.token, token);
        this.persistTokens(token.teamId);
        return token;
    }
    async getToken(token) {
        this.hydrate();
        return this.tokens.get(token) ?? null;
    }
    async revokeToken(token) {
        this.hydrate();
        const t = this.tokens.get(token);
        this.tokens.delete(token);
        if (t)
            this.persistTokens(t.teamId);
    }
}
//# sourceMappingURL=json-file.js.map
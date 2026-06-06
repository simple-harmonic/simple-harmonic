// ---------------------------------------------------------------------------
// Drizzle schema for a2ax tables
// ---------------------------------------------------------------------------
import { boolean, index, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uuid, } from "drizzle-orm/pg-core";
export const a2axChannelType = pgEnum("a2ax_channel_type", [
    "direct",
    "broadcast",
    "group",
    "task",
]);
export const a2axMessageStatus = pgEnum("a2ax_message_status", [
    "pending",
    "delivered",
    "read",
    "expired",
]);
export const a2axTaskState = pgEnum("a2ax_task_state", [
    "submitted",
    "accepted",
    "working",
    "input_required",
    "completed",
    "failed",
    "canceled",
    "rejected",
]);
// --- Channels ---
export const a2axChannels = pgTable("a2ax_channels", {
    id: text("id").primaryKey(),
    teamId: uuid("team_id").notNull(),
    channelType: a2axChannelType("channel_type").notNull(),
    name: text("name"),
    metadata: jsonb("metadata").$type(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});
// --- Channel Members ---
export const a2axChannelMembers = pgTable("a2ax_channel_members", {
    channelId: text("channel_id")
        .notNull()
        .references(() => a2axChannels.id),
    agentId: uuid("agent_id").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});
// --- Messages ---
export const a2axMessages = pgTable("a2ax_messages", {
    id: uuid("id").defaultRandom().primaryKey(),
    teamId: uuid("team_id").notNull(),
    channelType: a2axChannelType("channel_type").notNull(),
    channelId: text("channel_id").notNull(),
    fromAgentId: uuid("from_agent_id").notNull(),
    role: text("role").notNull().default("agent"),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    parts: jsonb("parts").$type(),
    artifacts: jsonb("artifacts").$type(),
    payload: jsonb("payload").$type(),
    replyTo: uuid("reply_to"),
    status: a2axMessageStatus("status").notNull().default("pending"),
    urgent: boolean("urgent").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});
// --- Message reads (per-recipient) ---
// One row per (message, agent) that has read it. Broadcast/group messages are a
// single message row, so read-state MUST be tracked per recipient here rather
// than on the message's shared status.
export const a2axMessageReads = pgTable("a2ax_message_reads", {
    messageId: uuid("message_id")
        .notNull()
        .references(() => a2axMessages.id),
    agentId: uuid("agent_id").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
    primaryKey({ columns: [t.messageId, t.agentId] }),
    index("a2ax_message_reads_agent_idx").on(t.agentId),
]);
// --- Tasks ---
export const a2axTasks = pgTable("a2ax_tasks", {
    id: uuid("id").defaultRandom().primaryKey(),
    teamId: uuid("team_id").notNull(),
    channelId: text("channel_id").notNull(),
    requestorId: uuid("requestor_id").notNull(),
    assigneeId: uuid("assignee_id").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    state: a2axTaskState("state").notNull().default("submitted"),
    metadata: jsonb("metadata").$type(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});
// --- Agent Cards ---
export const a2axAgentCards = pgTable("a2ax_agent_cards", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    endpoint: text("endpoint").notNull(),
    capabilities: jsonb("capabilities")
        .$type()
        .notNull(),
    skills: jsonb("skills").$type().notNull().default([]),
    securitySchemes: jsonb("security_schemes").$type(),
    security: jsonb("security").$type(),
    signature: jsonb("signature").$type(),
    provider: jsonb("provider").$type(),
    metadata: jsonb("metadata").$type(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});
// --- Auth Tokens ---
export const a2axTokens = pgTable("a2ax_tokens", {
    token: text("token").primaryKey(),
    agentId: uuid("agent_id").notNull(),
    teamId: uuid("team_id").notNull(),
    scopes: jsonb("scopes").$type().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});
//# sourceMappingURL=drizzle-schema.js.map
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const agentStatus = pgEnum("agent_status", [
  "running",
  "paused",
  "errored",
  // T2: agent suspended mid-tick awaiting human approval of a destructive
  // tool call. Its conversation state is parked in agents.conversationState
  // and the pending calls live in pending_approvals.
  "awaiting_approval",
]);

// T2: lifecycle of a destructive tool call that needs human sign-off.
export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
]);

// ---------------------------------------------------------------------------
// a2ax enums + tables (agent-to-agent communication)
// ---------------------------------------------------------------------------

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

export const teams = pgTable("teams", {
  id: uuid("id").defaultRandom().primaryKey(),
  parentTeamId: uuid("parent_team_id"),
  name: text("name").notNull(),
  paused: boolean("paused").notNull().default(false),
  tickCount: integer("tick_count").notNull().default(0),
  metaAgentPrompt: text("meta_agent_prompt"),
  cofounderName: text("cofounder_name"),
  lastUserActiveAt: timestamp("last_user_active_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("teams_parent_idx").on(t.parentTeamId),
]);

export const agents = pgTable("agents", {
  id: uuid("id").defaultRandom().primaryKey(),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id),
  name: text("name").notNull(),
  role: text("role").notNull(),
  archetype: text("archetype").notNull(),
  tools: jsonb("tools").$type<string[]>().notNull().default([]),
  scheduleSeconds: integer("schedule_seconds").notNull(),
  initialPrompt: text("initial_prompt").notNull(),
  status: agentStatus("status").notNull().default("running"),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  inFlight: boolean("in_flight").notNull().default(false),
  // T2: serialized AgentSuspension (conversation + pending calls + actions +
  // round) parked here while status === "awaiting_approval". Null otherwise.
  // Opaque to the DB layer — the runner is the only code that reads its shape.
  conversationState: jsonb("conversation_state").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("agents_team_id_idx").on(t.teamId),
]);

// T2: one row per destructive tool call awaiting human approval. Created when
// an agent suspends; resolved (approved/rejected) from the team UI; consumed by
// the next tick, which feeds the decisions back into runAgent({ resume }).
export const pendingApprovals = pgTable("pending_approvals", {
  id: uuid("id").defaultRandom().primaryKey(),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  // The runner's tool_call id (PendingToolCall.id), matched on resume.
  toolCallId: text("tool_call_id").notNull(),
  toolName: text("tool_name").notNull(),
  // Raw JSON arguments string as the LLM emitted them (shown in the UI).
  toolArguments: text("tool_arguments").notNull(),
  status: approvalStatus("status").notNull().default("pending"),
  // Optional human note attached on rejection, surfaced to the LLM on resume.
  decisionNote: text("decision_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [
  index("pending_approvals_team_status_idx").on(t.teamId, t.status),
  index("pending_approvals_agent_idx").on(t.agentId),
]);

export const chatSessions = pgTable("chat_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => chatSessions.id),
  role: text("role", { enum: ["user", "assistant", "error"] }).notNull(),
  content: text("content").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- a2ax: Channels ---

export const a2axChannels = pgTable("a2ax_channels", {
  id: text("id").primaryKey(),
  teamId: uuid("team_id").notNull(),
  channelType: a2axChannelType("channel_type").notNull(),
  name: text("name"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- a2ax: Channel Members ---

export const a2axChannelMembers = pgTable("a2ax_channel_members", {
  channelId: text("channel_id")
    .notNull()
    .references(() => a2axChannels.id),
  agentId: uuid("agent_id").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- a2ax: Messages ---

export const a2axMessages = pgTable("a2ax_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  teamId: uuid("team_id").notNull(),
  channelType: a2axChannelType("channel_type").notNull(),
  channelId: text("channel_id").notNull(),
  fromAgentId: uuid("from_agent_id").notNull(),
  role: text("role").notNull().default("agent"),
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  parts: jsonb("parts").$type<unknown[]>(),
  artifacts: jsonb("artifacts").$type<unknown[]>(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  replyTo: uuid("reply_to"),
  status: a2axMessageStatus("status").notNull().default("pending"),
  urgent: boolean("urgent").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("a2ax_messages_team_created_idx").on(t.teamId, t.createdAt),
]);

// --- a2ax: Tasks ---

export const a2axTasks = pgTable("a2ax_tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  teamId: uuid("team_id").notNull(),
  channelId: text("channel_id").notNull(),
  requestorId: uuid("requestor_id").notNull(),
  assigneeId: uuid("assignee_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  state: a2axTaskState("state").notNull().default("submitted"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- a2ax: Agent Cards ---

export const a2axAgentCards = pgTable("a2ax_agent_cards", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  endpoint: text("endpoint").notNull(),
  capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull(),
  skills: jsonb("skills").$type<unknown[]>().notNull().default([]),
  securitySchemes: jsonb("security_schemes").$type<Record<string, unknown>>(),
  security: jsonb("security").$type<unknown[]>(),
  signature: jsonb("signature").$type<Record<string, unknown>>(),
  provider: jsonb("provider").$type<Record<string, unknown>>(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- a2ax: Auth Tokens ---

export const a2axTokens = pgTable("a2ax_tokens", {
  token: text("token").primaryKey(),
  agentId: uuid("agent_id").notNull(),
  teamId: uuid("team_id").notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// ApiToolConfig: shape of .simple-harmonic/skills/<name>.json config field.
// Kept here as a shared type; no longer backed by a DB table.
// ---------------------------------------------------------------------------

export interface ApiToolConfig {
  baseUrl: string;
  connectorKey: string;
  authHeader?: string;
  authPrefix?: string;
  allowedMethods: string[];
  defaultHeaders?: Record<string, string>;
  pathPrefix?: string;
}

export const actionLog = pgTable("action_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  metaAgentApprovalId: text("meta_agent_approval_id"),
  actionType: text("action_type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  executedAt: timestamp("executed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("action_log_agent_executed_idx").on(t.agentId, t.executedAt),
]);

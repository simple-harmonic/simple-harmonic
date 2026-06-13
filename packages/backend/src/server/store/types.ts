// ---------------------------------------------------------------------------
// Row shapes for the JSON file store.
//
// These plain interfaces replace the Drizzle `$inferSelect` types that used to
// double as the canonical row types across the backend. Field names, optionality
// and `Date` vs `string` match the old Postgres rows exactly so call sites and
// API responses are unchanged. `*At` fields are real `Date`s in memory (the
// store revives them from ISO strings on read); opaque JSON blobs (payload,
// metadata, data, conversationState, outputContract) stay plain objects.
// ---------------------------------------------------------------------------

export type AgentStatus = "running" | "paused" | "errored" | "awaiting_approval";
export type ApprovalStatus = "pending" | "approved" | "rejected";
export type AppEventSeverity = "info" | "warning" | "error";
export type AppEventLevel = "agent" | "team" | "tool" | "infra";
export type PlatformStatusValue = "healthy" | "degraded" | "maintenance";

export interface Team {
  id: string;
  parentTeamId: string | null;
  name: string;
  goal: string | null;
  paused: boolean;
  tickCount: number;
  metaAgentPrompt: string | null;
  cofounderName: string | null;
  telemetryEnabled: boolean;
  lastUserActiveAt: Date;
  createdAt: Date;
}

export interface Agent {
  id: string;
  teamId: string;
  name: string;
  role: string;
  archetype: string;
  tools: string[];
  scheduleSeconds: number;
  initialPrompt: string;
  outputContract: Record<string, unknown> | null;
  status: AgentStatus;
  nextRunAt: Date | null;
  inFlight: boolean;
  conversationState: Record<string, unknown> | null;
  createdAt: Date;
}

export interface PendingApproval {
  id: string;
  teamId: string;
  agentId: string;
  toolCallId: string;
  toolName: string;
  toolArguments: string;
  status: ApprovalStatus;
  decisionNote: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface ActionLogEntry {
  id: string;
  agentId: string;
  metaAgentApprovalId: string | null;
  actionType: string;
  payload: Record<string, unknown>;
  executedAt: Date;
}

export interface AppEvent {
  id: string;
  teamId: string | null;
  agentId: string | null;
  severity: AppEventSeverity;
  level: AppEventLevel;
  source: string;
  message: string;
  metadata: Record<string, unknown> | null;
  acknowledgedAt: Date | null;
  createdAt: Date;
}

export interface PlatformStatus {
  id: number;
  status: PlatformStatusValue;
  message: string | null;
  updatedAt: Date;
}

export interface AgentTraceEvent {
  id: string;
  teamId: string;
  agentId: string;
  tickId: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  emittedAt: Date;
  createdAt: Date;
}

export interface LlmSpendEntry {
  id: string;
  teamId: string | null;
  agentId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  day: string; // UTC YYYY-MM-DD
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// ApiToolConfig: shape of .simple-harmonic/skills/<name>.json config field.
// Previously declared in db/schema.ts; kept here as the shared type now that
// the schema file is gone. No longer backed by any table.
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

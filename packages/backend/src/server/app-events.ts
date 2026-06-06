// ---------------------------------------------------------------------------
// App event emitter -- the feedback loop for dogfooding.
//
// Captures errors, warnings, and health signals into the app_events table.
// Agents see agent/team-level events via the health context injected into
// their tick prompt, or by calling the observe_app tool directly.
//
// Levels:
//   agent  -- single agent errors/issues. Agents self-correct.
//   team   -- team composition, goal, coordination. Lead/Harmon corrects.
//   tool   -- tool bugs, missing capability. Agents see it, founder fixes.
//   infra  -- platform, DB, deploy, framework. Founder only. Never agent-visible.
//
// Guardrails:
//   - Agents cannot emit infra events (hard-capped at "tool" from tool context).
//   - Rate limited: 50 events per agent per hour, then one "rate_limited" event.
//   - PII scrubbing: tokens, emails, keys stripped before persistence.
//   - Telemetry check: tool/infra events skipped if team has telemetry off.
// ---------------------------------------------------------------------------

import { db } from "./db";
import { appEvents, teams } from "./db/schema";
import { desc, eq, and, gte, isNull, ne, type SQL } from "drizzle-orm";

export type AppEventLevel = "agent" | "team" | "tool" | "infra";

export interface AppEvent {
  severity: "info" | "warning" | "error";
  level?: AppEventLevel;
  source: string;
  message: string;
  teamId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Rate limiting: 50 events per agent per hour
// ---------------------------------------------------------------------------

const RATE_LIMIT = 50;
const RATE_WINDOW_MS = 3600_000;
const rateCounts = new Map<string, { count: number; windowStart: number; limited: boolean }>();

function checkRateLimit(agentId: string | undefined): boolean {
  if (!agentId) return true; // system events aren't rate-limited
  const now = Date.now();
  let entry = rateCounts.get(agentId);

  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    entry = { count: 0, windowStart: now, limited: false };
    rateCounts.set(agentId, entry);
  }

  entry.count++;

  if (entry.count > RATE_LIMIT) {
    if (!entry.limited) {
      // Emit one final "rate limited" event, then silence
      entry.limited = true;
      return true; // allow this one through (the rate_limited event)
    }
    return false; // drop
  }
  return true;
}

// ---------------------------------------------------------------------------
// PII scrubbing: strip tokens, emails, keys before persistence
// ---------------------------------------------------------------------------

const PII_PATTERNS = [
  // API keys and tokens (common prefixes)
  /\b(sk-[a-zA-Z0-9_-]{20,})\b/g,
  /\b(ghp_[a-zA-Z0-9]{36,})\b/g,
  /\b(gho_[a-zA-Z0-9]{36,})\b/g,
  /\b(xoxb-[a-zA-Z0-9-]+)\b/g,
  /\b(xoxp-[a-zA-Z0-9-]+)\b/g,
  /\b(Bearer\s+[a-zA-Z0-9._-]{20,})\b/gi,
  // Generic long secret-looking strings (base64-ish, 32+ chars after = or :)
  /(?<=[=:]\s*)[A-Za-z0-9+/]{32,}={0,2}\b/g,
  // Email addresses
  /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
];

function scrubPII(message: string): string {
  let scrubbed = message;
  for (const pattern of PII_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, "[REDACTED]");
  }
  return scrubbed;
}

// ---------------------------------------------------------------------------
// Telemetry check cache (avoid DB hit on every emit)
// ---------------------------------------------------------------------------

const telemetryCache = new Map<string, { enabled: boolean; checkedAt: number }>();
const TELEMETRY_CACHE_TTL_MS = 60_000; // 1 minute

async function isTelemetryEnabled(teamId: string): Promise<boolean> {
  const cached = telemetryCache.get(teamId);
  if (cached && Date.now() - cached.checkedAt < TELEMETRY_CACHE_TTL_MS) {
    return cached.enabled;
  }
  try {
    const d = db();
    const team = await d.query.teams.findFirst({
      where: eq(teams.id, teamId),
      columns: { telemetryEnabled: true },
    });
    const enabled = team?.telemetryEnabled ?? true;
    telemetryCache.set(teamId, { enabled, checkedAt: Date.now() });
    return enabled;
  } catch {
    return true; // fail open: allow events through if DB check fails
  }
}

/** Clear the telemetry cache for a team (call when the setting changes). */
export function invalidateTelemetryCache(teamId: string): void {
  telemetryCache.delete(teamId);
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

/**
 * Write an event to the app_events table. Fire-and-forget.
 *
 * Guardrails:
 *  - Rate limited per agent (50/hr)
 *  - PII scrubbed from message
 *  - tool/infra events skipped if team has telemetry off
 *  - infra events always get teamId=null (they're platform-wide)
 */
export function emitAppEvent(event: AppEvent): void {
  try {
    const level = event.level ?? "agent";
    const message = scrubPII(event.message);

    // Rate limiting
    if (!checkRateLimit(event.agentId)) return;

    // If rate limited, replace the message
    const entry = event.agentId ? rateCounts.get(event.agentId) : undefined;
    const isRateLimitEvent = entry?.limited && entry.count === RATE_LIMIT + 1;
    const finalMessage = isRateLimitEvent
      ? `Rate limited: agent exceeded ${RATE_LIMIT} events/hour. Further events silenced until the window resets.`
      : message;

    // Infra events are always teamId=null (platform-wide)
    const teamId = level === "infra" ? null : (event.teamId ?? null);

    // Telemetry check for tool/infra events
    if ((level === "tool" || level === "infra") && event.teamId) {
      isTelemetryEnabled(event.teamId).then((enabled) => {
        if (!enabled) return;
        doInsert(level, teamId, event, finalMessage);
      }).catch(() => {});
      return;
    }

    doInsert(level, teamId, event, finalMessage);
  } catch {
    // DB not initialized yet (e.g., during startup). Silently skip.
  }
}

function doInsert(
  level: AppEventLevel,
  teamId: string | null,
  event: AppEvent,
  message: string,
): void {
  try {
    const d = db();
    d.insert(appEvents)
      .values({
        severity: event.severity,
        level,
        source: event.source,
        message,
        teamId,
        agentId: event.agentId ?? null,
        metadata: event.metadata ?? null,
      })
      .then(() => {})
      .catch((err) => {
        console.error("[app-events] Failed to write event:", err instanceof Error ? err.message : err);
      });
  } catch {
    // Silently skip
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface EventQuery {
  teamId?: string;
  severity?: "info" | "warning" | "error";
  level?: AppEventLevel;
  source?: string;
  since?: Date;
  limit?: number;
  /** If true, include infra events (founder report). Default false. */
  includeInfra?: boolean;
  /** If true, only return unacknowledged events. For founder report. */
  unacknowledgedOnly?: boolean;
}

/**
 * Query recent app events. Used by the observe_app tool and tick prompt builder.
 *
 * By default EXCLUDES infra-level events (agents should never see them).
 * Pass includeInfra: true for the founder report.
 */
export async function queryAppEvents(query: EventQuery = {}): Promise<Array<typeof appEvents.$inferSelect>> {
  const d = db();
  const conditions: SQL[] = [];

  if (query.teamId) {
    conditions.push(eq(appEvents.teamId, query.teamId));
  }
  if (query.severity) {
    conditions.push(eq(appEvents.severity, query.severity));
  }
  if (query.level) {
    conditions.push(eq(appEvents.level, query.level));
  }
  if (query.source) {
    conditions.push(eq(appEvents.source, query.source));
  }
  if (query.since) {
    conditions.push(gte(appEvents.createdAt, query.since));
  }

  // Default: exclude infra events from agent-facing queries
  if (!query.includeInfra) {
    conditions.push(ne(appEvents.level, "infra"));
  }

  if (query.unacknowledgedOnly) {
    conditions.push(isNull(appEvents.acknowledgedAt));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = query.limit ?? 20;

  return d.query.appEvents.findMany({
    where,
    orderBy: [desc(appEvents.createdAt)],
    limit,
  });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format events for injection into an agent's tick prompt.
 * Filters out infra events (they should never reach agents).
 * Tool events older than 24h are replaced with a summary line.
 */
export function formatEventsForPrompt(events: Array<typeof appEvents.$inferSelect>): string | undefined {
  if (events.length === 0) return undefined;

  const now = Date.now();
  const TOOL_EXPIRY_MS = 24 * 3600_000;

  const lines: string[] = [];
  let expiredToolCount = 0;

  for (const e of events) {
    // Never show infra events to agents
    if (e.level === "infra") continue;

    // Tool events older than 24h get summarized
    if (e.level === "tool" && now - e.createdAt.getTime() > TOOL_EXPIRY_MS) {
      expiredToolCount++;
      continue;
    }

    const ts = e.createdAt.toISOString().slice(11, 19);
    const sev = e.severity === "error" ? "ERROR" : e.severity === "warning" ? "WARN" : "INFO";
    const lvl = e.level ? ` [${e.level}]` : "";
    const agent = e.agentId ? ` (agent ${e.agentId.slice(0, 8)})` : "";
    lines.push(`[${ts}] ${sev}${lvl} [${e.source}]${agent}: ${e.message}`);
  }

  if (expiredToolCount > 0) {
    lines.push(`${expiredToolCount} known tool issue(s) (under review)`);
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
}

// ---------------------------------------------------------------------------
// Platform status
// ---------------------------------------------------------------------------

export type PlatformStatusValue = "healthy" | "degraded" | "maintenance";

export interface PlatformStatusRow {
  status: PlatformStatusValue;
  message: string | null;
  updatedAt: Date;
}

/** Get current platform status. Returns "healthy" if no row exists. */
export async function getPlatformStatus(): Promise<PlatformStatusRow> {
  try {
    const d = db();
    const rows = await d.query.platformStatus.findMany({ limit: 1 });
    if (rows.length > 0) {
      return rows[0] as PlatformStatusRow;
    }
  } catch {
    // Table may not exist yet
  }
  return { status: "healthy", message: null, updatedAt: new Date() };
}

/** Format platform status for tick prompt injection. Returns undefined if healthy. */
export function formatPlatformStatusForPrompt(ps: PlatformStatusRow): string | undefined {
  if (ps.status === "healthy") return undefined;
  const label = ps.status === "degraded" ? "DEGRADED" : "MAINTENANCE";
  const msg = ps.message ? `: ${ps.message}` : "";
  return `Platform status: ${label}${msg}. Reduce non-essential work and avoid retrying failed operations.`;
}

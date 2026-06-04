import { NextResponse } from "next/server";
import { Pool } from "pg";
import { getConfig, setConfig } from "@simple-harmonic/backend/server/config";

/** Extract a useful message from pg errors */
function pgError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  const code = (err as { code?: string }).code;
  if (code === "ECONNREFUSED") return "Connection refused. Is PostgreSQL running?";
  if (code === "ENOTFOUND") return "Host not found. Check your connection URL.";
  if (code === "ETIMEDOUT") return "Connection timed out.";
  if (code) return `pg error code: ${code}`;
  return String(err);
}

/**
 * SQL to create all tables. Source of truth is packages/backend/src/server/db/schema.ts.
 * This is a CREATE IF NOT EXISTS version so it's safe to run repeatedly.
 */
const SCHEMA_SQL = `
-- Enums
DO $$ BEGIN
  CREATE TYPE "agent_status" AS ENUM ('running', 'paused', 'errored', 'awaiting_approval');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "approval_status" AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "a2ax_channel_type" AS ENUM ('direct', 'broadcast', 'group', 'task');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "a2ax_message_status" AS ENUM ('pending', 'delivered', 'read', 'expired');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "a2ax_task_state" AS ENUM ('submitted', 'accepted', 'working', 'input_required', 'completed', 'failed', 'canceled', 'rejected');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Teams
CREATE TABLE IF NOT EXISTS "teams" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "parent_team_id" uuid REFERENCES "teams"("id"),
  "name" text NOT NULL,
  "paused" boolean NOT NULL DEFAULT false,
  "tick_count" integer NOT NULL DEFAULT 0,
  "meta_agent_prompt" text,
  "cofounder_name" text,
  "goal" text,
  "last_user_active_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "teams_parent_idx" ON "teams" ("parent_team_id");

-- Agents
CREATE TABLE IF NOT EXISTS "agents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" uuid NOT NULL REFERENCES "teams"("id"),
  "name" text NOT NULL,
  "role" text NOT NULL,
  "archetype" text NOT NULL,
  "tools" jsonb NOT NULL DEFAULT '[]',
  "schedule_seconds" integer NOT NULL,
  "initial_prompt" text NOT NULL,
  "output_contract" jsonb,
  "status" "agent_status" NOT NULL DEFAULT 'running',
  "next_run_at" timestamp with time zone,
  "in_flight" boolean NOT NULL DEFAULT false,
  "conversation_state" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "agents_team_id_idx" ON "agents" ("team_id");

-- Pending approvals
CREATE TABLE IF NOT EXISTS "pending_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" uuid NOT NULL REFERENCES "teams"("id"),
  "agent_id" uuid NOT NULL REFERENCES "agents"("id"),
  "tool_call_id" text NOT NULL,
  "tool_name" text NOT NULL,
  "tool_arguments" text NOT NULL,
  "status" "approval_status" NOT NULL DEFAULT 'pending',
  "decision_note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "pending_approvals_team_status_idx" ON "pending_approvals" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "pending_approvals_agent_idx" ON "pending_approvals" ("agent_id");

-- Chat
CREATE TABLE IF NOT EXISTS "chat_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" uuid NOT NULL REFERENCES "teams"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "chat_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL REFERENCES "chat_sessions"("id"),
  "role" text NOT NULL,
  "content" text NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- a2ax
CREATE TABLE IF NOT EXISTS "a2ax_channels" (
  "id" text PRIMARY KEY,
  "team_id" uuid NOT NULL,
  "channel_type" "a2ax_channel_type" NOT NULL,
  "name" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "a2ax_channel_members" (
  "channel_id" text NOT NULL REFERENCES "a2ax_channels"("id"),
  "agent_id" uuid NOT NULL,
  "joined_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "a2ax_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" uuid NOT NULL,
  "channel_type" "a2ax_channel_type" NOT NULL,
  "channel_id" text NOT NULL,
  "from_agent_id" uuid NOT NULL,
  "role" text NOT NULL DEFAULT 'agent',
  "kind" text NOT NULL,
  "content" text NOT NULL,
  "parts" jsonb,
  "artifacts" jsonb,
  "payload" jsonb,
  "reply_to" uuid,
  "status" "a2ax_message_status" NOT NULL DEFAULT 'pending',
  "urgent" boolean NOT NULL DEFAULT false,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "a2ax_messages_team_created_idx" ON "a2ax_messages" ("team_id", "created_at");

CREATE TABLE IF NOT EXISTS "a2ax_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" uuid NOT NULL,
  "channel_id" text NOT NULL,
  "requestor_id" uuid NOT NULL,
  "assignee_id" uuid NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "state" "a2ax_task_state" NOT NULL DEFAULT 'submitted',
  "metadata" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "a2ax_agent_cards" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "description" text,
  "endpoint" text NOT NULL,
  "capabilities" jsonb NOT NULL,
  "skills" jsonb NOT NULL DEFAULT '[]',
  "security_schemes" jsonb,
  "security" jsonb,
  "signature" jsonb,
  "provider" jsonb,
  "metadata" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "a2ax_tokens" (
  "token" text PRIMARY KEY,
  "agent_id" uuid NOT NULL,
  "team_id" uuid NOT NULL,
  "scopes" jsonb NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Action log
CREATE TABLE IF NOT EXISTS "action_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id" uuid NOT NULL REFERENCES "agents"("id"),
  "meta_agent_approval_id" text,
  "action_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "executed_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "action_log_agent_executed_idx" ON "action_log" ("agent_id", "executed_at");

-- App events (feedback loop for dogfooding)
DO $$ BEGIN
  CREATE TYPE "app_event_severity" AS ENUM ('info', 'warning', 'error');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "app_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" uuid,
  "agent_id" uuid,
  "severity" "app_event_severity" NOT NULL DEFAULT 'info',
  "source" text NOT NULL,
  "message" text NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "app_events_created_idx" ON "app_events" ("created_at");
CREATE INDEX IF NOT EXISTS "app_events_team_idx" ON "app_events" ("team_id", "created_at");

-- Add columns that may be missing on older databases
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "parent_team_id" uuid REFERENCES "teams"("id");
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "goal" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "output_contract" jsonb;
`;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const steps: string[] = [];

  const dbUrl =
    (typeof body.databaseUrl === "string" && body.databaseUrl) || getConfig().databaseUrl;
  if (!dbUrl) {
    return NextResponse.json({ ok: false, error: "No database URL provided", steps });
  }

  if (body.databaseUrl) {
    setConfig({ databaseUrl: body.databaseUrl });
    steps.push("Saved database URL to config");
  }

  let parsed: URL;
  try {
    parsed = new URL(dbUrl);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid database URL", steps });
  }

  const dbName = parsed.pathname.replace(/^\//, "");
  if (!dbName) {
    return NextResponse.json({ ok: false, error: "No database name in URL", steps });
  }

  // Step 1: Create database if needed
  const adminUrl = new URL(dbUrl);
  adminUrl.pathname = "/postgres";

  const adminPool = new Pool({
    connectionString: adminUrl.toString(),
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  try {
    const client = await adminPool.connect();
    steps.push(`Connected to ${parsed.host}`);
    try {
      const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
      if (exists.rowCount === 0) {
        const safeName = dbName.replace(/[^a-zA-Z0-9_-]/g, "");
        await client.query(`CREATE DATABASE "${safeName}"`);
        steps.push(`Created database "${safeName}"`);
      } else {
        steps.push(`Database "${dbName}" already exists`);
      }
    } finally {
      client.release();
    }
  } catch (err) {
    await adminPool.end().catch(() => {});
    return NextResponse.json({ ok: false, error: pgError(err), steps });
  }
  await adminPool.end().catch(() => {});

  // Step 2: Create/sync tables via raw SQL
  const appPool = new Pool({
    connectionString: dbUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  try {
    const client = await appPool.connect();
    try {
      await client.query(SCHEMA_SQL);
      steps.push("Schema applied successfully");
    } finally {
      client.release();
    }
  } catch (err) {
    await appPool.end().catch(() => {});
    return NextResponse.json({
      ok: false,
      error: `Schema setup failed: ${pgError(err)}`.slice(0, 500),
      steps,
    });
  }

  // Step 3: Verify
  try {
    const client = await appPool.connect();
    const tables = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const tableNames = tables.rows.map((r) => r.tablename as string);
    client.release();
    steps.push(`Tables: ${tableNames.join(", ") || "none"}`);
  } catch {
    steps.push("Warning: could not verify tables");
  }
  await appPool.end().catch(() => {});

  return NextResponse.json({ ok: true, steps });
}

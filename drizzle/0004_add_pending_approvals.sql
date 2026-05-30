-- T2: human approval gate for destructive tool calls.
--
-- Hand-written (drizzle-kit's journal is out of sync after the monorepo
-- restructure; see TODOS "repair drizzle-kit migration state"). Mirrors the
-- schema additions in packages/backend/src/server/db/schema.ts.

-- New agent status: parked mid-tick awaiting approval.
ALTER TYPE "agent_status" ADD VALUE IF NOT EXISTS 'awaiting_approval';

-- Lifecycle of a pending destructive tool call.
DO $$ BEGIN
  CREATE TYPE "approval_status" AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Serialized AgentSuspension parked here while status = 'awaiting_approval'.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "conversation_state" jsonb;

-- One row per destructive tool call awaiting a human decision.
CREATE TABLE IF NOT EXISTS "pending_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "tool_call_id" text NOT NULL,
  "tool_name" text NOT NULL,
  "tool_arguments" text NOT NULL,
  "status" "approval_status" DEFAULT 'pending' NOT NULL,
  "decision_note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone
);

DO $$ BEGIN
  ALTER TABLE "pending_approvals"
    ADD CONSTRAINT "pending_approvals_team_id_teams_id_fk"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id");
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "pending_approvals"
    ADD CONSTRAINT "pending_approvals_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id");
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "pending_approvals_team_status_idx"
  ON "pending_approvals" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "pending_approvals_agent_idx"
  ON "pending_approvals" ("agent_id");

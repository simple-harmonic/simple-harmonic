-- Drop old agent_messages table (superseded by a2ax)
DROP TABLE IF EXISTS "agent_messages";
--> statement-breakpoint

-- a2ax enums
DO $$ BEGIN
  CREATE TYPE "a2ax_channel_type" AS ENUM ('direct', 'broadcast', 'group', 'task');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "a2ax_message_status" AS ENUM ('pending', 'delivered', 'read', 'expired');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "a2ax_task_state" AS ENUM ('submitted', 'accepted', 'working', 'input_required', 'completed', 'failed', 'canceled', 'rejected');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- a2ax: Channels
CREATE TABLE "a2ax_channels" (
  "id" text PRIMARY KEY NOT NULL,
  "team_id" uuid NOT NULL,
  "channel_type" "a2ax_channel_type" NOT NULL,
  "name" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- a2ax: Channel Members
CREATE TABLE "a2ax_channel_members" (
  "channel_id" text NOT NULL,
  "agent_id" uuid NOT NULL,
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "a2ax_channel_members" ADD CONSTRAINT "a2ax_channel_members_channel_id_a2ax_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."a2ax_channels"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- a2ax: Messages
CREATE TABLE "a2ax_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL,
  "channel_type" "a2ax_channel_type" NOT NULL,
  "channel_id" text NOT NULL,
  "from_agent_id" uuid NOT NULL,
  "role" text DEFAULT 'agent' NOT NULL,
  "kind" text NOT NULL,
  "content" text NOT NULL,
  "parts" jsonb,
  "artifacts" jsonb,
  "payload" jsonb,
  "reply_to" uuid,
  "status" "a2ax_message_status" DEFAULT 'pending' NOT NULL,
  "urgent" boolean DEFAULT false NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- a2ax: Tasks
CREATE TABLE "a2ax_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL,
  "channel_id" text NOT NULL,
  "requestor_id" uuid NOT NULL,
  "assignee_id" uuid NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "state" "a2ax_task_state" DEFAULT 'submitted' NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- a2ax: Agent Cards
CREATE TABLE "a2ax_agent_cards" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "endpoint" text NOT NULL,
  "capabilities" jsonb NOT NULL,
  "skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "security_schemes" jsonb,
  "security" jsonb,
  "signature" jsonb,
  "provider" jsonb,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- a2ax: Auth Tokens
CREATE TABLE "a2ax_tokens" (
  "token" text PRIMARY KEY NOT NULL,
  "agent_id" uuid NOT NULL,
  "team_id" uuid NOT NULL,
  "scopes" jsonb NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

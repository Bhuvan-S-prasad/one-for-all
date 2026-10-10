CREATE TYPE "public"."routine_kind" AS ENUM('task', 'check');--> statement-breakpoint
-- Existing chats count as read now, so nothing old shows as unread (M5.11).
ALTER TABLE "thread_member" ADD COLUMN "last_read_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "thread_member" ALTER COLUMN "last_read_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "proactive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "request" text;--> statement-breakpoint
ALTER TABLE "routine" ADD COLUMN "kind" "routine_kind" DEFAULT 'task' NOT NULL;
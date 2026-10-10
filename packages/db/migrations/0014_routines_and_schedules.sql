CREATE TYPE "public"."routine_status" AS ENUM('active', 'paused');--> statement-breakpoint
CREATE TYPE "public"."schedule_kind" AS ENUM('task', 'reminder');--> statement-breakpoint
CREATE TYPE "public"."schedule_status" AS ENUM('pending', 'done', 'cancelled', 'failed');--> statement-breakpoint
ALTER TYPE "public"."run_trigger" ADD VALUE 'schedule';--> statement-breakpoint
CREATE TABLE "routine" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"name" text NOT NULL,
	"instructions" text NOT NULL,
	"cron" text NOT NULL,
	"time_zone" text NOT NULL,
	"status" "routine_status" DEFAULT 'active' NOT NULL,
	"paused_reason" text,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "routine_paused_reason_ck" CHECK ("routine"."paused_reason" is null or "routine"."paused_reason" in ('person', 'inactive'))
);
--> statement-breakpoint
CREATE TABLE "schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"run_id" uuid,
	"key" text NOT NULL,
	"kind" "schedule_kind" NOT NULL,
	"content" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" "schedule_status" DEFAULT 'pending' NOT NULL,
	"tainted" boolean DEFAULT false NOT NULL,
	"fired_run_id" uuid,
	"fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "time_zone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "routine_id" uuid;--> statement-breakpoint
ALTER TABLE "routine" ADD CONSTRAINT "routine_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine" ADD CONSTRAINT "routine_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine" ADD CONSTRAINT "routine_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agent"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine" ADD CONSTRAINT "routine_thread_fk" FOREIGN KEY ("workspace_id","thread_id") REFERENCES "public"."thread"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agent"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_thread_fk" FOREIGN KEY ("workspace_id","thread_id") REFERENCES "public"."thread"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_due_idx" ON "routine" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "routine_workspace_agent_idx" ON "routine" USING btree ("workspace_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_workspace_key_uq" ON "schedule" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "schedule_agent_status_idx" ON "schedule" USING btree ("workspace_id","agent_id","status","due_at");--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_routine_id_routine_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routine"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_routine_idx" ON "run" USING btree ("routine_id","created_at");--> statement-breakpoint
-- Row-level security (hard rule 3): rows of the current workspace only.
ALTER TABLE "routine" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "routine" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "routine"
  USING (workspace_id = ofa_current_workspace_id())
  WITH CHECK (workspace_id = ofa_current_workspace_id());
--> statement-breakpoint
ALTER TABLE "schedule" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "schedule" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "schedule"
  USING (workspace_id = ofa_current_workspace_id())
  WITH CHECK (workspace_id = ofa_current_workspace_id());

CREATE TYPE "public"."discussion_status" AS ENUM('active', 'closing', 'done', 'stopped', 'failed');--> statement-breakpoint
ALTER TYPE "public"."run_trigger" ADD VALUE 'discussion';--> statement-breakpoint
CREATE TABLE "discussion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"question_message_id" uuid NOT NULL,
	"started_by_run_id" uuid,
	"coordinator_agent_id" uuid NOT NULL,
	"member_ids" uuid[] NOT NULL,
	"rounds" integer NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"status" "discussion_status" DEFAULT 'active' NOT NULL,
	"closing_message_id" uuid,
	"tainted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "discussion_rounds_ck" CHECK ("discussion"."rounds" between 1 and 3 and "discussion"."round" between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE "discussion_turn" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"discussion_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"position" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discussion" ADD CONSTRAINT "discussion_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion" ADD CONSTRAINT "discussion_thread_fk" FOREIGN KEY ("workspace_id","thread_id") REFERENCES "public"."thread"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion" ADD CONSTRAINT "discussion_coordinator_fk" FOREIGN KEY ("workspace_id","coordinator_agent_id") REFERENCES "public"."agent"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion" ADD CONSTRAINT "discussion_question_fk" FOREIGN KEY ("question_message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_turn" ADD CONSTRAINT "discussion_turn_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_turn" ADD CONSTRAINT "discussion_turn_discussion_id_discussion_id_fk" FOREIGN KEY ("discussion_id") REFERENCES "public"."discussion"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_turn" ADD CONSTRAINT "discussion_turn_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."run"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discussion_open_thread_uq" ON "discussion" USING btree ("thread_id") WHERE "discussion"."status" in ('active', 'closing');--> statement-breakpoint
CREATE INDEX "discussion_thread_created_idx" ON "discussion" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "discussion_turn_run_uq" ON "discussion_turn" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "discussion_turn_discussion_idx" ON "discussion_turn" USING btree ("discussion_id","created_at");--> statement-breakpoint
-- Row-level security (hard rule 3): rows of the current workspace only.
ALTER TABLE "discussion" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "discussion" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "discussion"
  USING (workspace_id = ofa_current_workspace_id())
  WITH CHECK (workspace_id = ofa_current_workspace_id());
--> statement-breakpoint
ALTER TABLE "discussion_turn" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "discussion_turn" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "discussion_turn"
  USING (workspace_id = ofa_current_workspace_id())
  WITH CHECK (workspace_id = ofa_current_workspace_id());

CREATE TYPE "public"."episode_outcome" AS ENUM('done', 'stopped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."skill_source" AS ENUM('person', 'agent', 'consolidation');--> statement-breakpoint
CREATE TYPE "public"."skill_status" AS ENUM('active', 'proposed', 'archived');--> statement-breakpoint
CREATE TABLE "episode" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" text,
	"run_id" uuid NOT NULL,
	"thread_id" uuid,
	"summary" text NOT NULL,
	"outcome" "episode_outcome" NOT NULL,
	"tainted" boolean DEFAULT false NOT NULL,
	"summary_search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', summary)) STORED,
	"consolidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"steps" text[] NOT NULL,
	"status" "skill_status" DEFAULT 'active' NOT NULL,
	"source" "skill_source" NOT NULL,
	"source_run_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "memory_consolidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "episode" ADD CONSTRAINT "episode_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode" ADD CONSTRAINT "episode_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode" ADD CONSTRAINT "episode_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agent"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode" ADD CONSTRAINT "episode_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."run"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agent"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_source_run_fk" FOREIGN KEY ("workspace_id","source_run_id") REFERENCES "public"."run"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "episode_run_uq" ON "episode" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "episode_workspace_agent_idx" ON "episode" USING btree ("workspace_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "episode_summary_search_idx" ON "episode" USING gin ("summary_search");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_workspace_slug_uq" ON "skill" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "skill_workspace_agent_idx" ON "skill" USING btree ("workspace_id","agent_id","status");--> statement-breakpoint
-- Row-level security (hard rule 3): rows of the current workspace only.
ALTER TABLE "skill" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "skill" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "skill"
  USING (workspace_id = ofa_current_workspace_id())
  WITH CHECK (workspace_id = ofa_current_workspace_id());
--> statement-breakpoint
ALTER TABLE "episode" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "episode" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "episode"
  USING (workspace_id = ofa_current_workspace_id())
  WITH CHECK (workspace_id = ofa_current_workspace_id());

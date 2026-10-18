CREATE TABLE "thread_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"state" jsonb NOT NULL,
	"run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "thread_state" ADD CONSTRAINT "thread_state_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_state" ADD CONSTRAINT "thread_state_thread_fk" FOREIGN KEY ("workspace_id","thread_id") REFERENCES "public"."thread"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_state" ADD CONSTRAINT "thread_state_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agent"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "thread_state_thread_agent_uq" ON "thread_state" USING btree ("thread_id","agent_id");--> statement-breakpoint
-- Row-level security (hard rule 3): rows of the current workspace only.
ALTER TABLE "thread_state" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "thread_state" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "thread_state"
  USING (workspace_id = ofa_current_workspace_id())
  WITH CHECK (workspace_id = ofa_current_workspace_id());

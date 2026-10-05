CREATE TABLE "approval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool" text NOT NULL,
	"args" jsonb NOT NULL,
	"summary" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verdict" "policy_verdict" NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approval_run_call_uq" UNIQUE("run_id","tool_call_id"),
	CONSTRAINT "approval_status_ck" CHECK ("approval"."status" in ('pending', 'approved', 'rejected', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."run"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agent"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_workspace_status_idx" ON "approval" USING btree ("workspace_id","status","created_at");--> statement-breakpoint

-- Row-level security (hard rule 3): rows of the current workspace only.
ALTER TABLE "approval" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "approval" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "approval"
  USING (workspace_id = ofa_current_workspace_id())
  WITH CHECK (workspace_id = ofa_current_workspace_id());

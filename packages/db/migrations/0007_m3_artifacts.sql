CREATE TABLE "artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"untrusted" boolean NOT NULL,
	"content" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_run_key_uq" UNIQUE("run_id","key"),
	CONSTRAINT "artifact_kind_ck" CHECK ("artifact"."kind" in ('output', 'file')),
	CONSTRAINT "artifact_size_ck" CHECK ("artifact"."size" >= 0 and "artifact"."size" <= 10485760)
);
--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."run"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agent"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_workspace_run_idx" ON "artifact" USING btree ("workspace_id","run_id");--> statement-breakpoint

-- Row-level security (hard rule 3): rows of the current workspace only.
ALTER TABLE "artifact" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "artifact" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "artifact"
  USING (workspace_id = ofa_current_workspace_id())
  WITH CHECK (workspace_id = ofa_current_workspace_id());

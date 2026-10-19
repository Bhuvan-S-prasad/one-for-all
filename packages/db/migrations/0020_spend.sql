CREATE TABLE "spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"tool" text NOT NULL,
	"cost_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_cost_ck" CHECK ("spend"."cost_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "spend_cap_cents" integer;--> statement-breakpoint
ALTER TABLE "spend" ADD CONSTRAINT "spend_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spend_workspace_key_uq" ON "spend" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "spend_workspace_created_idx" ON "spend" USING btree ("workspace_id","created_at");--> statement-breakpoint
-- Row-level security (hard rule 3): rows of the current workspace only.
ALTER TABLE "spend" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "spend" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "spend"
  USING (workspace_id = ofa_current_workspace_id())
  WITH CHECK (workspace_id = ofa_current_workspace_id());

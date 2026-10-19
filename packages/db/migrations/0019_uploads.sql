CREATE TABLE "upload" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"uploaded_by" text,
	"message_id" uuid,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"content" "bytea",
	"blob_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_size_ck" CHECK ("upload"."size" >= 0 and ("upload"."blob_key" is not null or "upload"."size" <= 10485760)),
	CONSTRAINT "upload_bytes_ck" CHECK (("upload"."content" is null) <> ("upload"."blob_key" is null))
);
--> statement-breakpoint
ALTER TABLE "upload" ADD CONSTRAINT "upload_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload" ADD CONSTRAINT "upload_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload" ADD CONSTRAINT "upload_thread_fk" FOREIGN KEY ("workspace_id","thread_id") REFERENCES "public"."thread"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "upload_thread_idx" ON "upload" USING btree ("workspace_id","thread_id");--> statement-breakpoint
-- Row-level security (hard rule 3): rows of the current workspace only.
ALTER TABLE "upload" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "upload" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "upload"
  USING (workspace_id = ofa_current_workspace_id())
  WITH CHECK (workspace_id = ofa_current_workspace_id());

CREATE TYPE "public"."grant_mode" AS ENUM('auto', 'approve', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."memory_kind" AS ENUM('fact', 'preference', 'episode');--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM('workspace', 'agent', 'agent_user');--> statement-breakpoint
CREATE TYPE "public"."policy_verdict" AS ENUM('auto', 'approve', 'human', 'deny');--> statement-breakpoint
CREATE TYPE "public"."tool_call_status" AS ENUM('in_flight', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "agent_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"mode" "grant_mode" NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"tool" text NOT NULL,
	"args" jsonb NOT NULL,
	"status" "tool_call_status" DEFAULT 'in_flight' NOT NULL,
	"verdict" "policy_verdict",
	"result" jsonb,
	"untrusted" boolean DEFAULT false NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scope" "memory_scope" NOT NULL,
	"kind" "memory_kind" DEFAULT 'fact' NOT NULL,
	"agent_id" uuid,
	"user_id" text,
	"content" text NOT NULL,
	"embedding" vector,
	"embedding_model" text,
	"verified" boolean DEFAULT false NOT NULL,
	"source_run_id" uuid,
	"expires_at" timestamp with time zone,
	"last_recalled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_scope_owner_ck" CHECK (("memory"."scope" = 'workspace' and "memory"."agent_id" is null and "memory"."user_id" is null)
       or ("memory"."scope" = 'agent' and "memory"."agent_id" is not null and "memory"."user_id" is null)
       or ("memory"."scope" = 'agent_user' and "memory"."agent_id" is not null and "memory"."user_id" is not null)),
	CONSTRAINT "memory_embedding_model_ck" CHECK (("memory"."embedding" is null) = ("memory"."embedding_model" is null))
);
--> statement-breakpoint
CREATE TABLE "secret" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value_ciphertext" text NOT NULL,
	"key_ciphertext" text NOT NULL,
	"key_id" text NOT NULL,
	"hint" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent" ALTER COLUMN "spec" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "agent_grant" ADD CONSTRAINT "agent_grant_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grant" ADD CONSTRAINT "agent_grant_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grant" ADD CONSTRAINT "agent_grant_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agent"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."run"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory" ADD CONSTRAINT "memory_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory" ADD CONSTRAINT "memory_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory" ADD CONSTRAINT "memory_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agent"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory" ADD CONSTRAINT "memory_source_run_fk" FOREIGN KEY ("workspace_id","source_run_id") REFERENCES "public"."run"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_grant_agent_tool_uq" ON "agent_grant" USING btree ("agent_id","tool");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_workspace_key_uq" ON "tool_call" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "tool_call_run_idx" ON "tool_call" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "memory_workspace_scope_agent_idx" ON "memory" USING btree ("workspace_id","scope","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "secret_workspace_name_uq" ON "secret" USING btree ("workspace_id","name");
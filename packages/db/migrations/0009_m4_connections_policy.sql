CREATE TABLE "connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"account" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credentials_ciphertext" text,
	"key_ciphertext" text,
	"key_id" text,
	"oauth_state" text,
	"expires_at" timestamp with time zone,
	"refreshed_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_status_ck" CHECK ("connection"."status" in ('pending', 'active', 'needs_reauth')),
	CONSTRAINT "connection_credentials_ck" CHECK (("connection"."credentials_ciphertext" is null) = ("connection"."key_ciphertext" is null)
        and ("connection"."credentials_ciphertext" is null) = ("connection"."key_id" is null)),
	CONSTRAINT "connection_active_ck" CHECK ("connection"."status" <> 'active' or "connection"."credentials_ciphertext" is not null)
);
--> statement-breakpoint
CREATE TABLE "mcp_server" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"catalog_id" text,
	"url" text NOT NULL,
	"auth" text DEFAULT 'oauth' NOT NULL,
	"auth_origin" text,
	"client_ciphertext" text,
	"client_key_ciphertext" text,
	"client_key_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"tools" jsonb,
	"tools_fetched_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_server_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "mcp_server_slug_ck" CHECK ("mcp_server"."slug" ~ '^[a-z][a-z0-9_]{0,31}$'),
	CONSTRAINT "mcp_server_auth_ck" CHECK ("mcp_server"."auth" in ('oauth', 'none')),
	CONSTRAINT "mcp_server_client_ck" CHECK (("mcp_server"."client_ciphertext" is null) = ("mcp_server"."client_key_ciphertext" is null)
        and ("mcp_server"."client_ciphertext" is null) = ("mcp_server"."client_key_id" is null))
);
--> statement-breakpoint
CREATE TABLE "policy_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text,
	"agent_id" uuid,
	"tool" text NOT NULL,
	"effect" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_rule_scope_tool_uq" UNIQUE NULLS NOT DISTINCT("workspace_id","user_id","agent_id","tool","effect"),
	CONSTRAINT "policy_rule_effect_ck" CHECK ("policy_rule"."effect" in ('ask_first', 'allow_auto')),
	CONSTRAINT "policy_rule_personal_ck" CHECK ("policy_rule"."user_id" is null or "policy_rule"."effect" = 'ask_first'),
	CONSTRAINT "policy_rule_tool_ck" CHECK ("policy_rule"."tool" ~ '^(\*|[a-z][a-z0-9_]*(\.(\*|[a-z0-9_]+))?)$')
);
--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_mcp_server_fk" FOREIGN KEY ("workspace_id","mcp_server_id") REFERENCES "public"."mcp_server"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_rule" ADD CONSTRAINT "policy_rule_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_rule" ADD CONSTRAINT "policy_rule_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_rule" ADD CONSTRAINT "policy_rule_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_rule" ADD CONSTRAINT "policy_rule_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agent"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_server_user_uq" ON "connection" USING btree ("mcp_server_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_oauth_state_uq" ON "connection" USING btree ("oauth_state");--> statement-breakpoint
CREATE INDEX "connection_workspace_expires_idx" ON "connection" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_server_workspace_slug_uq" ON "mcp_server" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_server_workspace_catalog_uq" ON "mcp_server" USING btree ("workspace_id","catalog_id") WHERE "mcp_server"."catalog_id" is not null;--> statement-breakpoint
CREATE INDEX "policy_rule_workspace_idx" ON "policy_rule" USING btree ("workspace_id","enabled");--> statement-breakpoint

-- Row-level security (hard rule 3): rows of the current workspace only.
ALTER TABLE "mcp_server" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mcp_server" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mcp_server"
  USING (workspace_id = ofa_current_workspace_id())
  WITH CHECK (workspace_id = ofa_current_workspace_id());
--> statement-breakpoint
ALTER TABLE "connection" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "connection" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "connection"
  USING (workspace_id = ofa_current_workspace_id())
  WITH CHECK (workspace_id = ofa_current_workspace_id());
--> statement-breakpoint
ALTER TABLE "policy_rule" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "policy_rule" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "policy_rule"
  USING (workspace_id = ofa_current_workspace_id())
  WITH CHECK (workspace_id = ofa_current_workspace_id());

-- Row-level security for tenant tables (hard rule 3, ADR-0020).
--
-- `withTenant()` sets two transaction-local settings before any query:
--   app.workspace_id  the workspace the request acts in
--   app.user_id       the signed-in user
-- Policies compare rows against them. With no settings, every tenant table
-- looks empty. FORCE applies the policies to the table owner too; only
-- superusers (migrations, backups) bypass them.

CREATE FUNCTION ofa_current_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION ofa_current_user_id() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '') $$;
--> statement-breakpoint

-- workspace: the tenant row itself, plus read access to every workspace the
-- user belongs to (for the workspace switcher).
ALTER TABLE "workspace" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "workspace"
  USING (id = ofa_current_workspace_id())
  WITH CHECK (id = ofa_current_workspace_id());
--> statement-breakpoint
CREATE POLICY member_read ON "workspace" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "membership" m
    WHERE m.workspace_id = "workspace".id AND m.user_id = ofa_current_user_id()
  ));
--> statement-breakpoint

-- membership: tenant rows, plus the user's own memberships in any workspace,
-- so a session can be resolved to a workspace before one is chosen.
ALTER TABLE "membership" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "membership" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "membership"
  USING (workspace_id = ofa_current_workspace_id())
  WITH CHECK (workspace_id = ofa_current_workspace_id());
--> statement-breakpoint
CREATE POLICY self_read ON "membership" FOR SELECT
  USING (user_id = ofa_current_user_id());
--> statement-breakpoint

-- Every other tenant table: rows of the current workspace only.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'device', 'agent', 'thread', 'thread_member', 'message', 'run', 'run_event', 'audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (workspace_id = ofa_current_workspace_id())
         WITH CHECK (workspace_id = ofa_current_workspace_id())',
      t
    );
  END LOOP;
END
$$;
--> statement-breakpoint

-- Append-only tables (hard rule 7): no UPDATE for anyone, and DELETE only by
-- the table owner (retention jobs, workspace deletion cascades). Foreign-key
-- cascades run as the owner, so deleting a workspace still works.
CREATE FUNCTION ofa_forbid_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_has_role(
    current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'MEMBER'
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER run_event_append_only BEFORE UPDATE OR DELETE ON "run_event"
  FOR EACH ROW EXECUTE FUNCTION ofa_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION ofa_forbid_mutation();

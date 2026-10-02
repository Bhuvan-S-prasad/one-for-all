-- Row-level security for the M2 tenant tables (hard rule 3). Same policy as
-- 0001: rows of the current workspace only.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_grant', 'tool_call', 'memory', 'secret'] LOOP
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

-- Deleting a run keeps the facts it taught: clear only `source_run_id`.
-- Drizzle cannot express a column list on SET NULL, and the generated
-- constraint would also null `workspace_id` (NOT NULL), so replace it.
ALTER TABLE "memory" DROP CONSTRAINT "memory_source_run_fk";
--> statement-breakpoint
ALTER TABLE "memory" ADD CONSTRAINT "memory_source_run_fk"
  FOREIGN KEY ("workspace_id", "source_run_id") REFERENCES "public"."run"("workspace_id", "id")
  ON DELETE SET NULL ("source_run_id");

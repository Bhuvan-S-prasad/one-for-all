import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { loadRootEnv } from "./env";
import { createDatabase, pingDatabase, TENANT_TABLES, withDatabaseName } from "./index";

// Integration test: `pnpm test:integration` (after `pnpm infra:up`) first
// creates and migrates the throwaway database `oneforall_test_db`.
loadRootEnv();
const baseUrl = process.env.DATABASE_URL;

describe.skipIf(!baseUrl)("database (integration)", () => {
  const handle = createDatabase(withDatabaseName(baseUrl ?? "", "oneforall_test_db"), { max: 1 });

  afterAll(() => handle.close());

  it("connects as the app role", async () => {
    expect(await pingDatabase(handle.db)).toBe(true);
  });

  it("app role cannot bypass row-level security", async () => {
    const rows = await handle.db.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("has the pgvector extension", async () => {
    const rows = await handle.db.execute<{ extname: string }>(
      sql`select extname from pg_extension where extname = 'vector'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("every table with workspace_id is a tenant table with forced RLS", async () => {
    const rows = await handle.db.execute<{ table: string; rls: boolean; forced: boolean }>(sql`
      select c.relname as table, c.relrowsecurity as rls, c.relforcerowsecurity as forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and (c.relname = 'workspace' or exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped))
      order by c.relname`);

    expect(rows.map((r) => r.table)).toEqual([...TENANT_TABLES].sort());
    for (const row of rows) {
      expect(row, row.table).toMatchObject({ rls: true, forced: true });
    }
  });
});

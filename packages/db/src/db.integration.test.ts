import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { loadRootEnv } from "./env";
import { createDatabase, pingDatabase } from "./index";

// Integration test: run with `pnpm test:integration` after `pnpm infra:up`.
// Excluded from `pnpm test`; skipped when no database URL is configured.
loadRootEnv();
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("database connection (integration)", () => {
  const handle = createDatabase(url ?? "", { max: 1 });

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
});

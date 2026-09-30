import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;

export interface DatabaseHandle {
  readonly db: Database;
  /** Close all pooled connections. Call on shutdown. */
  close(): Promise<void>;
}

export interface CreateDatabaseOptions {
  /** Maximum pooled connections. */
  readonly max?: number;
}

/**
 * Connect with the app role. Row-level security applies to this role, so
 * tenant-scoped queries must go through `withTenant` (added in M1.12).
 */
export function createDatabase(url: string, options: CreateDatabaseOptions = {}): DatabaseHandle {
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return {
    db,
    close: () => client.end({ timeout: 5 }),
  };
}

/** Round-trip check for health endpoints. */
export async function pingDatabase(db: Database): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

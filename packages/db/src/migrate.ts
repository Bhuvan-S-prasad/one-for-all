import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * SQL migrations folder. In the source tree this is `packages/db/migrations`;
 * the app image copies it next to the bundled server and passes the path in.
 */
export const MIGRATIONS_FOLDER = resolve(import.meta.dirname, "../migrations");

/**
 * Apply pending migrations. Must run as the owner role
 * (DATABASE_MIGRATION_URL), never as the app role.
 */
export async function runMigrations(
  migrationUrl: string,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  const client = postgres(migrationUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end({ timeout: 5 });
  }
}

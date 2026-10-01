import postgres from "postgres";
import { runMigrations } from "./migrate";

const IDENTIFIER = /^[A-Za-z0-9_]+$/;

function identifier(value: string, what: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`Unsafe ${what}: ${value}`);
  return `"${value}"`;
}

/** Same server and credentials, different database. */
export function withDatabaseName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

export interface TestDatabase {
  /** App role; row-level security applies. */
  readonly url: string;
  /** Owner role. */
  readonly migrationUrl: string;
}

/**
 * Drop and recreate a throwaway database for integration tests, give the app
 * role the same access the init script gives it, and run all migrations.
 * Integration tests never touch the dev database.
 */
export async function prepareTestDatabase(options: {
  readonly name: string;
  readonly appUrl: string;
  readonly ownerUrl: string;
}): Promise<TestDatabase> {
  const name = identifier(options.name, "database name");
  const appRole = identifier(decodeURIComponent(new URL(options.appUrl).username), "app role");
  const ownerRole = identifier(decodeURIComponent(new URL(options.ownerUrl).username), "owner");

  const admin = postgres(options.ownerUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${name}`);
    await admin.unsafe(`GRANT CONNECT ON DATABASE ${name} TO ${appRole}`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const migrationUrl = withDatabaseName(options.ownerUrl, options.name);
  const target = postgres(migrationUrl, { max: 1, onnotice: () => {} });
  try {
    await target.unsafe(`
      CREATE EXTENSION IF NOT EXISTS vector;
      GRANT USAGE ON SCHEMA public TO ${appRole};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerRole} IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerRole} IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO ${appRole};
    `);
  } finally {
    await target.end({ timeout: 5 });
  }

  await runMigrations(migrationUrl);
  return { url: withDatabaseName(options.appUrl, options.name), migrationUrl };
}

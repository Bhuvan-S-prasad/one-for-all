// Creates fresh, migrated databases for integration tests. Test files that
// need an empty install (first-run setup) get a database of their own.
// Usage: tsx prepare-test-db.ts <database-name>...
import { loadConfig } from "@ofa/config";
import { loadRootEnv } from "../env";
import { prepareTestDatabase } from "../testing";

loadRootEnv();
const names = process.argv.slice(2);
if (names.length === 0) throw new Error("Usage: prepare-test-db.ts <database-name>...");

const config = loadConfig();
for (const name of names) {
  await prepareTestDatabase({
    name,
    appUrl: config.database.url,
    ownerUrl: config.database.migrationUrl,
  });
  console.warn(`Test database ${name} is ready.`);
}

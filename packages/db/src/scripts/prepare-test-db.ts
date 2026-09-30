// Creates a fresh, migrated database for integration tests.
// Usage: tsx prepare-test-db.ts <database-name>
import { loadConfig } from "@ofa/config";
import { loadRootEnv } from "../env";
import { prepareTestDatabase } from "../testing";

loadRootEnv();
const name = process.argv[2];
if (!name) throw new Error("Usage: prepare-test-db.ts <database-name>");

const config = loadConfig();
await prepareTestDatabase({
  name,
  appUrl: config.database.url,
  ownerUrl: config.database.migrationUrl,
});
console.warn(`Test database ${name} is ready.`);

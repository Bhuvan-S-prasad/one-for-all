// Creates the throwaway databases for API integration tests: one per test
// file, since each runs first-run setup on an empty install.
import { loadConfig } from "@ofa/config";
import { loadRootEnv, prepareTestDatabase } from "@ofa/db";

loadRootEnv();
const config = loadConfig();
for (const name of [
  "oneforall_test_api",
  "oneforall_test_api_agents",
  "oneforall_test_api_redaction",
]) {
  await prepareTestDatabase({
    name,
    appUrl: config.database.url,
    ownerUrl: config.database.migrationUrl,
  });
  console.warn(`Test database ${name} is ready.`);
}

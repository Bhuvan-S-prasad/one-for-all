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
  "oneforall_test_api_mcp",
  "oneforall_test_api_team",
  "oneforall_test_api_clock",
  "oneforall_test_api_memory",
  "oneforall_test_api_attention",
]) {
  await prepareTestDatabase({
    name,
    appUrl: config.database.url,
    ownerUrl: config.database.migrationUrl,
  });
  console.warn(`Test database ${name} is ready.`);
}

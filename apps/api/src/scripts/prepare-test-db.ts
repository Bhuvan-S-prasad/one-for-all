// Creates the throwaway database `oneforall_test_api` for API integration tests.
import { loadConfig } from "@ofa/config";
import { loadRootEnv, prepareTestDatabase } from "@ofa/db";

loadRootEnv();
const config = loadConfig();
await prepareTestDatabase({
  name: "oneforall_test_api",
  appUrl: config.database.url,
  ownerUrl: config.database.migrationUrl,
});
console.warn("Test database oneforall_test_api is ready.");

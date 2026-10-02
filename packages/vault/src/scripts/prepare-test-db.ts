// Creates the throwaway database `oneforall_test_vault` for vault integration tests.
import { loadRootEnv, prepareTestDatabase } from "@ofa/db";

loadRootEnv();
const appUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.DATABASE_MIGRATION_URL ?? appUrl;
if (!appUrl || !ownerUrl) throw new Error("DATABASE_URL is not set");
await prepareTestDatabase({ name: "oneforall_test_vault", appUrl, ownerUrl });
console.warn("Test database oneforall_test_vault is ready.");

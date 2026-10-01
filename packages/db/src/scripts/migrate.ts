// CLI: pnpm --filter @ofa/db db:migrate
import { loadConfig } from "@ofa/config";
import { loadRootEnv } from "../env";
import { runMigrations } from "../migrate";

loadRootEnv();
const config = loadConfig();

console.warn("Applying migrations…");
await runMigrations(config.database.migrationUrl);
console.warn("Migrations are up to date.");

import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load the repo-root `.env` into `process.env` for CLI tools (drizzle-kit,
 * migrate script, integration tests). Apps load it themselves at startup.
 * Variables already set in the shell win.
 */
export function loadRootEnv(): void {
  const path = resolve(import.meta.dirname, "../../../.env");
  if (existsSync(path)) process.loadEnvFile(path);
}

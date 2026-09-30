import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Walk up from `start` to the directory holding `pnpm-workspace.yaml`. */
export function findRepoRoot(start = process.cwd()): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Load the repo-root `.env` into `process.env` for CLI tools (drizzle-kit,
 * scripts, integration tests) and `pnpm dev`. Variables already set in the
 * shell win. Does nothing outside the repo (e.g. in the Docker image).
 */
export function loadRootEnv(): void {
  const root = findRepoRoot();
  const path = root && join(root, ".env");
  if (path && existsSync(path)) process.loadEnvFile(path);
}

import type { Config } from "@ofa/config";
import { createDatabase, type Database } from "@ofa/db";
import type { VaultRotation } from "../container";
import type { Logger } from "../lib/logger";

/**
 * Finish a vault key rotation when the app starts (M4.02). With previous keys
 * configured, re-wrap every workspace's secrets, tokens and OAuth clients with
 * the current key, then say whether the old key can go. Runs after the app is
 * already serving: until it finishes, previous keys still decrypt.
 */
export async function finishVaultRotation(
  rotation: VaultRotation,
  config: Config,
  logger: Logger,
  openOwnerDb: (url: string) => { db: Database; close(): Promise<void> } = (url) =>
    createDatabase(url, { max: 1 }),
): Promise<void> {
  if (rotation.keys.previousKeys.length === 0) return;
  if (config.database.migrationUrl === config.database.url) {
    logger.warn(
      "vault: previous keys are set, but re-wrapping needs DATABASE_MIGRATION_URL (the owner connection); they keep working meanwhile",
    );
    return;
  }
  const owner = openOwnerDb(config.database.migrationUrl);
  try {
    const result = await rotation.run(owner.db);
    if (result.unreadable > 0) {
      logger.warn(
        "vault: some values are wrapped by a key that is not configured; keep the previous keys and add the missing one",
        { ...result },
      );
    } else if (rotation.keys.source === "keychain") {
      rotation.forgetPrevious();
      logger.info("vault: rotation finished; the previous key was removed from the OS keychain", {
        ...result,
      });
    } else {
      logger.info(
        "vault: rotation finished; every value uses VAULT_KEY, so remove VAULT_PREVIOUS_KEYS",
        {
          ...result,
        },
      );
    }
  } catch (error) {
    logger.error(
      "vault: rotation failed; previous keys keep working, and it is tried again at the next start",
      {
        error,
      },
    );
  } finally {
    await owner.close();
  }
}

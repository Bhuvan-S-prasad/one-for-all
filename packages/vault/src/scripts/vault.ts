/* eslint-disable no-console -- a command-line tool prints its report */
// `pnpm vault <command>`: the vault key in the OS keychain, and rotation
// status (M4.02). Prints key fingerprints, never keys.
//
//   status           where the key comes from, and which key wraps each value
//   keychain:store   copy VAULT_KEY into the OS keychain
//   keychain:rotate  put a new key in the keychain; the app finishes at its next start
import { randomBytes } from "node:crypto";
import { loadConfig } from "@ofa/config";
import { asId, type UserId, type WorkspaceId } from "@ofa/core";
import { createDatabase, listEnvelopes, listWorkspaceOwners, loadRootEnv } from "@ofa/db";
import { keyFingerprint, parseVaultKey } from "../crypto";
import { createOsKeychain, resolveVaultKeys } from "../keychain";

loadRootEnv();
const config = loadConfig();
const command = process.argv[2];
const fingerprint = (key: string) => keyFingerprint(parseVaultKey(key));

async function status(): Promise<void> {
  const keys = resolveVaultKeys(config.vault);
  if (!keys) {
    console.log("No vault key is configured (VAULT_KEY is empty).");
    return;
  }
  const current = fingerprint(keys.key);
  const previous = new Set(keys.previousKeys.map(fingerprint));
  console.log(`Key source:    ${keys.source}`);
  console.log(`Current key:   ${current}`);
  console.log(`Previous keys: ${previous.size ? [...previous].join(", ") : "none"}`);

  if (config.database.migrationUrl === config.database.url) {
    console.log("Set DATABASE_MIGRATION_URL to count the values each key wraps.");
    return;
  }
  const owner = createDatabase(config.database.migrationUrl, { max: 1 });
  const app = createDatabase(config.database.url, { max: 1 });
  try {
    const counts = { current: 0, previous: 0, unknown: 0 };
    const workspaces = await listWorkspaceOwners(owner.db);
    for (const { workspaceId, userId } of workspaces) {
      const ctx = { workspaceId: asId<WorkspaceId>(workspaceId), userId: asId<UserId>(userId) };
      for (const stored of await listEnvelopes(app.db, ctx)) {
        if (stored.keyId === current) counts.current += 1;
        else if (previous.has(stored.keyId)) counts.previous += 1;
        else counts.unknown += 1;
      }
    }
    console.log(
      `Values:        ${counts.current} on the current key, ${counts.previous} on a previous key, ${counts.unknown} on a key that is not configured (${workspaces.length} workspaces)`,
    );
    if (counts.previous > 0) console.log("Restart the app to re-wrap them with the current key.");
    if (counts.unknown > 0) console.log("Add the missing key to VAULT_PREVIOUS_KEYS to read them.");
  } finally {
    await app.close();
    await owner.close();
  }
}

function keychainStore(): void {
  const key = config.vault.key;
  if (!key) throw new Error("Set VAULT_KEY first: this copies it into the OS keychain.");
  const chain = createOsKeychain();
  const existing = chain.read("vault-key");
  if (existing === key) {
    console.log(`The OS keychain already holds this key (${fingerprint(key)}).`);
  } else if (existing) {
    throw new Error(
      `The OS keychain holds a different vault key (${fingerprint(existing)}). Not replacing it: that key may encrypt your secrets.`,
    );
  } else {
    chain.write("vault-key", key);
    if (chain.read("vault-key") !== key)
      throw new Error("The key didn't read back from the keychain.");
    console.log(`Stored the vault key (${fingerprint(key)}) in the OS keychain.`);
  }
  console.log(
    "Next: set VAULT_KEY_SOURCE=keychain in .env, remove VAULT_KEY, and restart the app.",
  );
}

function keychainRotate(): void {
  if (config.vault.source !== "keychain") {
    throw new Error(
      "VAULT_KEY_SOURCE is not keychain. To rotate VAULT_KEY: put a new key in VAULT_KEY, the old one in VAULT_PREVIOUS_KEYS, and restart.",
    );
  }
  const chain = createOsKeychain();
  if (chain.read("vault-key.previous")) {
    throw new Error(
      "A rotation is still finishing. Start the app once: it re-wraps every value and removes the old key.",
    );
  }
  const old = chain.read("vault-key");
  if (!old) throw new Error("The OS keychain has no vault key to rotate.");
  const next = randomBytes(32).toString("base64");
  // Keep the old key first, so a failure part-way never loses it.
  chain.write("vault-key.previous", old);
  if (chain.read("vault-key.previous") !== old) {
    throw new Error("The old key didn't read back from the keychain; nothing was changed.");
  }
  chain.write("vault-key", next);
  if (chain.read("vault-key") !== next) {
    throw new Error(
      "The new key didn't read back from the keychain; the old key is still current.",
    );
  }
  console.log(
    `New vault key ${fingerprint(next)} replaces ${fingerprint(old)} in the OS keychain.`,
  );
  console.log(
    "Restart the app: it re-wraps every value with the new key, then removes the old one from the keychain.",
  );
}

try {
  switch (command) {
    case "status":
      await status();
      break;
    case "keychain:store":
      keychainStore();
      break;
    case "keychain:rotate":
      keychainRotate();
      break;
    default:
      console.log("Usage: pnpm vault <status | keychain:store | keychain:rotate>");
      process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

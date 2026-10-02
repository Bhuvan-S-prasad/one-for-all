import { pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, id, timestampAt, updatedAt } from "./columns";
import { workspaceId } from "./tenancy";

/**
 * A named secret, envelope-encrypted by `packages/vault` (ADR-0012). The
 * value is encrypted with its own data key, and the data key with the vault
 * key from the environment, which never touches the database. Both are bound
 * to the workspace and name, so a ciphertext copied to another row will not
 * decrypt.
 */
export const secret = pgTable(
  "secret",
  {
    id: id(),
    workspaceId: workspaceId(),
    /** e.g. `llm.openrouter.api_key`. */
    name: text("name").notNull(),
    valueCiphertext: text("value_ciphertext").notNull(),
    keyCiphertext: text("key_ciphertext").notNull(),
    /** Fingerprint of the vault key that wrapped `key_ciphertext`. */
    keyId: text("key_id").notNull(),
    /** Last four characters for display (`…a1b2`), when the value is long enough. */
    hint: text("hint"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastUsedAt: timestampAt("last_used_at"),
  },
  (t) => [uniqueIndex("secret_workspace_name_uq").on(t.workspaceId, t.name)],
);

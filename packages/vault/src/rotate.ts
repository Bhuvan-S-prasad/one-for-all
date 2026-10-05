import { asId, type UserId, type WorkspaceId } from "@ofa/core";
import { listWorkspaceOwners, type Database } from "@ofa/db";
import type { RotationResult, Vault } from "./vault";

// Key rotation across the install (M4.02). Envelope encryption makes it cheap:
// only each value's data key is re-wrapped with the current vault key. Each
// workspace is re-wrapped through the vault as one of its owners, so tenant
// rules hold; only listing the workspaces needs the owner connection.

export interface InstallRotation extends RotationResult {
  readonly workspaces: number;
}

/**
 * Re-wrap every workspace's values with the current key. `ownerDb` must be
 * the owner connection (`DATABASE_MIGRATION_URL`): under row-level security
 * the app's own connection sees no workspaces at all.
 */
export async function rotateInstall(vault: Vault, ownerDb: Database): Promise<InstallRotation> {
  const owners = await listWorkspaceOwners(ownerDb);
  let rewrapped = 0;
  let current = 0;
  let unreadable = 0;
  for (const owner of owners) {
    const result = await vault.rotate({
      workspaceId: asId<WorkspaceId>(owner.workspaceId),
      userId: asId<UserId>(owner.userId),
    });
    rewrapped += result.rewrapped;
    current += result.current;
    unreadable += result.unreadable;
  }
  return { workspaces: owners.length, rewrapped, current, unreadable };
}

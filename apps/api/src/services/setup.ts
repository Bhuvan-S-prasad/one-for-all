import type { FirstRunSetupRequest, SetupStatus } from "@ofa/contracts";
import { AppError } from "@ofa/core";
import { bootstrapOwner, isSetupComplete, type BootstrapOwnerResult, type Database } from "@ofa/db";
import type { Auth } from "../auth/auth";

export interface RequestMeta {
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface SetupService {
  status(): Promise<SetupStatus>;
  /** Create the owner account and the workspace. Fails with `conflict` once done. */
  run(input: FirstRunSetupRequest, meta?: RequestMeta): Promise<BootstrapOwnerResult>;
}

export function createSetupService(deps: { db: Database; auth: Auth }): SetupService {
  return {
    async status() {
      return { needsSetup: !(await isSetupComplete(deps.db)) };
    },

    async run(input, meta = {}) {
      // Cheap early exit; bootstrapOwner re-checks under a lock.
      if (await isSetupComplete(deps.db)) {
        throw new AppError("conflict", "Setup is already complete");
      }
      // Hash with Better Auth's hasher so its password login can verify it.
      const context = await deps.auth.$context;
      const passwordHash = await context.password.hash(input.password);
      return bootstrapOwner(deps.db, { ...input, passwordHash, ...meta });
    },
  };
}

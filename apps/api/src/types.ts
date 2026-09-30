import type { TenantContext } from "@ofa/core";
import type { Logger } from "./lib/logger";
import type { ResolvedSession } from "./services/sessions";

/** Hono environment: values middleware puts on the request context. */
export interface AppEnv {
  Variables: {
    requestId: string;
    logger: Logger;
    /** Set by `requireSession`. */
    session: ResolvedSession;
    /** Set by `requireTenant`. */
    tenant: TenantContext;
  };
}

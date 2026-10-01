import { sessionQuery, setupStatusQuery } from "@ofa/client";
import type { SessionResponse, SetupStatus } from "@ofa/contracts";
import type { RouterContext } from "@/router-context";

// Route guards. They read through the query cache, so a guard and the
// component it protects share one request.

export function loadSetupStatus(context: RouterContext): Promise<SetupStatus> {
  return context.queryClient.ensureQueryData(setupStatusQuery(context.api));
}

export function loadSession(context: RouterContext): Promise<SessionResponse | null> {
  return context.queryClient.ensureQueryData(sessionQuery(context.api));
}

/**
 * Accept only same-site paths as a post-login destination, so a crafted
 * `?redirect=` link cannot send the user to another site.
 */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return undefined;
  return value;
}

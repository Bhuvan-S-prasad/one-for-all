import type { ApiClient } from "@ofa/client";
import type { QueryClient } from "@tanstack/react-query";

/** Available to every route's `beforeLoad` and loader. */
export interface RouterContext {
  readonly api: ApiClient;
  readonly queryClient: QueryClient;
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** Page title shown in the app header. */
    title?: string;
  }
}

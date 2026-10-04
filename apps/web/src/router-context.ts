import type { ApiClient } from "@ofa/client";
import type { QueryClient } from "@tanstack/react-query";

/** Available to every route's `beforeLoad` and loader. */
export interface RouterContext {
  readonly api: ApiClient;
  readonly queryClient: QueryClient;
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** Page title, for the browser tab. */
    title?: string;
    /**
     * The page fills the area beside the sidebar and scrolls on its own (the
     * chat). On phones it also hides the tab bar.
     */
    fullBleed?: boolean;
  }
}

import { QueryClient, queryOptions } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "./api-client";

export const queryKeys = {
  session: ["session"] as const,
  setupStatus: ["setup-status"] as const,
  health: ["health"] as const,
};

/** Shared by hooks and router loaders, so both read the same cache entry. */
export const sessionQuery = (api: ApiClient) =>
  queryOptions({ queryKey: queryKeys.session, queryFn: () => api.session(), staleTime: 60_000 });

export const setupStatusQuery = (api: ApiClient) =>
  queryOptions({
    queryKey: queryKeys.setupStatus,
    queryFn: () => api.setupStatus(),
    staleTime: Infinity,
  });

/** Server health; refreshed every 30 seconds while shown. */
export const healthQuery = (api: ApiClient) =>
  queryOptions({
    queryKey: queryKeys.health,
    queryFn: () => api.health(),
    refetchInterval: 30_000,
    retry: false,
  });

/** Query client with defaults suited to this API. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Retry network and server errors, never 4xx: those will not change.
        retry: (failures, error) =>
          failures < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      },
    },
  });
}

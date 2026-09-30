import type { FirstRunSetupRequest, LoginRequest } from "@ofa/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import type { ApiClient } from "./api-client";
import { queryKeys, sessionQuery, setupStatusQuery } from "./query";

const ApiClientContext = createContext<ApiClient | null>(null);

/** Makes the API client available to the hooks below. */
export function ApiClientProvider(props: { client: ApiClient; children: ReactNode }) {
  return <ApiClientContext value={props.client}>{props.children}</ApiClientContext>;
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (!client) throw new Error("useApiClient must be used inside <ApiClientProvider>");
  return client;
}

/** The signed-in session (`null` when signed out). */
export function useSession() {
  return useQuery(sessionQuery(useApiClient()));
}

export function useSetupStatus() {
  return useQuery(setupStatusQuery(useApiClient()));
}

export function useLogin() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginRequest) => api.login(input),
    onSuccess: (session) => queryClient.setQueryData(queryKeys.session, session),
  });
}

export function useFirstRunSetup() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FirstRunSetupRequest) => api.setup(input),
    onSuccess: (session) => {
      queryClient.setQueryData(queryKeys.setupStatus, { needsSetup: false });
      queryClient.setQueryData(queryKeys.session, session);
    },
  });
}

export function useLogout() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      // Drop everything cached for the old session, then mark signed out.
      queryClient.clear();
      queryClient.setQueryData(queryKeys.session, null);
    },
  });
}

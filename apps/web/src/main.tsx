import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";

import { ApiClientProvider, createApiClient, createQueryClient } from "@ofa/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initTheme } from "./lib/theme";
import { routeTree } from "./routeTree.gen";

initTheme();

// Same origin: in development Vite proxies /api, in self-host the API serves this app.
const api = createApiClient();
const queryClient = createQueryClient();

const router = createRouter({
  routeTree,
  context: { api, queryClient },
  defaultPreload: "intent",
  // Route guards read from the query cache, so the router never caches on its own.
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <ApiClientProvider client={api}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ApiClientProvider>
  </StrictMode>,
);

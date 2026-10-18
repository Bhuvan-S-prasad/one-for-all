import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";

import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Landing } from "./landing/landing";

// The public site (ADR-0046): the landing page at / and the docs under /docs.
// A static build; Vercel sends every path to index.html.

document.documentElement.classList.add("dark");

const docs = () => import("./docs/routes");

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: lazyRouteComponent(docs, "NotFound"),
});

const landingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Landing,
});

const docsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/docs",
  component: lazyRouteComponent(docs, "DocsHome"),
});

const decisionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/docs/decisions",
  component: lazyRouteComponent(docs, "Decisions"),
});

const decisionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/docs/decisions/$id",
  component: lazyRouteComponent(docs, "Decision"),
});

const eventsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/docs/events",
  component: lazyRouteComponent(docs, "Events"),
});

const pageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/docs/$page",
  component: lazyRouteComponent(docs, "DocsPage"),
});

const routeTree = rootRoute.addChildren([
  landingRoute,
  docsIndexRoute,
  decisionsRoute,
  decisionRoute,
  eventsRoute,
  pageRoute,
]);

const router = createRouter({
  routeTree,
  scrollRestoration: true,
  defaultPreload: "intent",
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
    <RouterProvider router={router} />
  </StrictMode>,
);

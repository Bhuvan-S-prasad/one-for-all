import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";

import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Missing } from "./components/panels";
import { FilePage, PackagePage, Packages, SymbolPage } from "./views/code";
import { Home } from "./views/home";
import { SectionIndex, WrittenPage } from "./views/page";
import { Api, DataModel, Decision, Decisions, Jobs, Search, Tools } from "./views/reference";

// Learn One-for-All (ADR-0051): the codebase explained. A static build; the
// host sends every path to index.html.

document.documentElement.classList.add("dark");

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: () => <Missing>There is no page at this address.</Missing>,
});

const text = (v: unknown) => (typeof v === "string" ? v : undefined);

const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home }),
  ...(["path", "features", "walkthroughs"] as const).flatMap((section) => [
    createRoute({
      getParentRoute: () => rootRoute,
      path: `/${section}`,
      component: () => <SectionIndex section={section} />,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: `/${section}/$slug`,
      component: () => <WrittenPage section={section} />,
    }),
  ]),
  createRoute({ getParentRoute: () => rootRoute, path: "/code", component: Packages }),
  createRoute({ getParentRoute: () => rootRoute, path: "/code/$pkg", component: PackagePage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/file",
    validateSearch: (s: Record<string, unknown>) => ({ path: text(s.path) }),
    component: FilePage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/symbol",
    validateSearch: (s: Record<string, unknown>) => ({ id: text(s.id) }),
    component: SymbolPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/data", component: DataModel }),
  createRoute({ getParentRoute: () => rootRoute, path: "/api", component: Api }),
  createRoute({ getParentRoute: () => rootRoute, path: "/jobs", component: Jobs }),
  createRoute({ getParentRoute: () => rootRoute, path: "/tools", component: Tools }),
  createRoute({ getParentRoute: () => rootRoute, path: "/decisions", component: Decisions }),
  createRoute({ getParentRoute: () => rootRoute, path: "/decisions/$id", component: Decision }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/search",
    validateSearch: (s: Record<string, unknown>) => ({ q: text(s.q) }),
    component: Search,
  }),
];

const router = createRouter({
  routeTree: rootRoute.addChildren(routes),
  scrollRestoration: true,
  defaultPreload: "intent",
});

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

# ADR-0002: Thin clients over one API: Hono, Vite SPA, Expo

- **Status:** Accepted
- **Date:** 2026-09-30
- **Area:** Clients
- **Related:** ADR-0003, ADR-0016, ARCHITECTURE.md §13. The client design is amended by ADR-0021.

## Context

The product needs a web app and a mobile app (iOS and Android). Clients must show live agent activity, accept interrupts ("stop now", steering) and handle approvals, which requires long-lived two-way connections. The app is a logged-in dashboard, usually on localhost, so server-side rendering and SEO add nothing. Grok Bot describes its desktop and mobile apps as thin clients for chat, review and approvals.

## Decision

- `apps/api` (Hono) is the only backend: REST, WebSocket, auth, approvals, device pairing.
- `apps/web` is a Vite + React SPA (TanStack Router and Query, Tailwind, shadcn/ui).
- `apps/mobile` is an Expo app (Expo Router, NativeWind).
- Both clients use `packages/client` (typed Hono RPC client plus TanStack Query hooks) and `packages/contracts` (zod schemas).
- In self-host mode the API process also serves the built SPA, so the product runs as one process.

## Alternatives considered

- **Next.js for web and API:** Server Actions and Server Components cannot be called from React Native, so a REST layer would be built anyway; route handlers do not support WebSockets without a custom server; SSR brings no benefit here.
- **Express:** works, but request and response types would be hand-written and could drift from the clients.

## Consequences

- **Positive:** one API contract for every client; type errors surface at build time; small self-host footprint; the SPA can later be wrapped as a desktop app with Tauri.
- **Negative:** UI is written twice (web and native). Logic, data fetching and types are shared; components are not.
- **Follow-up:** shared Tailwind token preset for web and NativeWind; WebSocket reconnection handling in `packages/client`.

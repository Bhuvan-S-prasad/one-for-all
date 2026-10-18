# ADR-0046: The public site and docs are their own static app

- **Status:** Accepted
- **Date:** 2026-10-18
- **Area:** Clients
- **Related:** ADR-0002 (thin clients, Vite SPA), ADR-0003 (monorepo), ADR-0023 (familiars), ARCHITECTURE.md §17

## Context

The project needs a public face: a landing page that shows what One-for-All is and sends people to the repository to clone it, and documentation of everything built so far. It is hosted on Vercel, apart from the self-hosted app, and must never ship server code or anything private (a person's email, keys, the dev database).

The docs must not drift from the code and the decisions. Copying ARCHITECTURE.md or the decision records into a second place would leave two versions within a week. The landing page should show the product as it is: the real familiars, the real interface, the real routing.

## Decision

**A new deployable, `apps/site`: a static Vite and React build with the landing page at `/` and the docs under `/docs`, deployed on Vercel with `apps/site` as the project's root directory.**

- **Same stack as the web app.** Vite, React, TanStack Router, Tailwind with the shared tokens from `@ofa/tailwind-config`, the bundled fonts. Motion uses Lenis for smooth scrolling and GSAP with its plugins (ScrollTrigger, SplitText, DrawSVG, ScrambleText, Flip, CustomEase) for the scroll scenes; both are loaded only by this app.
- **Same boundary as the web app (R3).** It imports only `core`, `contracts` and `client`: the familiars come from `@ofa/client`'s geometry, the routing demo runs `rankByRequest` and `rosterText` from `@ofa/core`, and the run-events reference reads `RUN_EVENT_TYPES` from `@ofa/contracts`.
- **The decision records are read at build time** from `docs/adr`, so the docs always show the current set. Written pages are Markdown in `apps/site/src/docs/content`, rendered by the same safe parser as agent replies (never as HTML), with two fenced diagram blocks (`flow`, `layers`).
- **Only what is built.** The docs describe what exists; planned work is left out.
- **Nothing private.** The site names the dev seed's sign-in (`owner@example.com` / `dev-password-123`, development only) and tells a self-hoster that the first visit creates their own owner account. No real address, key or data is in it.
- **Not part of `pnpm dev`.** Its dev server is `pnpm --filter @ofa/site dev:site`, so the app's daily loop doesn't start it.

## Alternatives considered

- **Astro with Starlight for the docs:** a better docs engine out of the box, but a second framework to learn and maintain, for pages our own parser already renders.
- **VitePress for the docs and Vite for the landing page:** two builds and two deployments for one site.
- **Next.js:** rejected for the whole project (ARCHITECTURE.md §16); a static site needs none of it.
- **A separate repository:** the familiars, tokens and routing code would be copied and would drift, and the docs would lose the decision records at build time.

## Consequences

- **Positive:** the docs and the decision records can't drift apart; the landing page shows the real product; one Vercel project serves both.
- **Negative:** the landing bundle carries zod and the client package for the familiars (about 190 kB gzipped); the docs are a lazy-loaded chunk. Vercel must include files outside the root directory in the build (its default), so `packages/` and `docs/adr` are available.
- **Follow-up:** update the docs as features land (each milestone's pages), and add prerendering if search engines need the docs as HTML.

# ADR-0051: `apps/learn` explains the codebase from a code index built from the source

- **Status:** Accepted
- **Date:** 2026-10-21
- **Area:** Clients
- **Related:** ADR-0046 (the public site and docs), ARCHITECTURE.md §16, §17

## Context

People need to learn this repository: developers joining the project, and early-career developers who want to see how a full-stack AI system is built. The docs in `apps/site` describe what One-for-All does and how its parts fit, briefly. They don't show the code: which function does what, what calls what, the tables behind a feature, the endpoints it uses, or why it is built that way.

Written explanations of code go stale as soon as the code moves. A guide that quotes a function nobody calls any more teaches the wrong thing, and nothing notices.

## Decision

**A separate static app, `apps/learn`, explains the codebase. Its facts about the code (files, functions, calls, tables, endpoints, events, tools) come from an index built from the source at build time, and every written page refers to code by name, checked at build time.**

- **Its own app.** `apps/learn` is a static Vite and React app with the stack, tokens and fonts of `apps/site`, deployed on its own (Vercel or any static host). It is read-only: nothing runs, nothing is sent. Its dev script is `dev:learn`, so `pnpm dev` doesn't start it.
- **The code index.** `apps/learn/scripts/index-repo.ts` reads every TypeScript file under `apps/*/src` and `packages/*/src` with the TypeScript compiler (one program, so imports between packages resolve through the workspace) and writes JSON:
  - packages: name, description, internal dependencies and dependents;
  - files: path, header comment, exports, imports;
  - symbols: functions, classes, interfaces, types, constants and their members, with kind, signature, doc comment and lines; and **calls**, each resolved by the type checker to the declaration it reaches (a call through a port lands on the port's method);
  - domain facts read from known places: database tables and columns (`packages/db/src/schema`), HTTP endpoints (Hono routes mounted in `apps/api/src/app.ts`), Inngest events and functions, built-in tools.
- **Generated pages.** Every package, file and symbol gets a page from the index with its doc comment, callers, callees and source. The data model, the API, the events and the tools are listed from the index.
- **Written pages.** A guided path (chapters in order), feature pages (each feature's architecture, flow, data, endpoints and key functions) and walkthroughs (one action followed through the layers) are Markdown in `apps/learn/content`. They point at code with fenced blocks and links such as `packages/harness/src/loop.ts#runAgent`; a code excerpt may be narrowed to the lines between two pieces of text in it. Diagrams are fenced blocks (`flow`, `layers`, `sequence`), drawn as React, never as raw HTML.
- **Checked at build time.** The index script resolves every reference in the content; a reference to a symbol, file, table, endpoint or decision that no longer exists, or an excerpt anchor that no longer matches, fails the build and names the page. Stale docs become a broken build.
- **What it reads.** Source files under `apps/*/src`, `packages/*/src` and `evals/`, `package.json` files, and `docs/adr`. Never `.env` files, `graft/`, `docs/security-audit/` or anything outside the repository. The index holds source code only, so the app publishes nothing the repository doesn't.
- **Boundaries.** Like the web app and the site (R3), its browser code imports only `core`, `contracts` and `client` (in practice none of them). The index script is Node code under `scripts/`, run before `vite`.
- **The generated index is not committed.** `src/generated/` is git-ignored; the build makes it. The app loads it through `import.meta.glob`, so typechecking doesn't need it.
- **`apps/site` stays** the landing page and short user docs, and links to `apps/learn` for the code.

## Alternatives considered

- **More pages in `apps/site`'s docs:** one place, but the site is the public front door with short user docs; a code-level guide with generated pages for every symbol is a different audience and size, and would make the site's bundle and navigation heavy.
- **Hand-written explanations with pasted code:** goes stale silently, which is the problem being solved.
- **A generated API reference only (TypeDoc):** lists symbols, but not features, flows, the data model, or why; and not what calls what across packages.
- **Using the local `graft/` index:** it is a git-ignored cache on one machine, not a build input.
- **Running code in the browser:** the audience already programs; reading, diagrams and the call graph are what they need, and execution adds a sandbox to maintain.

## Consequences

- **Positive:** one place to learn the repository, from the big picture to a single function, whose facts are always the code's; a renamed function breaks the build instead of the guide.
- **Negative:** the build reads the whole repository with the TypeScript compiler (tens of seconds); written content must be kept up with the code, now enforced; the index of every source file makes the app's data large (loaded per package, on demand).
- **Follow-up:** CLAUDE.md's "keeping docs current" covers `apps/learn` content; chapters and feature pages are added in phases (tracker, Learn).

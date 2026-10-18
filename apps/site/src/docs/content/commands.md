Run these from the repository's root. Node 24, pnpm 12.3.4 and Docker.

## Everyday

| Command                             | Does                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                      | Installs dependencies, respecting the release-age wait and the list of packages allowed to run install scripts |
| `pnpm dev`                          | The API on port 3000 and the web app on http://localhost:5173                                                  |
| `pnpm build`                        | Bundles the API and builds the web app and this site                                                           |
| `pnpm lint`                         | ESLint, including the import-boundary rules                                                                    |
| `pnpm typecheck`                    | TypeScript in every package                                                                                    |
| `pnpm test`                         | Unit tests; no Docker needed                                                                                   |
| `pnpm test:integration`             | Integration tests in throwaway databases; needs `pnpm infra:up`                                                |
| `pnpm format` / `pnpm format:check` | Prettier                                                                                                       |

## Services and the database

| Command                                | Does                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm infra:up`                        | Starts Postgres, Inngest, SearXNG and the agents' sandbox with its egress proxy, on 127.0.0.1. The first start builds the sandbox image |
| `pnpm infra:down` / `pnpm infra:reset` | Stops them; `reset` also deletes their data                                                                                             |
| `pnpm --filter @ofa/db db:generate`    | Creates a migration from schema changes                                                                                                 |
| `pnpm --filter @ofa/db db:migrate`     | Applies migrations to the dev database                                                                                                  |
| `pnpm --filter @ofa/api db:seed`       | A dev owner (`owner@example.com` / `dev-password-123`), a workspace and sample agents. Development only                                 |

## Models and evals

| Command                               | Does                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm eval`                           | Eval cases against live models: `--list`, `--case`, `--k`, `--model`. Uses real quota |
| `pnpm --filter @ofa/llm spike`        | A tool-calling check of free models                                                   |
| `pnpm --filter @ofa/llm spike:vision` | A screenshot check of free vision models                                              |

## The vault

| Command                      | Does                                                                   |
| ---------------------------- | ---------------------------------------------------------------------- |
| `pnpm vault status`          | Which vault key wraps how many values. Prints fingerprints, never keys |
| `pnpm vault keychain:store`  | Copies `VAULT_KEY` into the OS keychain                                |
| `pnpm vault keychain:rotate` | Rotates a key kept in the keychain; the app finishes at its next start |

## The self-host bundle

| Command                                                                     | Does                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `sh infra/scripts/init-env.sh`                                              | Creates `infra/compose/.env` with random secrets; never overwrites |
| `docker compose -f infra/compose/docker-compose.selfhost.yml up -d --build` | Builds and runs the bundle on http://localhost:3000                |

## After adding a durable function

```sh
curl -X PUT -H "Host: host.docker.internal:3000" http://127.0.0.1:3000/api/inngest
```

## This site

| Command                            | Does                               |
| ---------------------------------- | ---------------------------------- |
| `pnpm --filter @ofa/site dev:site` | This site on http://localhost:5180 |
| `pnpm --filter @ofa/site build`    | A static build in `apps/site/dist` |

Running from source gives you hot reload on the API and the web app. Only the infrastructure runs in Docker; the API and the web app run natively.

## What you need

- **Node 24** and **pnpm 12.3.4**
- **Docker** (give Docker Desktop at least 4 GB of memory)
- An **OpenRouter key**, if you want the agents to talk to models

## Set up

```sh
git clone https://github.com/Bhuvan-S-prasad/one-for-all.git
cd one-for-all
pnpm install
cp .env.example .env
```

Fill in three values in `.env`:

| Variable      | What to put                                                                        |
| ------------- | ---------------------------------------------------------------------------------- |
| `AUTH_SECRET` | Any random string of 32 characters or more                                         |
| `VAULT_KEY`   | 32 random bytes in base64, for example the output of `openssl rand -base64 32`     |
| `LLM_API_KEY` | Your OpenRouter key. Optional here: you can also save it per workspace in Settings |

`pnpm install` respects pnpm's release-age wait and its list of packages allowed to run install scripts. Don't bypass them.

## Start the services and the database

```sh
pnpm infra:up                       # Postgres, Inngest, SearXNG and the sandbox, on 127.0.0.1
pnpm --filter @ofa/db db:migrate    # create the tables
pnpm --filter @ofa/api db:seed      # a dev owner, a workspace and sample agents
```

The first `infra:up` builds the sandbox image, which takes about ten minutes.

## Sign in to the dev app

The seed creates the owner account for you:

|          |                     |
| -------- | ------------------- |
| Email    | `owner@example.com` |
| Password | `dev-password-123`  |

These are for development only, and the seed refuses to run against a production database. To use your own, set `SEED_EMAIL` and `SEED_PASSWORD` before seeding. If you skip the seed, the first visit shows the setup page instead, as in the [quick start](/docs/quick-start).

## Run it

```sh
pnpm dev
```

This starts the API on port 3000 and the web app on **http://localhost:5173**, which proxies `/api` to the API. Then register the durable functions with the Inngest dev server:

```sh
curl -X PUT -H "Host: host.docker.internal:3000" http://127.0.0.1:3000/api/inngest
```

Do this again after adding or renaming a durable function. A plain `localhost` registration would point the Inngest container at itself.

## Local addresses

| Address               | What                                               |
| --------------------- | -------------------------------------------------- |
| http://localhost:5173 | The web app                                        |
| http://127.0.0.1:3000 | The API (restarts on edits; brief 502s are normal) |
| 127.0.0.1:5432        | Postgres                                           |
| http://127.0.0.1:8288 | The Inngest dev server and its dashboard           |
| http://127.0.0.1:8888 | SearXNG, the self-hosted web search                |
| http://127.0.0.1:7070 | The agents' sandbox service                        |

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test                 # unit tests, no Docker needed
pnpm test:integration     # against throwaway databases; needs pnpm infra:up
pnpm format:check
```

Agent behaviour is tested with evals against live models: see [Reliability and evals](/docs/reliability).

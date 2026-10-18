Configuration is environment variables, checked by a zod schema when the app starts: a missing or malformed value stops it with a message saying which. Running from source, they live in `.env` at the root (copied from `.env.example`). In the self-host bundle, `infra/scripts/init-env.sh` writes `infra/compose/.env` with random secrets.

Keep both files private. Never commit them.

## The app

| Variable        | What it is                                                         |
| --------------- | ------------------------------------------------------------------ |
| `NODE_ENV`      | `development` or `production`                                      |
| `OFA_MODE`      | `self-host`                                                        |
| `HOST`, `PORT`  | Where the API listens; `127.0.0.1` by default                      |
| `APP_URL`       | The address you open the app at                                    |
| `WEB_DEV_URL`   | The Vite dev server's address, allowed as an origin in development |
| `ALLOWED_HOSTS` | Extra host names the app accepts                                   |

## Database

| Variable                 | What it is                                                                 |
| ------------------------ | -------------------------------------------------------------------------- |
| `DATABASE_URL`           | The app's connection, under row-level security                             |
| `DATABASE_MIGRATION_URL` | The owner connection, for migrations and the few jobs that span workspaces |

## Secrets

| Variable              | What it is                                                    |
| --------------------- | ------------------------------------------------------------- |
| `AUTH_SECRET`         | Signs sessions: 32 random characters or more                  |
| `VAULT_KEY`           | 32 random bytes in base64; wraps every stored credential      |
| `VAULT_KEY_SOURCE`    | `keychain` to read the vault key from the OS keychain instead |
| `VAULT_PREVIOUS_KEYS` | Old keys during a rotation                                    |

## Models

| Variable                                                                           | What it is                                                  |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `LLM_PROVIDER`                                                                     | `openrouter`                                                |
| `LLM_API_KEY`                                                                      | A fallback key; each workspace can save its own in Settings |
| `LLM_MODELS_FAST`, `LLM_MODELS_STANDARD`, `LLM_MODELS_STRONG`, `LLM_MODELS_VISION` | The models of each tier, in fallback order                  |

## Services

| Variable                                                                      | What it is                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `SEARXNG_URL`                                                                 | The self-hosted web search                                         |
| `INNGEST_DEV`, `INNGEST_BASE_URL`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | The durable execution engine                                       |
| `SANDBOX_URL`, `SANDBOX_TOKEN`                                                | The agents' sandbox service and the token the app uses to reach it |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                                 | Where traces go, if anywhere                                       |
| `LOG_LEVEL`, `LOG_FORMAT`                                                     | How much the app logs, and in what form                            |
| `DB_MIGRATE_ON_START`                                                         | Apply migrations when the app starts (on in the bundle)            |

## The bundle

| Variable               | What it is                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `APP_PORT`             | The port on 127.0.0.1; change it together with `APP_URL`                                        |
| `SANDBOX_EGRESS_ALLOW` | Read by the egress proxy: the sites the agents' computers may reach; `*` allows any public site |

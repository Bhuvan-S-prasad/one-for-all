# syntax=docker/dockerfile:1
#
# The self-host app image: API + built web app in one Node process.
# Build from the repo root:
#
#   docker build -f infra/docker/app.Dockerfile -t one-for-all .
#   docker buildx build -f infra/docker/app.Dockerfile --platform linux/amd64,linux/arm64 .
#
# The build stage runs on the build machine's own architecture and produces
# plain JavaScript (the API bundled into one file, the web app as static
# files), so a multi-arch build compiles once and only the small runtime stage
# differs per architecture.

ARG NODE_VERSION=24

# ── Build ─────────────────────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS build
WORKDIR /repo

# Same pnpm version as `packageManager` in package.json. The store lives in a
# BuildKit cache mount, so rebuilds reuse downloaded packages.
RUN npm install --global pnpm@12.3.4
ENV PNPM_STORE=/pnpm-store

# Download dependencies using only the lockfile, so this layer is reused until
# the lockfile changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm fetch --store-dir "$PNPM_STORE"

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --offline --store-dir "$PNPM_STORE"

RUN pnpm --filter @ofa/web build && pnpm --filter @ofa/api build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime

ARG APP_VERSION=0.1.0

ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    # Listen on all interfaces inside the container. Compose publishes the
    # port on 127.0.0.1 only, so the app is still local-only (ADR-0017).
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIST_DIR=/app/web \
    MIGRATIONS_DIR=/app/migrations \
    DB_MIGRATE_ON_START=true \
    LOG_FORMAT=json \
    OFA_IN_CONTAINER=1

WORKDIR /app

# Files stay owned by root; the app runs as the unprivileged `node` user and
# cannot modify its own code.
COPY --from=build /repo/apps/api/dist/ ./
COPY --from=build /repo/apps/web/dist/ ./web/
COPY --from=build /repo/packages/db/migrations/ ./migrations/

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "--enable-source-maps", "server.js"]

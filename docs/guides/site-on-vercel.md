# Deploying the site on Vercel

The public site (`apps/site`, ADR-0046) is a static build: the landing page at `/` and the docs under `/docs`. It holds no server code and no secrets.

## Create the project

1. In Vercel, **Add New → Project** and import the GitHub repository.
2. **Root Directory:** `apps/site`. Leave **Include files outside the root directory in the Build Step** on (the default): the build reads `packages/` and `docs/adr`.
3. **Framework preset:** Vite. The rest comes from `apps/site/vercel.json`:
   - install: `pnpm install --frozen-lockfile`
   - build: `pnpm run build`
   - output: `dist`
   - every path is served `index.html`, so `/docs/...` links work on reload.
4. **Node.js version** (Project Settings → General): 24.x.
5. **pnpm 12:** add the environment variable `ENABLE_EXPERIMENTAL_COREPACK=1`, so Vercel uses the `packageManager` version from the root `package.json`.

No other environment variables are needed: the site reads nothing at runtime.

## Check locally first

```sh
pnpm --filter @ofa/site build
pnpm --filter @ofa/site preview    # http://localhost:4173
```

## Updating

Every push to the branch Vercel watches rebuilds the site. The decision records are read from `docs/adr` at build time, so a new ADR appears on the next deploy. Written docs pages live in `apps/site/src/docs/content`.

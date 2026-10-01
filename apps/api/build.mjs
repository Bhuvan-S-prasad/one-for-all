// Bundle the API and every dependency into dist/server.js. The Docker image
// then needs no node_modules at all, which keeps it small and arch-neutral
// (pure JavaScript; no native modules).
import { build } from "esbuild";

await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  legalComments: "linked",
  logLevel: "info",
  // Some dependencies are CommonJS and call require(); give ESM output one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});

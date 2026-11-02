import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The codebase explained (ADR-0051): a static build. The index of the source
// (src/generated) is made by scripts/index-repo.ts before Vite runs; the
// decision records are read from docs/adr, so the repository root must be
// readable by the dev server.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5181,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
});

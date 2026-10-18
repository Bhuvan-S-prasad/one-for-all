import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The public site (ADR-0046): a static build of the landing page and the docs.
// The docs read the decision records from docs/adr at build time, so the
// repository root must be readable by the dev server.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5180,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  build: {
    sourcemap: false,
  },
});

import path from "node:path";
import { defineConfig } from "vitest/config";

// Standalone test config (vite.config.ts stays build-only). Pure-logic tests
// run in node; DOM-dependent suites opt into jsdom per file via
// `// @vitest-environment jsdom`.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

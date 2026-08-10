import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Vitest config for the API test suite.
 *
 * The tests are "black-box" HTTP tests: they boot a real Next.js server on a
 * random port, point it at a fresh temp SQLite file, and assert on JSON
 * responses. Per the PRD, the REST API is the one seam we test through.
 */
export default defineConfig({
  test: {
    environment: "node",
    // Test files live next to the code they cover, named `*.test.ts`.
    include: ["src/**/*.test.ts", "tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Each test file gets its own worker so the per-file DB isolation is clean
    // and the Next server lifecycle is simple to reason about.
    fileParallelism: false,
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});

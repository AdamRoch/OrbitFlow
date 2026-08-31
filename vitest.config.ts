import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Vitest config for the API test suite.
 *
 * The Vitest suite covers browser components and PostgreSQL-backed contracts.
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

import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@threadline/api",
    // Same as packages/core: one migrated PGlite per run, a fresh copy per test.
    globalSetup: ["./src/test/global-setup.ts"],
    setupFiles: ["./src/test/cleanup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

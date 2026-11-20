import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@threadline/core",
    // Migrates one database per run; every test then loads its own copy of it.
    globalSetup: ["./src/db/test-global-setup.ts"],
    setupFiles: ["./src/db/test-cleanup.ts"],
    // A PGlite boot takes a second or two, more while every worker boots at once.
    // It runs in beforeEach in most files, so hooks get the same allowance as tests.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

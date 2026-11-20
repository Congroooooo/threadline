import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@threadline/core",
    // The first PGlite boot in each test file takes a few seconds.
    // It runs in beforeEach in most files, so hooks get the same allowance as tests.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

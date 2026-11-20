import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@threadline/core",
    // The first PGlite boot in each test file takes a few seconds.
    testTimeout: 30_000,
  },
});

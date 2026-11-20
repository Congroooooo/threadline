// The hook is tested with node:test (no install step); keep the root vitest run away from it.
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: [], passWithNoTests: true } });

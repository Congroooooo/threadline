// Vite's import.meta.glob, used only by db/testing.ts (which runs under Vitest) to load the
// SQL migrations without Node file APIs. Declared here so the package keeps `types: []`.
interface ImportMeta {
  glob<T>(
    pattern: string,
    options: { query: "?raw"; import: "default"; eager: true },
  ): Record<string, T>;
}

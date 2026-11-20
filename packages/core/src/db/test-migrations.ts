// The SQL migrations as a list, for test code only (Vite's import.meta.glob, no Node file APIs).
import { type Migration, migrationName } from "./migrate.js";

const files = import.meta.glob<string>("./migrations/*.sql", { query: "?raw", import: "default", eager: true });

/** Every SQL file in ./migrations, in name order. */
export const migrations: Migration[] = Object.entries(files)
  .map(([path, sql]) => ({ name: migrationName(path), sql }))
  .sort((a, b) => a.name.localeCompare(b.name));

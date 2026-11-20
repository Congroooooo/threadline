// `pnpm migrate`: applies packages/core/src/db/migrations/*.sql, in name order, to
// MIGRATION_DATABASE_URL (the database owner role, never app_user). The runner is the one
// the tests use (runMigrations in core); only reading the files from disk lives here.
//
//   MIGRATION_DATABASE_URL=postgres://owner:…@host/db pnpm migrate
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { type Migration, migrationName, runMigrations } from "../packages/core/src/db/migrate.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../packages/core/src/db/migrations");

function readMigrations(dir = DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: migrationName(f), sql: readFileSync(join(dir, f), "utf8") }));
}

async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is required (the owner role's connection string, not app_user's)");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // Simple-query protocol (no parameters): a multi-statement migration runs as one implicit transaction.
    const applied = await runMigrations(
      { exec: (sql) => client.query(sql), query: async <T>(sql: string) => (await client.query(sql)).rows as T[] },
      readMigrations(),
    );
    console.log(applied.length === 0 ? "migrations: up to date" : `migrations applied: ${applied.join(", ")}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

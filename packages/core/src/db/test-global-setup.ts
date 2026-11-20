// Vitest global setup: migrates one PGlite database once per test run and hands its data
// directory (gzipped tar, base64) to every worker, so test files load a migrated database
// instead of each running every migration again. See createTestDb in testing.ts.
import { PGlite } from "@electric-sql/pglite";
import type { TestProject } from "vitest/node";
import { runMigrations } from "./migrate.js";
import { migrations } from "./test-migrations.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** Base64 of a gzipped dump of a freshly migrated database. */
    pgliteTemplate: string;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export default async function setup(project: TestProject): Promise<void> {
  const pg = new PGlite();
  await runMigrations(
    { exec: (sql) => pg.exec(sql), query: async <T>(sql: string) => (await pg.query<T>(sql)).rows },
    migrations,
  );
  const dump = await pg.dumpDataDir("gzip");
  await pg.close();
  project.provide("pgliteTemplate", toBase64(new Uint8Array(await dump.arrayBuffer())));
}

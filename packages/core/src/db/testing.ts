// Test helpers. Imported as `@threadline/core/testing`, never from the main entry.
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { inject } from "vitest";
import type { EventInput } from "../events.js";
import { newId } from "../ids.js";
import { type Db, withSystem } from "./client.js";
import { MIGRATIONS_TABLE, runMigrations } from "./migrate.js";
import * as schema from "./schema.js";
import { users, workspaces } from "./schema.js";
import { migrations } from "./test-migrations.js";

export { migrations };

const clients = new WeakMap<Db, PGlite>();

function client(db: Db): PGlite {
  const pg = clients.get(db);
  if (!pg) throw new Error("not a database from createTestDb()");
  return pg;
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type Dump = NonNullable<PGliteOptions["loadDataDir"]>;

let template: Promise<Dump> | undefined;
const open = new Set<PGlite>();

/**
 * A dump of a migrated database. The global setup (test-global-setup.ts) migrates once per
 * test run and provides the dump to every worker; a project without that setup migrates once
 * per test file instead. Each test then loads its own copy, so tests stay isolated.
 */
function migratedTemplate(): Promise<Dump> {
  template ??= (async () => {
    const provided = inject("pgliteTemplate");
    if (provided) return new (globalThis as unknown as { Blob: new (parts: Uint8Array[]) => Dump }).Blob([fromBase64(provided)]);
    const pg = new PGlite();
    await runMigrations(
      {
        exec: (sql) => pg.exec(sql),
        query: async <T>(sql: string) => (await pg.query<T>(sql)).rows,
      },
      migrations,
    );
    const dump = await pg.dumpDataDir("gzip");
    await pg.close();
    return dump;
  })();
  return template;
}

/**
 * A fresh in-memory database with all migrations applied by the owner (PGlite's superuser).
 * The connection then switches to `app_user` for the rest of its life, so every query made
 * through the returned `Db` is subject to row-level security and app_user's grants.
 */
export async function createTestDb(): Promise<Db> {
  const pg = await PGlite.create({ loadDataDir: await migratedTemplate() });
  open.add(pg);
  await pg.exec("SET ROLE app_user");
  const db: Db = drizzle({ client: pg, schema });
  clients.set(db, pg);
  return db;
}

/** Closes every database createTestDb opened. Run after each test (see test-cleanup.ts). */
export async function closeTestDbs(): Promise<void> {
  const all = [...open];
  open.clear();
  await Promise.all(all.map((pg) => pg.close()));
}

/** Runs one statement as the owner (superuser in PGlite, so RLS does not apply). */
export async function rawQuery(db: Db, sql: string): Promise<any[]> {
  return client(db).transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE NONE");
    return (await tx.query(sql)).rows;
  });
}

/** Fails for any table in `public`, other than `_migrations`, without enabled and forced RLS. */
export async function assertAllTablesHaveForcedRls(db: Db): Promise<void> {
  const rows: { relname: string }[] = await rawQuery(
    db,
    `SELECT c.relname FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relkind IN ('r', 'p')
        AND c.relname <> '${MIGRATIONS_TABLE}'
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
      ORDER BY c.relname`,
  );
  if (rows.length > 0) {
    throw new Error(`tables without forced row-level security: ${rows.map((r) => r.relname).join(", ")}`);
  }
}

/** Creates two workspaces and returns their ids. */
export async function seedTwoWorkspaces(db: Db): Promise<[string, string]> {
  const a = newId();
  const b = newId();
  await withSystem(db, (tx) =>
    tx.insert(workspaces).values([
      { id: a, name: "Workspace A" },
      { id: b, name: "Workspace B" },
    ]),
  );
  return [a, b];
}

/** Creates a user account without a sign-in identity (see findOrCreateUser) and returns its id. */
export async function seedUser(db: Db, displayName = "Test User"): Promise<string> {
  const id = newId();
  await withSystem(db, (tx) => tx.insert(users).values({ id, displayName }));
  return id;
}

/** An event by a member of `workspaceId`. */
export function sampleEvent(workspaceId: string): EventInput {
  return {
    actor: { kind: "member", workspaceId, memberId: newId() },
    type: "test.sample",
    subjectKind: "test",
    subjectId: newId(),
    data: { sample: true },
  };
}

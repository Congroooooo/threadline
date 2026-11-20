// Test helpers. Imported as `@threadline/core/testing`, never from the main entry.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { EventInput } from "../events.js";
import { newId } from "../ids.js";
import { type Db, withSystem } from "./client.js";
import { MIGRATIONS_TABLE, type Migration, migrationName, runMigrations } from "./migrate.js";
import * as schema from "./schema.js";
import { users, workspaces } from "./schema.js";

const files = import.meta.glob<string>("./migrations/*.sql", { query: "?raw", import: "default", eager: true });

/** Every SQL file in ./migrations, in name order. */
export const migrations: Migration[] = Object.entries(files)
  .map(([path, sql]) => ({ name: migrationName(path), sql }))
  .sort((a, b) => a.name.localeCompare(b.name));

const clients = new WeakMap<Db, PGlite>();

function client(db: Db): PGlite {
  const pg = clients.get(db);
  if (!pg) throw new Error("not a database from createTestDb()");
  return pg;
}

let template: Promise<PGlite> | undefined;

/** One migrated database per test file; each test gets a clone (much faster than initdb). */
function migratedTemplate(): Promise<PGlite> {
  template ??= (async () => {
    const pg = new PGlite();
    await runMigrations(
      {
        exec: (sql) => pg.exec(sql),
        query: async <T>(sql: string) => (await pg.query<T>(sql)).rows,
      },
      migrations,
    );
    return pg;
  })();
  return template;
}

/**
 * A fresh in-memory database with all migrations applied by the owner (PGlite's superuser).
 * The connection then switches to `app_user` for the rest of its life, so every query made
 * through the returned `Db` is subject to row-level security and app_user's grants.
 */
export async function createTestDb(): Promise<Db> {
  // clone() is typed as the interface but returns a PGlite instance.
  const pg = (await (await migratedTemplate()).clone()) as PGlite;
  await pg.exec("SET ROLE app_user");
  const db: Db = drizzle({ client: pg, schema });
  clients.set(db, pg);
  return db;
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

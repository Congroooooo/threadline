export type Migration = { name: string; sql: string };

/** The two things the runner needs from a connection that runs as the table owner. */
export type MigrationExecutor = {
  /** Runs one or more statements with no parameters. */
  exec(sql: string): Promise<unknown>;
  /** Runs a single statement and returns its rows. */
  query<T>(sql: string): Promise<T[]>;
};

/**
 * Bookkeeping table for applied migrations. It is owned by the migration role, has no
 * grants for app_user and holds no workspace data, so it is the one table excluded from
 * the forced-RLS check in testing.ts.
 */
export const MIGRATIONS_TABLE = "_migrations";

const NAME = /^\d{4}_[a-z0-9_]+$/;

/** Turns `./migrations/0001_init.sql` into `0001_init`. */
export function migrationName(path: string): string {
  const name = path.replace(/^.*[\\/]/, "").replace(/\.sql$/, "");
  if (!NAME.test(name)) throw new Error(`bad migration file name: ${path}`);
  return name;
}

/**
 * Applies, in name order, every migration not yet recorded in `_migrations`. Each one runs
 * with its bookkeeping row in a single transaction. Returns the names it applied.
 * Not safe to run concurrently against one database.
 */
export async function runMigrations(db: MigrationExecutor, migrations: Migration[]): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    REVOKE ALL ON ${MIGRATIONS_TABLE} FROM PUBLIC;
  `);
  const done = new Set(
    (await db.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`)).map((r) => r.name),
  );
  const pending = [...migrations].sort((a, b) => a.name.localeCompare(b.name)).filter((m) => !done.has(m.name));
  const applied: string[] = [];
  for (const m of pending) {
    if (!NAME.test(m.name)) throw new Error(`bad migration name: ${m.name}`);
    // One multi-statement simple query runs as a single implicit transaction and rolls
    // back entirely on error. Migrations must not contain BEGIN/COMMIT themselves.
    await db.exec(`${m.sql}\n;INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ('${m.name}');`);
    applied.push(m.name);
  }
  return applied;
}

import { Pool } from "@neondatabase/serverless";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

export type Schema = typeof schema;

/** Any Drizzle Postgres database over the Threadline schema (Neon, node-postgres or PGlite). */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

/** A transaction opened by `withWorkspace` or `withSystem`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Production driver: Neon over WebSockets (interactive transactions are required by
 * `withWorkspace`, so not the HTTP driver). Connect as `app_user`. On Workers create one
 * per request and call `close()` through `waitUntil`.
 */
export function createDb(connectionString: string): { db: Db; close(): Promise<void> } {
  const pool = new Pool({ connectionString });
  const db = drizzle({ client: pool, schema });
  return { db, close: () => pool.end() };
}

/** Runs `fn` in a transaction scoped to one workspace by row-level security. */
export function withWorkspace<T>(db: Db, workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    return fn(tx);
  });
}

/**
 * Runs `fn` in a transaction allowed to cross workspaces on the account tables only
 * (session and token resolution, workspace creation). Workspace data stays hidden.
 */
export function withSystem<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.system', 'on', true)`);
    return fn(tx);
  });
}

/**
 * Startup and health guard: row-level security only protects anything if the application's
 * database role is not a superuser, has no BYPASSRLS and owns no tables in `public` (owners
 * skip unforced policies, and could drop them). Privileges reachable through role membership
 * count too: the role fails if it is a member of any superuser or BYPASSRLS role, or of any
 * role that owns a table in `public`. Returns what is wrong, without throwing.
 */
export async function checkDatabaseRole(db: Db): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await db.execute(sql`
    select current_user::text as role,
           (select string_agg(x.rolname, ', ' order by x.rolname) from pg_roles x
             where x.rolsuper and pg_has_role(current_user, x.oid, 'MEMBER')) as superuser,
           (select string_agg(x.rolname, ', ' order by x.rolname) from pg_roles x
             where x.rolbypassrls and pg_has_role(current_user, x.oid, 'MEMBER')) as bypassrls,
           (select count(*)::int from pg_class c
             where c.relnamespace = 'public'::regnamespace
               and c.relkind in ('r', 'p')
               and pg_has_role(current_user, c.relowner, 'MEMBER')) as owned`);
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  const row = rows[0] as { role: string; superuser: string | null; bypassrls: string | null; owned: number } | undefined;
  if (!row) return { ok: false, reason: "current database role not found" };
  const via = (roles: string) => (roles.split(", ").includes(row.role) ? "" : ` through membership of ${roles}`);
  if (row.superuser) return { ok: false, reason: `database role ${row.role} is a superuser${via(row.superuser)}` };
  if (row.bypassrls) return { ok: false, reason: `database role ${row.role} has BYPASSRLS${via(row.bypassrls)}` };
  if (Number(row.owned) > 0) {
    return { ok: false, reason: `database role ${row.role} owns ${row.owned} tables in public (directly or through membership)` };
  }
  return { ok: true };
}

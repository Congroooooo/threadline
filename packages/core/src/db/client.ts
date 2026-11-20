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

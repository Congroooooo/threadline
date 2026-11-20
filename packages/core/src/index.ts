export * from "./ids.js";
export * from "./types.js";
export * from "./safety.js";
export { createDb, withSystem, withWorkspace, type Db, type Schema, type Tx } from "./db/client.js";
// Tables stay internal: apps go through withWorkspace and core functions, never Drizzle tables.
export type { EventRow, WorkspaceRow } from "./db/schema.js";
export { runMigrations, migrationName, MIGRATIONS_TABLE, type Migration, type MigrationExecutor } from "./db/migrate.js";
export { recordEvent, listEvents, DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT, type EventInput } from "./events.js";

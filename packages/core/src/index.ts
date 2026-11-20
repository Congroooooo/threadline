export * from "./ids.js";
export * from "./types.js";
export * from "./safety.js";
export { createDb, withSystem, withWorkspace, type Db, type Schema, type Tx } from "./db/client.js";
// Tables stay internal: apps go through withWorkspace and core functions, never Drizzle tables.
export type {
  AgentIdentityRow,
  EventRow,
  InviteRow,
  MemberRow,
  RoleRow,
  SessionRow,
  UserIdentityRow,
  UserRow,
  WorkspaceRow,
} from "./db/schema.js";
export { runMigrations, migrationName, MIGRATIONS_TABLE, type Migration, type MigrationExecutor } from "./db/migrate.js";
export { recordEvent, listEvents, DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT, type EventInput } from "./events.js";
export {
  ROLE_TEMPLATES,
  ROLE_KEY,
  createWorkspace,
  addMember,
  setMemberRoles,
  removeMember,
  listMembers,
  upsertRole,
  archiveRole,
  restoreRole,
  listRoles,
  membersWithRole,
  can,
  requirePermission,
} from "./tenancy.js";
export {
  PROVIDERS,
  SESSION_DAYS,
  findOrCreateUser,
  createSession,
  resolveSession,
  listMemberships,
  createAgentToken,
  revokeAgentToken,
  resolveAgentToken,
  type Provider,
} from "./auth.js";
export { DEFAULT_INVITE_DAYS, MAX_INVITE_DAYS, createInvite, acceptInvite, revokeInvite } from "./invites.js";

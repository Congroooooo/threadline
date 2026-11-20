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
export {
  PROJECT_KEY,
  MAX_REPO_URLS,
  createProject,
  updateProjectConfig,
  findProjectByRepoUrl,
  getProject,
  normalizeRepoUrl,
  type NotifierConfig,
} from "./projects.js";
// getTask, getHandoff and the raw row types stay internal: apps read views from context.ts.
export {
  TASK_STATUSES,
  EVIDENCE_KINDS,
  MAX_DEPENDENCIES,
  MAX_EVIDENCE,
  createTask,
  setTaskStatus,
  addDependency,
  removeDependency,
  blockedBy,
  resolveTaskRef,
  startRun,
  finishRun,
  reportProgress,
  type TaskStatus,
  type RunStatus,
} from "./work.js";
export {
  createHandoff, respondToHandoff, raiseBlocker, setBlockerCause, resolveBlocker, getBlocker,
  type BlockerStatus, type CauseStatus, type HandoffStatus,
} from "./coordination.js";
export {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_QUERY,
  MAX_CONTEXT_PROGRESS,
  SESSION_CONTEXT_FIRST_LINE,
  SESSION_CONTEXT_EMPTY,
  SESSION_CONTEXT_MAX,
  myOpenItems,
  getTaskContext,
  getByRef,
  search,
  renderSessionContext,
  type BlockerView,
  type HandoffView,
  type OpenItems,
  type ProgressView,
  type SearchHit,
  type TaskContext,
  type TaskView,
} from "./context.js";
export { createNotifier, notifyProject, handoffMessage, blockerMessage, type Notifier } from "./notify/index.js";

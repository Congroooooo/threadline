import { index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { Permission } from "../types.js";

// Column shapes only. Row-level security, policies and grants live in the
// hand-written SQL migrations under ./migrations, which are the source of truth.

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    projectId: uuid("project_id"),
    actorKind: text("actor_kind", { enum: ["member", "agent", "connection"] }).notNull(),
    actorId: uuid("actor_id").notNull(),
    type: text("type").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("events_workspace_id_idx").on(t.workspaceId, t.id),
    index("events_workspace_project_id_idx").on(t.workspaceId, t.projectId, t.id),
  ],
);

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  displayName: text("display_name").notNull(),
  email: text("email"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const members = pgTable(
  "members",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    displayName: text("display_name").notNull(),
    status: text("status", { enum: ["active", "removed"] }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id), unique().on(t.workspaceId, t.userId)],
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    permissions: text("permissions").array().$type<Permission[]>().notNull().default([]),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id), unique().on(t.workspaceId, t.key)],
);

/** A null projectId means every project. Rows are revoked, never deleted. */
export const memberRoles = pgTable("member_roles", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  memberId: uuid("member_id").notNull(),
  roleId: uuid("role_id").notNull(),
  projectId: uuid("project_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type MemberRow = typeof members.$inferSelect;
export type RoleRow = typeof roles.$inferSelect;

export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").primaryKey(),
    provider: text("provider", { enum: ["github", "gitlab", "local"] }).notNull(),
    providerUserId: text("provider_user_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.provider, t.providerUserId)],
);

/** Keyed by the SHA-256 hex of the session token; the token itself is never stored. */
export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** tokenHash is null only for revoked tokens imported from another deployment. */
export const agentIdentities = pgTable("agent_identities", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  memberId: uuid("member_id").notNull(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").unique(),
  projectIds: uuid("project_ids").array().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** codeHash is null only for invites imported from another deployment. */
export const invites = pgTable("invites", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  codeHash: text("code_hash").unique(),
  roleKeys: text("role_keys").array().notNull().default([]),
  projectId: uuid("project_id"),
  createdBy: uuid("created_by").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedBy: uuid("used_by"),
  usedAt: timestamp("used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserIdentityRow = typeof userIdentities.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type AgentIdentityRow = typeof agentIdentities.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.id), unique().on(t.workspaceId, t.key)],
);

/** notifier holds a webhook URL (a secret); approval and tracker are validated from Phase 3. */
export const projectConfig = pgTable("project_config", {
  projectId: uuid("project_id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  repoUrls: text("repo_urls").array().notNull().default([]),
  notifier: jsonb("notifier").$type<{ kind: "mattermost" | "slack"; webhookUrl: string }>(),
  approval: jsonb("approval").$type<Record<string, unknown>>().notNull(),
  tracker: jsonb("tracker").$type<Record<string, unknown>>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProjectRow = typeof projects.$inferSelect;

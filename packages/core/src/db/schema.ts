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

import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type EventRow = typeof events.$inferSelect;

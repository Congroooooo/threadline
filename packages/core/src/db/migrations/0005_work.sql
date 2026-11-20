-- 0005_work: tasks, their dependencies, runs, progress notes, evidence and handoffs.
-- "Blocked" is computed from dependencies (and, later, blockers); it is never stored.
-- Composite foreign keys carrying workspace_id (and project_id where it matters) keep
-- every reference inside one workspace, and dependencies and handoffs inside one project.

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid NOT NULL,
  number integer NOT NULL CHECK (number > 0),
  title text NOT NULL CHECK (title <> ''),
  description text,
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'in_review', 'done')),
  owner_role_id uuid NOT NULL,
  branch text,
  -- The member who created it, directly or through one of their agents.
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, project_id, id),
  UNIQUE (project_id, number),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  FOREIGN KEY (workspace_id, owner_role_id) REFERENCES roles (workspace_id, id),
  FOREIGN KEY (workspace_id, created_by) REFERENCES members (workspace_id, id)
);

-- Edges are never deleted: removing one sets removed_at, and re-adding inserts a new row.
CREATE TABLE task_dependencies (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  depends_on_task_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CHECK (task_id <> depends_on_task_id),
  FOREIGN KEY (workspace_id, project_id, task_id) REFERENCES tasks (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, depends_on_task_id) REFERENCES tasks (workspace_id, project_id, id)
);
CREATE UNIQUE INDEX task_dependencies_current_idx
  ON task_dependencies (task_id, depends_on_task_id) WHERE removed_at IS NULL;
CREATE INDEX task_dependencies_depends_on_idx
  ON task_dependencies (depends_on_task_id) WHERE removed_at IS NULL;

CREATE TABLE runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  task_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('member', 'agent', 'connection')),
  actor_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((status = 'running') = (finished_at IS NULL)),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, task_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id)
);
CREATE INDEX runs_task_idx ON runs (task_id);

-- Append-only.
CREATE TABLE progress_notes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  task_id uuid NOT NULL,
  run_id uuid,
  note text NOT NULL CHECK (note <> ''),
  actor_kind text NOT NULL CHECK (actor_kind IN ('member', 'agent', 'connection')),
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id),
  -- A note's run must be a run of the same task (ignored when run_id is null).
  FOREIGN KEY (workspace_id, task_id, run_id) REFERENCES runs (workspace_id, task_id, id)
);
CREATE INDEX progress_notes_task_idx ON progress_notes (task_id, id);

CREATE TABLE handoffs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  from_actor_kind text NOT NULL CHECK (from_actor_kind IN ('member', 'agent', 'connection')),
  from_actor_id uuid NOT NULL,
  to_role_id uuid NOT NULL,
  delivered text NOT NULL CHECK (delivered <> ''),
  required_action text NOT NULL CHECK (required_action <> ''),
  known_limits text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'needs_changes')),
  idempotency_key text,
  responded_by uuid,
  response_note text,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pending') = (responded_by IS NULL)),
  CHECK (status <> 'needs_changes' OR response_note IS NOT NULL),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id, task_id) REFERENCES tasks (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, to_role_id) REFERENCES roles (workspace_id, id),
  FOREIGN KEY (workspace_id, responded_by) REFERENCES members (workspace_id, id)
);
CREATE UNIQUE INDEX handoffs_idempotency_idx
  ON handoffs (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX handoffs_task_idx ON handoffs (task_id);
CREATE INDEX handoffs_pending_role_idx ON handoffs (workspace_id, to_role_id) WHERE status = 'pending';

-- External things attached to a task, handoff or progress note. Append-only. connection_id
-- will reference connections once they exist; it is not a foreign key yet.
CREATE TABLE evidence (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('task', 'handoff', 'progress')),
  subject_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('change_request', 'commit', 'pipeline_run', 'deployment', 'ticket', 'file', 'message')),
  url text NOT NULL CHECK (url <> ''),
  external_id text,
  version text,
  connection_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id)
);
CREATE INDEX evidence_subject_idx ON evidence (subject_kind, subject_id, id);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tasks_workspace ON tasks
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE task_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_dependencies FORCE ROW LEVEL SECURITY;
CREATE POLICY task_dependencies_workspace ON task_dependencies
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs FORCE ROW LEVEL SECURITY;
CREATE POLICY runs_workspace ON runs
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE progress_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE progress_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY progress_notes_workspace ON progress_notes
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY handoffs_workspace ON handoffs
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_workspace ON evidence
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

-- Records are never deleted, so no DELETE grants. Progress notes and evidence are
-- append-only, so no UPDATE either.
GRANT SELECT, INSERT, UPDATE ON tasks TO app_user;
GRANT SELECT, INSERT, UPDATE ON task_dependencies TO app_user;
GRANT SELECT, INSERT, UPDATE ON runs TO app_user;
GRANT SELECT, INSERT ON progress_notes TO app_user;
GRANT SELECT, INSERT, UPDATE ON handoffs TO app_user;
GRANT SELECT, INSERT ON evidence TO app_user;

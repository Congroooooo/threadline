-- 0006_blockers: what is in the way of a project or one of its tasks.
-- cause_status says how far the cause is known: none, suspected (anyone may say so) or
-- verified (only a member). A blocker is open until resolved; records are never deleted.

CREATE TABLE blockers (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid NOT NULL,
  task_id uuid,
  observed text NOT NULL CHECK (observed <> ''),
  cause text,
  cause_status text NOT NULL DEFAULT 'none' CHECK (cause_status IN ('none', 'suspected', 'verified')),
  cause_verified_by uuid,
  owner_role_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  raised_by_kind text NOT NULL CHECK (raised_by_kind IN ('member', 'agent', 'connection')),
  raised_by_id uuid NOT NULL,
  resolved_by_kind text CHECK (resolved_by_kind IN ('member', 'agent', 'connection')),
  resolved_by uuid,
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((cause_status = 'none') = (cause IS NULL)),
  CHECK ((cause_status = 'verified') = (cause_verified_by IS NOT NULL)),
  CHECK ((status = 'resolved') = (resolved_by IS NOT NULL)),
  CHECK ((status = 'resolved') = (resolved_by_kind IS NOT NULL)),
  CHECK ((status = 'resolved') = (resolution IS NOT NULL)),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  -- A blocker's task must belong to the blocker's project (ignored when task_id is null).
  FOREIGN KEY (workspace_id, project_id, task_id) REFERENCES tasks (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, owner_role_id) REFERENCES roles (workspace_id, id),
  FOREIGN KEY (workspace_id, cause_verified_by) REFERENCES members (workspace_id, id)
);
CREATE INDEX blockers_task_open_idx ON blockers (task_id) WHERE status = 'open' AND task_id IS NOT NULL;
CREATE INDEX blockers_project_open_idx ON blockers (project_id) WHERE status = 'open';

ALTER TABLE blockers ENABLE ROW LEVEL SECURITY;
ALTER TABLE blockers FORCE ROW LEVEL SECURITY;
CREATE POLICY blockers_workspace ON blockers
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON blockers TO app_user;

-- Blockers can carry evidence too.
ALTER TABLE evidence DROP CONSTRAINT evidence_subject_kind_check;
ALTER TABLE evidence ADD CONSTRAINT evidence_subject_kind_check
  CHECK (subject_kind IN ('task', 'handoff', 'progress', 'blocker'));

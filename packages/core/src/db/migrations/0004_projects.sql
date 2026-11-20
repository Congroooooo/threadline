-- 0004_projects: projects and their configuration. Phase 0 only stores `approval` and
-- `tracker`; later phases read and validate them. `notifier` holds a webhook URL, which is
-- a secret: core never returns it, only whether one is configured.

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  key text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name text NOT NULL CHECK (name <> ''),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, key)
);

CREATE TABLE project_config (
  project_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  repo_urls text[] NOT NULL DEFAULT '{}',
  notifier jsonb,
  approval jsonb NOT NULL DEFAULT '{"requirements":{"roleKey":"approver","count":1}}',
  tracker jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id)
);
CREATE INDEX project_config_repo_urls_idx ON project_config USING gin (repo_urls);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY projects_workspace ON projects
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE project_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_config FORCE ROW LEVEL SECURITY;
CREATE POLICY project_config_workspace ON project_config
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

-- Records are never deleted, so no DELETE grants.
GRANT SELECT, INSERT, UPDATE ON projects TO app_user;
GRANT SELECT, INSERT, UPDATE ON project_config TO app_user;

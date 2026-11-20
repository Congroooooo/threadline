-- 0001_init: workspaces, the event log, the app_user role and forced row-level security.
--
-- Run as the table owner. Application code connects as app_user, which is not
-- superuser, has no BYPASSRLS and owns nothing, so every policy below applies to it.
-- Production creates app_user (with a password) in the Neon console; this only
-- creates it where it is missing, without a password.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('member', 'agent', 'connection', 'system')),
  actor_id uuid NOT NULL,
  type text NOT NULL,
  subject_kind text NOT NULL,
  subject_id uuid NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_workspace_id_idx ON events (workspace_id, id);
CREATE INDEX events_workspace_project_id_idx ON events (workspace_id, project_id, id);

-- Settings are read with missing_ok and NULLIF so that a connection outside
-- withWorkspace / withSystem (setting absent, or reset to '') matches no rows
-- instead of raising an error.

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_access ON workspaces
  USING (
    id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    OR current_setting('app.system', true) = 'on'
  )
  WITH CHECK (
    id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    OR current_setting('app.system', true) = 'on'
  );

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;
CREATE POLICY events_workspace ON events
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

-- Records are never deleted. The event log is append-only.
GRANT SELECT, INSERT, UPDATE ON workspaces TO app_user;
GRANT SELECT, INSERT ON events TO app_user;

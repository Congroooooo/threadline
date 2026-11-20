-- 0002_tenancy: users (account data), members, roles and role assignments (workspace data).

CREATE TABLE users (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE members (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  user_id uuid NOT NULL REFERENCES users (id),
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, user_id)
);
CREATE INDEX members_user_id_idx ON members (user_id);

CREATE TABLE roles (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  name text NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, key)
);

-- Assignments are never deleted: replacing a member's roles sets revoked_at on the old rows.
-- A null project_id means every project. The composite keys keep a member and a role in
-- the assignment's own workspace.
CREATE TABLE member_roles (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  member_id uuid NOT NULL,
  role_id uuid NOT NULL,
  project_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  FOREIGN KEY (workspace_id, member_id) REFERENCES members (workspace_id, id),
  FOREIGN KEY (workspace_id, role_id) REFERENCES roles (workspace_id, id)
);
CREATE UNIQUE INDEX member_roles_current_idx
  ON member_roles (member_id, role_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;
CREATE INDEX member_roles_role_idx ON member_roles (workspace_id, role_id) WHERE revoked_at IS NULL;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_system ON users
  USING (current_setting('app.system', true) = 'on')
  WITH CHECK (current_setting('app.system', true) = 'on');

ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE members FORCE ROW LEVEL SECURITY;
CREATE POLICY members_workspace ON members
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_workspace ON roles
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE member_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY member_roles_workspace ON member_roles
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

-- Records are never deleted, so no DELETE grants.
GRANT SELECT, INSERT, UPDATE ON users TO app_user;
GRANT SELECT, INSERT, UPDATE ON members TO app_user;
GRANT SELECT, INSERT, UPDATE ON roles TO app_user;
GRANT SELECT, INSERT, UPDATE ON member_roles TO app_user;

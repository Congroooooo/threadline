-- 0003_auth: sign-in identities and sessions (account data), agent tokens and invites
-- (workspace data). Tokens and codes are stored only as SHA-256 hex.

CREATE TABLE user_identities (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('github', 'gitlab', 'local')),
  provider_user_id text NOT NULL CHECK (provider_user_id <> ''),
  user_id uuid NOT NULL REFERENCES users (id),
  -- The provider's current login (GitHub login, GitLab username), refreshed at each sign-in.
  -- Used only to match WORKSPACE_CREATORS; the stable key is provider_user_id.
  login text CHECK (login <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX user_identities_user_id_idx ON user_identities (user_id);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES users (id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- token_hash is always set on creation. It is nullable only so a workspace imported from
-- another deployment can carry revoked tokens without hashes; a null hash never matches.
CREATE TABLE agent_identities (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  member_id uuid NOT NULL,
  name text NOT NULL,
  token_hash text UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  project_ids uuid[] NOT NULL CHECK (cardinality(project_ids) > 0),
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, member_id) REFERENCES members (workspace_id, id)
);
CREATE INDEX agent_identities_member_idx ON agent_identities (workspace_id, member_id);

-- code_hash is nullable for the same import reason. used_by is the member the invite
-- created or reactivated; the key is deferred so the invite can be claimed before the
-- member row is written in the same transaction.
CREATE TABLE invites (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  code_hash text UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  role_keys text[] NOT NULL DEFAULT '{}',
  project_id uuid,
  created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_by uuid,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, created_by) REFERENCES members (workspace_id, id),
  FOREIGN KEY (workspace_id, used_by) REFERENCES members (workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX invites_workspace_idx ON invites (workspace_id, created_at);

ALTER TABLE user_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY user_identities_system ON user_identities
  USING (current_setting('app.system', true) = 'on')
  WITH CHECK (current_setting('app.system', true) = 'on');

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_system ON sessions
  USING (current_setting('app.system', true) = 'on')
  WITH CHECK (current_setting('app.system', true) = 'on');

-- Workspace tables. withSystem may additionally READ the one agent identity or invite
-- whose hash it names in app.lookup_hash (set transaction-local by resolveAgentToken and
-- acceptInvite only), so a token or code can be resolved before its workspace is known.
-- An absent or empty setting, or a NULL stored hash, matches nothing. System may not write
-- these tables: resolution then sets app.workspace_id to the row's workspace and writes
-- under the workspace policy (last_used_at, claiming an invite).
ALTER TABLE agent_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_identities_workspace ON agent_identities
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY agent_identities_system_lookup ON agent_identities FOR SELECT
  USING (
    current_setting('app.system', true) = 'on'
    AND token_hash = NULLIF(current_setting('app.lookup_hash', true), '')
  );

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE ROW LEVEL SECURITY;
CREATE POLICY invites_workspace ON invites
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY invites_system_lookup ON invites FOR SELECT
  USING (
    current_setting('app.system', true) = 'on'
    AND code_hash = NULLIF(current_setting('app.lookup_hash', true), '')
  );

-- listMemberships: withSystem may read one user's own member rows, named by app.user_id.
CREATE POLICY members_system_own ON members FOR SELECT
  USING (
    current_setting('app.system', true) = 'on'
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- Records are never deleted, so no DELETE grants.
GRANT SELECT, INSERT, UPDATE ON user_identities TO app_user;
GRANT SELECT, INSERT, UPDATE ON sessions TO app_user;
GRANT SELECT, INSERT, UPDATE ON agent_identities TO app_user;
GRANT SELECT, INSERT, UPDATE ON invites TO app_user;

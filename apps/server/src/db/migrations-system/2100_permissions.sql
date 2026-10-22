-- System DB — roles and per-resource grants (ARCHITECTURE_DELTA §4.1 `2100_permissions`, §5.1; PRD AOS-2.14, 18.6,
-- 21.18, 21.37). P1-T4 step 1, release R1-c. The one policy that reads them is modules/authz (rules/channels.ts).
--
-- 'student' is not a row here: it is an approved channel_membership. Roles inherit down the tree (channel_closure): a
-- role on a university applies to every subject under it, and never to a sibling.
CREATE TABLE role_assignment (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES channel_node(id),
  user_id TEXT NOT NULL REFERENCES user_account(id),
  role TEXT NOT NULL CHECK (role IN ('admin','assistant','subject_moderator','contributor')),
  granted_by TEXT NOT NULL REFERENCES user_account(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT REFERENCES user_account(id)
) STRICT;
CREATE UNIQUE INDEX idx_role_active ON role_assignment(node_id, user_id, role) WHERE revoked_at IS NULL;
CREATE INDEX idx_role_user ON role_assignment(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_role_node ON role_assignment(node_id) WHERE revoked_at IS NULL;

-- «Shared with specific users» and per-resource grants (publications, collaborative copies, recording shares, rooms;
-- used from P1-T5 / Phase 2 on)
CREATE TABLE acl_grant (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('publication','collab_doc','recording_share','room')),
  resource_db TEXT NOT NULL,                         -- 'system' or the id of the space holding the resource
  resource_id TEXT NOT NULL,
  grantee_user_id TEXT NOT NULL REFERENCES user_account(id),
  permission TEXT NOT NULL CHECK (permission IN ('view','comment','suggest','edit','manage')),
  granted_by TEXT NOT NULL REFERENCES user_account(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
) STRICT;
CREATE UNIQUE INDEX idx_acl_active ON acl_grant(resource_type, resource_db, resource_id, grantee_user_id, permission) WHERE revoked_at IS NULL;
CREATE INDEX idx_acl_grantee ON acl_grant(grantee_user_id) WHERE revoked_at IS NULL;

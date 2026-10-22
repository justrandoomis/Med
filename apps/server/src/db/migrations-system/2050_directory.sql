-- System DB — the university tree, joining and course follows (ARCHITECTURE_DELTA §4.1 `2050_directory`; PRD AOS-2.1,
-- 2.11–2.16, 18.2, 18.5, 21.2–21.6). P1-T4 step 1, release R1-c.
--
-- University → College → Department → Stage → Academic Year → Course (Semester/Course) → Subject. Kinds strictly
-- descend in this order; a level may be skipped (a college without departments). Enforced by modules/channels
-- (zod + parent-kind check), tested in test/channels/tree.test.ts. A root node is always a university, created by the
-- platform admin (PRD Q4).
CREATE TABLE channel_node (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES channel_node(id),
  kind TEXT NOT NULL CHECK (kind IN ('university','college','department','stage','academic_year','course','subject')),
  title TEXT NOT NULL,                               -- Arabic display title (no bidi controls: AC-20)
  title_en TEXT,
  ordinal INTEGER,                                   -- stage number / manual order
  starts_on TEXT,                                    -- academic_year and course: YYYY-MM-DD
  ends_on TEXT,
  space_id TEXT REFERENCES space(id),                -- subject: its own space (one space per subject, PRD Q36)
  join_policy TEXT NOT NULL DEFAULT 'approval' CHECK (join_policy IN ('closed','approval','open_with_code')),
  rights_json TEXT NOT NULL DEFAULT '{"official_files":"members_only"}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by TEXT NOT NULL REFERENCES user_account(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE INDEX idx_channel_node_parent ON channel_node(parent_id, ordinal);
CREATE UNIQUE INDEX idx_channel_node_space ON channel_node(space_id) WHERE space_id IS NOT NULL;

-- closure table: «is X inside Y» in one indexed lookup (membership and role inheritance down the tree). Every node has
-- its self row (depth 0); a move rewrites the rows of the moved subtree in one transaction.
CREATE TABLE channel_closure (
  ancestor_id TEXT NOT NULL REFERENCES channel_node(id),
  descendant_id TEXT NOT NULL REFERENCES channel_node(id),
  depth INTEGER NOT NULL CHECK (depth >= 0),
  PRIMARY KEY (ancestor_id, descendant_id)
) STRICT;
CREATE INDEX idx_channel_closure_desc ON channel_closure(descendant_id, depth);

-- class codes and invite links. Only an HMAC of the normalised secret is kept (keyed by the server secret, so a copy of
-- this database alone cannot be brute-forced offline); the plaintext is shown once to whoever created it.
CREATE TABLE join_code (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES channel_node(id),
  kind TEXT NOT NULL CHECK (kind IN ('class_code','invite_link')),   -- the QR encodes the invite link
  secret_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,                                -- last 2 characters, for the admin list
  requires_approval INTEGER NOT NULL DEFAULT 1 CHECK (requires_approval IN (0,1)),
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses >= 1),
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_by TEXT NOT NULL REFERENCES user_account(id),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_join_code_node ON join_code(node_id, revoked_at);

CREATE TABLE channel_membership (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES channel_node(id),   -- membership applies to the node AND its descendants
  user_id TEXT NOT NULL REFERENCES user_account(id),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','left','removed')),
  join_method TEXT NOT NULL CHECK (join_method IN ('class_code','qr','invite_link','invitation','added_by_admin','legacy_owner')),
  join_code_id TEXT REFERENCES join_code(id),
  decided_by TEXT REFERENCES user_account(id),
  decided_at INTEGER,
  decision_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (node_id, user_id)
) STRICT;
CREATE INDEX idx_membership_user ON channel_membership(user_id, status);
CREATE INDEX idx_membership_node ON channel_membership(node_id, status, created_at);

-- an invitation is addressed to an EXISTING account; it is no credential (review W2-step0 R3)
CREATE TABLE channel_invitation (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES channel_node(id),
  invitee_user_id TEXT NOT NULL REFERENCES user_account(id),
  invited_by TEXT NOT NULL REFERENCES user_account(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','revoked','expired')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
) STRICT;
CREATE INDEX idx_invitation_invitee ON channel_invitation(invitee_user_id, status);
CREATE UNIQUE INDEX idx_invitation_pending ON channel_invitation(node_id, invitee_user_id) WHERE status = 'pending';

-- «Subscribe to Course» = «تابع المادة»: new official lectures are added to the student's library as stubs (links, not
-- copies). Not a payment (PRD Q1). Routes arrive with P1-T4 step 2.
CREATE TABLE course_follow (
  user_id TEXT NOT NULL REFERENCES user_account(id),
  subject_node_id TEXT NOT NULL REFERENCES channel_node(id),
  add_new_lectures INTEGER NOT NULL DEFAULT 1 CHECK (add_new_lectures IN (0,1)),
  library_folder_id TEXT,                            -- the vault library_node the user chose (plain TEXT: it lives in the vault)
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY (user_id, subject_node_id)
) STRICT;

-- join attempts (class codes, invite links, the public preview and registration): a per-account limit on wrong codes
-- (10 per hour) and a high per-IP ceiling (a campus NAT puts a whole class behind one address). Survives restarts.
CREATE TABLE join_attempt (
  id TEXT PRIMARY KEY,
  user_id TEXT,                                      -- null: the public preview and registration (no account yet)
  ip TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('code','link','preview','register')),
  succeeded INTEGER NOT NULL DEFAULT 0 CHECK (succeeded IN (0,1)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_join_attempt_user ON join_attempt(user_id, created_at) WHERE user_id IS NOT NULL;
CREATE INDEX idx_join_attempt_ip ON join_attempt(ip, created_at);

-- System DB (DATA_DIR/system.sqlite) — identity (ARCHITECTURE_DELTA §4.1, ADR-0003 §3.1). P1-T1, release R1-b.
-- The only file that knows that several users exist. Personal data never lives here: it stays in each user's vault.
-- Reached only through the repositories in apps/server/src/system/* (every method takes the viewer, or is an internal
-- API of auth / jobs).

CREATE TABLE user_account (
  id TEXT PRIMARY KEY,                               -- ULID
  username TEXT NOT NULL,
  username_norm TEXT NOT NULL UNIQUE,                -- NFKC + trim + lower-case; the login key. On deletion renamed to 'deleted:<id>'
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,                       -- scrypt$N$r$p$salt$hash (same format as owner.password_hash)
  recovery_codes_json TEXT NOT NULL DEFAULT '[]',    -- scrypt hashes; used codes removed
  password_changed_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deletion_pending','deleted')),
  is_platform_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_platform_admin IN (0,1)),
  legacy_owner INTEGER NOT NULL DEFAULT 0 CHECK (legacy_owner IN (0,1)),   -- the migrated single owner (P1-T1 step 3)
  timezone TEXT NOT NULL DEFAULT 'Asia/Baghdad',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE UNIQUE INDEX idx_user_account_legacy_owner ON user_account(legacy_owner) WHERE legacy_owner = 1;

CREATE TABLE user_profile (
  user_id TEXT PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,
  bio TEXT,
  avatar_sha256 TEXT,                                -- blob in the CAS
  academic_json TEXT NOT NULL DEFAULT '{}',          -- {university_node_id?, college_node_id?, department_node_id?, stage_node_id?}
  field_visibility_json TEXT NOT NULL DEFAULT '{}',  -- per field: 'only_me' | 'followers' | 'members' | 'public'
  -- private by default (PRD N1, AOS-5.1): others see only display_name until the user opens fields
  profile_visibility TEXT NOT NULL DEFAULT 'only_me' CHECK (profile_visibility IN ('only_me','followers','members','public')),
  follow_requires_approval INTEGER NOT NULL DEFAULT 0 CHECK (follow_requires_approval IN (0,1)),
  updated_at INTEGER NOT NULL
) STRICT;

-- same names as the vault's legacy auth tables ON PURPOSE (different file): auth/sessions.ts and limiter.ts moved here
-- with minimal change; the legacy copies stay unused in a migrated vault (ADR-0003 §5 step 5)
CREATE TABLE auth_session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user_account(id),
  token_hash TEXT NOT NULL UNIQUE,                   -- sha256 of the cookie token (unchanged scheme)
  device_id TEXT,
  device_label TEXT,
  user_agent TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE INDEX idx_auth_session_user ON auth_session(user_id, revoked_at);

CREATE TABLE login_attempt (
  id TEXT PRIMARY KEY,
  ip TEXT,
  username_norm TEXT,
  succeeded INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_login_attempt_user ON login_attempt(username_norm, created_at);
CREATE INDEX idx_login_attempt_ip ON login_attempt(ip, created_at);
-- limiter (modules/auth/limiter.ts): per account a PROGRESSIVE DELAY (1 s, 2 s, 4 s … capped at 60 s between attempts
-- after 5 failures), never a hard lockout; a valid recovery code always signs in and resets the delay. Per IP only a
-- high ceiling (a campus NAT puts a whole class behind one address).

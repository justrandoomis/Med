-- System DB — security audit and the consent registry (ARCHITECTURE_DELTA §4.1, §5.6, §13). P1-T1, release R1-b.
CREATE TABLE security_audit (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_role TEXT,                                   -- e.g. 'subject_moderator@<node_id>' | 'platform_admin' | 'self'
  scope_node_id TEXT,
  action TEXT NOT NULL,                              -- login | setup | password_change | recover | session_revoke | device_register |
                                                     -- device_revoke | role_grant | membership_decide | account_export | ...
  target_db TEXT,
  target_type TEXT,
  target_id TEXT,
  summary TEXT NOT NULL,                             -- Arabic, no private content
  details_json TEXT,                                 -- redacted like audit.ts (secret-looking keys removed)
  ip TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_security_audit_scope ON security_audit(scope_node_id, created_at);
CREATE INDEX idx_security_audit_actor ON security_audit(actor_user_id, created_at);

CREATE TABLE consent_record (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('recording_share','lecturer_recording_policy','recording_attestation','room_recording',
                                     'cloud_asr','ai_processing','progress_share','relay_participation')),
  subject_user_id TEXT NOT NULL REFERENCES user_account(id),   -- whose consent it is
  recorded_by TEXT NOT NULL REFERENCES user_account(id),       -- the same user, or a moderator attesting a lecturer's policy
  resource_db TEXT,
  resource_type TEXT,
  resource_id TEXT,
  scope_json TEXT NOT NULL,                          -- e.g. {"audience":"course","download":false} | {"provider":"azure"}
  text_version TEXT NOT NULL,                        -- version of the exact Arabic consent text shown
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE INDEX idx_consent_resource ON consent_record(resource_db, resource_type, resource_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_consent_subject ON consent_record(subject_user_id, kind) WHERE revoked_at IS NULL;

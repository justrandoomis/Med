-- System DB — devices (ARCHITECTURE_DELTA §4.1, §7.2). P1-T1, release R1-b.
CREATE TABLE device (
  user_id TEXT NOT NULL REFERENCES user_account(id),
  device_id TEXT NOT NULL,                           -- client ULID; per user on the web (per-user localStorage key)
  device_uid TEXT NOT NULL UNIQUE,                   -- SERVER-issued ULID, globally unique: the identity used in relay
                                                     -- receipts, version vectors and CRDT client bindings (§8.6, ADR-0004 §2.6)
  label TEXT,
  platform TEXT CHECK (platform IN ('web','ios','android','other')),
  public_key TEXT,                                   -- Ed25519, base64url; signs relay bundles (ADR-0004 §2.6, ADR-0005 §A.2)
  key_registered_at INTEGER,
  shared_device INTEGER NOT NULL DEFAULT 0 CHECK (shared_device IN (0,1)),  -- clear local data on sign-out
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (user_id, device_id)
) STRICT;

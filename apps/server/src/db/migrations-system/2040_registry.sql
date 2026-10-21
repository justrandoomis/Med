-- System DB — the vault and space registry (ARCHITECTURE_DELTA §4.1, ADR-0003 §3.1). P1-T1, release R1-b.
-- A vault or space file exists for the application only through its row here; the binding hook and the job worker
-- resolve every database through this registry (no default database).
CREATE TABLE space (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  db_file TEXT NOT NULL UNIQUE,                      -- relative to DATA_DIR/spaces/
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','read_only','migrating','archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE vault (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES user_account(id),
  db_file TEXT NOT NULL UNIQUE,                      -- relative to DATA_DIR/vaults/
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','deleting','deleted')),
  bytes_db INTEGER NOT NULL DEFAULT 0,
  bytes_files INTEGER NOT NULL DEFAULT 0,            -- blobs referenced by this vault (quota)
  created_at INTEGER NOT NULL,
  last_opened_at INTEGER
) STRICT;

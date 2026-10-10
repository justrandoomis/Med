-- Data module (track D1): server data epoch (sync after restore), backup registry.
-- Range 0750–0769. No existing migration is edited.

-- The server's data epoch. A restore replaces the server's data with an older snapshot, so the sync change feed
-- goes back in time; clients compare the epoch id from GET /api/sync/pull with the one they stored and, when it
-- differs, reset their pull cursor (and re-send their own writes acknowledged after `base_seq`).
-- Exactly one row has is_current = 1.
CREATE TABLE data_server_epoch (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  base_seq INTEGER NOT NULL DEFAULT 0,               -- sync_change head when this epoch started
  reason TEXT NOT NULL CHECK (reason IN ('initial','restore')),
  backup_id TEXT,                                    -- restore: the backup that was restored
  backup_created_at INTEGER,
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_data_server_epoch_current ON data_server_epoch(is_current) WHERE is_current = 1;

INSERT INTO data_server_epoch (id, started_at, base_seq, reason, is_current, created_at)
VALUES (
  lower(hex(randomblob(16))),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'sync_change'), 0),
  'initial',
  1,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);

-- Backups made through the API (job) or the CLI on this server. The archive itself lives in DATA_DIR/backups.
CREATE TABLE data_backup (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,                           -- archive file name inside DATA_DIR/backups (no path)
  status TEXT NOT NULL CHECK (status IN ('running','completed','completed_with_warnings','failed')),
  origin TEXT NOT NULL DEFAULT 'api' CHECK (origin IN ('api','cli')),
  size INTEGER,
  sha256 TEXT,                                       -- of the archive file
  summary_json TEXT,                                 -- {tables, rows, files, file_bytes, migrations}
  warnings_json TEXT,                                -- Arabic warnings (e.g. missing blobs)
  error_detail TEXT,                                 -- Arabic, never a stack trace
  job_id TEXT,
  verify_status TEXT CHECK (verify_status IN ('passed','failed')),
  verify_report_json TEXT,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  deleted_at INTEGER
) STRICT;
CREATE INDEX idx_data_backup_created ON data_backup(created_at);

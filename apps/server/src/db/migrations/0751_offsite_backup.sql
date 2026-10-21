-- Off-site backups (PL-0, data range 0750–0759; 0760–0769 stay reserved for the parity plan). No existing migration
-- is edited. One row per off-site run: a local backup (data_backup) is made, verified like restore:verify, encrypted
-- on this server and uploaded to Cloudflare R2 (S3 API), then old copies are pruned by the retention policy.
-- Secrets are never stored here: not the R2 keys, not the encryption key — only the key's fingerprint (key_id) and the
-- per-archive random salt, which is not secret (it lets a resumed upload re-create byte-identical ciphertext).
CREATE TABLE data_offsite_backup (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule','manual')),
  status TEXT NOT NULL CHECK (status IN ('running','uploaded','failed')),
  stage TEXT CHECK (stage IN ('backup','verify','upload','retention','done')),
  backup_id TEXT,                                    -- data_backup.id of the local archive this run uploads
  archive_size INTEGER,                              -- plaintext .tar.gz bytes
  archive_sha256 TEXT,
  object_key TEXT,                                   -- key in the bucket (prefix + backups/<archive>.mlenc)
  upload_id TEXT,                                    -- an unfinished multipart upload (resumed on retry / after a restart)
  salt_hex TEXT,                                     -- encryption salt of this object (not secret)
  key_id TEXT,                                       -- fingerprint of the encryption key (never the key)
  size INTEGER,                                      -- encrypted bytes stored off-site
  parts INTEGER,
  parts_resumed INTEGER,                             -- parts already in the store when an upload was resumed
  verify_status TEXT CHECK (verify_status IN ('passed','failed')),
  retention_json TEXT,                               -- {kept, deleted, deleted_local, errors_ar}
  warnings_json TEXT,                                -- Arabic warnings (e.g. files missing at backup time)
  error_detail TEXT,                                 -- Arabic, never a stack trace or a secret
  job_id TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;
CREATE INDEX idx_data_offsite_backup_created ON data_offsite_backup(created_at);
CREATE INDEX idx_data_offsite_backup_status ON data_offsite_backup(status, created_at);

-- System DB — operations: blob registry (mark-and-sweep), job index, uploads, quotas, AI budget ledger
-- (ARCHITECTURE_DELTA §4.1, §14; ADR-0003 §3.2–3.3, §3.8). P1-T1, release R1-b. Step 1 uses job_index; the blob
-- registry, uploads, quotas and the ledger are filled by P1-T1 step 2. Step 2 additions to the §4.1 DDL (this file
-- never shipped before R1-b): blob_sweep (sweep history), upload_session.file_id / updated_at, ai_budget_ledger.space_id.
CREATE TABLE blob (
  sha256 TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  storage TEXT NOT NULL DEFAULT 'local' CHECK (storage IN ('local','r2')),
  storage_key TEXT NOT NULL,                         -- aa/bb/<sha256> (unchanged layout)
  created_at INTEGER NOT NULL,
  orphaned_at INTEGER,                               -- first sweep that found NO stored_file row anywhere
  quarantined_at INTEGER                             -- moved to quarantine/<sha256>; deleted only after a later sweep agrees
) STRICT;

-- HINT ONLY. Kept for quota display and fast checks; never the reason a blob is deleted (it lives in another file than
-- the stored_file rows it counts, and per-file restores make it drift).
CREATE TABLE blob_ref (
  sha256 TEXT NOT NULL REFERENCES blob(sha256),
  db_id TEXT NOT NULL,                               -- vault id | space id | 'system'
  ref_count INTEGER NOT NULL CHECK (ref_count >= 0),
  PRIMARY KEY (sha256, db_id)
) STRICT;

-- MARK-AND-SWEEP GC (the only deletion path; ARCHITECTURE_DELTA §4.1 2250_ops)
CREATE TABLE blob_mark (
  sweep_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  db_id TEXT NOT NULL,
  PRIMARY KEY (sweep_id, sha256, db_id)
) STRICT;

-- one row per sweep (P1-T1 step 2): what it marked and decided; a sweep that could not read EVERY registered database
-- ends 'incomplete' and decides nothing (fail closed)
CREATE TABLE blob_sweep (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('sweep','mark')),  -- 'mark' = a mark pass only (after a restore / at boot)
  status TEXT NOT NULL CHECK (status IN ('running','completed','incomplete','failed')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  databases_marked INTEGER NOT NULL DEFAULT 0,
  blobs_marked INTEGER NOT NULL DEFAULT 0,
  registered INTEGER NOT NULL DEFAULT 0,               -- referenced or stored blobs that had no registry row yet
  orphaned INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  restored INTEGER NOT NULL DEFAULT 0,                 -- back from quarantine (a mark found them again)
  error TEXT
) STRICT;
CREATE INDEX idx_blob_sweep_started ON blob_sweep(started_at);

-- Where the due work is. The job's own row (processing_job, with its checkpoints) stays in its database and is the
-- truth; this index tells the single worker which database to bind before it claims (modules/jobs/queue.ts).
-- actor_user_id: who enqueued it (gate 6 of §5.5); NULL for system work.
CREATE TABLE job_index (
  db_kind TEXT NOT NULL CHECK (db_kind IN ('vault','space')),
  db_id TEXT NOT NULL,
  job_id TEXT NOT NULL,                              -- processing_job.id inside that DB (checkpoints stay there)
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  run_after INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  actor_user_id TEXT,
  PRIMARY KEY (db_id, job_id)
) STRICT;
CREATE INDEX idx_job_index_due ON job_index(status, run_after);

CREATE TABLE upload_session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user_account(id),
  target_db TEXT NOT NULL,                           -- the DB that will receive the stored_file row
  expected_sha256 TEXT NOT NULL,
  expected_size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  mime TEXT,
  original_name TEXT,
  received_json TEXT NOT NULL DEFAULT '[]',          -- indexes of verified chunks
  status TEXT NOT NULL CHECK (status IN ('open','completed','expired','failed')),
  file_id TEXT,                                      -- stored_file id in target_db once completed (a repeated complete answers it)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_upload_session_user ON upload_session(user_id, status);

CREATE TABLE user_quota (
  user_id TEXT PRIMARY KEY REFERENCES user_account(id),
  storage_bytes_limit INTEGER,
  ai_monthly_usd_limit REAL,                         -- default 0 for new users (§14)
  asr_monthly_minutes_limit INTEGER,
  asr_monthly_cpu_minutes_limit INTEGER,             -- server-local engines cost CPU, not money (ADR-0006 §2.13)
  live_session_usd_cap REAL,
  rooms_concurrent_limit INTEGER,
  updated_by TEXT REFERENCES user_account(id),
  updated_at INTEGER NOT NULL
) STRICT;

-- per subject space (PRD Q22)
CREATE TABLE space_quota (
  space_id TEXT PRIMARY KEY REFERENCES space(id),
  storage_bytes_limit INTEGER,
  ai_monthly_usd_limit REAL,
  asr_monthly_cpu_minutes_limit INTEGER,
  updated_by TEXT REFERENCES user_account(id),
  updated_at INTEGER NOT NULL
) STRICT;

-- atomic budget reservations (fixes the non-atomic pre-check noted in docs/modules/core-server.md)
CREATE TABLE ai_budget_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user_account(id),  -- who asked (always known)
  space_id TEXT REFERENCES space(id),                -- set: charged to that subject space's allowance, not the user's
  month TEXT NOT NULL,                               -- YYYY-MM in the user's timezone
  kind TEXT NOT NULL CHECK (kind IN ('ai','asr')),
  reserved_usd REAL NOT NULL,                        -- worst-case estimate (outputTokenCeiling / minutes)
  actual_usd REAL,                                   -- ESTIMATED cost from the usage record
  status TEXT NOT NULL CHECK (status IN ('reserved','settled','released')),
  usage_ref TEXT,                                    -- usage_record id in the user's vault
  created_at INTEGER NOT NULL,
  settled_at INTEGER
) STRICT;
CREATE INDEX idx_ai_budget_user_month ON ai_budget_ledger(user_id, month, status);
CREATE INDEX idx_ai_budget_space_month ON ai_budget_ledger(space_id, month, status) WHERE space_id IS NOT NULL;
CREATE INDEX idx_ai_budget_created ON ai_budget_ledger(created_at);

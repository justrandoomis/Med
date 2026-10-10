-- Quality ops (track F5, control range 0700–0749): the §57 evaluation store and its runs, the §56 client error
-- sink, and read-path indexes for the §56 daily trend metrics. No existing migration is edited.
--
-- evaluation_case (created in 0001, never written before F5) gains what the runner and the report need:
--   set_kind          'regression' (frozen: expected values change only with a reviewed catalogue bump) or
--                     'tuning' (examples one may iterate on while adjusting rules / prompts). The two are reported apart.
--   title             one readable line (Arabic) naming what the case checks
--   fixture           the TEST FIXTURE file the case reads (fixtures/golden or fixtures/acceptance), NULL for pure checks
--   catalogue_version the catalogue that wrote the row (cases are upserted from the code catalogue by id)
--   retired_at        a case removed from the catalogue is retired, never deleted (old reports keep their meaning)
--   updated_at        last upsert
ALTER TABLE evaluation_case ADD COLUMN set_kind TEXT NOT NULL DEFAULT 'regression' CHECK (set_kind IN ('regression','tuning'));
ALTER TABLE evaluation_case ADD COLUMN title TEXT;
ALTER TABLE evaluation_case ADD COLUMN fixture TEXT;
ALTER TABLE evaluation_case ADD COLUMN catalogue_version TEXT;
ALTER TABLE evaluation_case ADD COLUMN retired_at INTEGER;
ALTER TABLE evaluation_case ADD COLUMN updated_at INTEGER;
CREATE INDEX idx_evaluation_case_axis ON evaluation_case(axis, set_kind);

-- One row per evaluation run (npm run eval records here when the server's database exists).
--   mode         'scripted' (AI axes driven by the evaluation-only scripted provider: they measure the SERVER's
--                validation / abstention guarantees, never a model) | 'live' (a real provider, when configured)
--   system_json  every version the result depends on: app, pipeline/OCR, index (chunking), parser, matcher,
--                retrieval, rules, generator, verifier, models — the basis of compare-and-rollback (docs/EVALUATION.md)
--   catalogue_hash sha256 of the regression set's expected values (two runs are comparable only on the same hash)
--   report_json  the full report (per-axis rates WITH denominators, per-case results); report_md the same in Markdown
CREATE TABLE evaluation_run (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('completed','failed')),
  mode TEXT NOT NULL CHECK (mode IN ('scripted','live')),
  set_filter TEXT NOT NULL DEFAULT 'all',
  label TEXT,
  system_json TEXT NOT NULL,
  catalogue_version TEXT NOT NULL,
  catalogue_hash TEXT NOT NULL,
  report_json TEXT NOT NULL,
  report_md TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_evaluation_run_time ON evaluation_run(started_at);

-- Client error sink (§56 error tracking). Rows are REDACTED on the client and again on the server before they are
-- stored: no document text, no query strings, no tokens / keys; stack frames are reduced to code locations. One row per
-- fingerprint (same kind + message + first frame) with a count. Retention: 30 days after the last occurrence and at
-- most 500 rows (enforced on every write by the control module).
CREATE TABLE client_error (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('error','unhandledrejection','route','react')),
  message TEXT NOT NULL,
  stack TEXT,
  route TEXT,
  app_version TEXT,
  user_agent TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_client_error_last ON client_error(last_seen_at);

-- §56 daily trends (citation / verification failures, sync rejections / conflicts) are computed from the rows the
-- evidence and sync modules already write; these read-path indexes keep a 30-day window cheap.
CREATE INDEX IF NOT EXISTS idx_control_claim_created ON claim(created_at);
CREATE INDEX IF NOT EXISTS idx_control_verification_created ON verification_result(created_at);
CREATE INDEX IF NOT EXISTS idx_control_sync_op_received ON sync_operation(received_at);

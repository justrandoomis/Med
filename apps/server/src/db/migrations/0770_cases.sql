-- Clinical cases / OSCE / Viva (track D3, range 0770–0789) — §42, §44 signals. No existing migration edited.
--
-- clinical_case (0001) is the case's identity; its definition is VERSIONED in clinical_case_version so an attempt
-- pins the exact definition it started on (fixed patient facts never change under a running attempt).
--   origin             : owner (authored by hand, no AI) | generated (AI, evidence-validated)
--   current_version_no : latest version (clinical_case.definition_json mirrors it for listing)
--   station_type       : OSCE station type (null for cases / viva)
--   source_id          : focal lecture of the case's Source Lock (plain TEXT, may be null)
--   generation_json    : AI generation run {status, job_id, message_ar, removed[], model, request}
--   status_reasons_json: why it is not 'ready' (Arabic)
--   deleted_at         : trash (attempts are kept)
ALTER TABLE clinical_case ADD COLUMN origin TEXT NOT NULL DEFAULT 'owner' CHECK (origin IN ('owner','generated'));
ALTER TABLE clinical_case ADD COLUMN current_version_no INTEGER NOT NULL DEFAULT 1;
ALTER TABLE clinical_case ADD COLUMN station_type TEXT;
ALTER TABLE clinical_case ADD COLUMN source_id TEXT;
ALTER TABLE clinical_case ADD COLUMN generation_json TEXT;
ALTER TABLE clinical_case ADD COLUMN status_reasons_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE clinical_case ADD COLUMN deleted_at INTEGER;
CREATE INDEX idx_clinical_case_updated ON clinical_case(deleted_at, updated_at);

CREATE TABLE clinical_case_version (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES clinical_case(id),
  version_no INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  scope_json TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('owner','generated')),
  status TEXT NOT NULL CHECK (status IN ('draft','needs_review','ready')),
  validation_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  UNIQUE (case_id, version_no)
) STRICT;

-- case_attempt (0001): state_json is a SNAPSHOT derived by replaying case_event (rebuildable); the log is the truth.
-- events_json (0001) is not used — the append-only log lives in case_event.
--   case_version_id : the pinned definition version
--   feedback        : immediate (guided practice) | end (feedback only in the final review)
--   judge           : deterministic (rubric coverage) | ai (AI-gated viva judge; its verdicts are stored in events)
--   mode            : text (voice is not available in this version)
--   last_seq        : last event sequence number
ALTER TABLE case_attempt ADD COLUMN case_version_id TEXT;
ALTER TABLE case_attempt ADD COLUMN feedback TEXT NOT NULL DEFAULT 'immediate' CHECK (feedback IN ('immediate','end'));
ALTER TABLE case_attempt ADD COLUMN judge TEXT NOT NULL DEFAULT 'deterministic' CHECK (judge IN ('deterministic','ai'));
ALTER TABLE case_attempt ADD COLUMN mode TEXT NOT NULL DEFAULT 'text' CHECK (mode IN ('text','voice'));
ALTER TABLE case_attempt ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_case_attempt_case ON case_attempt(case_id, started_at);

-- Append-only, idempotent decision log (id = client-generated event id: a repeated id is never applied twice).
CREATE TABLE case_event (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES case_attempt(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('choose','advance','utterance','viva_answer','revise','override_item','finish')),
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (attempt_id, seq)
) STRICT;

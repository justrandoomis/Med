-- Questions module (track F3, range 0500–0549): derived question versions — translations / paraphrases (§35, §37).
--
-- A derivation request lives in question_derivation until its text passed the checks. Only then is a question_version
-- row written (kind 'translation' | 'paraphrase', created_by 'translation', derived_from_version_id = the original,
-- lang = target language) with the SAME option keys and the same key (by option key) — and it is NEVER made the
-- question's current version: the original stays the question, its options, key, attempts and exams unchanged.
-- A derivation that failed its checks stays here (status needs_review) with its issues and a review_queue_item; its
-- text is never a version. Rows follow their question on a permanent purge (ON DELETE CASCADE).
--   source_version_id  : the original version the text was derived from
--   derived_version_id : the published derived version (NULL until published)
--   candidate_json     : the model's derived text {stem, options:[{option_key, text}]} (kept for review)
--   issues_json        : [{check, reason_ar, by}] of the last checks
--   error_json         : {code, message_ar} of a failed job
CREATE TABLE question_derivation (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES question(id) ON DELETE CASCADE,
  source_version_id TEXT NOT NULL REFERENCES question_version(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('translation','paraphrase')),
  lang TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','published','needs_review','failed')),
  derived_version_id TEXT REFERENCES question_version(id) ON DELETE SET NULL,
  candidate_json TEXT,
  issues_json TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  job_id TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_question_derivation_question ON question_derivation(question_id, created_at);

-- Practice & exams module (track C4, range 0550–0599): exam builder, attempts, hints, results, generated MCQs and
-- written answers (§37–§39, §41, §44 signals; AC-14, AC-17, AC-18, AC-19, AC-26, AC-27).
--
-- exam (0001) keeps config_json / policy_json / items_json. items_json = [{question_id, question_version_id,
-- option_order:[option ids], display_labels:[…], scored, unscored_reason_ar, origin_type}] — versions are PINNED
-- (an attempted / placed version is immutable in the questions module) and the policy is fixed at creation.
--   build_json : ExamBuildReport (what matched, what was excluded and why — real counts)
--   seed       : seed of the deterministic selection / option shuffle
ALTER TABLE exam ADD COLUMN build_json TEXT;
ALTER TABLE exam ADD COLUMN seed TEXT;

-- exam_attempt (sync entity 'exam_attempt'): resumable state. Answers of an exam in progress live here (they may
-- change until the owner finishes); finishing materializes one question_attempt per answered item with the
-- client ids recorded in answers_json (idempotent with the client's own appends).
--   answers_json : {"<item index>": ExamAnswerState}
--   flags_json   : [item indexes]
--   rev          : bumped on every server change
ALTER TABLE exam_attempt ADD COLUMN answers_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE exam_attempt ADD COLUMN flags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE exam_attempt ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE exam_attempt ADD COLUMN device_id TEXT;
CREATE INDEX idx_exam_attempt_exam ON exam_attempt(exam_id);
CREATE INDEX idx_exam_attempt_updated ON exam_attempt(updated_at);

-- question_attempt (sync entity 'question_attempt', append-only by client id). Scored at insertion against the
-- PINNED version's key; the key used is snapshotted so a later correction never re-grades silently (AC-26).
--   exam_item_index          : which item of the exam attempt it answers (one attempt per item and exam attempt)
--   unscored_reason          : why it does not count (unresolved key, blocking validation, …) — AC-14
--   key_status_at_answer     : answer_status of the pinned version when it was graded
--   key_at_answer_json       : correct option ids used for grading
--   time_budget_ms           : per-question time budget of the policy (time-pressure analysis, suggestion only)
--   auto_mistake_type/_reason: deterministic suggestion (§44) kept even after the owner edits mistake_type
--   rev / updated_at         : owner edits of the derived signals (mistake type) — the answer never changes
ALTER TABLE question_attempt ADD COLUMN exam_item_index INTEGER;
ALTER TABLE question_attempt ADD COLUMN unscored_reason TEXT;
ALTER TABLE question_attempt ADD COLUMN key_status_at_answer TEXT;
ALTER TABLE question_attempt ADD COLUMN key_at_answer_json TEXT;
ALTER TABLE question_attempt ADD COLUMN time_budget_ms INTEGER;
ALTER TABLE question_attempt ADD COLUMN auto_mistake_type TEXT;
ALTER TABLE question_attempt ADD COLUMN auto_mistake_reason TEXT;
ALTER TABLE question_attempt ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE question_attempt ADD COLUMN updated_at INTEGER;
CREATE INDEX idx_question_attempt_exam ON question_attempt(exam_attempt_id, exam_item_index);
CREATE UNIQUE INDEX idx_question_attempt_exam_item ON question_attempt(exam_attempt_id, exam_item_index)
  WHERE exam_attempt_id IS NOT NULL AND exam_item_index IS NOT NULL;

-- Hints / solution views served by the server for an item (practice). hints_used / solution_viewed_before_answer
-- of the attempt are never lower than what the server actually served (AC-27 data cannot be hidden).
-- question_version_id has no FK on purpose (a purged question must not block the purge of its source).
CREATE TABLE exam_item_event (
  id TEXT PRIMARY KEY,
  exam_attempt_id TEXT NOT NULL REFERENCES exam_attempt(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL,
  question_version_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('hint_1','hint_2','solution_viewed')),
  created_at INTEGER NOT NULL,
  UNIQUE (exam_attempt_id, item_index, kind)
) STRICT;

-- Generated hard MCQs (§37–§38): one run per request; candidates that failed validation stay here (review),
-- they are NEVER published to the vault. Claims of a candidate are owned by ('generated_question', candidate id).
CREATE TABLE question_generation_run (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  lecture_source_id TEXT REFERENCES source(id) ON DELETE SET NULL,
  request_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,                          -- resolved scope: mode, version ids, hash, describe_ar
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','partial','needs_review','abstained','failed')),
  abstain_json TEXT,
  summary_json TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_generation_run_lecture ON question_generation_run(lecture_source_id, created_at);

CREATE TABLE generated_question_candidate (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES question_generation_run(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('published','needs_review','rejected')),
  rounds INTEGER NOT NULL DEFAULT 1,                 -- generation + bounded repairs (max 3)
  candidate_json TEXT NOT NULL,                      -- last model output for this item (untrusted data)
  issues_json TEXT NOT NULL DEFAULT '[]',            -- [{check, reason_ar, by, round}]
  evidence_json TEXT NOT NULL DEFAULT '{}',          -- {alias_map, option_evidence:{option_key:[evidence ids]}, region_ids, lecture_page_ids}
  concepts_json TEXT,
  learning_objective TEXT,
  difficulty_est TEXT,
  question_id TEXT REFERENCES question(id) ON DELETE SET NULL,
  question_version_id TEXT REFERENCES question_version(id) ON DELETE SET NULL,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (run_id, ord)
) STRICT;
CREATE INDEX idx_generated_candidate_question ON generated_question_candidate(question_id);

-- written_attempt (0001) + grading state. Typed text (or recognized text the owner CONFIRMED) is the only
-- graded input; OCR uncertainty never costs points (§41).
ALTER TABLE written_attempt ADD COLUMN status TEXT NOT NULL DEFAULT 'saved' CHECK (status IN ('saved','graded','grading_failed'));
ALTER TABLE written_attempt ADD COLUMN graded_at INTEGER;
ALTER TABLE written_attempt ADD COLUMN rubric_json TEXT;
ALTER TABLE written_attempt ADD COLUMN scope_json TEXT;
ALTER TABLE written_attempt ADD COLUMN model TEXT;
ALTER TABLE written_attempt ADD COLUMN error_json TEXT;
ALTER TABLE written_attempt ADD COLUMN updated_at INTEGER;
CREATE INDEX idx_written_attempt_question ON written_attempt(question_id, answered_at);

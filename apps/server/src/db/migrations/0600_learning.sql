-- Learning module (track L1, range 0600–0649): flashcards & spaced repetition, weakness center, learning profile,
-- planner, one-tap revision (§40, §43–§45, §47; AC-23 server side, AC-24, AC-26, AC-27). No existing migration edited.
--
-- flashcard (0001) additions
--   note_id                 : cards created together share it (one cloze text → one card per {{cN::}} index;
--                             one image → one card per occlusion mask)
--   cloze_index             : the index a cloze card asks
--   image_json              : image occlusion {image_asset_id, masks:[{id, box:{x,y,w,h} normalized on the ORIGINAL
--                             image, label}], active_mask_id} — non-destructive (the image is never modified)
--   conflict_of_id          : the card whose concurrent edit this row preserves (stale sync edit → keep both, §47)
--   merged_into_id          : tombstoned by an owner-confirmed merge (never automatic); its review history is kept
--   evidence_snapshot_json  : citations as they were when the card was made [{evidence_id, source_id, source_title,
--                             version_id, locator_label_ar, quote}] — a citation that later disappears is shown as
--                             unavailable instead of silently vanishing (AC-26, §46)
ALTER TABLE flashcard ADD COLUMN note_id TEXT;
ALTER TABLE flashcard ADD COLUMN cloze_index INTEGER;
ALTER TABLE flashcard ADD COLUMN image_json TEXT;
ALTER TABLE flashcard ADD COLUMN conflict_of_id TEXT;
ALTER TABLE flashcard ADD COLUMN merged_into_id TEXT;
ALTER TABLE flashcard ADD COLUMN evidence_snapshot_json TEXT NOT NULL DEFAULT '[]';
CREATE INDEX idx_flashcard_source ON flashcard(source_id);
CREATE INDEX idx_flashcard_note ON flashcard(note_id);
CREATE INDEX idx_flashcard_updated ON flashcard(updated_at);

-- review_state (0001) is a rebuildable CACHE of the fold of review_event (+ review_reset) with fixed parameters.
--   params_key      : sha256 of the FSRS parameters used; a row with another key is recomputed
--   event_count     : events folded (diagnostics / staleness)
--   learning_steps, scheduled_days : remaining ts-fsrs card fields (the state can be restored exactly)
--   first_review_at : first review of the card (new cards introduced per owner day)
ALTER TABLE review_state ADD COLUMN params_key TEXT;
ALTER TABLE review_state ADD COLUMN event_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_state ADD COLUMN learning_steps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_state ADD COLUMN scheduled_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_state ADD COLUMN first_review_at INTEGER;
CREATE INDEX idx_review_event_reviewed ON review_event(reviewed_at);

-- Relearn markers (owner decision after a source change, AC-26): folded as FSRS `forget` at `at`. Append-only; the
-- review events before a marker are never deleted.
CREATE TABLE review_reset (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES flashcard(id),
  at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_review_reset_card ON review_reset(card_id, at);

-- Why a card needs review after a source / key / evidence change (AC-26). One row per (card, cause); `active` is
-- recomputed (a cause can disappear, e.g. a pending comparison later finds the cited text unchanged); the owner's
-- resolution and its time are kept.
CREATE TABLE flashcard_impact (
  card_id TEXT NOT NULL REFERENCES flashcard(id),
  kind TEXT NOT NULL CHECK (kind IN ('source_changed','evidence_unavailable','source_trashed','question_changed','newer_version')),
  ref TEXT NOT NULL,
  alert_id TEXT,
  reason_ar TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  resolved_at INTEGER,
  resolution TEXT CHECK (resolution IN ('keep','relearn','move_to_current_version','edited','alert_resolved')),
  PRIMARY KEY (card_id, kind, ref)
) STRICT;

-- Owner decisions on duplicate suggestions (cards are never merged automatically). card_a_id < card_b_id.
CREATE TABLE flashcard_duplicate_decision (
  card_a_id TEXT NOT NULL,
  card_b_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('not_duplicate','merged')),
  decided_at INTEGER NOT NULL,
  PRIMARY KEY (card_a_id, card_b_id)
) STRICT;

-- weakness (0001) additions: one row per group key ('concept:<id>', 'lecture:<source id>', 'topic:<id>',
-- 'question:<id>'); recomputed from signals, owner edits kept.
--   details_json       : counts, repeated mistakes, signal views, status reason (derived)
--   actions_json       : suggested actions (derived)
--   owner_label / owner_note / excluded_refs_json : owner corrections (never overwritten by a recompute)
--   status_origin      : 'owner' when the owner set the status (dismissed / resolved / active)
ALTER TABLE weakness ADD COLUMN key TEXT;
ALTER TABLE weakness ADD COLUMN kind TEXT;
ALTER TABLE weakness ADD COLUMN source_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE weakness ADD COLUMN actions_json TEXT;
ALTER TABLE weakness ADD COLUMN details_json TEXT;
ALTER TABLE weakness ADD COLUMN owner_label TEXT;
ALTER TABLE weakness ADD COLUMN owner_note TEXT;
ALTER TABLE weakness ADD COLUMN excluded_refs_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE weakness ADD COLUMN status_origin TEXT NOT NULL DEFAULT 'auto' CHECK (status_origin IN ('auto','owner'));
ALTER TABLE weakness ADD COLUMN status_changed_at INTEGER;
CREATE UNIQUE INDEX idx_weakness_key ON weakness(key);

-- Learning profile (§44): the parts the settings schema does not hold (self level, explanation level, dialect and
-- Socratic default stay in owner_setting). signal_resets_json = {part: epoch ms} — signals of a part older than its
-- reset are ignored by the profile / weakness / mastery estimates; the attempts and reviews themselves are kept.
CREATE TABLE learning_profile (
  id TEXT PRIMARY KEY CHECK (id = 'owner'),
  subjects_json TEXT NOT NULL DEFAULT '[]',
  pace_minutes_per_day INTEGER,
  signal_resets_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
) STRICT;

-- study_plan / plan_task (0001) additions. Days are YYYY-MM-DD in the owner timezone the plan was made in
-- (stored, so a later device / setting change never shifts a due day); times stay UTC epoch ms.
ALTER TABLE study_plan ADD COLUMN timezone TEXT;
ALTER TABLE study_plan ADD COLUMN feasibility_json TEXT;
ALTER TABLE study_plan ADD COLUMN report_json TEXT;
ALTER TABLE study_plan ADD COLUMN generator_version TEXT;
ALTER TABLE plan_task ADD COLUMN title_ar TEXT;
ALTER TABLE plan_task ADD COLUMN ord INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plan_task ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plan_task ADD COLUMN done_at INTEGER;
CREATE INDEX idx_plan_task_status ON plan_task(plan_id, status, day);

-- One-tap revision sessions (§45): deterministic selection with time estimates and reasons.
CREATE TABLE revision_session (
  id TEXT PRIMARY KEY,
  request_json TEXT NOT NULL,
  items_json TEXT NOT NULL,
  explanation_ar TEXT NOT NULL,
  details_json TEXT,
  total_est_minutes REAL NOT NULL,
  weakness_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;

-- read paths of the learning aggregations on tables owned by others
CREATE INDEX IF NOT EXISTS idx_l1_question_attempt_answered ON question_attempt(answered_at);

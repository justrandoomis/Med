-- Questions module (track C3, range 0500–0549): Question Vault bookkeeping (§33–§36, AC-10…AC-17).
--
-- 1) answer_key_entry is rebuilt (own table, nothing references it) to allow SEVERAL key blocks per version:
--    two printed key tables that disagree (AC-15) are both kept verbatim, so the UNIQUE identity now includes
--    key_block (1, 2, … in reading order). Keys stay bound by (version, section_key, printed_number) — never by
--    the number alone (AC-12).
--      key_block     : ordinal of the key block in the version (heading «Answer Key» / table / inline «Answer: B»)
--      binding       : bound | ambiguous_section (no section label in a multi-section file) | no_matching_question
--                      | unofficial (circled / handwritten marks — never an official key, AC-13)
--      section_title : the section label as printed in the key («Section A»), if any
--      raw_text      : the key line / cell text as printed
CREATE TABLE answer_key_entry_v2 (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL REFERENCES source_version(id),
  section_key TEXT NOT NULL DEFAULT '',
  printed_number TEXT NOT NULL,
  key_label TEXT NOT NULL,
  mark_kind TEXT NOT NULL CHECK (mark_kind IN ('printed_key','key_table','circled_option','handwritten','highlight','unknown')),
  origin_known INTEGER NOT NULL DEFAULT 0,
  page_id TEXT REFERENCES source_page(id),
  region_id TEXT REFERENCES source_region(id),
  matched_occurrence_id TEXT REFERENCES question_occurrence(id),
  created_at INTEGER NOT NULL,
  key_block INTEGER NOT NULL DEFAULT 1,
  binding TEXT NOT NULL DEFAULT 'bound' CHECK (binding IN ('bound','ambiguous_section','no_matching_question','unofficial')),
  section_title TEXT,
  raw_text TEXT,
  UNIQUE (source_version_id, section_key, printed_number, mark_kind, key_block)
) STRICT;
INSERT INTO answer_key_entry_v2 (id, source_version_id, section_key, printed_number, key_label, mark_kind, origin_known, page_id, region_id,
    matched_occurrence_id, created_at)
  SELECT id, source_version_id, section_key, printed_number, key_label, mark_kind, origin_known, page_id, region_id, matched_occurrence_id, created_at
    FROM answer_key_entry;
DROP TABLE answer_key_entry;
ALTER TABLE answer_key_entry_v2 RENAME TO answer_key_entry;
CREATE INDEX idx_answer_key_version ON answer_key_entry(source_version_id);
CREATE INDEX idx_answer_key_region ON answer_key_entry(region_id);
CREATE INDEX idx_answer_key_occurrence ON answer_key_entry(matched_occurrence_id);

-- 2) occurrences: stable identity inside a version + what THIS occurrence printed.
--      item_key           : printed number, or 'u<n>' for an unnumbered question (n-th in its section) — idempotent re-extraction
--      section_title      : section heading as printed («Section A — Abdominal pain»), NULL for implicit sections
--      option_labels_json : {option_key: label as printed here} — the same question may letter its options differently
--                           in another file; keys printed in this file are mapped through THIS map
--      raw_text           : verbatim text of the question block (stem + options lines) — the reference for AC-11 checks
--      boxes_json         : [{page_id, page_index, region_id, bbox}] regions of the block (open original page + highlight)
--      content_hash       : hash of the extracted block (unchanged block → nothing is rewritten)
--      ord                : order inside the version (reading order)
--      status             : current | not_found (no longer extracted after re-processing; kept, never deleted silently)
--      parse_json         : what the parser saw for this block: {issues (structural checks), figure_region_ids,
--                           uncertain (low-confidence regions)} — re-validation needs it without re-parsing
ALTER TABLE question_occurrence ADD COLUMN item_key TEXT;
ALTER TABLE question_occurrence ADD COLUMN section_title TEXT;
ALTER TABLE question_occurrence ADD COLUMN option_labels_json TEXT;
ALTER TABLE question_occurrence ADD COLUMN raw_text TEXT;
ALTER TABLE question_occurrence ADD COLUMN boxes_json TEXT;
ALTER TABLE question_occurrence ADD COLUMN content_hash TEXT;
ALTER TABLE question_occurrence ADD COLUMN ord INTEGER;
ALTER TABLE question_occurrence ADD COLUMN status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current','not_found'));
ALTER TABLE question_occurrence ADD COLUMN parse_json TEXT;
CREATE UNIQUE INDEX idx_question_occurrence_item ON question_occurrence(source_version_id, section_key, item_key);
CREATE INDEX idx_question_occurrence_source ON question_occurrence(source_id);

-- 3) versions: exact-duplicate fingerprint (normalized stem + option SET) and the reason a version was made.
ALTER TABLE question_version ADD COLUMN fingerprint TEXT;
ALTER TABLE question_version ADD COLUMN note TEXT;
CREATE INDEX idx_question_version_fingerprint ON question_version(fingerprint);
CREATE INDEX idx_question_version_question ON question_version(question_id, version_no);
CREATE INDEX idx_question_option_region ON question_option(region_id);
CREATE INDEX idx_question_attempt_version ON question_attempt(question_version_id);

ALTER TABLE question ADD COLUMN retired_reason TEXT;
CREATE INDEX idx_question_status ON question(status, updated_at);
CREATE INDEX idx_question_course ON question(course_node_id);

-- 4) lecture links: which lecture version was matched and by which matcher (owner decisions are never overridden).
ALTER TABLE question_lecture_link ADD COLUMN lecture_version_id TEXT;
ALTER TABLE question_lecture_link ADD COLUMN matcher_version TEXT;
CREATE INDEX idx_question_lecture_link_lecture ON question_lecture_link(lecture_source_id, status);

-- 5) duplicate decisions keep the owner's reason.
ALTER TABLE question_duplicate ADD COLUMN decision_reason TEXT;
ALTER TABLE question_duplicate ADD COLUMN decided_at INTEGER;
CREATE INDEX idx_question_duplicate_b ON question_duplicate(question_b_id);

-- 6) one extraction summary per source version (what was found, sections, key blocks, unbound keys, reasons).
CREATE TABLE question_extraction (
  version_id TEXT PRIMARY KEY REFERENCES source_version(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('completed','needs_review','nothing_found')),
  summary_json TEXT NOT NULL,
  job_id TEXT,
  parser_version TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- 7) lookups used by matching and the review queue.
CREATE INDEX IF NOT EXISTS idx_qv_concept_mention_region ON concept_mention(region_id);
CREATE INDEX IF NOT EXISTS idx_qv_concept_mention_version ON concept_mention(version_id);
CREATE INDEX IF NOT EXISTS idx_qv_review_queue_entity ON review_queue_item(entity_type, entity_id);

-- 8) Re-processing a page replaces its regions (processing persist.ts). Question options, key entries and
--    concept-candidate mentions only POINT at regions (derived locations, refreshed by the automatic
--    re-extraction / re-matching that follows processing), so they must not block the replace: the pointer is
--    cleared (options/keys) or the derived candidate mention removed. Evidence citations are untouched and keep
--    protecting their regions (REGIONS_IN_USE).
CREATE TRIGGER question_region_refs_bd BEFORE DELETE ON source_region BEGIN
  UPDATE question_option SET region_id = NULL WHERE region_id = OLD.id;
  UPDATE answer_key_entry SET region_id = NULL WHERE region_id = OLD.id;
  DELETE FROM concept_mention WHERE region_id = OLD.id AND role LIKE 'candidate%';
END;

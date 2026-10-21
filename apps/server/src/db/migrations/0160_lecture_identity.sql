-- Sources module (range 0150–0199), Academic OS track P1-T3 (ARCHITECTURE_DELTA §4.2, §6.1; PRD AOS-3.2…3.5, 3.7, 3.18).
--
-- Lecture identity: the lecture number and session date found in a file (or set by the owner), and the stub columns
-- P1-T5 uses later for official lectures (origin_space_id / origin_lecture_id / is_stub; always empty in R1-a).
--   lecture_no_origin / held_on_origin : 'detected' = a CERTAIN detection stored automatically (the owner can change
--                                        it); 'owner' / 'moderator' = a human decision — automation never overrides it.
--                                        Uncertain detections are NOT stored here: they wait in import_suggestion.
ALTER TABLE source ADD COLUMN lecture_no INTEGER;
ALTER TABLE source ADD COLUMN lecture_no_origin TEXT CHECK (lecture_no_origin IN ('detected','owner','moderator'));
ALTER TABLE source ADD COLUMN held_on TEXT;                    -- YYYY-MM-DD, the lecture's session date
ALTER TABLE source ADD COLUMN held_on_origin TEXT CHECK (held_on_origin IN ('detected','owner','moderator'));
ALTER TABLE source ADD COLUMN origin_space_id TEXT;            -- stub: the space holding the official lecture (P1-T5)
ALTER TABLE source ADD COLUMN origin_lecture_id TEXT;          -- stub: official_lecture.id in that space (P1-T5)
ALTER TABLE source ADD COLUMN is_stub INTEGER NOT NULL DEFAULT 0 CHECK (is_stub IN (0,1));  -- chunks/FTS/regions stay in the space
CREATE UNIQUE INDEX idx_source_origin_lecture ON source(origin_space_id, origin_lecture_id) WHERE origin_lecture_id IS NOT NULL;
CREATE INDEX idx_source_lecture_no ON source(node_id, lecture_no) WHERE lecture_no IS NOT NULL;

-- The uploader's review queue for import intelligence (AOS-3.18): every detected value with its reasons.
--   field          : lecture_no | held_on | title | subject | new_version_of
--   value_key      : the normalised value; (source, field, value_key) is unique, so a REJECTED value is remembered and
--                    never proposed again for that source (AOS-3.7 «accept/reject remembered»)
--   status         : open (waiting, no downstream effect) · applied (a certain lecture_no / held_on stored automatically)
--                    · accepted · rejected · superseded (a newer analysis no longer finds it)
-- Rows die with their source (ON DELETE CASCADE): the sources purge needs no extra step for them.
CREATE TABLE import_suggestion (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  version_id TEXT,
  field TEXT NOT NULL CHECK (field IN ('lecture_no','held_on','title','subject','new_version_of')),
  value_json TEXT NOT NULL,
  value_key TEXT NOT NULL,
  certainty TEXT NOT NULL CHECK (certainty IN ('certain','uncertain')),
  reasons_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','applied','accepted','rejected','superseded')),
  algo TEXT NOT NULL,
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_import_suggestion_value ON import_suggestion(source_id, field, value_key);
CREATE INDEX idx_import_suggestion_status ON import_suggestion(status, field);

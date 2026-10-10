-- Track F4 — handwriting recognition (§28, §41 handwritten answers, §46 search in handwriting).
-- ink_recognition (0001) was created but never written. A row is a DERIVED, correctable reading of strokes the owner
-- selected on a page / note page (purpose 'page_ink', the strokes stay in `annotation`, listed in annotation_ids_json)
-- or wrote in a written-answer pad (purpose 'written_answer', the pad strokes are kept here in strokes_json so the
-- owner's handwriting is never lost). The machine reading (`text`, `lines_json`) is never overwritten: the owner's
-- correction goes to `corrected_text` (history in change_log).
--   status          queued → running → recognized | unreadable (the reader abstained, with its reason) | failed
--   lines_json      [{words:[{text, uncertain, alternatives?}]}] — uncertain words are shown as uncertain
--   image_png       the exact cropped black-on-white picture that was sent to the vision reader (owner-visible)
--   page_id / note_page_id / question_id cascade: a purge of the page / note page / question removes the reading
--   (and, through the trigger below, its search entry)
ALTER TABLE ink_recognition ADD COLUMN purpose TEXT NOT NULL DEFAULT 'page_ink' CHECK (purpose IN ('page_ink','written_answer'));
ALTER TABLE ink_recognition ADD COLUMN status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','recognized','unreadable','failed'));
ALTER TABLE ink_recognition ADD COLUMN lang_requested TEXT NOT NULL DEFAULT 'mixed' CHECK (lang_requested IN ('ar','en','mixed'));
ALTER TABLE ink_recognition ADD COLUMN lines_json TEXT;
ALTER TABLE ink_recognition ADD COLUMN uncertain_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ink_recognition ADD COLUMN target_key TEXT;
ALTER TABLE ink_recognition ADD COLUMN anchor_json TEXT;
ALTER TABLE ink_recognition ADD COLUMN source_id TEXT;
ALTER TABLE ink_recognition ADD COLUMN version_id TEXT;
ALTER TABLE ink_recognition ADD COLUMN page_id TEXT REFERENCES source_page(id) ON DELETE CASCADE;
ALTER TABLE ink_recognition ADD COLUMN note_page_id TEXT REFERENCES note_page(id) ON DELETE CASCADE;
ALTER TABLE ink_recognition ADD COLUMN question_id TEXT REFERENCES question(id) ON DELETE CASCADE;
ALTER TABLE ink_recognition ADD COLUMN bbox_json TEXT;
ALTER TABLE ink_recognition ADD COLUMN strokes_json TEXT;
ALTER TABLE ink_recognition ADD COLUMN image_png BLOB;
ALTER TABLE ink_recognition ADD COLUMN image_w INTEGER;
ALTER TABLE ink_recognition ADD COLUMN image_h INTEGER;
ALTER TABLE ink_recognition ADD COLUMN job_id TEXT;
ALTER TABLE ink_recognition ADD COLUMN error_json TEXT;
ALTER TABLE ink_recognition ADD COLUMN corrected_at INTEGER;
ALTER TABLE ink_recognition ADD COLUMN deleted_at INTEGER;
CREATE INDEX idx_ink_recognition_page ON ink_recognition(page_id) WHERE page_id IS NOT NULL;
CREATE INDEX idx_ink_recognition_note_page ON ink_recognition(note_page_id) WHERE note_page_id IS NOT NULL;
CREATE INDEX idx_ink_recognition_question ON ink_recognition(question_id) WHERE question_id IS NOT NULL;
CREATE INDEX idx_ink_recognition_source ON ink_recognition(source_id) WHERE source_id IS NOT NULL;

-- search entry of a reading (owner_content_fts entity 'ink_recognition') goes with it, also on cascades
CREATE TRIGGER ink_recognition_fts_ad AFTER DELETE ON ink_recognition BEGIN
  DELETE FROM owner_content_fts WHERE entity_type = 'ink_recognition' AND entity_id = old.id;
END;

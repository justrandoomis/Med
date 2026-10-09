-- Annotations module (track B1, range 0250–0299): sync bookkeeping and read-path indexes for
-- annotation / note / note_page / study_session / source_progress (§25, §26, §45, §46, §47).
--
-- annotation.conflict_of_id   : set on the copy the server keeps when an edit arrives with a stale base_rev
--                               (keep both — ARCHITECTURE §3.4). Points at the annotation it preserves an edit of.
-- note.source_id / note.anchor_target_key
--                             : denormalized from anchor_json (page anchors → source + 'source_page:<id>') so
--                               «ملاحظاتي» for a source/page is an indexed lookup. anchor_json stays the truth.
-- note_page.rev / device_id   : note pages are synced with revisions like notes (NotePageDTO.rev).
-- source_progress.progress_version_id
--                             : the version whose page indexes pages_viewed_json holds. Reading progress of
--                               another version is not mixed in (a replacement version has different pages).
ALTER TABLE annotation ADD COLUMN conflict_of_id TEXT;
CREATE INDEX idx_annotation_anchor_status ON annotation(anchor_status) WHERE anchor_status <> 'ok';

ALTER TABLE note ADD COLUMN source_id TEXT;
ALTER TABLE note ADD COLUMN anchor_target_key TEXT;
CREATE INDEX idx_note_source ON note(source_id, updated_at);
CREATE INDEX idx_note_node ON note(node_id, updated_at);
CREATE INDEX idx_note_anchor_target ON note(anchor_target_key);

ALTER TABLE note_page ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE note_page ADD COLUMN device_id TEXT;
CREATE INDEX idx_note_page_source ON note_page(source_id, sort_order);

CREATE INDEX idx_study_session_updated ON study_session(updated_at);

ALTER TABLE source_progress ADD COLUMN progress_version_id TEXT;

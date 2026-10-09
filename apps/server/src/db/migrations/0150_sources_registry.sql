-- Sources module (range 0150–0199).
--
-- source.trash_root_id       : see 0100 (set when the source was hidden because its folder was trashed;
--                              NULL when the source itself was trashed or is live).
-- source.source_type_origin  : 'auto' while the type is only the upload heuristic's suggestion,
--                              'owner' once the owner chose/confirmed it (§06: suggest, owner corrects).
-- source_version.display_file_id : a PDF the reader can render as fixed pages (the PDF itself, or a
--                              LibreOffice rendering of PPTX/DOC produced by processing). NULL if none.
ALTER TABLE source ADD COLUMN trash_root_id TEXT;
ALTER TABLE source ADD COLUMN source_type_origin TEXT NOT NULL DEFAULT 'owner' CHECK (source_type_origin IN ('auto','owner'));
ALTER TABLE source_version ADD COLUMN display_file_id TEXT REFERENCES stored_file(id);

CREATE INDEX idx_source_deleted ON source(deleted_at);
CREATE INDEX idx_source_trash_root ON source(trash_root_id);
CREATE INDEX idx_source_last_opened ON source(last_opened_at);
CREATE INDEX idx_source_version_hash ON source_version(content_hash);
CREATE INDEX idx_source_page_version ON source_page(version_id, page_index);
CREATE INDEX idx_source_link_to ON source_link(to_source_id);

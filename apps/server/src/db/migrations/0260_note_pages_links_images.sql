-- Annotations module (range 0250–0299), notebook track F1 (§26, §25, §5): notebook pages with section dividers,
-- page placement that survives re-numbered versions, and pictures placed on pages.
--
-- note_page.page_kind     : 'page' (a writing page) or 'divider' (starts a section / tab of a notebook).
-- note_page.color         : cover colour token of a divider's tab (null → the notebook's colour).
-- note_page.after_page_id : the source page a page was inserted after (placement by id first, else by
--                           after_page_index; a page whose source page is gone is still shown, never dropped).
-- annotation_image        : the uploaded bytes of an image annotation, keyed by the client's image_key. Uploads are
--                           idempotent by key and independent of the annotation's sync op (either may arrive first).
--                           `referenced` = an annotation has pointed at it; prune (after a purge) removes rows no
--                           annotation points at any more (tombstoned annotations still count — undo restores them).
ALTER TABLE note_page ADD COLUMN page_kind TEXT NOT NULL DEFAULT 'page' CHECK (page_kind IN ('page', 'divider'));
ALTER TABLE note_page ADD COLUMN color TEXT;
ALTER TABLE note_page ADD COLUMN after_page_id TEXT;
CREATE INDEX idx_note_page_node ON note_page(node_id, sort_order);

CREATE TABLE annotation_image (
  image_key TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES stored_file(id),
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  referenced INTEGER NOT NULL DEFAULT 0,
  device_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_annotation_image_file ON annotation_image(file_id);
-- which live / tombstoned annotations show a picture (prune and «used_by» look it up by key)
CREATE INDEX idx_annotation_image_key ON annotation(json_extract(data_json, '$.image_key')) WHERE kind = 'image';

-- Academic OS, P1-T2 step 1 (ARCHITECTURE_DELTA §4.3; ADR-0004 §2.1; annotations range 0250–0279). Base set: every vault
-- and every space. Additive only — safe on the single owner's EXISTING database (applied there after 0810): no row is
-- rewritten and nothing is lost.
--
-- annotation_layer         authorship layers on a document: 'source:<source_id>' (all versions of a lecture) or
--                          'notebook:<library_node_id>'. The `annotation.layer` column (ink | highlight | text | media)
--                          stays the RENDER class; `layer_id` is authorship and visibility.
-- annotation.layer_id      NULL = the default personal layer («ملاحظاتي») of the document in this vault. Every annotation
-- note.layer_id            and note written before this migration therefore IS on the owner's personal layer, unchanged
--                          (ink, highlights, text boxes, stickies, pictures, links, bookmarks, notes). The default layer's
--                          id is derived from the document key (shared `defaultPersonalLayerId`); a row for it exists
--                          only once the owner renames or recolours it.
-- author_user_id           NULL in a vault = the vault's own user.
-- migrated_from_id         the original item a layer copy / re-anchor copy came from (the original is never changed).
-- annotation.origin        how the row came to exist; 'device' for every existing row.
-- sync_operation.detail_code  the machine-readable reason of a FINAL rejection (`layer_read_only`, `layer_forbidden`,
--                          `use_crdt`; ARCHITECTURE_DELTA §8.2), recorded with the verdict so a retried op_id gets the same
--                          reason back with its `duplicate` answer (the client re-homes the item, ADR-0004 R2). NULL on
--                          every existing row.
CREATE TABLE annotation_layer (
  id TEXT PRIMARY KEY,
  document_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('personal','explanation','answers','published_snapshot','followed','forked',
                                     'group_comments','suggestion','collaborative')),
  title TEXT NOT NULL,
  owner_user_id TEXT,
  writable INTEGER NOT NULL DEFAULT 1 CHECK (writable IN (0,1)),
  frozen INTEGER NOT NULL DEFAULT 0 CHECK (frozen IN (0,1)),
  origin_json TEXT,
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
  color TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 1,
  device_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE INDEX idx_annotation_layer_doc ON annotation_layer(document_key, sort_order);

ALTER TABLE annotation ADD COLUMN layer_id TEXT REFERENCES annotation_layer(id);
ALTER TABLE annotation ADD COLUMN author_user_id TEXT;
ALTER TABLE annotation ADD COLUMN migrated_from_id TEXT;
ALTER TABLE annotation ADD COLUMN origin TEXT NOT NULL DEFAULT 'device' CHECK (origin IN (
  'device','crdt_projection','publish_copy','follow_copy','fork_copy','layer_copy','reanchor_copy'));
CREATE INDEX idx_annotation_layer ON annotation(layer_id) WHERE layer_id IS NOT NULL;
CREATE INDEX idx_annotation_migrated ON annotation(migrated_from_id) WHERE migrated_from_id IS NOT NULL;

ALTER TABLE note ADD COLUMN layer_id TEXT REFERENCES annotation_layer(id);
ALTER TABLE note ADD COLUMN author_user_id TEXT;
ALTER TABLE note ADD COLUMN migrated_from_id TEXT;
CREATE INDEX idx_note_layer ON note(layer_id) WHERE layer_id IS NOT NULL;
CREATE INDEX idx_note_migrated ON note(migrated_from_id) WHERE migrated_from_id IS NOT NULL;

ALTER TABLE sync_operation ADD COLUMN detail_code TEXT;

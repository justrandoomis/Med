-- Academic OS, P1-T2 step 2 (ARCHITECTURE_DELTA §4.3, §6.6; ADR-0004 §2.8; annotations range 0250–0279). Base set.
-- Append-only before-images of every update, delete and restore of an annotation, a note or a layer, written in the SAME
-- transaction as the change (version history, AOS-4.15; later the restore and the Study Time Machine). Re-anchored and
-- layer copies are NEW rows (`migrated_from_id`), so their originals never need a before-image.
--   rev            the rev the before-image had
--   snapshot_json  the full stored row before the change
--   layer_id, document_key  (P1-T2 addition to the §4.3 DDL) the layer and document the item was on before the change,
--                  so a layer's history is listed without scanning snapshots; layer_id NULL = the default personal layer
-- The sources purge and note-page purge delete the revisions of the items they delete (the purge preview counts them).
-- Additive only: on the owner's existing database the table starts empty; no existing row changes.
CREATE TABLE annotation_revision (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('annotation','note','annotation_layer')),
  entity_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('update','delete','restore','followed_update','layer_restore')),
  snapshot_json TEXT NOT NULL,
  actor_user_id TEXT,
  device_id TEXT,
  op_id TEXT,
  at INTEGER NOT NULL,
  layer_id TEXT,
  document_key TEXT,
  PRIMARY KEY (entity_type, entity_id, rev)
) STRICT;
CREATE INDEX idx_annotation_revision_time ON annotation_revision(at);
CREATE INDEX idx_annotation_revision_layer ON annotation_revision(document_key, layer_id, at);

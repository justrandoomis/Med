-- Academic OS PRD AOS-21.12 «strokes carry author, layer and document / fork» (ARCHITECTURE_DELTA §4.2 `0860`, §6.1, §6.5;
-- forks range 0860–0869 — after `0860_document_copy`, whose table the identity points at). Base set: every vault and
-- every space (in a space both columns stay NULL until the Phase-2 group layers write there).
--
-- annotation.document_key / note.document_key
--     the document the item is written on: 'source:<source_id>' (every version of a lecture — for an official lecture
--     the vault's stub keeps the SPACE's source id, so this names the official lecture) or 'notebook:<library_node_id>'.
--     Same derivation as `annotation_layer.document_key` (layers.ts ANNOTATION_DOC_SQL / NOTE_DOC_SQL).
-- annotation.document_copy_id / note.document_copy_id
--     the study copy («ابدأ الدراسة» personal copy, independent fork or followed copy — `document_copy.id`) whose layer
--     holds the item: the copy whose `personal_layer_id` or `copied_layer_id` is the item's layer; for an item on the
--     document's default «ملاحظاتي» (layer_id NULL) the copy that uses that default layer (its id is the derived `pl_…`
--     one; a second copy of the same lecture gets its own `ly_…` personal layer, forks/following.ts personalLayerFor).
--     NULL = the item belongs to the document, not to one copy (a private upload with no copy, an extra layer the owner
--     made on the document).
--
-- Both columns are SERVER-DERIVED, never taken from a client: the triggers below keep them for every writer (sync push,
-- fork / follow copies, layer copies, re-anchor copies, imports), so the sync wire format is unchanged — an older client
-- sends exactly what it sent before and its strokes get the identity anyway. A copy created AFTER items were written on
-- its layers (a fork's copied layer is filled before its `document_copy` row; strokes on a stub before «ابدأ الدراسة»)
-- stamps them when it is inserted, and puts them back on the change feed so devices learn the identity.
--
-- Backfill: every existing row gets its document key; rows on a layer of an existing copy get that copy. Nothing else
-- of any row changes (no rev, updated_at or data is touched).
ALTER TABLE annotation ADD COLUMN document_key TEXT;
ALTER TABLE annotation ADD COLUMN document_copy_id TEXT;
ALTER TABLE note ADD COLUMN document_key TEXT;
ALTER TABLE note ADD COLUMN document_copy_id TEXT;

-- ── backfill ──────────────────────────────────────────────────────────────────────────────────────────────────────
UPDATE annotation SET document_key = (CASE json_extract(anchor_json, '$.type')
    WHEN 'page' THEN 'source:' || json_extract(anchor_json, '$.source_id')
    WHEN 'note_page' THEN (SELECT CASE WHEN np.source_id IS NOT NULL THEN 'source:' || np.source_id WHEN np.node_id IS NOT NULL THEN 'notebook:' || np.node_id END
                           FROM note_page np WHERE np.id = json_extract(annotation.anchor_json, '$.note_page_id'))
    WHEN 'block' THEN (SELECT 'source:' || ar.primary_source_id FROM artifact ar
                       WHERE ar.lineage_id = json_extract(annotation.anchor_json, '$.lineage_id') AND ar.primary_source_id IS NOT NULL LIMIT 1)
  END);

UPDATE note SET document_key = (CASE
    WHEN source_id IS NOT NULL THEN 'source:' || source_id
    WHEN json_extract(anchor_json, '$.type') = 'note_page' THEN (SELECT CASE WHEN np.source_id IS NOT NULL THEN 'source:' || np.source_id WHEN np.node_id IS NOT NULL THEN 'notebook:' || np.node_id END
                           FROM note_page np WHERE np.id = json_extract(note.anchor_json, '$.note_page_id'))
    WHEN json_extract(anchor_json, '$.type') = 'page' THEN 'source:' || json_extract(anchor_json, '$.source_id')
    WHEN node_id IS NOT NULL THEN 'notebook:' || node_id
  END);

-- a live copy before a deleted one, the newest first (the default layer is used by one live copy at a time)
UPDATE annotation SET document_copy_id = (SELECT c.id FROM document_copy c
    WHERE c.source_id = substr(annotation.document_key, 8)
      AND (CASE WHEN annotation.layer_id IS NULL THEN c.personal_layer_id LIKE 'pl\_%' ESCAPE '\'
                ELSE (c.personal_layer_id = annotation.layer_id OR c.copied_layer_id = annotation.layer_id) END)
    ORDER BY c.deleted_at IS NOT NULL, c.created_at DESC, c.id LIMIT 1)
  WHERE document_key LIKE 'source:%';

UPDATE note SET document_copy_id = (SELECT c.id FROM document_copy c
    WHERE c.source_id = substr(note.document_key, 8)
      AND (CASE WHEN note.layer_id IS NULL THEN c.personal_layer_id LIKE 'pl\_%' ESCAPE '\'
                ELSE (c.personal_layer_id = note.layer_id OR c.copied_layer_id = note.layer_id) END)
    ORDER BY c.deleted_at IS NOT NULL, c.created_at DESC, c.id LIMIT 1)
  WHERE document_key LIKE 'source:%';

CREATE INDEX idx_annotation_document ON annotation(document_key, layer_id);
CREATE INDEX idx_annotation_copy ON annotation(document_copy_id) WHERE document_copy_id IS NOT NULL;
CREATE INDEX idx_note_document ON note(document_key, layer_id);
CREATE INDEX idx_note_copy ON note(document_copy_id) WHERE document_copy_id IS NOT NULL;

-- ── kept by the database for every writer ─────────────────────────────────────────────────────────────────────────
CREATE TRIGGER annotation_identity_ai AFTER INSERT ON annotation BEGIN
  UPDATE annotation SET document_key = (CASE json_extract(NEW.anchor_json, '$.type')
      WHEN 'page' THEN 'source:' || json_extract(NEW.anchor_json, '$.source_id')
      WHEN 'note_page' THEN (SELECT CASE WHEN np.source_id IS NOT NULL THEN 'source:' || np.source_id WHEN np.node_id IS NOT NULL THEN 'notebook:' || np.node_id END
                             FROM note_page np WHERE np.id = json_extract(NEW.anchor_json, '$.note_page_id'))
      WHEN 'block' THEN (SELECT 'source:' || ar.primary_source_id FROM artifact ar
                         WHERE ar.lineage_id = json_extract(NEW.anchor_json, '$.lineage_id') AND ar.primary_source_id IS NOT NULL LIMIT 1)
    END) WHERE id = NEW.id;
  UPDATE annotation SET document_copy_id = (SELECT c.id FROM document_copy c
      WHERE annotation.document_key LIKE 'source:%' AND c.source_id = substr(annotation.document_key, 8)
        AND (CASE WHEN annotation.layer_id IS NULL THEN c.personal_layer_id LIKE 'pl\_%' ESCAPE '\'
                  ELSE (c.personal_layer_id = annotation.layer_id OR c.copied_layer_id = annotation.layer_id) END)
      ORDER BY c.deleted_at IS NOT NULL, c.created_at DESC, c.id LIMIT 1)
    WHERE id = NEW.id;
END;

CREATE TRIGGER annotation_identity_au AFTER UPDATE OF anchor_json, layer_id ON annotation BEGIN
  UPDATE annotation SET document_key = (CASE json_extract(NEW.anchor_json, '$.type')
      WHEN 'page' THEN 'source:' || json_extract(NEW.anchor_json, '$.source_id')
      WHEN 'note_page' THEN (SELECT CASE WHEN np.source_id IS NOT NULL THEN 'source:' || np.source_id WHEN np.node_id IS NOT NULL THEN 'notebook:' || np.node_id END
                             FROM note_page np WHERE np.id = json_extract(NEW.anchor_json, '$.note_page_id'))
      WHEN 'block' THEN (SELECT 'source:' || ar.primary_source_id FROM artifact ar
                         WHERE ar.lineage_id = json_extract(NEW.anchor_json, '$.lineage_id') AND ar.primary_source_id IS NOT NULL LIMIT 1)
    END) WHERE id = NEW.id;
  UPDATE annotation SET document_copy_id = (SELECT c.id FROM document_copy c
      WHERE annotation.document_key LIKE 'source:%' AND c.source_id = substr(annotation.document_key, 8)
        AND (CASE WHEN annotation.layer_id IS NULL THEN c.personal_layer_id LIKE 'pl\_%' ESCAPE '\'
                  ELSE (c.personal_layer_id = annotation.layer_id OR c.copied_layer_id = annotation.layer_id) END)
      ORDER BY c.deleted_at IS NOT NULL, c.created_at DESC, c.id LIMIT 1)
    WHERE id = NEW.id;
END;

CREATE TRIGGER note_identity_ai AFTER INSERT ON note BEGIN
  UPDATE note SET document_key = (CASE
      WHEN NEW.source_id IS NOT NULL THEN 'source:' || NEW.source_id
      WHEN json_extract(NEW.anchor_json, '$.type') = 'note_page' THEN (SELECT CASE WHEN np.source_id IS NOT NULL THEN 'source:' || np.source_id WHEN np.node_id IS NOT NULL THEN 'notebook:' || np.node_id END
                             FROM note_page np WHERE np.id = json_extract(NEW.anchor_json, '$.note_page_id'))
      WHEN json_extract(NEW.anchor_json, '$.type') = 'page' THEN 'source:' || json_extract(NEW.anchor_json, '$.source_id')
      WHEN NEW.node_id IS NOT NULL THEN 'notebook:' || NEW.node_id
    END) WHERE id = NEW.id;
  UPDATE note SET document_copy_id = (SELECT c.id FROM document_copy c
      WHERE note.document_key LIKE 'source:%' AND c.source_id = substr(note.document_key, 8)
        AND (CASE WHEN note.layer_id IS NULL THEN c.personal_layer_id LIKE 'pl\_%' ESCAPE '\'
                  ELSE (c.personal_layer_id = note.layer_id OR c.copied_layer_id = note.layer_id) END)
      ORDER BY c.deleted_at IS NOT NULL, c.created_at DESC, c.id LIMIT 1)
    WHERE id = NEW.id;
END;

CREATE TRIGGER note_identity_au AFTER UPDATE OF anchor_json, layer_id, source_id, node_id ON note BEGIN
  UPDATE note SET document_key = (CASE
      WHEN NEW.source_id IS NOT NULL THEN 'source:' || NEW.source_id
      WHEN json_extract(NEW.anchor_json, '$.type') = 'note_page' THEN (SELECT CASE WHEN np.source_id IS NOT NULL THEN 'source:' || np.source_id WHEN np.node_id IS NOT NULL THEN 'notebook:' || np.node_id END
                             FROM note_page np WHERE np.id = json_extract(NEW.anchor_json, '$.note_page_id'))
      WHEN json_extract(NEW.anchor_json, '$.type') = 'page' THEN 'source:' || json_extract(NEW.anchor_json, '$.source_id')
      WHEN NEW.node_id IS NOT NULL THEN 'notebook:' || NEW.node_id
    END) WHERE id = NEW.id;
  UPDATE note SET document_copy_id = (SELECT c.id FROM document_copy c
      WHERE note.document_key LIKE 'source:%' AND c.source_id = substr(note.document_key, 8)
        AND (CASE WHEN note.layer_id IS NULL THEN c.personal_layer_id LIKE 'pl\_%' ESCAPE '\'
                  ELSE (c.personal_layer_id = note.layer_id OR c.copied_layer_id = note.layer_id) END)
      ORDER BY c.deleted_at IS NOT NULL, c.created_at DESC, c.id LIMIT 1)
    WHERE id = NEW.id;
END;

-- A new copy takes the items already on its layers that no copy holds yet, and puts them back on the change feed
-- (the copy's id is new, so the rows holding it afterwards are exactly the ones stamped here).
CREATE TRIGGER document_copy_identity_ai AFTER INSERT ON document_copy BEGIN
  UPDATE annotation SET document_copy_id = NEW.id
    WHERE document_copy_id IS NULL AND document_key = 'source:' || NEW.source_id
      AND ((layer_id IS NULL AND NEW.personal_layer_id LIKE 'pl\_%' ESCAPE '\') OR layer_id = NEW.personal_layer_id OR layer_id = NEW.copied_layer_id);
  UPDATE note SET document_copy_id = NEW.id
    WHERE document_copy_id IS NULL AND document_key = 'source:' || NEW.source_id
      AND ((layer_id IS NULL AND NEW.personal_layer_id LIKE 'pl\_%' ESCAPE '\') OR layer_id = NEW.personal_layer_id OR layer_id = NEW.copied_layer_id);
  DELETE FROM sync_change WHERE entity_type = 'annotation' AND entity_id IN (SELECT id FROM annotation WHERE document_copy_id = NEW.id);
  INSERT INTO sync_change (entity_type, entity_id, changed_at) SELECT 'annotation', id, NEW.created_at FROM annotation WHERE document_copy_id = NEW.id ORDER BY id;
  DELETE FROM sync_change WHERE entity_type = 'note' AND entity_id IN (SELECT id FROM note WHERE document_copy_id = NEW.id);
  INSERT INTO sync_change (entity_type, entity_id, changed_at) SELECT 'note', id, NEW.created_at FROM note WHERE document_copy_id = NEW.id ORDER BY id;
END;

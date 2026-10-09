-- Document processing (track A2): normalized full-text indexing + pipeline lookups.
--
-- (source_version.display_file_id, written by this pipeline, is added by the sources migration 0150.)

-- 1) Normalized FTS. chunk_fts stays an external-content table over document_chunk, but the INDEXED
--    values are the search keys ml_norm(text) / ml_norm(heading_path) (normalizeForSearch from
--    @medlevo/shared: harakat/tatweel removed, alef/ya/ta-marbuta/hamza carriers unified, Arabic-Indic
--    digits → ASCII, lower-case). Stored chunk text is never normalized. ml_norm is a deterministic UDF
--    registered on every connection by db/db.ts — the same function must be used for the 'delete'
--    entries, so deletes always remove exactly what was indexed. Queries must be built with toFtsQuery()
--    (which applies the same normalization) and filter by version/scope BEFORE ranking.
DROP TRIGGER IF EXISTS chunk_fts_ai;
DROP TRIGGER IF EXISTS chunk_fts_ad;
DROP TRIGGER IF EXISTS chunk_fts_au;

CREATE TRIGGER chunk_fts_ai AFTER INSERT ON document_chunk BEGIN
  INSERT INTO chunk_fts(rowid, text, heading_path) VALUES (new.rowid, ml_norm(new.text), ml_norm(new.heading_path));
END;
CREATE TRIGGER chunk_fts_ad AFTER DELETE ON document_chunk BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, text, heading_path)
    VALUES ('delete', old.rowid, ml_norm(old.text), ml_norm(old.heading_path));
END;
-- only text / heading changes touch the index (prev/next relinking does not)
CREATE TRIGGER chunk_fts_au AFTER UPDATE OF text, heading_path ON document_chunk BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, text, heading_path)
    VALUES ('delete', old.rowid, ml_norm(old.text), ml_norm(old.heading_path));
  INSERT INTO chunk_fts(rowid, text, heading_path) VALUES (new.rowid, ml_norm(new.text), ml_norm(new.heading_path));
END;

-- rebuild the index from the content table with normalized keys ('rebuild' would index raw text)
INSERT INTO chunk_fts(chunk_fts) VALUES ('delete-all');
INSERT INTO chunk_fts(rowid, text, heading_path)
  SELECT rowid, ml_norm(text), ml_norm(heading_path) FROM document_chunk;

-- 2) lookups used by the pipeline
CREATE INDEX IF NOT EXISTS idx_chunk_source ON document_chunk(source_id);
CREATE INDEX IF NOT EXISTS idx_image_asset_page ON image_asset(page_id);
CREATE INDEX IF NOT EXISTS idx_image_asset_version ON image_asset(version_id);

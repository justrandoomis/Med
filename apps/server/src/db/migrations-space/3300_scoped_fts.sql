-- Academic OS P1-T5 step 2 — federated search (ARCHITECTURE_DELTA §4.4 `3300_scoped_fts`, §11.1; ADR-0003 §3.5; search
-- range 3300–3349). Space set, release R1-c. A contentless FTS index of the space's chunks whose `scope` column holds
-- one token per version and per source (`v<version id>` `s<source id>`), so the allowed versions go INSIDE the MATCH
-- («scope:(v… OR v…) AND (terms)») and out-of-scope chunks never reach bm25 ranking or LIMIT (measured 8.1–13.8 ms vs
-- 85.8–241.9 ms post-filter over 246k chunks, identical results; ADR-0003 §2). Text is read back from document_chunk
-- by rowid. Same Arabic normalisation as chunk_fts (ml_norm, migration 0200). The vault indexes are unchanged.
-- Ids are [A-Za-z0-9_-]; the unicode61 tokenizer splits on '_' and '-' and folds case, so each id is written lower-case
-- with those two characters removed — the search module builds the query tokens with the same rule (search/scope.ts)
-- and still checks the version of every hit after the MATCH (a defensive post-filter on the few rows returned).
-- `hd` marks the chunks of the PUBLISHED HEAD of an official lecture (not withdrawn, not taken down): «all official
-- lectures of my subjects» is then ONE token in the MATCH instead of an OR over every head (measured 250k chunks:
-- one token p50 9.4 ms vs 19.6 ms for 200 OR'ed version tokens). The lectures module re-tokenises the old and the new
-- head when a version is published or a lecture withdrawn (search/scopeTokens.ts `retokenizeVersions`).
-- ONLY PUBLISHED official versions are indexed (review P1-T5 s2 R-E): bm25 statistics are computed over every row of
-- the index, so a draft (or a moderators-only attachment) indexed here would change the ORDER of members' hits — a side
-- channel on what an unpublished draft contains. A version enters the index in the transaction that publishes it
-- (`retokenizeVersions` from the lectures module's publish); chunks of a published version re-processed later are
-- indexed by the triggers. Moderators' draft search (§11.1), when built, uses an index of its own.
CREATE VIRTUAL TABLE chunk_scope_fts USING fts5(
  text, heading_path, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER chunk_scope_fts_ai AFTER INSERT ON document_chunk
WHEN EXISTS (SELECT 1 FROM official_version_publish p WHERE p.version_id = new.version_id) BEGIN
  INSERT INTO chunk_scope_fts(rowid, text, heading_path, scope)
  VALUES (new.rowid, ml_norm(new.text), ml_norm(coalesce(new.heading_path, '')),
          'v' || lower(replace(replace(new.version_id, '_', ''), '-', '')) || ' s' || lower(replace(replace(new.source_id, '_', ''), '-', ''))
          || CASE WHEN EXISTS (SELECT 1 FROM official_lecture l WHERE l.head_version_id = new.version_id AND l.status = 'published' AND l.takedown_at IS NULL) THEN ' hd' ELSE '' END);
END;
CREATE TRIGGER chunk_scope_fts_ad AFTER DELETE ON document_chunk BEGIN
  DELETE FROM chunk_scope_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER chunk_scope_fts_au AFTER UPDATE OF text, heading_path, version_id, source_id ON document_chunk BEGIN
  DELETE FROM chunk_scope_fts WHERE rowid = old.rowid;
  INSERT INTO chunk_scope_fts(rowid, text, heading_path, scope)
  SELECT new.rowid, ml_norm(new.text), ml_norm(coalesce(new.heading_path, '')),
         'v' || lower(replace(replace(new.version_id, '_', ''), '-', '')) || ' s' || lower(replace(replace(new.source_id, '_', ''), '-', ''))
         || CASE WHEN EXISTS (SELECT 1 FROM official_lecture l WHERE l.head_version_id = new.version_id AND l.status = 'published' AND l.takedown_at IS NULL) THEN ' hd' ELSE '' END
   WHERE EXISTS (SELECT 1 FROM official_version_publish p WHERE p.version_id = new.version_id);
END;
-- chunks of the versions already published in the space (step 1 lectures) are indexed now
INSERT INTO chunk_scope_fts(rowid, text, heading_path, scope)
  SELECT rowid, ml_norm(text), ml_norm(coalesce(heading_path, '')),
         'v' || lower(replace(replace(version_id, '_', ''), '-', '')) || ' s' || lower(replace(replace(source_id, '_', ''), '-', ''))
         || CASE WHEN EXISTS (SELECT 1 FROM official_lecture l WHERE l.head_version_id = document_chunk.version_id AND l.status = 'published' AND l.takedown_at IS NULL) THEN ' hd' ELSE '' END
    FROM document_chunk
   WHERE EXISTS (SELECT 1 FROM official_version_publish p WHERE p.version_id = document_chunk.version_id);

-- Course Brain — Round 7 H4 (module `brain`, range 0800–0849). Three additions; no existing table is changed.
--
-- 1) concept_relation_statement: a relation a lecture sentence STATES in prose («X causes Y», «X is treated with Y»,
--    «X is a complication of Y», Arabic equivalents) — read deterministically by the extraction job, with the exact
--    sentence. The course recompute turns statements into suggested relations with support 'stated' and the sentence
--    as their reason. Rows are derived: they are replaced at every extraction of the version, and go with their
--    region (a re-processed page) or version (the sources purge) — ON DELETE CASCADE.
CREATE TABLE concept_relation_statement (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES source_version(id) ON DELETE CASCADE,
  region_id TEXT NOT NULL REFERENCES source_region(id) ON DELETE CASCADE,
  from_concept_id TEXT NOT NULL REFERENCES concept(id),
  to_concept_id TEXT NOT NULL REFERENCES concept(id),
  relation TEXT NOT NULL CHECK (relation IN ('causes', 'treats', 'complication_of')),
  pattern TEXT NOT NULL,
  quote TEXT NOT NULL,
  -- 'uncertain' when the sentence was read by OCR
  certainty TEXT NOT NULL CHECK (certainty IN ('stated', 'uncertain')),
  extractor_version TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_relation_statement_version ON concept_relation_statement(version_id);
CREATE INDEX idx_relation_statement_region ON concept_relation_statement(region_id);

-- 2) knowledge_algorithm: algorithms / flowcharts read from a lecture (numbered steps, «if … then» rules, arrow
--    chains, decision lists, flowchart-figure OCR labels). structure_json = { nodes: [{key, text, kind, region_id}],
--    edges: [{from, to, label}] } — every node is the exact printed text of a region. Figure labels never get edges
--    from OCR; edges appear only from a figure reading the owner reviewed (certainty 'owner_reviewed'). Derived and
--    replaced at every extraction of the version; region ids live in the JSON (a re-processed page shows «لم يعد
--    موجودًا» until the follow-up extraction replaces the row).
CREATE TABLE knowledge_algorithm (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES source_version(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('numbered_steps', 'conditional', 'arrow_chain', 'decision_list', 'flowchart_figure')),
  title TEXT,
  section TEXT,
  concept_id TEXT REFERENCES concept(id) ON DELETE SET NULL,
  certainty TEXT NOT NULL CHECK (certainty IN ('stated', 'uncertain', 'owner_reviewed')),
  ordered INTEGER NOT NULL DEFAULT 0,
  structure_json TEXT NOT NULL,
  region_ids_json TEXT NOT NULL,
  page_id TEXT,
  first_region_id TEXT,
  ord INTEGER NOT NULL DEFAULT 0,
  extractor_version TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_knowledge_algorithm_version ON knowledge_algorithm(version_id, ord);
CREATE INDEX idx_knowledge_algorithm_concept ON knowledge_algorithm(concept_id);

-- 3) brain_relation_state: the state each course group's suggested relations were last computed for (a signature of
--    its lectures, extractions, concepts and statements), so the course page enqueues a background recompute only when
--    something changed and can say honestly whether the relations it shows are current.
CREATE TABLE brain_relation_state (
  course_key TEXT PRIMARY KEY,
  signature TEXT NOT NULL,
  stats_json TEXT,
  job_id TEXT,
  computed_at INTEGER NOT NULL
) STRICT;

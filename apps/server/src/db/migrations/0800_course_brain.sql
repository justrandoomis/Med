-- Course Brain (track F2, module `brain`, migration range 0800–0849): deterministic knowledge structure per processed
-- lecture (§16), owner corrections of concepts and relations, inferred relations with their reasons.
--
-- The concept tables exist since 0001 (concept, concept_mention, concept_relation). The questions module writes
-- concept CANDIDATES (concept_mention.role 'candidate_*'); the brain module writes STATED mentions (any other role,
-- support = 'stated') and every concept_relation row. Owner decisions are columns on the rows themselves and are
-- never overwritten by a later extraction.

-- 1) owner corrections on concepts: a merged concept points at the concept that absorbed it (it is never deleted, so
--    a later extraction that meets its old name lands on the target); a rename keeps the old name as an alias.
ALTER TABLE concept ADD COLUMN merged_into_id TEXT REFERENCES concept(id) ON DELETE SET NULL;
ALTER TABLE concept ADD COLUMN name_origin TEXT NOT NULL DEFAULT 'auto' CHECK (name_origin IN ('auto', 'owner'));
ALTER TABLE concept ADD COLUMN kind_origin TEXT NOT NULL DEFAULT 'auto' CHECK (kind_origin IN ('auto', 'owner'));
ALTER TABLE concept ADD COLUMN owner_note TEXT;
CREATE INDEX idx_concept_merged ON concept(merged_into_id);

-- names that resolve to a concept besides name_en / name_ar (old names after a rename, names of merged concepts)
CREATE TABLE concept_alias (
  id TEXT PRIMARY KEY,
  concept_id TEXT NOT NULL REFERENCES concept(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  alias_norm TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL CHECK (origin IN ('rename', 'merge', 'owner')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_concept_alias_concept ON concept_alias(concept_id);

-- 2) stated mentions: the exact sentence / cell the mention came from and the section heading it sits under
ALTER TABLE concept_mention ADD COLUMN support TEXT CHECK (support IS NULL OR support IN ('stated'));
ALTER TABLE concept_mention ADD COLUMN quote TEXT;
ALTER TABLE concept_mention ADD COLUMN section TEXT;
ALTER TABLE concept_mention ADD COLUMN extractor_version TEXT;
CREATE INDEX idx_concept_mention_version_role ON concept_mention(version_id, role);

-- Re-processing a page replaces its regions (processing persist.ts). Stated mentions only POINT at regions (derived,
-- re-extracted by the extract_knowledge job that follows processing), so they must not block the replace.
-- (Candidate mentions are handled by the questions trigger `question_region_refs_bd`.)
CREATE TRIGGER brain_region_mentions_bd BEFORE DELETE ON source_region BEGIN
  DELETE FROM concept_mention WHERE region_id = OLD.id AND role NOT LIKE 'candidate%';
END;

-- 3) relations: owner-made or suggested (inferred, with reasons); one row per (from, to, relation)
ALTER TABLE concept_relation ADD COLUMN origin TEXT NOT NULL DEFAULT 'auto' CHECK (origin IN ('auto', 'owner'));
ALTER TABLE concept_relation ADD COLUMN reasons_json TEXT;
ALTER TABLE concept_relation ADD COLUMN course_node_id TEXT;
ALTER TABLE concept_relation ADD COLUMN note TEXT;
ALTER TABLE concept_relation ADD COLUMN updated_at INTEGER;
CREATE UNIQUE INDEX idx_concept_relation_unique ON concept_relation(from_concept_id, to_concept_id, relation);
CREATE INDEX idx_concept_relation_to ON concept_relation(to_concept_id);

-- 4) one extraction record per source version (what was found, objectives, counts)
CREATE TABLE concept_extraction (
  version_id TEXT PRIMARY KEY REFERENCES source_version(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('completed', 'nothing_found')),
  summary_json TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  job_id TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_concept_extraction_source ON concept_extraction(source_id);

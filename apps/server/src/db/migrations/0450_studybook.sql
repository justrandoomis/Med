-- Study Book module (track C2, range 0450–0499): explanations, Study Book, contextual chat, summaries (§16–§21,
-- §24, §28, §30, §31). Existing tables artifact / content_block / contextual_thread / message (0001) get the
-- columns the ArtifactView contract needs; new tables hold per-section generation state, owner explanation-rule
-- overrides and the re-anchoring report of regenerated Study Books.
--
-- artifact.abstain_json        : {reason, reason_ar, detail?, suggest_scope?} when the request abstained (no blocks)
-- artifact.removed_json        : [{text, reason_ar}] sentences removed by verification (shown on demand only)
-- artifact.anchor_json         : the SelectionAnchor an explanation / figure explanation was made for
-- artifact.parent_artifact_id  : Explain Until Understood — the artifact this version retried (same lineage)
-- artifact.scope_hash          : resolved scope hash (also inside cache_key); lets reads show the lock cheaply
-- content_block.table_json     : comparison tables: {header: RichText[], rows: RichText[][]} (claims per cell)
-- content_block.meta_json      : {label_ar, generated_label_ar, visual:{items, uncertain}, page_ids, …} — display
--                                facts derived by the server, never medical content
-- contextual_thread.*          : threads are bound to anchor + source + version + resolved scope (pinned versions)
-- message.*                    : answer style, the owner question it answers, verification detail (removed, abstain)
ALTER TABLE artifact ADD COLUMN abstain_json TEXT;
ALTER TABLE artifact ADD COLUMN removed_json TEXT;
ALTER TABLE artifact ADD COLUMN anchor_json TEXT;
ALTER TABLE artifact ADD COLUMN parent_artifact_id TEXT;
ALTER TABLE artifact ADD COLUMN scope_hash TEXT;
CREATE INDEX idx_artifact_lineage ON artifact(lineage_id, version_no);
CREATE INDEX idx_artifact_job ON artifact(job_id);

ALTER TABLE content_block ADD COLUMN table_json TEXT;
ALTER TABLE content_block ADD COLUMN meta_json TEXT;
CREATE INDEX idx_content_block_section ON content_block(artifact_id, section_key, ord);

ALTER TABLE contextual_thread ADD COLUMN page_id TEXT;
ALTER TABLE contextual_thread ADD COLUMN socratic INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contextual_thread ADD COLUMN resolved_scope_json TEXT;
ALTER TABLE contextual_thread ADD COLUMN scope_hash TEXT;
ALTER TABLE contextual_thread ADD COLUMN archived_at INTEGER;
CREATE INDEX idx_thread_source ON contextual_thread(source_id, page_id, updated_at);

ALTER TABLE message ADD COLUMN style TEXT;
ALTER TABLE message ADD COLUMN reply_to_id TEXT;
ALTER TABLE message ADD COLUMN detail_json TEXT;
ALTER TABLE message ADD COLUMN updated_at INTEGER;
CREATE INDEX idx_message_thread ON message(thread_id, created_at);

-- Per-section generation state of a Study Book / summary artifact (progressive, resumable; AC-25).
-- status: pending → generating → complete | abstained | failed. A section's blocks are written in ONE
-- transaction together with status = 'complete', so an interrupted section is never visible half-finished.
CREATE TABLE artifact_section (
  artifact_id TEXT NOT NULL REFERENCES artifact(id),
  section_key TEXT NOT NULL,
  ord INTEGER NOT NULL,
  title TEXT,
  region_ids_json TEXT NOT NULL DEFAULT '[]',
  page_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','generating','complete','abstained','failed')),
  block_count INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT,                                   -- abstain / failure reason (Arabic), removed count
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, section_key)
) STRICT;
CREATE INDEX idx_artifact_section_ord ON artifact_section(artifact_id, ord);

-- Owner explanation-rule overrides (§19). target_type 'owner' (target_id 'owner') = owner-wide extras that the
-- settings schema does not hold; 'node' = a library node (subject/course/folder) override, inherited downwards.
CREATE TABLE explanation_rule_override (
  target_type TEXT NOT NULL CHECK (target_type IN ('owner','node')),
  target_id TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (target_type, target_id)
) STRICT;

-- Re-anchoring report after a Study Book regeneration (§25, AC-22). Owner notes / annotations are NEVER modified:
-- an anchor whose block_key exists in the new version is 'matched' (the semantic anchor resolves as is); one whose
-- block disappeared is 'needs_reanchor' (kept, listed with its previous place).
CREATE TABLE artifact_reanchor (
  artifact_id TEXT NOT NULL REFERENCES artifact(id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('annotation','note')),
  target_id TEXT NOT NULL,
  block_key TEXT NOT NULL,
  previous_version_no INTEGER,
  status TEXT NOT NULL CHECK (status IN ('matched','needs_reanchor')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, target_kind, target_id)
) STRICT;

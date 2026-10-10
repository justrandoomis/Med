-- Study Book module (track F3, range 0450–0499): interactive timelines and flowcharts (§31).
--
-- A study diagram is GENERATED content re-organized from the evidence of a locked scope: nodes (steps / events /
-- decisions) and edges (directed relations, from → to) each carry a verified statement and claim ids (claims are owned
-- by ('study_diagram', id) and validated by the evidence services like any generated sentence). Parts whose claim did
-- not pass verification are removed and listed in removed_json (never shown as supported). It is labelled
-- «re-organized», distinct from the source's own figures, and never replaces the original.
--   structure_json : {title, nodes:[{key,label,kind,order,time_label,statement,claim_ids,verification}], edges:[…]}
--   scope_json     : the resolved scope (mode, source/version ids, describe_ar, hash) the diagram was made in
--   cache_key      : sha256 of (kind, scope hash + versions, pages / anchor / topic, generator & verifier versions)
-- Rows follow their source on a permanent purge (ON DELETE CASCADE); the trigger removes their claims too.
CREATE TABLE study_diagram (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('flowchart','timeline')),
  source_id TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  version_ids_json TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('published','abstained','failed')),
  request_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  structure_json TEXT,
  removed_json TEXT NOT NULL DEFAULT '[]',
  abstain_json TEXT,
  cache_key TEXT NOT NULL,
  model TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_study_diagram_source ON study_diagram(source_id, created_at);
CREATE INDEX idx_study_diagram_cache ON study_diagram(cache_key);

CREATE TRIGGER study_diagram_claims_ad AFTER DELETE ON study_diagram BEGIN
  DELETE FROM verification_result WHERE subject_type = 'claim'
    AND subject_id IN (SELECT id FROM claim WHERE owner_type = 'study_diagram' AND owner_id = OLD.id);
  DELETE FROM citation WHERE claim_id IN (SELECT id FROM claim WHERE owner_type = 'study_diagram' AND owner_id = OLD.id);
  DELETE FROM claim WHERE owner_type = 'study_diagram' AND owner_id = OLD.id;
END;

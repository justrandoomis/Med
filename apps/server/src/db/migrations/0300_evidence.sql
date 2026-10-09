-- Evidence module (track C1, range 0300–0349): content change alerts with per-dependent impact,
-- reprocessing bookkeeping, and read-path indexes for evidence / dependencies (§10, §11, §18).
--
-- content_alert.from_version_id   : the version the dependents were built on (replacement / correction source)
-- content_alert.acknowledged_at   : owner saw the alert («اطلعت عليه»); resolved_at stays for «تمت المعالجة»
-- content_alert.details_json      : {pages_changed?, job_id?, kind-specific facts} (never document text)
-- content_alert_item              : one row per affected dependent with its impact (still_valid / needs_regeneration /
--                                   needs_review), whether it is kept on its version on purpose (frozen) and why.
--                                   content_alert.affected_json stays filled ([{type,id,impact}]) for older readers.
-- content_alert_job               : re-processing jobs already turned into an alert (idempotent reconcile).
ALTER TABLE content_alert ADD COLUMN from_version_id TEXT;
ALTER TABLE content_alert ADD COLUMN acknowledged_at INTEGER;
ALTER TABLE content_alert ADD COLUMN details_json TEXT;
CREATE INDEX idx_content_alert_status ON content_alert(status, created_at);
CREATE INDEX idx_content_alert_source ON content_alert(source_id);

CREATE TABLE content_alert_item (
  alert_id TEXT NOT NULL REFERENCES content_alert(id) ON DELETE CASCADE,
  dependent_type TEXT NOT NULL,
  dependent_id TEXT NOT NULL,
  impact TEXT NOT NULL CHECK (impact IN ('still_valid','needs_regeneration','needs_review')),
  frozen INTEGER NOT NULL DEFAULT 0,
  reason_ar TEXT,
  version_ids_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (alert_id, dependent_type, dependent_id)
) STRICT;
CREATE INDEX idx_content_alert_item_dependent ON content_alert_item(dependent_type, dependent_id);

CREATE TABLE content_alert_job (
  job_id TEXT PRIMARY KEY,
  alert_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_evidence_version ON evidence(version_id);
CREATE INDEX idx_evidence_source ON evidence(source_id);
CREATE INDEX idx_artifact_dep_region ON artifact_dependency(region_id);
CREATE INDEX idx_claim_status ON claim(verification_status);

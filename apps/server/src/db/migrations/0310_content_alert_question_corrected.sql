-- Evidence module (range 0300–0349), track H1: a dedicated content_alert kind for corrections of a QUESTION's own
-- text (stem / options / explanation — AC-26). content_alert.kind is a CHECK constraint (0001), so until now those
-- alerts were stored as 'source_updated' («تحديث في المصدر»), which named the wrong thing.
--
-- SQLite cannot alter a CHECK: the table is rebuilt. The runner applies a migration inside a transaction, where
-- PRAGMA foreign_keys cannot be switched off, and DROP TABLE content_alert would CASCADE-delete content_alert_item
-- (alert_id … ON DELETE CASCADE). So the items are copied aside first and put back after the rebuild: every alert and
-- every item row is kept with all its columns. Indexes from 0300 are recreated.
-- Existing question-correction alerts (written by questions/lifecycle.ts with details_json
-- {question_id, corrected, by:'owner'}) are relabelled 'question_corrected'; every other row keeps its kind.
CREATE TEMP TABLE h1_content_alert_item_backup AS SELECT * FROM content_alert_item;

CREATE TABLE content_alert_h1 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('source_updated','ocr_corrected','key_corrected','source_deleted','source_replaced','conflict_found','layout_changed','question_corrected')),
  severity TEXT NOT NULL CHECK (severity IN ('info','fact_change','answer_change')),
  source_id TEXT,
  source_version_id TEXT,
  summary TEXT NOT NULL,
  affected_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  from_version_id TEXT,
  acknowledged_at INTEGER,
  details_json TEXT
) STRICT;

INSERT INTO content_alert_h1 (id, kind, severity, source_id, source_version_id, summary, affected_json, status, created_at, resolved_at, from_version_id, acknowledged_at, details_json)
  SELECT id, kind, severity, source_id, source_version_id, summary, affected_json, status, created_at, resolved_at, from_version_id, acknowledged_at, details_json
    FROM content_alert;

DROP TABLE content_alert;
ALTER TABLE content_alert_h1 RENAME TO content_alert;
CREATE INDEX idx_content_alert_status ON content_alert(status, created_at);
CREATE INDEX idx_content_alert_source ON content_alert(source_id);

INSERT INTO content_alert_item SELECT * FROM h1_content_alert_item_backup;
DROP TABLE h1_content_alert_item_backup;

UPDATE content_alert SET kind = 'question_corrected'
 WHERE kind = 'source_updated'
   AND details_json IS NOT NULL AND json_valid(details_json)
   AND json_extract(details_json, '$.question_id') IS NOT NULL
   AND json_extract(details_json, '$.corrected') IS NOT NULL
   AND json_extract(details_json, '$.by') = 'owner';

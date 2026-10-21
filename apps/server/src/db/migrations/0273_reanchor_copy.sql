-- Academic OS, P1-T2 step 3 (ARCHITECTURE_DELTA §6.3; PRD AOS-3.13, 4.17, 4.20, Q35; Scenario 4; annotations range
-- 0250–0279). Base set, release R1-a. «انقل ملاحظاتي إلى الإصدار الجديد» — COPY, NEVER MOVE: the copies themselves are
-- ordinary `annotation` / `note` rows (origin 'reanchor_copy', `migrated_from_id`, deterministic ids); these tables only
-- keep the bookkeeping that makes a run reportable and undoable, and the owner's «اتركها على الإصدار السابق» choices.
-- Additive only: three new, empty tables on the owner's existing database; no existing row changes.
--
-- reanchor_copy_run       one row per tap (kind 'run') or per review copy (kind 'manual'): the versions, the counts
--                         shown in the report, and the undo (undone_at + what it did). A run that copied nothing is not
--                         recorded (a repeated tap is a no-op).
-- reanchor_copy_item      one row per copy written by a run: the original (`from_id`), the copy (`copy_id`), the copy's
--                         revision when written (`copy_rev`: an undo tombstones only a copy the owner did not change since)
--                         and `undone_at`. An original with a live row here is «carried forward» and never copied twice;
--                         after an undo it is offered again (and the same deterministic copy id is revived).
-- reanchor_copy_decision  «اتركها على الإصدار السابق»: the original stays where it is and is counted «بقيت» for that
--                         target version. Nothing is written to the original.
-- Backups copy the whole database; the full JSON export and the sources purge include these tables (the purge through
-- the annotations module's purge extension).
CREATE TABLE reanchor_copy_run (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  from_version_id TEXT NOT NULL,
  to_version_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('run','manual')),
  algo TEXT,
  counts_json TEXT NOT NULL,
  device_id TEXT,
  created_at INTEGER NOT NULL,
  undone_at INTEGER,
  undo_json TEXT
) STRICT;
CREATE INDEX idx_reanchor_copy_run_pair ON reanchor_copy_run(source_id, to_version_id, created_at);

CREATE TABLE reanchor_copy_item (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('annotation','note')),
  copy_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES reanchor_copy_run(id),
  from_id TEXT NOT NULL,
  to_version_id TEXT NOT NULL,
  to_page_id TEXT NOT NULL,
  copy_rev INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  undone_at INTEGER,
  PRIMARY KEY (entity_type, copy_id)
) STRICT;
CREATE INDEX idx_reanchor_copy_item_from ON reanchor_copy_item(entity_type, from_id);
CREATE INDEX idx_reanchor_copy_item_run ON reanchor_copy_item(run_id);

CREATE TABLE reanchor_copy_decision (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('annotation','note')),
  entity_id TEXT NOT NULL,
  to_version_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('keep_on_previous')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id, to_version_id)
) STRICT;

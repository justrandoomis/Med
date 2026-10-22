-- Space commons, lectures module (3000–3049), Academic OS track P1-T5 step 1 (ARCHITECTURE_DELTA §4.4
-- `3010_subject_content`; PRD AOS-2.5, 2.9; spec §2 «ملفات إضافية وملخصات وأسئلة السنوات السابقة», «آخر التحديثات
-- وإصدارات المحاضرات»; spec §17 exam dates).
--
-- Additions to the design DDL: subject_attachment.withdrawn_at; subject_exam_date.lecture_ids_json is validated by the
-- module (ids of this space's lectures); subject_event rows are written by the lectures module in the SAME transaction
-- as the change they report and never carry private content (titles of official content only).
CREATE TABLE subject_attachment (
  id TEXT PRIMARY KEY,
  subject_node_id TEXT NOT NULL,                     -- system channel_node id (plain TEXT: cross-DB)
  lecture_id TEXT REFERENCES official_lecture(id),   -- optional: attached to one lecture
  kind TEXT NOT NULL CHECK (kind IN ('summary','previous_exam','reference','other')),
  title TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES source(id),     -- processed like any source in the space (versions = source_version)
  uploaded_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published','withdrawn')),   -- contributor uploads start as draft
  visibility TEXT NOT NULL DEFAULT 'course' CHECK (visibility IN ('course','moderators')),
  rights_json TEXT NOT NULL DEFAULT '{"members_only":true}',
  approved_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  withdrawn_at INTEGER
) STRICT;
CREATE INDEX idx_subject_attachment ON subject_attachment(subject_node_id, kind, status);
CREATE INDEX idx_subject_attachment_source ON subject_attachment(source_id);

CREATE TABLE subject_exam_date (
  id TEXT PRIMARY KEY,
  subject_node_id TEXT NOT NULL,
  title TEXT NOT NULL,                               -- e.g. «الامتحان النهائي — الدور الأول»
  exam_on TEXT NOT NULL,                             -- YYYY-MM-DD
  starts_at TEXT,                                    -- HH:MM, local
  lecture_ids_json TEXT NOT NULL DEFAULT '[]',       -- lectures the moderator says are included (optional)
  published_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','changed','cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_subject_exam_date ON subject_exam_date(subject_node_id, exam_on);

-- the subject updates feed (AOS-2.9): appended by the lectures module in the same transaction as the change it reports
CREATE TABLE subject_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_node_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('lecture_published','version_published','lecture_withdrawn','attachment_published',
                                     'exam_date_published','exam_date_changed')),
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  title TEXT NOT NULL,                               -- Arabic display line; never private content
  visibility_key TEXT,                               -- NULL = all members; 'mod' for moderator-only events
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_subject_event ON subject_event(subject_node_id, seq);

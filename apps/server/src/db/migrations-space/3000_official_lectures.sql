-- Space commons (band 3000–3999), lectures module (3000–3049), Academic OS track P1-T5 step 1
-- (ARCHITECTURE_DELTA §4.4 `3000_official_lectures`, §6.1, §6.2, §6.7; PRD AOS-2.2, 2.3, 4.5, 18.3, 18.4, 18.9, 18.10,
-- 19H.1, 21.7, 21.8). Applied to every subject space after the base set, so `source`, `source_version`, `source_page`,
-- `source_region` and `stored_file` exist here: an official lecture IS a source of the space (its versions are
-- source_version rows of that one source, processed by the existing pipeline inside the space).
--
-- Additions to the design DDL (all nullable or defaulted, documented in docs/modules/lectures.md):
--   official_lecture.withdrawn_note / withdrawn_by — the moderator's Arabic reason shown over the placeholders;
--   official_lecture.takedown_at — when a rights takedown removed the lecture's files and text from the space;
--   official_lecture.client_body_hash — the idempotent create (§7.1: same client id + same body → the same lecture);
--   official_version_publish.kind — 'upload' or 'correction' (§6.7: a correction of a published version);
--   official_version_upload — who uploaded each version (a contributor's version waits for a moderator to publish it);
--   official_correction — a correction of a published version (applied by a job) or a contributor's proposal waiting
--     in the moderators' queue (AOS-18.9; review W2-step0 N1).

-- Stable Lecture Identity (§19H): survives renames and re-uploads; versions are source_version rows of `source_id`.
CREATE TABLE official_lecture (
  id TEXT PRIMARY KEY,
  subject_node_id TEXT NOT NULL,                     -- system channel_node id (plain TEXT: cross-DB)
  source_id TEXT NOT NULL UNIQUE REFERENCES source(id),
  title TEXT NOT NULL,
  lecture_no INTEGER CHECK (lecture_no IS NULL OR lecture_no BETWEEN 1 AND 999),
  lecture_no_origin TEXT CHECK (lecture_no_origin IN ('detected','moderator')),
  held_on TEXT,                                      -- YYYY-MM-DD
  status TEXT NOT NULL CHECK (status IN ('draft','in_review','published','withdrawn')),
  head_version_id TEXT REFERENCES source_version(id),   -- the published official version students see
  uploaded_by TEXT NOT NULL,                         -- user id (contributor / moderator)
  approved_by TEXT,
  approved_at INTEGER,
  withdrawn_reason TEXT CHECK (withdrawn_reason IN ('replaced','error','rights_takedown','other')),
  withdrawn_note TEXT,
  withdrawn_by TEXT,
  takedown_at INTEGER,
  client_body_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  withdrawn_at INTEGER
) STRICT;
CREATE INDEX idx_official_lecture_subject ON official_lecture(subject_node_id, status, lecture_no, held_on);

CREATE TABLE official_version_publish (
  version_id TEXT PRIMARY KEY REFERENCES source_version(id),
  lecture_id TEXT NOT NULL REFERENCES official_lecture(id),
  published_by TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  change_note TEXT,
  previous_version_id TEXT REFERENCES source_version(id),
  kind TEXT NOT NULL DEFAULT 'upload' CHECK (kind IN ('upload','correction')),
  page_map_status TEXT NOT NULL DEFAULT 'pending' CHECK (page_map_status IN ('pending','ready','failed'))
) STRICT;
CREATE INDEX idx_official_version_publish_lecture ON official_version_publish(lecture_id, published_at);
-- Once a version is published, its source_page / source_region rows are IMMUTABLE: a correction creates a new version
-- (§6.7). Drafts may still be corrected in place.

CREATE TABLE official_version_upload (
  version_id TEXT PRIMARY KEY REFERENCES source_version(id),
  lecture_id TEXT NOT NULL REFERENCES official_lecture(id),
  uploaded_by TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('upload','correction')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_official_version_upload_lecture ON official_version_upload(lecture_id, created_at);

CREATE TABLE official_correction (
  id TEXT PRIMARY KEY,
  lecture_id TEXT NOT NULL REFERENCES official_lecture(id),
  version_id TEXT NOT NULL REFERENCES source_version(id),   -- the version the corrected regions belong to
  items_json TEXT NOT NULL,                                 -- [{region_id, text}]
  note TEXT,
  proposed_by TEXT NOT NULL,
  -- open: a contributor's proposal waiting for a moderator · queued: accepted / a moderator's own, a job applies it ·
  -- applied · rejected · failed (the job could not apply it; the reason is kept)
  status TEXT NOT NULL CHECK (status IN ('open','queued','applied','rejected','failed')),
  result_version_id TEXT REFERENCES source_version(id),
  decided_by TEXT,
  decided_at INTEGER,
  decision_note TEXT,
  failure_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_official_correction_status ON official_correction(status, created_at);
CREATE INDEX idx_official_correction_lecture ON official_correction(lecture_id, created_at);

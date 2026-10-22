-- Academic OS P1-T5 step 3 — course-only publications, their immutable content in the subject's space (ARCHITECTURE_DELTA
-- §4.4 `3050_publications`, §6.4; ADR-0004 §2.4; forks band 3050–3099; PRD AOS-4.2, 4.3, 4.14, 4.18, 5.12, 21.16).
--
-- A publication version is the set of `publication_item` rows valid at it. Items keep a STABLE id in every version
-- (sha256 of publication id + the author's item id), and a row covers the versions [valid_from, valid_to) in which that
-- content was current: a republish writes rows only for added or changed items and closes the rows of changed or
-- removed ones — an unchanged item costs nothing, and a follower's references to it survive every update.
--
-- Additions to the design DDL:
--   publication_version.author_layer_ids_json — the author's own vault layers the version was taken from (read back
--                       only by the author, to republish the same layers); never shown to anyone else.
--   publication_version.skipped_json          — what the snapshot left out and why, as counts per reason (pictures,
--                       bookmarks, links, items on inserted note pages, items not on this lecture) — the author is told.
-- `suggestion` (AOS-4.19 / 5.20, Phase 2) is created here as the design places it; Phase 1 has no route that writes it.
CREATE TABLE publication_version (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL,                      -- system publication.id
  version_no INTEGER NOT NULL,
  lecture_id TEXT NOT NULL REFERENCES official_lecture(id),
  lecture_version_id TEXT NOT NULL REFERENCES source_version(id),   -- the official version the explanation was written on
  author_user_id TEXT NOT NULL,
  change_note TEXT,
  item_count INTEGER NOT NULL,
  pages_covered INTEGER NOT NULL,                    -- honest completeness numerator
  pages_total INTEGER NOT NULL,                      -- denominator: pages of lecture_version_id
  audio_recording_id TEXT,
  content_hash TEXT NOT NULL,                        -- sha256 over the canonical item list
  derived_from_json TEXT,
  created_at INTEGER NOT NULL,
  author_layer_ids_json TEXT NOT NULL DEFAULT '[]',
  skipped_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (publication_id, version_no)
) STRICT;
CREATE INDEX idx_publication_version_lecture ON publication_version(lecture_id);

CREATE TABLE publication_item (
  publication_id TEXT NOT NULL,
  item_id TEXT NOT NULL,                             -- stable across versions
  valid_from INTEGER NOT NULL,                       -- first version_no with this content
  valid_to INTEGER,                                  -- first version_no without it (NULL = still current)
  entity_type TEXT NOT NULL CHECK (entity_type IN ('annotation','note','note_page')),
  content_hash TEXT NOT NULL,                        -- sha256 of the canonical row (anchor + data) — diff and integrity
  row_json TEXT NOT NULL,                            -- the canonical row
  source_crop INTEGER NOT NULL DEFAULT 0 CHECK (source_crop IN (0,1)),
  PRIMARY KEY (publication_id, item_id, valid_from)
) STRICT;
CREATE INDEX idx_publication_item_current ON publication_item(publication_id, valid_to);

-- «Suggest a correction or addition» without editing the author's work (Phase 2; no Phase 1 route writes it)
CREATE TABLE suggestion (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL,
  target_version_no INTEGER NOT NULL,
  suggester_user_id TEXT NOT NULL,
  layer_id TEXT NOT NULL REFERENCES annotation_layer(id),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','partially_accepted','rejected','withdrawn')),
  decided_by TEXT,
  decided_at INTEGER,
  decision_note TEXT,
  accepted_item_ids_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_suggestion_publication ON suggestion(publication_id, status);

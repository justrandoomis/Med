-- Academic OS P1-T5 step 3 — course-only publications, the system index (ARCHITECTURE_DELTA §4.1 `2150_publications`,
-- §6.4, §6.5, §7.6; forks band 2150–2199; PRD AOS-2.8, 4.2, 4.3, 4.14, 4.18, 5.12, 5.18, 5.27, 21.16, 21.44, Q6, Q14,
-- Q25). System set, release R1-c. The immutable CONTENT of a publication (its versions and delta-stored items) lives in
-- the subject's space (`3050_publications`); this file holds who published what where, the live head, its moderation
-- state, and who holds a fork or a followed copy (fan-out of updates, honest counts — never content).
--
-- Additions to the design DDL (each a column the module needs, nothing removed):
--   publication.hidden_reason_ar / hidden_at / hidden_by — a moderator's hide (PRD AOS-18.7: «أخفى المشرف هذا الشرح:
--                       السبب» is shown to the author and to holders of a copy; cleared by a restore);
--   publication.withdrawn_at — when the author withdrew it (or the account was deleted, Q14);
--   publication.client_key   — the `Idempotency-Key` of the first publish (a retried POST returns the same publication).
-- `publication_series` (AOS-5.19, a Phase 2 «Could») is created here as the design places it; Phase 1 has no route that
-- writes it (the Phase 1 contract refuses `series_id`).
CREATE TABLE publication_series (
  id TEXT PRIMARY KEY,
  author_user_id TEXT NOT NULL REFERENCES user_account(id),
  subject_node_id TEXT NOT NULL REFERENCES channel_node(id),
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- index row of a publication; its immutable content (versions) lives in the space (publication_version)
CREATE TABLE publication (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES space(id),
  lecture_id TEXT NOT NULL,                          -- official_lecture.id in that space (plain TEXT: cross-DB)
  subject_node_id TEXT NOT NULL REFERENCES channel_node(id),
  author_user_id TEXT NOT NULL REFERENCES user_account(id),
  kind TEXT NOT NULL CHECK (kind IN ('explanation','voice_explanation','crowd_notes')),
  title TEXT NOT NULL,
  summary TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN ('specific_users','followers','course','public')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden_by_moderator','withdrawn','author_deleted')),
  moderator_review TEXT NOT NULL DEFAULT 'none' CHECK (moderator_review IN ('none','reviewed','changes_requested')),
  reviewed_by TEXT REFERENCES user_account(id),
  reviewed_role TEXT,
  reviewed_at INTEGER,
  head_version_no INTEGER NOT NULL,                  -- the live head; versions are immutable
  quick_review_tag INTEGER NOT NULL DEFAULT 0 CHECK (quick_review_tag IN (0,1)),
  series_id TEXT REFERENCES publication_series(id),
  series_ord REAL,
  signals_json TEXT NOT NULL DEFAULT '{}',
  rank_score REAL,
  rank_version TEXT,
  published_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  hidden_reason_ar TEXT,
  hidden_at INTEGER,
  hidden_by TEXT REFERENCES user_account(id),
  withdrawn_at INTEGER,
  client_key TEXT
) STRICT;
CREATE INDEX idx_publication_lecture ON publication(space_id, lecture_id, status);
CREATE INDEX idx_publication_author ON publication(author_user_id, published_at);
CREATE INDEX idx_publication_subject ON publication(subject_node_id, published_at);
CREATE UNIQUE INDEX idx_publication_client_key ON publication(author_user_id, client_key) WHERE client_key IS NOT NULL;

-- who holds a fork / followed copy (fan-out of updates, honest counts). The user's own truth is document_copy in the vault.
CREATE TABLE publication_copy (
  user_id TEXT NOT NULL REFERENCES user_account(id),
  publication_id TEXT NOT NULL REFERENCES publication(id),
  mode TEXT NOT NULL CHECK (mode IN ('independent','followed')),
  applied_version_no INTEGER NOT NULL,
  pending_version_no INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY (user_id, publication_id)
) STRICT;
CREATE INDEX idx_publication_copy_pub ON publication_copy(publication_id, mode) WHERE ended_at IS NULL;

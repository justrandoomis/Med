-- Academic OS P1-T5 step 2 — «ابدأ الدراسة» (ARCHITECTURE_DELTA §4.2 `0860_document_copy`, §6.5, §7.5; forks range
-- 0860–0869; PRD AOS-2.17–2.19, 4.1–4.3, Q25, Q35). Base set, release R1-c. A user's study copy of a lecture, in their
-- OWN vault: the stub (source with the space's ids, `source.is_stub = 1`) or a private upload, the personal layer, and
-- (Phase 1 step 3) a forked or followed layer. Unused in spaces.
--
-- Additions to the design DDL:
--   reanchor_policy   — «انقل ملاحظاتي تلقائيًا» for a new OFFICIAL version (PRD Q35; copies-api `reanchor_policy`);
--                       `update_policy` is the followed explanation's (Q25).
--   client_body_hash  — sha256 of the «ابدأ الدراسة» body: the same client id with another body answers 409.
--   created_device_id — the device that asked (shown nowhere; diagnostics only).
-- A copy is never deleted by an update, a takedown or another person's action: `deleted_at` is set only by its owner.
CREATE TABLE document_copy (
  id TEXT PRIMARY KEY,                               -- client ULID allowed (Start Studying works offline for a downloaded stub)
  source_id TEXT NOT NULL REFERENCES source(id),     -- the stub (or a private upload)
  origin_space_id TEXT,                              -- NULL for private uploads
  origin_lecture_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('personal','independent_fork','followed','collaborative')),
  publication_id TEXT,                               -- fork / followed: the system publication id
  applied_version_no INTEGER,                        -- fork: pinned forever; followed: last applied
  pending_version_no INTEGER,                        -- followed: an update waiting for preview
  update_policy TEXT NOT NULL DEFAULT 'preview' CHECK (update_policy IN ('preview','auto')),
  reanchor_policy TEXT NOT NULL DEFAULT 'preview' CHECK (reanchor_policy IN ('preview','auto')),
  personal_layer_id TEXT NOT NULL REFERENCES annotation_layer(id),
  copied_layer_id TEXT REFERENCES annotation_layer(id),   -- forked (writable) or followed (read-only) layer
  collab_doc_ref TEXT,                               -- collaborative: collab_doc id in the space (Phase 4)
  client_body_hash TEXT,
  created_device_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE INDEX idx_document_copy_source ON document_copy(source_id);
CREATE INDEX idx_document_copy_lecture ON document_copy(origin_space_id, origin_lecture_id) WHERE origin_lecture_id IS NOT NULL;
CREATE UNIQUE INDEX idx_document_copy_pub ON document_copy(publication_id) WHERE publication_id IS NOT NULL AND deleted_at IS NULL;
-- one personal copy per lecture (Start Studying twice reopens the same copy)
CREATE UNIQUE INDEX idx_document_copy_personal ON document_copy(source_id) WHERE mode = 'personal' AND deleted_at IS NULL;

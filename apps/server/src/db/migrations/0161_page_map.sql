-- Sources module (range 0150–0199), Academic OS track P1-T3 (ARCHITECTURE_DELTA §4.2, §6.2; PRD AOS-3.11, 3.12, 19H.2,
-- 21.13). Page fingerprints and the order-preserving old ↔ new page map between two versions (Scenario 4).
--
-- page_fingerprint.layout_hash / text_len are additions to the design DDL: the hash of the text-region geometry tells
-- «same text, same layout» (coordinates reusable) from «same text, re-laid-out» without rendering the page, and
-- text_len decides whether the text signals are meaningful. dHash is rendered only for pages with little text.
CREATE TABLE page_fingerprint (
  page_id TEXT PRIMARY KEY REFERENCES source_page(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL,
  text_norm_hash TEXT,                               -- sha256 of the page's normalised logical text (null: no text)
  text_minhash BLOB,                                 -- 64 × u32 MinHash over word 3-shingles (little-endian)
  image_dhash TEXT,                                  -- 64-bit dHash of the page image, hex
  layout_hash TEXT,                                  -- hash of the rounded text-region boxes (null: no text regions)
  text_len INTEGER NOT NULL DEFAULT 0,               -- characters of normalised text
  algo TEXT NOT NULL,                                -- fingerprint scheme version
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_page_fingerprint_version ON page_fingerprint(version_id);
CREATE INDEX idx_page_fingerprint_text ON page_fingerprint(text_norm_hash) WHERE text_norm_hash IS NOT NULL;

CREATE TABLE version_page_map (
  from_version_id TEXT NOT NULL,
  to_version_id TEXT NOT NULL,
  from_page_id TEXT NOT NULL,
  to_page_id TEXT,                                   -- NULL: no safe counterpart (page removed or rewritten)
  method TEXT NOT NULL CHECK (method IN ('identical','text_similarity','image_similarity','moderator','owner')),
  text_score REAL,
  image_distance INTEGER,
  layout_safe INTEGER NOT NULL DEFAULT 0 CHECK (layout_safe IN (0,1)),  -- 1 → normalised coordinates may be reused (§6.2)
  status TEXT NOT NULL CHECK (status IN ('safe','uncertain','none','confirmed','rejected')),
  algo TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_version_id, to_version_id, from_page_id)
) STRICT;
CREATE INDEX idx_version_page_map_to ON version_page_map(to_version_id);
-- the sources purge deletes both tables' rows for purged versions through the versions module's purge extension
-- (modules/versions/purgeExtension.ts; docs/modules/library-sources.md)

-- One row per computed pair: tells «computed, ready» from «not computed yet», and keeps the counts of the last run.
CREATE TABLE page_map_run (
  from_version_id TEXT NOT NULL,
  to_version_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready','failed')),
  algo TEXT NOT NULL,
  counts_json TEXT,
  reason TEXT,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (from_version_id, to_version_id)
) STRICT;

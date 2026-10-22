-- Academic OS P1-T5 step 2 (ARCHITECTURE_DELTA §4.2 `0163_pinned_region`, §6.7; ADR-0003 §3.3; BUILD_PLAN §3.7). Base set,
-- release R1-c. Lazy pinning: a vault STUB of an official lecture holds no region text (regions, chunks and FTS stay in
-- the subject's space); when a vault artifact cites a region of the official version, the region row is copied into the
-- vault under the SAME id (so `evidence.region_id` keeps its foreign key) and this row records where it came from and
-- the content hash it copied. Published official regions are immutable, so for them the hash never changes; a
-- difference between the space and the vault is detectable and never silent, and a pin is refreshed only by an
-- explicit user action after a content alert (§6.7). Additive: one new, empty table. Unused in spaces.
CREATE TABLE pinned_region (
  region_id TEXT PRIMARY KEY,                        -- the space's source_region.id (same id in the vault)
  space_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,                        -- sha256 of the region text + locator at pin time
  pinned_at INTEGER NOT NULL,
  refreshed_at INTEGER
) STRICT;
CREATE INDEX idx_pinned_region_version ON pinned_region(version_id);

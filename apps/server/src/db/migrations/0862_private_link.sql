-- Academic OS Phase 1 completion, track C2 (PRD AOS-19H.3, X8 (c); ARCHITECTURE_DELTA §6.9 step 2; forks range
-- 0860–0869). Base set. «اربط بالمحاضرة الرسمية» records WHICH private version was linked to WHICH official version of
-- the user's stub, so the items that could not be placed safely are listed in the review list of the official copy
-- («تحتاج مراجعة — من محاضرتك الخاصة») and can be copied across the two documents by hand (or kept on the private
-- lecture). A link that copied nothing is still a link: nothing else would remember it.
-- Unused in spaces. Additive only: a new, empty table; no existing row changes. Inserted note pages are copied as
-- ordinary `note_page` rows with deterministic ids (no bookkeeping table needed).
CREATE TABLE private_link (
  private_version_id TEXT NOT NULL,                  -- the private upload's version whose items were copied (source untouched)
  to_version_id TEXT NOT NULL,                       -- the official version (a stub version: the space's id)
  private_source_id TEXT NOT NULL,
  stub_source_id TEXT NOT NULL,                      -- the vault stub of the official lecture (source.is_stub = 1)
  space_id TEXT NOT NULL,
  lecture_id TEXT NOT NULL,
  counts_json TEXT NOT NULL,                         -- the last link's report: total / copied / needs_review / kept / note pages
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (private_version_id, to_version_id)
) STRICT;
CREATE INDEX idx_private_link_stub ON private_link(stub_source_id);
CREATE INDEX idx_private_link_private ON private_link(private_source_id);

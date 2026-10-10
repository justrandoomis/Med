-- Personal Control Center (track D2, range 0700–0749): history of owner corrections made from the Review Queue
-- (§48, AC-26) and read-path indexes for the queue. No existing migration is edited.
--
-- control_region_correction : one row per owner decision on a region / page text made from the Review Queue.
--   The PREVIOUS text, origin, status and confidence are kept here verbatim (the region row itself is updated in
--   place to the owner's text: text_origin 'owner', status 'owner_reviewed'), so a correction is never a silent
--   overwrite and can be inspected later. No foreign keys on purpose: a permanent delete of the source must not be
--   blocked by this history (the control module removes rows of purged sources itself).
--     action        : correct (owner text replaces the extracted text) | accept (extracted text confirmed as is)
--                     | reject (extracted text excluded from search and evidence) | owner_text (owner transcription
--                     of an unreadable page, stored as a new region)
--     alert_id      : the content change alert raised for the dependents (NULL when nothing depended on it)
CREATE TABLE control_region_correction (
  id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  page_id TEXT,
  review_item_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('correct','accept','reject','owner_text')),
  before_text TEXT,
  after_text TEXT,
  before_origin TEXT,
  after_origin TEXT,
  before_status TEXT,
  after_status TEXT,
  before_confidence REAL,
  alert_id TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_control_correction_region ON control_region_correction(region_id, created_at);
CREATE INDEX idx_control_correction_page ON control_region_correction(page_id, created_at);
CREATE INDEX idx_control_correction_item ON control_region_correction(review_item_id);
CREATE INDEX idx_control_correction_source ON control_region_correction(source_id);

-- Review Queue read paths (list across all kinds by status / source, newest first).
CREATE INDEX IF NOT EXISTS idx_control_review_created ON review_queue_item(status, created_at);
CREATE INDEX IF NOT EXISTS idx_control_review_source ON review_queue_item(source_id, status);

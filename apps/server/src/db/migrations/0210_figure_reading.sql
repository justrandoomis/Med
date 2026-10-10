-- Processing module (track F3, range 0200–0249): the on-demand Vision step for visual regions (§13, §14, AC-08).
--
-- A figure reading is a DERIVED, UNCERTAIN reading of a figure's structure by a vision model (task 'vision_figure'):
-- nodes / edges / direction with a certainty per element. It is stored HERE, never in source_region: the original
-- region, its OCR text and its OCR-only diagram structure stay exactly as processed. A reading is 'uncertain' until
-- the owner reviews it ('owner_reviewed' / 'rejected'); while uncertain it is never evidence and never a fixed exam
-- answer. Re-processing a page replaces its regions: the reading keeps its row (figure_region_id becomes NULL —
-- «the figure was re-processed») so the owner's review is not silently lost; a permanent purge removes it with its
-- version (ON DELETE CASCADE).
--   structure_json          : DiagramStructure as read by the model (certainty per node / edge)
--   reviewed_structure_json : the owner's corrected structure (the model reading stays as it was)
--   direction               : top_down | bottom_up | left_right | right_left | radial | mixed | unknown
CREATE TABLE figure_reading (
  id TEXT PRIMARY KEY,
  figure_region_id TEXT REFERENCES source_region(id) ON DELETE SET NULL,
  diagram_region_id TEXT REFERENCES source_region(id) ON DELETE SET NULL,
  page_id TEXT REFERENCES source_page(id) ON DELETE SET NULL,
  version_id TEXT NOT NULL REFERENCES source_version(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','uncertain','owner_reviewed','rejected','failed')),
  structure_json TEXT,
  reviewed_structure_json TEXT,
  direction TEXT NOT NULL DEFAULT 'unknown',
  notes_json TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  job_id TEXT,
  error_json TEXT,
  review_note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_at INTEGER
) STRICT;
CREATE INDEX idx_figure_reading_region ON figure_reading(figure_region_id, created_at);
CREATE INDEX idx_figure_reading_version ON figure_reading(version_id);

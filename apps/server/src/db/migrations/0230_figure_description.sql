-- Processing module (range 0200–0249): automatic figure descriptions for image-heavy lectures (histology, gross
-- specimens, radiology, graphs, clinical photos). A description is a DERIVED, STRUCTURED reading of one picture by a
-- vision model — stored HERE, never in source_region / image_asset: the original picture, its region and its OCR text
-- stay exactly as processed.
--
-- figure_description : one row per picture of a version. Identity = (version_id, file_id): the crop's stored file is
--                      content-addressed, so re-processing a page that yields the same crop finds the same row
--                      (idempotent per picture + version) and the owner's correction is never lost; region_id /
--                      image_asset_id / page_id are refreshed to the new rows (SET NULL while they are gone).
--   target           : 'figure' (a cropped figure region) | 'page' (an image-only page / slide: its render)
--   status           : pending | described | failed | skipped (skip_reason: budget | consent | not_configured |
--                      cap | no_image — nothing was sent)
--   model_json       : the model's description after the server's checks (a diagnosis whose quote is not in the
--                      slide's own text / caption is downgraded to basis 'suggestion' = «اقتراح — غير مؤكد»)
--   owner_json       : the owner's corrected description — it WINS over model_json and is kept on every re-run
--   owner_status     : confirmed | edited | rejected (NULL: not reviewed — shown as «وصف آلي — راجعه»)
-- figure_description_run : one «describe every picture» pass over a version (auto after processing, or the owner's
--                      «صف كل الصور»), with an honest status / reason when nothing could be sent.
-- figure_question    : a generated image question ↔ the description of the lecture picture it asks about (the
--                      question shows the ORIGINAL picture; validation counts it as the attached image).
CREATE TABLE figure_description (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES source_version(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  page_id TEXT REFERENCES source_page(id) ON DELETE SET NULL,
  region_id TEXT REFERENCES source_region(id) ON DELETE SET NULL,
  image_asset_id TEXT REFERENCES image_asset(id) ON DELETE SET NULL,
  file_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('figure','page')),
  ord INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending','described','failed','skipped')),
  skip_reason TEXT,
  model_json TEXT,
  owner_json TEXT,
  owner_status TEXT CHECK (owner_status IN ('confirmed','edited','rejected')),
  model TEXT,
  task TEXT,
  error_json TEXT,
  run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  described_at INTEGER,
  reviewed_at INTEGER,
  UNIQUE (version_id, file_id)
) STRICT;
CREATE INDEX idx_figure_description_region ON figure_description(region_id);
CREATE INDEX idx_figure_description_source ON figure_description(source_id, version_id);

CREATE TABLE figure_description_run (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES source_version(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  job_id TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('auto','owner')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','partial','skipped','failed')),
  reason_ar TEXT,
  request_json TEXT NOT NULL DEFAULT '{}',
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_figure_description_run_version ON figure_description_run(version_id, created_at);

CREATE TABLE figure_question (
  question_id TEXT PRIMARY KEY REFERENCES question(id) ON DELETE CASCADE,
  description_id TEXT NOT NULL REFERENCES figure_description(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_figure_question_description ON figure_question(description_id);

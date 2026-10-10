-- Media module (track D3, range 0650–0699): lecture audio layer (§29), Medical Image Explorer, non-destructive
-- overlays and Image Quiz (§32, AC-08, AC-09). No existing migration edited.
--
-- References into tables owned by other modules are plain TEXT (no FK) so the sources purge (which refuses to run
-- while an unknown FK points into its purge set) keeps working; references to media rows that a purge deletes use
-- ON DELETE CASCADE.

-- audio_asset (0001): one row per audio source version (created lazily from source_version format 'audio').
--   version_id      : the source_version it plays (plain TEXT)
--   mime            : copied from the version (stream content type)
--   duration_origin : 'player' when the duration was reported by the owner's browser (the server does not decode audio)
ALTER TABLE audio_asset ADD COLUMN version_id TEXT;
ALTER TABLE audio_asset ADD COLUMN mime TEXT;
ALTER TABLE audio_asset ADD COLUMN duration_origin TEXT CHECK (duration_origin IN ('player'));
ALTER TABLE audio_asset ADD COLUMN updated_at INTEGER;
CREATE UNIQUE INDEX idx_audio_asset_version ON audio_asset(version_id) WHERE version_id IS NOT NULL;
CREATE INDEX idx_audio_asset_source ON audio_asset(source_id);

-- transcript_segment (0001): `text` is the ORIGINAL text (typed / imported / recognized) and is never overwritten;
-- corrections go to corrected_text and every change appends a transcript_revision row.
--   origin    : manual | imported_vtt | imported_srt | transcription
--   speaker   : only when the imported file names it (a VTT <v Name> tag) — never guessed (§29)
--   rev       : optimistic concurrency for edits
--   deleted_at: tombstone (the row and its history stay)
--   import_id : the transcript_import that created it
ALTER TABLE transcript_segment ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','imported_vtt','imported_srt','transcription'));
ALTER TABLE transcript_segment ADD COLUMN speaker TEXT;
ALTER TABLE transcript_segment ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE transcript_segment ADD COLUMN updated_at INTEGER;
ALTER TABLE transcript_segment ADD COLUMN deleted_at INTEGER;
ALTER TABLE transcript_segment ADD COLUMN import_id TEXT;
CREATE INDEX idx_transcript_segment_audio ON transcript_segment(audio_id, start_ms);

-- Append-only history of every change to a segment (create, correction, retime, delete, restore, replaced by import).
CREATE TABLE transcript_revision (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES transcript_segment(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create','correct','clear_correction','retime','delete','restore','replaced_by_import')),
  text TEXT NOT NULL,
  corrected_text TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_transcript_revision_segment ON transcript_revision(segment_id, rev);

-- Subtitle files imported as transcript segments (WebVTT / SubRip). Skipped cues are reported with reasons.
CREATE TABLE transcript_import (
  id TEXT PRIMARY KEY,
  audio_id TEXT NOT NULL REFERENCES audio_asset(id) ON DELETE CASCADE,
  format TEXT NOT NULL CHECK (format IN ('vtt','srt')),
  file_name TEXT,
  created_count INTEGER NOT NULL,
  skipped_json TEXT NOT NULL DEFAULT '[]',
  replaced_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_transcript_import_audio ON transcript_import(audio_id, created_at);

-- media_region_link (0001): segment ↔ page / region. origin 'manual' (owner) or 'auto' (a future auto-linker —
-- none exists in this version, nothing is invented). An auto link the owner confirms keeps origin 'auto'.
ALTER TABLE media_region_link ADD COLUMN confirmed_at INTEGER;
ALTER TABLE media_region_link ADD COLUMN deleted_at INTEGER;
ALTER TABLE media_region_link ADD COLUMN to_version_id TEXT;
ALTER TABLE media_region_link ADD COLUMN to_source_id TEXT;
CREATE INDEX idx_media_region_link_from ON media_region_link(from_type, from_id);
CREATE INDEX idx_media_region_link_page ON media_region_link(to_page_id);
CREATE INDEX idx_media_region_link_region ON media_region_link(to_region_id);

-- media_overlay (0001): non-destructive overlays on the ORIGINAL image geometry (normalized). Tombstoned, versioned.
--   aliases_json : accepted alternative answers for a quiz mask
ALTER TABLE media_overlay ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE media_overlay ADD COLUMN note TEXT;
ALTER TABLE media_overlay ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE media_overlay ADD COLUMN updated_at INTEGER;
ALTER TABLE media_overlay ADD COLUMN deleted_at INTEGER;
CREATE INDEX idx_media_overlay_image ON media_overlay(image_id);

-- The owner's classification of an image. image_asset belongs to processing; the owner's values live here and win
-- for display, labelled «صنّفتها أنت». Nothing is auto-assigned.
CREATE TABLE image_meta (
  image_id TEXT PRIMARY KEY REFERENCES image_asset(id) ON DELETE CASCADE,
  image_kind TEXT CHECK (image_kind IN (
    'clinical_photo','educational_drawing','diagram','radiology','histology','pathology','ecg','dermatology',
    'ophthalmology','table_image','generated_illustration','reorganized_diagram','unknown')),
  title TEXT,
  modality TEXT,
  anatomic_region TEXT,
  age_group TEXT CHECK (age_group IN ('neonate','infant','child','adolescent','adult','elderly','pregnant')),
  topic_id TEXT,
  note TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_image_meta_topic ON image_meta(topic_id);

-- Image Quiz sessions. items_json [{key:'m1', overlay_id}] maps NEUTRAL keys to overlays (never sent to the client
-- before answering). Answers are append-only.
CREATE TABLE image_quiz (
  id TEXT PRIMARY KEY,
  image_id TEXT NOT NULL REFERENCES image_asset(id) ON DELETE CASCADE,
  items_json TEXT NOT NULL,
  excluded_json TEXT NOT NULL DEFAULT '[]',
  masks_rendered TEXT NOT NULL CHECK (masks_rendered IN ('server','client')),
  status TEXT NOT NULL CHECK (status IN ('in_progress','finished')),
  created_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;
CREATE INDEX idx_image_quiz_image ON image_quiz(image_id, created_at);

CREATE TABLE image_quiz_answer (
  id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL REFERENCES image_quiz(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  overlay_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('correct','incorrect','self_marked_correct')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_image_quiz_answer_quiz ON image_quiz_answer(quiz_id, created_at);

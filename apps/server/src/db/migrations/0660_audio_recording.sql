-- Track F4 — in-app recording (§29). A recording made in the app is stored as a «ملاحظة صوتية» (my_audio_note) source
-- through the sources module; this table maps the client's recording id (ULID, generated when the owner pressed
-- «سجّل») to that source, so a retried upload is idempotent and pen strokes written during the recording
-- (annotation.data.audio_link.recording_id) can be played back at their moment.
--   started_at   device clock (epoch ms) when recording started — stroke offsets are relative to it, computed on the
--                device that recorded (never re-derived from server time)
--   linked_source_id  the lecture open while recording (also a source_link 'audio_for'); SET NULL on purge
CREATE TABLE audio_recording (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  version_id TEXT REFERENCES source_version(id) ON DELETE CASCADE,
  linked_source_id TEXT REFERENCES source(id) ON DELETE SET NULL,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER,
  mime TEXT NOT NULL,
  device_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_audio_recording_source ON audio_recording(source_id);
CREATE INDEX idx_audio_recording_linked ON audio_recording(linked_source_id) WHERE linked_source_id IS NOT NULL;

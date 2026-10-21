-- Sources module (range 0150–0199; 0162 and 0163 are reserved for P3-T2 and P1-T5), Academic OS track P1-T3
-- (PRD AOS-2.4, 3.14). A DOCX version keeps its paragraph pages and locators (the evidence, §07); this table holds the
-- fixed-page display PDF LibreOffice makes of it. It is NOT source_version.display_file_id on purpose: every reader of
-- that column assumes «PDF page i = source page i», which is false for a DOCX (pages are paragraph sections).
CREATE TABLE version_rendition (
  version_id TEXT NOT NULL REFERENCES source_version(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('docx_display_pdf')),
  file_id TEXT REFERENCES stored_file(id),
  status TEXT NOT NULL CHECK (status IN ('ready','failed','unavailable')),
  page_count INTEGER,
  fonts_json TEXT,                                   -- [{"name","embedded"}] read from the PDF's font dictionaries
  engine TEXT,                                       -- e.g. «LibreOffice 24.2»
  reason TEXT,                                       -- Arabic, when not ready
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (version_id, role)
) STRICT;
CREATE INDEX idx_version_rendition_file ON version_rendition(file_id) WHERE file_id IS NOT NULL;

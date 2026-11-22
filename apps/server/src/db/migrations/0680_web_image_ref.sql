-- Web reference images («صور من الويب», media/web-images): «أضف إلى ملاحظاتي» keeps a picture found on the web as a
-- REFERENCE CARD in the owner's notes — never as lecture content and never without its attribution. The row is made
-- only from a result the server itself signed (so the credit cannot be dropped or changed). The picture itself is not
-- stored here: thumb_remote / large_remote are allow-listed URLs the server proxies and caches (DATA_DIR/cache).
--   usage        free_licence (Wikimedia Commons, a free licence) | linked_preview (Open-i / Google: credit + link)
--   source_id …  the lecture (and version / page) it was pinned from; null = not tied to a lecture
CREATE TABLE web_image_ref (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('wikimedia', 'openi', 'google')),
  query TEXT,
  title TEXT NOT NULL,
  caption TEXT,
  author TEXT,
  license TEXT,
  license_url TEXT,
  usage TEXT NOT NULL CHECK (usage IN ('free_licence', 'linked_preview')),
  page_url TEXT NOT NULL,
  image_url TEXT NOT NULL,
  thumb_remote TEXT NOT NULL,
  large_remote TEXT NOT NULL,
  source_id TEXT,
  version_id TEXT,
  page_id TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_web_image_ref_source ON web_image_ref(source_id, created_at);

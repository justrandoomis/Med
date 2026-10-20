-- Round 7 H4 (§32) — the registry of external visual sources the owner allows («أنشئ سجلًا للمصادر البصرية التي
-- أسمح بها»). Owner-managed. An external image candidate is accepted only when its original URL belongs to an ENABLED
-- entry (media/validate-image.ts check `allowed_source`); any future fetch passes the same registry AND the server
-- switch MEDLEVO_ALLOW_EXTERNAL_FETCH. Nothing is fetched by having an entry here.
--   domain       lowercase host name (no scheme / port / path); sub-domains of it are included
--   path_prefix  optional: narrows the entry to one atlas / collection on that domain («/cases/»)
--   licence_note the owner's own note on the licence / terms (MedLevo does not verify licences)
CREATE TABLE visual_source (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  path_prefix TEXT,
  kind TEXT NOT NULL DEFAULT 'atlas' CHECK (kind IN ('atlas', 'open_repository', 'journal', 'institution', 'other')),
  licence_note TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_visual_source_place ON visual_source(domain, COALESCE(path_prefix, ''));

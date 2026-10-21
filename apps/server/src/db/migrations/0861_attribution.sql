-- Academic OS, P1-T2 step 2 (ARCHITECTURE_DELTA §4.2 «0861_attribution», §6.6; new forks range 0860–0869). Base set.
-- Human authorship of copied content: one row per copied item («انسخ الطبقة» now; follow / fork / publish copies with the
-- channels release). Never evidence; shown as «مأخوذ من …».
--   author_user_id    the author of the original; 'vault:self' = this vault's own user before accounts exist (R1-a; the
--                     owner migration maps it to user #1)
--   author_display    the name at copy time: an offline FALLBACK only. Online, names are rendered at read time from the
--                     system user_account (a deleted account renders «طالب سابق» everywhere at once), so no other user's
--                     vault is ever written to change a name (PRD Q14)
--   derived_from_json [{space_id, publication_id, version_no, item_id, layer_id?, document_key?}] — appended on every hop
-- Additive only: a new, empty table on the owner's existing database.
CREATE TABLE attribution (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('annotation','note','note_page','annotation_layer','publication_version')),
  entity_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  author_display TEXT NOT NULL,
  derived_from_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
) STRICT;

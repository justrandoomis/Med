-- Round 7 — H3 item 2 (§25 manual re-anchoring). The owner moves a note / highlight / ink group listed in «تحتاج إعادة
-- ربط» to a place they choose, or keeps it detached on purpose. Nothing is ever deleted or moved silently:
--   annotation.detached_at  the owner chose to keep this item detached (it leaves «تحتاج إعادة ربط» and is listed under
--                           «محفوظة دون ربط», where it can still be re-anchored); its anchor and previous anchor stay.
--   note.previous_anchor_json  the anchor a note had before the owner re-anchored it (annotations already keep theirs
--                              in previous_anchor_json)
--   note.detached_at           as for annotations
-- Every decision is also recorded in the audit log (change_log) with the anchor before and after.
ALTER TABLE annotation ADD COLUMN detached_at INTEGER;
ALTER TABLE note ADD COLUMN previous_anchor_json TEXT;
ALTER TABLE note ADD COLUMN detached_at INTEGER;

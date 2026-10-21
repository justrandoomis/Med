-- Academic OS, P1-T1 step 0 (ARCHITECTURE_DELTA §4.2, §8.3–§8.4; sync range 0040–0049). Base set: applied to every vault
-- and every space. Additive only, safe on the single owner's existing database (applied after 0810 there; every row is
-- kept and the new columns start NULL):
--   sync_operation.actor_user_id  who sent the op; NULL in a vault = the vault's user (today: the owner)
--   sync_change.visibility_key    who may pull the change; NULL = every reader of this database. Spaces set it
--                                 (`pub:<id>`, `collab:<id>`, `room:<id>`, `thread:<id>`, `mod`) and filter with
--                                 `visibility_key IS NULL OR visibility_key IN (…)` (§8.4)
ALTER TABLE sync_operation ADD COLUMN actor_user_id TEXT;
ALTER TABLE sync_change ADD COLUMN visibility_key TEXT;
CREATE INDEX idx_sync_change_visibility ON sync_change(visibility_key, seq) WHERE visibility_key IS NOT NULL;

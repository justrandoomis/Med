-- Academic OS, P1-T1 step 0 (ARCHITECTURE_DELTA §4.2, §13; new audit range 0050–0059). Base set. Additive only, safe on
-- the single owner's existing database (every row kept, the new columns start NULL):
--   change_log.actor_user_id  the acting user; `actor` keeps its owner|system|job meaning ('owner' now means «the acting
--                             user»); NULL on every row written before accounts exist
--   change_log.actor_role     the role used, e.g. 'subject_moderator@<node_id>' | 'platform_admin' | 'self'
ALTER TABLE change_log ADD COLUMN actor_user_id TEXT;
ALTER TABLE change_log ADD COLUMN actor_role TEXT;

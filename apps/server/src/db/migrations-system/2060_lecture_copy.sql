-- Academic OS P1-T5 step 2 (ARCHITECTURE_DELTA §4.1 `2060_lecture_copy`, §6.3; forks). System set, release R1-c.
-- Who holds a copy of which official lecture, so jobs never scan vaults: stub fan-out of new versions, withdrawal
-- notices, «refuse purge while personal items exist», takedown. Written ONLY by the copy / stub / reanchor services in
-- the same job that changes the vault, keyed for idempotency; read ONLY by jobs; moderators see counts (minimum group
-- 5). A cross-user dataset by necessity: it holds no content, titles or item ids — only that a user has a copy and how
-- many personal items sit on each version.
CREATE TABLE lecture_copy (
  user_id TEXT NOT NULL REFERENCES user_account(id),
  space_id TEXT NOT NULL REFERENCES space(id),
  lecture_id TEXT NOT NULL,                          -- official_lecture.id in that space
  version_id TEXT NOT NULL,                          -- a version the user's vault holds a stub of
  personal_items INTEGER NOT NULL DEFAULT 0,         -- personal annotations + notes on that version (refreshed by the vault job)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, space_id, lecture_id, version_id)
) STRICT;
CREATE INDEX idx_lecture_copy_lecture ON lecture_copy(space_id, lecture_id, version_id);

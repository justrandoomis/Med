-- System DB — reports and moderation actions (ARCHITECTURE_DELTA §4.1 `2310_moderation`, §13; PRD AOS-18.7, 18.8 Phase 1
-- parts, Q6). P1-T4 step 2, release R1-c.
--
-- Phase 1: reports on publications (system index) and publication versions (the subject's space) → the moderators of
-- `scope_node_id` → hide / restore / dismiss with an Arabic reason the author and the reporter read; one OPEN report per
-- reporter per target. The content itself lives with its owner track (P1-T5 publications): moderation asks it, through
-- the target registry (modules/moderation/targets.ts), for the scope, title, author and state, and to hide or restore
-- — copy, never move: followers keep what they had. Phase 2 widens the vocabulary below (appeals, discussions …).
CREATE TABLE moderation_report (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT NOT NULL REFERENCES user_account(id),
  target_db TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('publication','publication_version','discussion_thread','discussion_post',
                                                   'suggestion','profile','room','official_lecture')),
  target_id TEXT NOT NULL,
  scope_node_id TEXT NOT NULL REFERENCES channel_node(id),     -- routes the report to the moderators of that subtree
  reason TEXT NOT NULL CHECK (reason IN ('wrong_content','copyright','harassment','spam','privacy','patient_identifiers','other')),
  note TEXT,                                         -- the reporter's note: moderators of the scope only
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
) STRICT;
CREATE INDEX idx_report_scope ON moderation_report(scope_node_id, status, created_at);
CREATE UNIQUE INDEX idx_report_once ON moderation_report(reporter_user_id, target_db, target_type, target_id) WHERE status = 'open';
CREATE INDEX idx_report_target ON moderation_report(target_db, target_type, target_id, status);
CREATE INDEX idx_report_reporter ON moderation_report(reporter_user_id, created_at);

CREATE TABLE moderation_action (
  id TEXT PRIMARY KEY,
  report_id TEXT REFERENCES moderation_report(id),
  moderator_user_id TEXT NOT NULL REFERENCES user_account(id),
  role TEXT NOT NULL,                                -- the role acted with in that scope, or 'platform_admin'
  action TEXT NOT NULL CHECK (action IN ('hide','restore','request_changes','mark_reviewed','remove_post','lock_thread',
                                         'warn_user','suspend_user','dismiss')),   -- mark_reviewed: Subject Moderator only (§5.3)
  target_db TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  scope_node_id TEXT NOT NULL REFERENCES channel_node(id),
  reason_ar TEXT NOT NULL,                           -- shown to the author (and the reporter)
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_moderation_action_target ON moderation_action(target_db, target_type, target_id, created_at);
CREATE INDEX idx_moderation_action_scope ON moderation_action(scope_node_id, created_at);

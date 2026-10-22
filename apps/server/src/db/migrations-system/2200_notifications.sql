-- System DB — the in-app inbox, preferences, Web Push subscriptions and the fan-out queue (ARCHITECTURE_DELTA §4.1
-- `2200_notifications`, §12; PRD AOS-18.13, 21.31, 5.18 Phase 1 part). P1-T4 step 2, release R1-c.
--
-- A payload holds TITLES AND COUNTS ONLY (packages/shared notificationContentSchema, strict per kind, checked before
-- the row is written); names of people are rendered at read time from `actor_user_id`. A recipient sees a row only
-- while it may still open what the row is about (`access` on `scope_node_id`, checked when the row is written AND when
-- the inbox is read), so a lost membership or role hides earlier notices instead of leaking titles.
CREATE TABLE notification (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user_account(id),
  kind TEXT NOT NULL,                                -- §12 (notifications-api.ts NOTIFICATION_KINDS)
  actor_user_id TEXT,                                -- null for the kinds without an actor (moderation, reports, system)
  subject_db TEXT,                                   -- 'system' | 'vault' | the id of a subject space
  subject_type TEXT,
  subject_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',           -- titles and counts only; never private note text
  link TEXT,                                         -- in-app route it opens (access is re-checked there)
  access TEXT NOT NULL DEFAULT 'self' CHECK (access IN ('self','member','manage_members','moderate')),
  scope_node_id TEXT,                                -- the channel node `access` is checked on
  dedupe_key TEXT,
  seq INTEGER NOT NULL,                              -- per-user order of arrival (the inbox pages by it, newest first)
  created_at INTEGER NOT NULL,                       -- when the event happened (shown, grouped per day)
  read_at INTEGER,
  dismissed_at INTEGER
) STRICT;
CREATE UNIQUE INDEX idx_notification_seq ON notification(user_id, seq);
CREATE UNIQUE INDEX idx_notification_dedupe ON notification(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_notification_unread ON notification(user_id, access, scope_node_id) WHERE read_at IS NULL AND dismissed_at IS NULL;
CREATE INDEX idx_notification_scope ON notification(user_id, access, scope_node_id);

-- per kind × channel; a missing row means the default (in_app on, push off — push is opt-in per device)
CREATE TABLE notification_pref (
  user_id TEXT NOT NULL REFERENCES user_account(id),
  kind TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('in_app','push')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  PRIMARY KEY (user_id, kind, channel)
) STRICT;

-- Web Push (VAPID) subscriptions — the table of §4.1; no route writes it while this server cannot deliver push
-- (no VAPID keys, nothing measured on a device): the preferences say so instead of offering a switch that does nothing
CREATE TABLE push_subscription (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user_account(id),
  device_id TEXT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  revoked_at INTEGER
) STRICT;

-- The fan-out queue (§12 «a job that writes notification rows in batches of 500 with dedupe_key»). The job queue of
-- modules/jobs keeps each job in a vault or a space; a notification for many people belongs to neither, so its job
-- lives here. Publishing writes ONE row (in the caller's transaction) and returns; the worker (root context, never on
-- a request) writes at most 500 recipients per step, moves `cursor` in the same transaction and yields between
-- steps. `dedupe_key` is unique: the same event published twice is one fan-out, and (user_id, dedupe_key) above makes a
-- replayed step write nothing twice.
CREATE TABLE notification_fanout (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  actor_user_id TEXT,
  subject_db TEXT,
  subject_type TEXT,
  subject_id TEXT,
  link TEXT,
  access TEXT NOT NULL CHECK (access IN ('self','member','manage_members','moderate')),
  scope_node_id TEXT,
  dedupe_key TEXT NOT NULL,
  audience_json TEXT NOT NULL,                       -- {kind:'users'|'node_approvers'|'scope_moderators'|'course_followers'|'registered', …}
  exclude_json TEXT NOT NULL DEFAULT '[]',           -- user ids never told (the actor, the author of a reported item …)
  cursor TEXT,                                       -- keyset position in the audience (null = from the start)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  batches INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,                                   -- a short code, never a payload
  run_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;
CREATE UNIQUE INDEX idx_fanout_dedupe ON notification_fanout(dedupe_key);
CREATE INDEX idx_fanout_due ON notification_fanout(status, run_after, created_at);

-- the audience «course_followers» pages a subject's active follows by user id (2050 keys `course_follow` by user first)
CREATE INDEX idx_course_follow_subject ON course_follow(subject_node_id, user_id) WHERE ended_at IS NULL;

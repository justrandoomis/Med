-- Claude-style study chat (wp/chat-ux): saved conversations with history on the contextual chat of 0001/0450.
-- contextual_thread.kind        chat | explain | question | compare (the surface's empty-state / task wording)
-- contextual_thread.deleted_at  the owner deleted the conversation (hidden from lists, 404 on read); messages stay for
--                               notes that were saved from them (ai_record keeps the ids)
-- message.model / effort        what the owner asked for (owner row) / what served the answer (assistant row)
-- message.page_indexes_json     0-based lecture pages the turn is about (owner: attached page; answer: cited/explained
--                               pages) — the reader ↔ chat page sync reads it
-- message.context_json          the page / selection chips attached to the question
-- message.input_tokens / output_tokens / cost_usd  ESTIMATED usage of the answer (generation + verification calls)
-- chat_preference               the owner's remembered model / effort / auto-explain / page-sync (one row per vault)
ALTER TABLE contextual_thread ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE contextual_thread ADD COLUMN deleted_at INTEGER;
CREATE INDEX idx_thread_recent ON contextual_thread(deleted_at, updated_at);

ALTER TABLE message ADD COLUMN model TEXT;
ALTER TABLE message ADD COLUMN effort TEXT;
ALTER TABLE message ADD COLUMN page_indexes_json TEXT;
ALTER TABLE message ADD COLUMN context_json TEXT;
ALTER TABLE message ADD COLUMN input_tokens INTEGER;
ALTER TABLE message ADD COLUMN output_tokens INTEGER;
ALTER TABLE message ADD COLUMN cost_usd REAL;

CREATE TABLE chat_preference (
  id TEXT PRIMARY KEY CHECK (id = 'owner'),
  model TEXT,
  effort TEXT,
  auto_explain INTEGER NOT NULL DEFAULT 0,
  sync_pages INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
) STRICT;

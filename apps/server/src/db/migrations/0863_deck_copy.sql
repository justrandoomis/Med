-- Academic OS AOS-21.27 — «ادرس هذه البطاقات» (forks range 0860–0869; ARCHITECTURE_DELTA §10.4). Base set: used in a
-- vault, unused in spaces. A student's copy of a publication's deck, in their OWN vault: the cards are ordinary
-- `flashcard` rows of this vault (own FSRS state, own append-only review_event log — never shared).
--   deck_copy       one per publication per vault; `applied_version_no` = the deck version the cards were last brought
--                   to, `skipped_version_no` = «تخطَّ هذا الإصدار» (no preview until a newer version)
--   deck_copy_card  which vault card holds which published card, and the hash of the content last APPLIED to it: a card
--                   whose text no longer matches it was edited by the student and an update leaves its text alone
-- Additive only: new, empty tables.
CREATE TABLE deck_copy (
  id TEXT PRIMARY KEY,
  origin_space_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  applied_version_no INTEGER NOT NULL,
  skipped_version_no INTEGER,
  created_device_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE UNIQUE INDEX idx_deck_copy_pub ON deck_copy(publication_id) WHERE deleted_at IS NULL;

CREATE TABLE deck_copy_card (
  copy_id TEXT NOT NULL REFERENCES deck_copy(id),
  item_id TEXT NOT NULL,                             -- the published card's stable id
  card_id TEXT NOT NULL REFERENCES flashcard(id),    -- the student's own card
  applied_hash TEXT NOT NULL,                        -- sha256 of the card text last applied (edit detection)
  PRIMARY KEY (copy_id, item_id)
) STRICT;
CREATE INDEX idx_deck_copy_card_card ON deck_copy_card(card_id);

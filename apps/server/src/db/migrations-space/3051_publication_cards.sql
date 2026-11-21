-- Academic OS AOS-21.27 — the deck of a publication (forks band 3050–3099; ARCHITECTURE_DELTA §10.4 «community cards are
-- copy-on-use into the vault»). The author's OWN text flashcards on the lecture, published with an explanation version
-- (PublishRequest `include_cards`). Same version model as `publication_item`: a row covers the versions
-- [valid_from, valid_to) in which that card's content was current, under one STABLE id in every version. Nothing of the
-- author's vault rides along: no evidence id, concept, topic, file, review event or schedule — text and kind only.
-- Members copy the deck into their OWN vault on use (base `0863_deck_copy`), so every student's FSRS state is theirs.
CREATE TABLE publication_card (
  publication_id TEXT NOT NULL,                      -- system publication.id
  card_id TEXT NOT NULL,                             -- stable across versions (stableItemId of the author's card id)
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  content_hash TEXT NOT NULL,                        -- sha256 of row_json's canonical form
  row_json TEXT NOT NULL,                            -- {t:'card', kind, front, back, cloze_index, note_key}
  PRIMARY KEY (publication_id, card_id, valid_from)
) STRICT;
CREATE INDEX idx_publication_card_current ON publication_card(publication_id, valid_to);

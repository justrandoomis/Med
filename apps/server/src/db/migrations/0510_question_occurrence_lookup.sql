-- Questions module (range 0500–0549) — performance (I2, docs/PERFORMANCE.md).
-- «Questions of this source» filters are correlated lookups `o.question_id = q.id AND o.source_id = ?`
-- (Question Vault list, exam candidates by source, universal search with a source filter). With only the two
-- single-column indexes, SQLite drove that lookup through idx_question_occurrence_source: for EVERY question it
-- rescanned all occurrences of the source — O(questions × occurrences). Measured on a 2 000-question bank:
-- 0.9–1.1 s per statement (≈ 2 s for one Question Vault page). This composite index answers the lookup with one
-- index probe (≈ 2–8 ms on the same data). Purely additive; no data changes.
CREATE INDEX IF NOT EXISTS idx_question_occurrence_q_source ON question_occurrence(question_id, source_id);

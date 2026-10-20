-- Questions (H2 item 10f): exact-duplicate fingerprints written before the G5 / AC-17 fix ignored meaning-bearing symbols
-- («−8» = «8», «♀» = «♂», «→» = «←»), so a NEW question «base excess 8» matched the OLD fingerprint of a stored «base
-- excess −8» and was attached to it as the same question. question_version.fingerprint_algo records which algorithm
-- wrote a fingerprint: rows that exist before this migration are marked 1 (pre-fix); new rows default to 2. The
-- questions module recomputes every algo-1 fingerprint from the stored stem and options at boot (idempotent: a row
-- is rewritten once and marked 2). Derived versions (translations / paraphrases) keep a NULL fingerprint.
ALTER TABLE question_version ADD COLUMN fingerprint_algo INTEGER NOT NULL DEFAULT 2;
UPDATE question_version SET fingerprint_algo = 1 WHERE fingerprint IS NOT NULL;
CREATE INDEX idx_question_version_fp_algo ON question_version(fingerprint_algo) WHERE fingerprint_algo < 2;

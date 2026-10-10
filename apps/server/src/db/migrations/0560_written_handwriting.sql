-- Track F4 — handwritten written answers (§41). An attempt answered by hand points at the reading of its pad
-- (ink_recognition, purpose 'written_answer', which keeps the pad strokes and the machine reading). Only the text the
-- owner CONFIRMED (answer_text, possibly edited) is graded; recognized_text keeps the machine reading for reference.
ALTER TABLE written_attempt ADD COLUMN recognition_id TEXT REFERENCES ink_recognition(id) ON DELETE SET NULL;

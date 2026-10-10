-- Exams module (track F3, range 0550–0599): generated simulation following the owner's Exam DNA (§40).
--
-- One row per simulation request. The plan (buckets per lecture with their share of the owner's sample, item types,
-- topics, warnings) is computed deterministically from the Exam DNA when the request is made and stored as it was;
-- each bucket becomes a regular question_generation_run (origin 'simulation') executed by the simulation job, so every
-- question passes the same validation / evidence pipeline and failed candidates go to the review queue as usual.
-- The simulation exam is a normal exam (mode 'simulation', is_generated_simulation = 1) built from the PUBLISHED
-- generated questions only. Labelled «محاكاة مولدة» everywhere — never the expected exam.
--   request_json : SimulationRequest       plan_json : SimulationPlanView (as computed at request time)
--   parts_json   : [{bucket_index, run_id}] (generation runs created by the job)
--   exam_id / attempt_id : the assembled simulation exam (NULL until assembled; no FK: exams are never purged by it)
CREATE TABLE simulation_run (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','partial','abstained','failed')),
  request_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  parts_json TEXT NOT NULL DEFAULT '[]',
  exam_id TEXT,
  attempt_id TEXT,
  summary_json TEXT,
  error_json TEXT,
  job_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_simulation_run_created ON simulation_run(created_at);

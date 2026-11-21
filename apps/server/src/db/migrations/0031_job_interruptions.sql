-- Jobs module (range 0030–0039) — restarts and «not ready yet» never spend the attempt budget of a real error.
-- interruptions: how many times a running job was cut off because its process went away (container restart, deploy,
--   host move, crash) and was re-queued by requeueStale. Counted apart from attempts, with a higher cap of its own, so a
--   few restarts in a row no longer fail a job (JOB_INTERRUPTED); a job that keeps killing its process still stops.
-- deferrals: how many times a handler said «what I need is not ready yet, try again later» (JobError retryAfterMs —
--   e.g. extract_knowledge claimed while its source version is still being processed). Capped per job kind.
-- Both are reset when the owner retries the job.
ALTER TABLE processing_job ADD COLUMN interruptions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE processing_job ADD COLUMN deferrals INTEGER NOT NULL DEFAULT 0;

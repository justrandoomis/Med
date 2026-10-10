-- Jobs module (range 0030–0039) — crash resume latency (I2, docs/PERFORMANCE.md).
-- The process that claimed a running job: '<hostname>/<pid>/<boot nonce>'. After a crash (SIGKILL, OOM kill, power
-- loss) the restarted server can see that the claiming process is gone (same host and its pid no longer exists, or
-- the same pid with another boot nonce) and resume the job at once from its checkpoints, instead of leaving it
-- «running» until the heartbeat goes stale (measured: 61.6 s after a restart). NULL (rows from before this
-- migration) and other hosts keep the heartbeat rule.
ALTER TABLE processing_job ADD COLUMN worker_id TEXT;

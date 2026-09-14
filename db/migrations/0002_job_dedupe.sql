-- 0002_job_dedupe.sql
-- Stop the same job being queued twice.
--
-- Two API requests racing to schedule a flight's match run, or a retried
-- verify_flight re-queueing the lifecycle jobs, would otherwise leave duplicates
-- in the queue. Only *queued* rows are covered: once a job has run, an identical
-- one later is a legitimate new piece of work.

BEGIN;

CREATE UNIQUE INDEX jobs_dedupe_queued
  ON jobs (type, payload)
  WHERE status = 'queued';

COMMIT;

-- Mutable retry ownership begins only after an exact seeded delivery handoff.
-- Runtime work, warnings and physical cleanup remain outside this table.
CREATE TABLE backfill_jobs (
  occurrence_id TEXT PRIMARY KEY NOT NULL REFERENCES backfill_seeds(occurrence_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN ('due','claimed','awaiting_complete_receipt','complete','stopped')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 1000000),
  next_attempt_at_ms INTEGER NOT NULL CHECK(next_attempt_at_ms BETWEEN 0 AND 9007199254740991),
  claim_token TEXT CHECK(claim_token IS NULL OR (length(claim_token)=32 AND claim_token NOT GLOB '*[^0-9a-f]*')),
  claim_expires_at_ms INTEGER CHECK(claim_expires_at_ms IS NULL OR claim_expires_at_ms BETWEEN 0 AND 9007199254740991),
  target_revision INTEGER CHECK(target_revision IS NULL OR target_revision BETWEEN 1 AND 1000000),
  last_reason TEXT CHECK(last_reason IS NULL OR (length(last_reason) BETWEEN 1 AND 64 AND last_reason GLOB '[a-z]*' AND last_reason NOT GLOB '*[^a-z0-9_]*')),
  stop_at_ms INTEGER NOT NULL CHECK(stop_at_ms BETWEEN 0 AND 9007199254740991),
  completion_revision INTEGER CHECK(completion_revision IS NULL OR completion_revision BETWEEN 1 AND 1000000),
  completion_artifact_hash TEXT CHECK(completion_artifact_hash IS NULL OR (
    substr(completion_artifact_hash,1,7)='sha256:'
    AND length(completion_artifact_hash)=71
    AND substr(completion_artifact_hash,8) NOT GLOB '*[^0-9a-f]*'
  )),
  CHECK((claim_token IS NULL) = (claim_expires_at_ms IS NULL)),
  CHECK((state='claimed') = (claim_token IS NOT NULL)),
  CHECK(state!='claimed' OR target_revision IS NOT NULL),
  CHECK(state NOT IN ('awaiting_complete_receipt','complete') OR target_revision IS NOT NULL),
  CHECK((completion_revision IS NULL) = (completion_artifact_hash IS NULL)),
  CHECK((state='complete') = (completion_revision IS NOT NULL))
) STRICT;

CREATE TRIGGER backfill_job_exact_insert BEFORE INSERT ON backfill_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM backfill_seeds AS seed
  JOIN backfill_seed_lifecycle AS lifecycle ON lifecycle.occurrence_id=seed.occurrence_id
  WHERE seed.occurrence_id=NEW.occurrence_id
    AND seed.stop_at_ms=NEW.stop_at_ms
    AND lifecycle.stop_at_ms=NEW.stop_at_ms
    AND lifecycle.owner='delivery'
    AND lifecycle.state='pending'
)
BEGIN SELECT RAISE(ABORT, 'backfill job seed binding mismatch'); END;

CREATE TRIGGER backfill_job_immutable_binding
BEFORE UPDATE OF occurrence_id,stop_at_ms ON backfill_jobs
WHEN OLD.occurrence_id!=NEW.occurrence_id OR OLD.stop_at_ms!=NEW.stop_at_ms
BEGIN SELECT RAISE(ABORT, 'backfill job binding is immutable'); END;

CREATE TRIGGER backfill_job_monotonic_completion
BEFORE UPDATE ON backfill_jobs
WHEN (OLD.state='complete' AND (
       NEW.state!='complete'
       OR NEW.completion_revision!=OLD.completion_revision
       OR NEW.completion_artifact_hash!=OLD.completion_artifact_hash
     ))
  OR NEW.attempt_count<OLD.attempt_count
BEGIN SELECT RAISE(ABORT, 'backfill job completion and attempts are monotonic'); END;

CREATE INDEX backfill_jobs_due
  ON backfill_jobs(state,next_attempt_at_ms,stop_at_ms,occurrence_id);

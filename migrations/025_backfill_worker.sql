-- Bounded retry scheduling, original-deadline warning intents and the shared
-- nondecreasing wall observation. Runtime work and filesystem bytes stay out
-- of SQLite; seed-only deletion remains claimed through the existing lifecycle.
ALTER TABLE backfill_seed_lifecycle ADD COLUMN initial_build_next_attempt_at_ms INTEGER NOT NULL DEFAULT 0
  CHECK(initial_build_next_attempt_at_ms BETWEEN 0 AND 9007199254740991);
ALTER TABLE backfill_seed_lifecycle ADD COLUMN initial_build_last_reason TEXT
  CHECK(initial_build_last_reason IS NULL OR initial_build_last_reason IN
    ('runtime_failed','alignment_failed','build_failed','cleanup_failed','attempts_exhausted'));
ALTER TABLE backfill_seed_lifecycle ADD COLUMN last_observed_at_ms INTEGER NOT NULL DEFAULT 0
  CHECK(last_observed_at_ms BETWEEN 0 AND 9007199254740991);
ALTER TABLE backfill_seed_lifecycle ADD COLUMN process_owner_token TEXT
  CHECK(process_owner_token IS NULL OR (length(process_owner_token)=32 AND process_owner_token NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE backfill_seed_lifecycle ADD COLUMN process_cleanup_state TEXT
  CHECK((process_cleanup_state IS NULL OR process_cleanup_state IN ('active','failed'))
    AND ((process_cleanup_state IS NULL)=(process_owner_token IS NULL)));

UPDATE backfill_seed_lifecycle
SET initial_build_next_attempt_at_ms=(SELECT ended_at_ms FROM backfill_seeds WHERE occurrence_id=backfill_seed_lifecycle.occurrence_id),
    last_observed_at_ms=(SELECT ended_at_ms FROM backfill_seeds WHERE occurrence_id=backfill_seed_lifecycle.occurrence_id);

CREATE TRIGGER backfill_seed_lifecycle_worker_monotonic
BEFORE UPDATE ON backfill_seed_lifecycle
WHEN NEW.initial_build_attempts<OLD.initial_build_attempts
  OR NEW.last_observed_at_ms<OLD.last_observed_at_ms
BEGIN SELECT RAISE(ABORT, 'backfill lifecycle attempts and wall observation are monotonic'); END;

CREATE TRIGGER backfill_seed_lifecycle_process_fence
BEFORE UPDATE ON backfill_seed_lifecycle
WHEN (NEW.process_owner_token IS NULL)!=(NEW.process_cleanup_state IS NULL)
  OR (OLD.process_cleanup_state='failed' AND (
    NEW.process_cleanup_state IS NOT 'failed' OR NEW.process_owner_token IS NOT OLD.process_owner_token))
  OR (NEW.process_cleanup_state='failed' AND (
    (OLD.process_cleanup_state IS NOT 'active' AND OLD.process_cleanup_state IS NOT 'failed')
    OR NEW.process_owner_token IS NOT OLD.process_owner_token))
  OR (OLD.process_cleanup_state='active' AND NEW.process_cleanup_state='active'
    AND NEW.process_owner_token!=OLD.process_owner_token)
BEGIN SELECT RAISE(ABORT, 'backfill process ownership fence violated'); END;

CREATE TABLE backfill_warning_intents (
  occurrence_id TEXT PRIMARY KEY NOT NULL REFERENCES backfill_seed_lifecycle(occurrence_id) ON DELETE RESTRICT,
  stop_at_ms INTEGER NOT NULL CHECK(stop_at_ms BETWEEN 0 AND 9007199254740991),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms BETWEEN 1 AND 9007199254740991),
  reason TEXT NOT NULL CHECK(reason='backfill_stopped'),
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','accepted','terminal')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 1000000),
  next_attempt_at_ms INTEGER NOT NULL CHECK(next_attempt_at_ms BETWEEN 0 AND 9007199254740991),
  claim_token TEXT CHECK(claim_token IS NULL OR (length(claim_token)=32 AND claim_token NOT GLOB '*[^0-9a-f]*')),
  claim_expires_at_ms INTEGER CHECK(claim_expires_at_ms IS NULL OR claim_expires_at_ms BETWEEN 0 AND 9007199254740991),
  accepted_at_ms INTEGER CHECK(accepted_at_ms IS NULL OR accepted_at_ms BETWEEN 0 AND 9007199254740991),
  terminal_reason TEXT CHECK(terminal_reason IS NULL OR terminal_reason IN ('expired','attempts_exhausted')),
  CHECK(expires_at_ms>stop_at_ms),
  CHECK((claim_token IS NULL)=(claim_expires_at_ms IS NULL)),
  CHECK((state='claimed')=(claim_token IS NOT NULL)),
  CHECK((state='accepted')=(accepted_at_ms IS NOT NULL)),
  CHECK((state='terminal')=(terminal_reason IS NOT NULL))
) STRICT;

CREATE TRIGGER backfill_warning_exact_insert BEFORE INSERT ON backfill_warning_intents
WHEN NOT EXISTS (
  SELECT 1 FROM backfill_seed_lifecycle AS lifecycle
  WHERE lifecycle.occurrence_id=NEW.occurrence_id
    AND lifecycle.stop_at_ms=NEW.stop_at_ms
    AND lifecycle.expires_at_ms=NEW.expires_at_ms
)
BEGIN SELECT RAISE(ABORT, 'backfill warning deadline binding mismatch'); END;

CREATE TRIGGER backfill_warning_immutable_binding
BEFORE UPDATE OF occurrence_id,stop_at_ms,expires_at_ms,reason ON backfill_warning_intents
WHEN OLD.occurrence_id!=NEW.occurrence_id OR OLD.stop_at_ms!=NEW.stop_at_ms
  OR OLD.expires_at_ms!=NEW.expires_at_ms OR OLD.reason!=NEW.reason
BEGIN SELECT RAISE(ABORT, 'backfill warning binding is immutable'); END;

CREATE TRIGGER backfill_warning_monotonic
BEFORE UPDATE ON backfill_warning_intents
WHEN NEW.attempt_count<OLD.attempt_count
  OR (OLD.state='accepted' AND (NEW.state!='accepted' OR NEW.accepted_at_ms!=OLD.accepted_at_ms))
  OR (OLD.state='terminal' AND (NEW.state!='terminal' OR NEW.terminal_reason!=OLD.terminal_reason))
BEGIN SELECT RAISE(ABORT, 'backfill warning terminal state and attempts are monotonic'); END;

CREATE INDEX backfill_warning_due ON backfill_warning_intents(state,next_attempt_at_ms,stop_at_ms,expires_at_ms,occurrence_id);

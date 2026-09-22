-- Unknown-end custody: one immutable detection/deadline per EXACT stopped
-- encrypted source whose occurrence has no authoritative end (D002/D007).
--
-- A row is never an occurrence end. It creates no artifact, delivery, job,
-- receipt, warning or publication authority, and nothing here is deletion
-- authority: time eligibility only lets a later owner claim the fenced
-- cleanup, prove exact-source quiescence and recheck the stored identity.
--
-- Two source classes share the lifecycle but keep REAL parent coverage:
--   * final           -> recordings(occurrence_id)                     (failure_attempt = 0)
--   * bridge_failure  -> bridge_failure_recordings(occurrence_id, attempt)
-- The CHECK below forces exactly one reference column set per class, so the
-- composite foreign key is evaluated for every failed attempt and the final
-- key for every canonical source. The primary key is per exact source: a
-- canonical row and each failed attempt of the same occurrence are distinct
-- rows with distinct T, deadline, identity, claim and tombstone completion.
CREATE TABLE unknown_end_custody (
  occurrence_id TEXT NOT NULL REFERENCES sessions(occurrence_id) ON DELETE RESTRICT,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('final','bridge_failure')),
  -- 0 is the canonical final source; a failed generation is its attempt >= 1.
  failure_attempt INTEGER NOT NULL CHECK(failure_attempt BETWEEN 0 AND 1000000),
  final_occurrence_id TEXT REFERENCES recordings(occurrence_id) ON DELETE RESTRICT,
  failure_occurrence_id TEXT,
  -- Immutable Runtime descriptor plus the exact regular-child filesystem
  -- identity observed at first durable detection. Never audio or key bytes.
  recording_handle TEXT NOT NULL CHECK(length(recording_handle)=32 AND recording_handle NOT GLOB '*[^0-9a-f]*'),
  recording_path TEXT NOT NULL CHECK(length(CAST(recording_path AS BLOB)) BETWEEN 1 AND 4096),
  recording_sha256 TEXT NOT NULL CHECK(length(recording_sha256)=64 AND recording_sha256 NOT GLOB '*[^0-9a-f]*'),
  recording_key_id TEXT NOT NULL CHECK(length(recording_key_id)=16 AND recording_key_id NOT GLOB '*[^0-9a-f]*'),
  recording_bytes INTEGER NOT NULL CHECK(recording_bytes BETWEEN 1 AND 8589934592),
  recording_device TEXT NOT NULL CHECK(length(recording_device) BETWEEN 1 AND 40 AND recording_device NOT GLOB '*[^0-9]*'),
  recording_inode TEXT NOT NULL CHECK(length(recording_inode) BETWEEN 1 AND 40 AND recording_inode NOT GLOB '*[^0-9]*'),
  -- Write-once T and its checked T + 14 days.
  unknown_end_detected_at_ms INTEGER NOT NULL CHECK(unknown_end_detected_at_ms BETWEEN 0 AND 9007199254740991),
  unknown_end_deadline_ms INTEGER NOT NULL CHECK(unknown_end_deadline_ms BETWEEN 0 AND 9007199254740991),
  -- Cleanup fence only. 'cleanup_failed' and 'deleted' are monotonic.
  state TEXT NOT NULL CHECK(state IN ('assigned','cleanup_claimed','cleanup_failed','deleted')),
  cleanup_claim_token TEXT CHECK(cleanup_claim_token IS NULL OR (length(cleanup_claim_token)=32 AND cleanup_claim_token NOT GLOB '*[^0-9a-f]*')),
  cleanup_claim_expires_at_ms INTEGER CHECK(cleanup_claim_expires_at_ms IS NULL OR cleanup_claim_expires_at_ms BETWEEN 0 AND 9007199254740991),
  cleanup_failure_reason TEXT CHECK(cleanup_failure_reason IS NULL OR cleanup_failure_reason IN
    ('identity_mismatch','source_missing','unsafe_source','detach_failed','reader_active','quiescence_unproven')),
  deleted_at_ms INTEGER CHECK(deleted_at_ms IS NULL OR deleted_at_ms BETWEEN 0 AND 9007199254740991),
  -- Nondecreasing wall observation so a clock regression cannot revive a lease.
  last_observed_at_ms INTEGER NOT NULL CHECK(last_observed_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (occurrence_id, source_kind, failure_attempt),
  FOREIGN KEY (failure_occurrence_id, failure_attempt) REFERENCES bridge_failure_recordings(occurrence_id, attempt) ON DELETE RESTRICT,
  CHECK ((source_kind='final' AND failure_attempt=0 AND final_occurrence_id=occurrence_id AND failure_occurrence_id IS NULL)
      OR (source_kind='bridge_failure' AND failure_attempt>=1 AND failure_occurrence_id=occurrence_id AND final_occurrence_id IS NULL)),
  CHECK (unknown_end_deadline_ms = unknown_end_detected_at_ms + 1209600000),
  CHECK (last_observed_at_ms >= unknown_end_detected_at_ms),
  CHECK ((cleanup_claim_token IS NULL) = (cleanup_claim_expires_at_ms IS NULL)),
  CHECK ((state='cleanup_claimed') = (cleanup_claim_token IS NOT NULL)),
  CHECK ((state='cleanup_failed') = (cleanup_failure_reason IS NOT NULL)),
  CHECK ((state='deleted') = (deleted_at_ms IS NOT NULL)),
  CHECK (deleted_at_ms IS NULL OR deleted_at_ms >= unknown_end_deadline_ms)
) STRICT;

-- The stored descriptor must be the persisted Runtime finalization for that
-- exact source. A legacy canonical row without a Runtime locator has no
-- finalized descriptor and can never be classified stopped.
CREATE TRIGGER unknown_end_custody_exact_final_insert BEFORE INSERT ON unknown_end_custody
WHEN NEW.source_kind='final' AND NOT EXISTS (
  SELECT 1 FROM recordings AS recording
  WHERE recording.occurrence_id=NEW.occurrence_id
    AND recording.handle=NEW.recording_handle
    AND recording.sha256=NEW.recording_sha256
    AND recording.key_id=NEW.recording_key_id
    AND recording.encrypted_path IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'unknown-end custody does not match the finalized canonical source'); END;

CREATE TRIGGER unknown_end_custody_exact_failure_insert BEFORE INSERT ON unknown_end_custody
WHEN NEW.source_kind='bridge_failure' AND NOT EXISTS (
  SELECT 1 FROM bridge_failure_recordings AS recording
  WHERE recording.occurrence_id=NEW.occurrence_id
    AND recording.attempt=NEW.failure_attempt
    AND recording.handle=NEW.recording_handle
    AND recording.sha256=NEW.recording_sha256
    AND recording.key_id=NEW.recording_key_id
)
BEGIN SELECT RAISE(ABORT, 'unknown-end custody does not match the finalized failed source'); END;

-- A seeded canonical source has an authoritative bridge-observed end and a
-- CUT3 owner; a delivery-journaled canonical source is owned by the outbox.
CREATE TRIGGER unknown_end_custody_known_end_insert BEFORE INSERT ON unknown_end_custody
WHEN NEW.source_kind='final' AND (
  EXISTS (SELECT 1 FROM backfill_seeds WHERE occurrence_id=NEW.occurrence_id)
  OR EXISTS (SELECT 1 FROM delivery_journal WHERE occurrence_id=NEW.occurrence_id)
)
BEGIN SELECT RAISE(ABORT, 'unknown-end custody refuses a seeded or delivery-owned source'); END;

CREATE TRIGGER unknown_end_custody_immutable_assignment
BEFORE UPDATE OF occurrence_id,source_kind,failure_attempt,final_occurrence_id,failure_occurrence_id,
  recording_handle,recording_path,recording_sha256,recording_key_id,recording_bytes,recording_device,recording_inode,
  unknown_end_detected_at_ms,unknown_end_deadline_ms ON unknown_end_custody
WHEN OLD.occurrence_id!=NEW.occurrence_id OR OLD.source_kind!=NEW.source_kind OR OLD.failure_attempt!=NEW.failure_attempt
  OR OLD.final_occurrence_id IS NOT NEW.final_occurrence_id OR OLD.failure_occurrence_id IS NOT NEW.failure_occurrence_id
  OR OLD.recording_handle!=NEW.recording_handle OR OLD.recording_path!=NEW.recording_path
  OR OLD.recording_sha256!=NEW.recording_sha256 OR OLD.recording_key_id!=NEW.recording_key_id
  OR OLD.recording_bytes!=NEW.recording_bytes OR OLD.recording_device!=NEW.recording_device
  OR OLD.recording_inode!=NEW.recording_inode
  OR OLD.unknown_end_detected_at_ms!=NEW.unknown_end_detected_at_ms
  OR OLD.unknown_end_deadline_ms!=NEW.unknown_end_deadline_ms
BEGIN SELECT RAISE(ABORT, 'unknown-end custody assignment is immutable'); END;

CREATE TRIGGER unknown_end_custody_monotonic BEFORE UPDATE ON unknown_end_custody
WHEN NEW.last_observed_at_ms<OLD.last_observed_at_ms
  OR (OLD.state='deleted' AND (NEW.state!='deleted' OR NEW.deleted_at_ms!=OLD.deleted_at_ms))
  OR (OLD.state='cleanup_failed' AND (NEW.state!='cleanup_failed' OR NEW.cleanup_failure_reason!=OLD.cleanup_failure_reason))
BEGIN SELECT RAISE(ABORT, 'unknown-end custody completion and wall observation are monotonic'); END;

CREATE TRIGGER unknown_end_custody_never_deleted BEFORE DELETE ON unknown_end_custody
BEGIN SELECT RAISE(ABORT, 'unknown-end custody is never deleted'); END;

CREATE INDEX unknown_end_custody_due
  ON unknown_end_custody(state, unknown_end_deadline_ms, occurrence_id, source_kind, failure_attempt);

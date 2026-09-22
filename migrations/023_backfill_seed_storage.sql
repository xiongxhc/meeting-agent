-- Immutable known-ended rebuild inputs plus the mutable seed-owned lifecycle.
-- This schema creates no artifact, delivery, retry job, warning, or cleanup
-- authority. Legacy finalized rows remain honestly seedless.
CREATE TABLE backfill_seeds (
  occurrence_id TEXT PRIMARY KEY NOT NULL REFERENCES recordings(occurrence_id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 40 AND provider GLOB '[a-z]*' AND provider NOT GLOB '*[^a-z0-9_]*'),
  provider_meeting_id TEXT NOT NULL CHECK(length(CAST(provider_meeting_id AS BLOB)) BETWEEN 1 AND 4096),
  meeting_no TEXT NOT NULL CHECK(length(CAST(meeting_no AS BLOB)) BETWEEN 1 AND 4096),
  occurrence_started_at TEXT NOT NULL CHECK(length(occurrence_started_at) BETWEEN 20 AND 24),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  organizer_person_id TEXT,
  organizer_display_name TEXT,
  organizer_source TEXT CHECK(organizer_source IN ('reservation','calendar_event')),
  ended_at TEXT NOT NULL CHECK(length(ended_at) BETWEEN 20 AND 24),
  ended_at_ms INTEGER NOT NULL CHECK(ended_at_ms BETWEEN 0 AND 9007199254740991),
  stop_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  bridge_session_id TEXT NOT NULL CHECK(length(CAST(bridge_session_id AS BLOB)) BETWEEN 1 AND 4096),
  generation_id TEXT NOT NULL UNIQUE REFERENCES recording_recovery_bindings(generation_id) ON DELETE RESTRICT,
  source_session_id TEXT NOT NULL,
  capability_recording_handle TEXT NOT NULL,
  capability_sha256 TEXT NOT NULL,
  capability_key_id TEXT NOT NULL,
  capability_authorization TEXT NOT NULL,
  recording_path TEXT NOT NULL CHECK(length(CAST(recording_path AS BLOB)) BETWEEN 1 AND 4096),
  recording_format TEXT NOT NULL CHECK(length(recording_format) BETWEEN 1 AND 200),
  recording_encryption TEXT NOT NULL CHECK(length(recording_encryption) BETWEEN 1 AND 200),
  recording_bytes INTEGER NOT NULL CHECK(recording_bytes BETWEEN 1 AND 8589934592),
  recording_device TEXT NOT NULL,
  recording_inode TEXT NOT NULL,
  recording_duration_ms INTEGER NOT NULL CHECK(recording_duration_ms BETWEEN 0 AND 9007199254740991),
  recording_sha256 TEXT NOT NULL,
  recording_key_id TEXT NOT NULL,
  bridge_gaps_json TEXT NOT NULL CHECK(json_valid(bridge_gaps_json) AND length(CAST(bridge_gaps_json AS BLOB)) BETWEEN 2 AND 262144),
  runtime_gaps_json TEXT NOT NULL CHECK(json_valid(runtime_gaps_json) AND length(CAST(runtime_gaps_json AS BLOB)) BETWEEN 2 AND 262144),
  processing_warnings_json TEXT NOT NULL CHECK(json_valid(processing_warnings_json) AND length(CAST(processing_warnings_json AS BLOB)) BETWEEN 2 AND 262144),
  runtime_profile TEXT NOT NULL CHECK(runtime_profile IN ('offline','online')),
  stt_provider TEXT NOT NULL CHECK(length(stt_provider) BETWEEN 1 AND 200),
  stt_model TEXT NOT NULL CHECK(length(stt_model) BETWEEN 1 AND 200),
  live_stream_model TEXT NOT NULL CHECK(length(live_stream_model) BETWEEN 1 AND 200),
  final_batch_model TEXT NOT NULL CHECK(length(final_batch_model) BETWEEN 1 AND 200),
  text_provider TEXT NOT NULL CHECK(length(text_provider) BETWEEN 1 AND 200),
  text_model TEXT NOT NULL CHECK(length(text_model) BETWEEN 1 AND 200),
  agent_version TEXT NOT NULL CHECK(length(agent_version) BETWEEN 1 AND 200),
  CHECK((organizer_person_id IS NULL) = (organizer_display_name IS NULL)),
  CHECK((organizer_person_id IS NULL) = (organizer_source IS NULL)),
  CHECK(organizer_person_id IS NULL OR (length(organizer_person_id) BETWEEN 1 AND 200 AND length(organizer_display_name) BETWEEN 1 AND 200)),
  CHECK(strftime('%s', ended_at) IS NOT NULL),
  CHECK(ended_at = strftime('%Y-%m-%dT%H:%M:%SZ', julianday(ended_at)) OR ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(ended_at))),
  CHECK(ended_at_ms = CAST(strftime('%s', ended_at) AS INTEGER) * 1000 + CASE length(ended_at) WHEN 24 THEN CAST(substr(ended_at, 21, 3) AS INTEGER) ELSE 0 END),
  CHECK(stop_at_ms = ended_at_ms + 950400000),
  CHECK(expires_at_ms = ended_at_ms + 1209600000 AND expires_at_ms <= 9007199254740991),
  CHECK(length(source_session_id) BETWEEN 1 AND 20 AND source_session_id NOT GLOB '*[^0-9]*' AND substr(source_session_id,1,1)!='0'),
  CHECK(length(capability_recording_handle)=32 AND capability_recording_handle NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(capability_sha256)=64 AND capability_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(capability_key_id)=16 AND capability_key_id NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(capability_authorization)=64 AND capability_authorization NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(recording_sha256)=64 AND recording_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(recording_key_id)=16 AND recording_key_id NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(recording_device) BETWEEN 1 AND 40 AND recording_device NOT GLOB '*[^0-9]*'),
  CHECK(length(recording_inode) BETWEEN 1 AND 40 AND recording_inode NOT GLOB '*[^0-9]*')
) STRICT;

CREATE TRIGGER backfill_seed_immutable_update BEFORE UPDATE ON backfill_seeds
BEGIN SELECT RAISE(ABORT, 'backfill seed is immutable'); END;
CREATE TRIGGER backfill_seed_immutable_delete BEFORE DELETE ON backfill_seeds
BEGIN SELECT RAISE(ABORT, 'backfill seed is immutable'); END;

CREATE TABLE backfill_seed_lifecycle (
  occurrence_id TEXT PRIMARY KEY NOT NULL REFERENCES backfill_seeds(occurrence_id) ON DELETE RESTRICT,
  owner TEXT NOT NULL CHECK(owner IN ('seed','delivery')),
  state TEXT NOT NULL CHECK(state IN ('pending','stopped','cleanup_claimed','deleted')),
  stop_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  initial_build_attempts INTEGER NOT NULL DEFAULT 0 CHECK(initial_build_attempts BETWEEN 0 AND 1000000),
  build_claim_token TEXT CHECK(build_claim_token IS NULL OR (length(build_claim_token)=32 AND build_claim_token NOT GLOB '*[^a-f0-9]*')),
  build_claim_expires_at_ms INTEGER,
  cleanup_claim_token TEXT CHECK(cleanup_claim_token IS NULL OR (length(cleanup_claim_token)=32 AND cleanup_claim_token NOT GLOB '*[^a-f0-9]*')),
  cleanup_claim_expires_at_ms INTEGER,
  deleted_at_ms INTEGER,
  CHECK(stop_at_ms >= 0 AND expires_at_ms > stop_at_ms),
  CHECK((build_claim_token IS NULL) = (build_claim_expires_at_ms IS NULL)),
  CHECK(build_claim_token IS NULL OR (owner='seed' AND state='pending')),
  CHECK((cleanup_claim_token IS NULL) = (cleanup_claim_expires_at_ms IS NULL)),
  CHECK(cleanup_claim_token IS NULL OR (owner='seed' AND state='cleanup_claimed')),
  CHECK((state='deleted') = (deleted_at_ms IS NOT NULL))
) STRICT;
CREATE TRIGGER backfill_seed_lifecycle_exact_insert BEFORE INSERT ON backfill_seed_lifecycle
WHEN NOT EXISTS (
  SELECT 1 FROM backfill_seeds AS seed
  WHERE seed.occurrence_id=NEW.occurrence_id
    AND seed.stop_at_ms=NEW.stop_at_ms
    AND seed.expires_at_ms=NEW.expires_at_ms
)
BEGIN SELECT RAISE(ABORT, 'backfill lifecycle deadline binding mismatch'); END;
CREATE TRIGGER backfill_seed_lifecycle_immutable_deadlines
BEFORE UPDATE OF occurrence_id,stop_at_ms,expires_at_ms ON backfill_seed_lifecycle
WHEN OLD.occurrence_id!=NEW.occurrence_id
  OR OLD.stop_at_ms!=NEW.stop_at_ms
  OR OLD.expires_at_ms!=NEW.expires_at_ms
BEGIN SELECT RAISE(ABORT, 'backfill lifecycle deadlines are immutable'); END;
CREATE INDEX backfill_seed_build_due ON backfill_seed_lifecycle(state, owner, stop_at_ms, occurrence_id)
  WHERE owner='seed' AND state='pending';

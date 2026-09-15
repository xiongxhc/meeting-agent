-- Private restart authority, not ordinary recording/publication metadata.
-- The immutable generation identity remains after the existing UI-evidence purge.
CREATE TABLE recording_recovery_bindings (
  generation_id TEXT PRIMARY KEY NOT NULL,
  occurrence_id TEXT NOT NULL REFERENCES sessions(occurrence_id),
  bridge_session_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  recording_handle TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  key_id TEXT NOT NULL,
  authorization TEXT NOT NULL,
  recording_kind TEXT NOT NULL CHECK(recording_kind IN ('final','bridge_failure')),
  failure_attempt INTEGER,
  last_alignment_failure TEXT CHECK(last_alignment_failure IN ('read_failed','cancelled','cleanup_failed','recovered_owner')),
  UNIQUE(occurrence_id,bridge_session_id),
  UNIQUE(source_session_id,recording_handle),
  CHECK(length(source_session_id) BETWEEN 1 AND 20 AND source_session_id NOT GLOB '*[^0-9]*' AND substr(source_session_id,1,1)!='0'),
  CHECK(length(recording_handle)=32 AND recording_handle NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(key_id)=16 AND key_id NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(authorization)=64 AND authorization NOT GLOB '*[^0-9a-f]*'),
  CHECK((recording_kind='final' AND failure_attempt IS NULL) OR (recording_kind='bridge_failure' AND failure_attempt>=1))
) STRICT;

CREATE TABLE recording_alignment_attempts (
  attempt_id TEXT PRIMARY KEY NOT NULL CHECK(length(attempt_id)=36),
  generation_id TEXT NOT NULL REFERENCES recording_recovery_bindings(generation_id),
  owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),
  token TEXT NOT NULL CHECK(length(token)=36),
  source_session_id TEXT NOT NULL,
  recording_handle TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  key_id TEXT NOT NULL,
  timing_contract TEXT NOT NULL CHECK(timing_contract='capture-clock/v1'),
  state TEXT NOT NULL CHECK(state IN ('staging','complete','cleanup_failed','abandoned')),
  page_count INTEGER NOT NULL DEFAULT 0 CHECK(page_count BETWEEN 0 AND 250000),
  entry_count INTEGER NOT NULL DEFAULT 0 CHECK(entry_count BETWEEN 0 AND 2000000),
  stored_bytes INTEGER NOT NULL DEFAULT 0 CHECK(stored_bytes BETWEEN 0 AND 268435456),
  warnings_json TEXT NOT NULL DEFAULT '[]' CHECK(length(CAST(warnings_json AS BLOB))<=4096),
  coverage_status TEXT CHECK(coverage_status IN ('available','partial','unavailable_legacy')),
  failure_reason TEXT CHECK(failure_reason IN ('read_failed','cancelled','cleanup_failed','recovered_owner')),
  CHECK((state='complete')=(coverage_status IS NOT NULL))
) STRICT;
CREATE INDEX recording_alignment_generation ON recording_alignment_attempts(generation_id,attempt_id);
CREATE UNIQUE INDEX recording_alignment_active ON recording_alignment_attempts(generation_id) WHERE state IN ('staging','cleanup_failed','abandoned');
CREATE TABLE recording_alignment_pages (
  attempt_id TEXT NOT NULL REFERENCES recording_alignment_attempts(attempt_id),
  page_index INTEGER NOT NULL CHECK(page_index BETWEEN 0 AND 249999),
  entry_count INTEGER NOT NULL CHECK(entry_count BETWEEN 1 AND 64),
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 32768),
  PRIMARY KEY(attempt_id,page_index)
) STRICT;
CREATE TABLE recording_alignment_selected (
  generation_id TEXT PRIMARY KEY NOT NULL REFERENCES recording_recovery_bindings(generation_id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES recording_alignment_attempts(attempt_id)
) STRICT;

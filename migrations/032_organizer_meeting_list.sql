-- meeting-migration: foreign-keys-off
-- An organizer may come from Feishu's meeting list (source meeting_list), and a seed
-- without one records why: instant_meeting when Feishu reported this exact occurrence
-- with no organizer, organizer_unresolved otherwise. SQLite cannot widen a CHECK in
-- place, so both tables are rebuilt. The runner applies this file with foreign keys
-- off and checks them before commit; legacy_alter_table keeps the rename from
-- rewriting or rejecting other tables' references to the rebuilt names. The ledger
-- applies it once; a failure rolls the whole file back.
PRAGMA legacy_alter_table = ON;

CREATE TABLE feishu_invite_occurrences_v32 (
  occurrence_id TEXT PRIMARY KEY,
  region TEXT NOT NULL CHECK(region IN ('feishu','lark')),
  tenant_key TEXT NOT NULL, app_id TEXT NOT NULL,
  provider_meeting_id TEXT NOT NULL, meeting_no TEXT NOT NULL,
  occurrence_started_at TEXT NOT NULL, title TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending_metadata','metadata_blocked','admitted','existing_session')),
  accepted_at_ms INTEGER NOT NULL CHECK(accepted_at_ms >= 0),
  last_observed_at_ms INTEGER NOT NULL CHECK(last_observed_at_ms >= accepted_at_ms),
  first_attempt_at_ms INTEGER, last_attempt_at_ms INTEGER, generation_started_at_ms INTEGER,
  next_attempt_at_ms INTEGER NOT NULL CHECK(next_attempt_at_ms >= 0),
  total_attempts INTEGER NOT NULL DEFAULT 0 CHECK(total_attempts BETWEEN 0 AND 1000000),
  generation_attempts INTEGER NOT NULL DEFAULT 0 CHECK(generation_attempts BETWEEN 0 AND 8),
  retry_generation INTEGER NOT NULL DEFAULT 0 CHECK(retry_generation BETWEEN 0 AND 1000000),
  operator_retry_count INTEGER NOT NULL DEFAULT 0 CHECK(operator_retry_count BETWEEN 0 AND 1000000),
  last_operator TEXT, last_operator_retry_at_ms INTEGER,
  last_blocked_reason TEXT, last_blocked_at_ms INTEGER,
  claim_token TEXT CHECK(claim_token IS NULL OR (length(claim_token)=32 AND claim_token NOT GLOB '*[^a-f0-9]*')),
  claim_expires_at_ms INTEGER,
  organizer_source TEXT CHECK(organizer_source IN ('reservation','calendar_event','meeting_list')),
  organizer_id_type TEXT CHECK(organizer_id_type='open_id'), organizer_open_id TEXT, organizer_display_name TEXT,
  reference_kind TEXT CHECK(reference_kind IN ('reservation','calendar_event','meeting_list')),
  reference_json TEXT CHECK(reference_json IS NULL OR (json_valid(reference_json) AND length(CAST(reference_json AS BLOB)) <= 8192)),
  admitted_at_ms INTEGER,
  CHECK(occurrence_id = provider_meeting_id || '@' || occurrence_started_at),
  CHECK((claim_token IS NULL) = (claim_expires_at_ms IS NULL)),
  CHECK(claim_token IS NULL OR state='pending_metadata'),
  CHECK((last_blocked_reason IS NULL) = (last_blocked_at_ms IS NULL)),
  CHECK((first_attempt_at_ms IS NULL) = (last_attempt_at_ms IS NULL)),
  CHECK(first_attempt_at_ms IS NULL OR last_attempt_at_ms >= first_attempt_at_ms),
  CHECK((last_operator IS NULL) = (last_operator_retry_at_ms IS NULL)),
  CHECK((admitted_at_ms IS NOT NULL) = (state IN ('admitted','existing_session'))),
  CHECK((organizer_source IS NOT NULL) = (admitted_at_ms IS NOT NULL)),
  CHECK((organizer_id_type IS NOT NULL) = (admitted_at_ms IS NOT NULL)),
  CHECK((organizer_open_id IS NOT NULL) = (admitted_at_ms IS NOT NULL)),
  CHECK((organizer_display_name IS NOT NULL) = (admitted_at_ms IS NOT NULL)),
  CHECK((reference_kind IS NOT NULL) = (admitted_at_ms IS NOT NULL)),
  CHECK((reference_json IS NOT NULL) = (admitted_at_ms IS NOT NULL)),
  CHECK(admitted_at_ms IS NULL OR (organizer_id_type='open_id' AND length(organizer_open_id)>0 AND length(organizer_display_name)>0
    AND reference_kind=organizer_source))
) STRICT;
INSERT INTO feishu_invite_occurrences_v32 SELECT * FROM feishu_invite_occurrences;
DROP TABLE feishu_invite_occurrences;
ALTER TABLE feishu_invite_occurrences_v32 RENAME TO feishu_invite_occurrences;
CREATE INDEX feishu_invite_pending ON feishu_invite_occurrences(state, next_attempt_at_ms);

CREATE TABLE backfill_seeds_v32 (
  occurrence_id TEXT PRIMARY KEY NOT NULL REFERENCES recordings(occurrence_id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 40 AND provider GLOB '[a-z]*' AND provider NOT GLOB '*[^a-z0-9_]*'),
  provider_meeting_id TEXT NOT NULL CHECK(length(CAST(provider_meeting_id AS BLOB)) BETWEEN 1 AND 4096),
  meeting_no TEXT NOT NULL CHECK(length(CAST(meeting_no AS BLOB)) BETWEEN 1 AND 4096),
  occurrence_started_at TEXT NOT NULL CHECK(length(occurrence_started_at) BETWEEN 20 AND 24),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  organizer_person_id TEXT,
  organizer_display_name TEXT,
  organizer_source TEXT CHECK(organizer_source IN ('reservation','calendar_event','meeting_list')),
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
  organizer_unresolved_reason TEXT CHECK(organizer_unresolved_reason IN ('instant_meeting','organizer_unresolved')),
  CHECK((organizer_person_id IS NULL) = (organizer_unresolved_reason IS NOT NULL)),
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
-- Seeds written before this migration were published as instant meetings; keep them consistent.
INSERT INTO backfill_seeds_v32 SELECT *, CASE WHEN organizer_person_id IS NULL THEN 'instant_meeting' END FROM backfill_seeds;
DROP TABLE backfill_seeds;
ALTER TABLE backfill_seeds_v32 RENAME TO backfill_seeds;
CREATE TRIGGER backfill_seed_immutable_update BEFORE UPDATE ON backfill_seeds
BEGIN SELECT RAISE(ABORT, 'backfill seed is immutable'); END;
CREATE TRIGGER backfill_seed_immutable_delete BEFORE DELETE ON backfill_seeds
BEGIN SELECT RAISE(ABORT, 'backfill seed is immutable'); END;

PRAGMA legacy_alter_table = OFF;

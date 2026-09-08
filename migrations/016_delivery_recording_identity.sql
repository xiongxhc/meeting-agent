-- Persist the Runtime handle binding used to name its direct-child encrypted
-- recording.  Existing rows are repaired by the SQLite adapter after this
-- schema transaction, because canonical filesystem identity is not SQL text.
ALTER TABLE delivery_journal ADD COLUMN recording_handle TEXT
  CHECK (recording_handle IS NULL OR (length(recording_handle) = 32 AND recording_handle NOT GLOB '*[^0-9a-f]*'));

CREATE TABLE delivery_recording_owners_v16 (
  canonical_path TEXT NOT NULL PRIMARY KEY,
  physical_identity TEXT NOT NULL UNIQUE,
  occurrence_id TEXT NOT NULL REFERENCES recordings(occurrence_id) ON DELETE CASCADE,
  recording_handle TEXT,
  failure_reason TEXT,
  CHECK ((recording_handle IS NOT NULL AND failure_reason IS NULL) OR
         (recording_handle IS NULL AND failure_reason = 'invalid_runtime_recording_binding')),
  CHECK (recording_handle IS NULL OR (length(recording_handle) = 32 AND recording_handle NOT GLOB '*[^0-9a-f]*'))
) STRICT;

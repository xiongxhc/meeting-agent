-- A missing legacy path is a canonical-path reservation, not evidence that a
-- physical inode was observed.  Keep those facts separate so a recreated
-- path can be resolved before another occurrence claims a hardlink to it.
CREATE TABLE delivery_recording_owners_v17 (
  canonical_path TEXT NOT NULL PRIMARY KEY,
  physical_identity TEXT UNIQUE,
  occurrence_id TEXT NOT NULL REFERENCES recordings(occurrence_id) ON DELETE CASCADE,
  recording_handle TEXT,
  owner_state TEXT NOT NULL,
  failure_reason TEXT,
  CHECK (owner_state IN ('observed', 'reserved', 'invalid')),
  CHECK (
    (owner_state = 'observed' AND physical_identity IS NOT NULL AND recording_handle IS NOT NULL AND failure_reason IS NULL)
    OR (owner_state = 'reserved' AND physical_identity IS NULL AND recording_handle IS NOT NULL AND failure_reason = 'source_missing')
    OR (owner_state = 'invalid' AND physical_identity IS NULL AND recording_handle IS NULL AND failure_reason = 'invalid_runtime_recording_binding')
  ),
  CHECK (physical_identity IS NULL OR physical_identity GLOB 'inode:*:*'),
  CHECK (recording_handle IS NULL OR (length(recording_handle) = 32 AND recording_handle NOT GLOB '*[^0-9a-f]*'))
) STRICT;

INSERT INTO delivery_recording_owners_v17
  (canonical_path, physical_identity, occurrence_id, recording_handle, owner_state, failure_reason)
SELECT canonical_path,
       CASE WHEN physical_identity GLOB 'inode:*:*' THEN physical_identity ELSE NULL END,
       occurrence_id,
       recording_handle,
       CASE
         WHEN failure_reason = 'invalid_runtime_recording_binding' THEN 'invalid'
         WHEN physical_identity GLOB 'inode:*:*' THEN 'observed'
         ELSE 'reserved'
       END,
       CASE
         WHEN failure_reason = 'invalid_runtime_recording_binding' THEN failure_reason
         WHEN physical_identity GLOB 'inode:*:*' THEN NULL
         ELSE 'source_missing'
       END
  FROM delivery_recording_owners_v16;

DROP TABLE delivery_recording_owners_v16;

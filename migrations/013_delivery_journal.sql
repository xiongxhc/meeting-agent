CREATE TABLE delivery_journal (
  occurrence_id TEXT NOT NULL REFERENCES sessions(occurrence_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
  artifact_hash TEXT NOT NULL CHECK (artifact_hash GLOB 'sha256:[0-9a-f]*' AND length(artifact_hash) = 71),
  recording_path TEXT NOT NULL,
  bundle_path TEXT NOT NULL,
  ended_at_ms INTEGER NOT NULL CHECK (ended_at_ms >= 0),
  transcript_complete INTEGER NOT NULL CHECK (transcript_complete IN (0, 1)),
  retry_count INTEGER NOT NULL CHECK (retry_count >= 0),
  next_retry_at_ms INTEGER NOT NULL CHECK (next_retry_at_ms >= 0),
  retry_reason TEXT CHECK (retry_reason IS NULL OR retry_reason = 'receipt_unavailable'),
  published_at_ms INTEGER,
  deleted_at_ms INTEGER,
  publication_url TEXT,
  vault_commit TEXT CHECK (vault_commit IS NULL OR (length(vault_commit) = 40 AND vault_commit NOT GLOB '*[^0-9a-f]*')),
  PRIMARY KEY (occurrence_id, revision),
  CHECK ((published_at_ms IS NULL AND publication_url IS NULL AND vault_commit IS NULL) OR
         (published_at_ms IS NOT NULL AND publication_url IS NOT NULL AND vault_commit IS NOT NULL)),
  CHECK (deleted_at_ms IS NULL OR deleted_at_ms >= ended_at_ms)
) STRICT;

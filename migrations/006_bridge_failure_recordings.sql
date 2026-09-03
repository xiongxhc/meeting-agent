-- Each failed bridge generation has its own runtime-issued encrypted locator.
-- It cannot share recordings.occurrence_id because recovery keeps the same
-- occurrence while creating a fresh bridge/runtime generation.
CREATE TABLE bridge_failure_recordings (
  occurrence_id TEXT NOT NULL REFERENCES sessions(occurrence_id),
  attempt INTEGER NOT NULL,
  handle TEXT NOT NULL,
  encrypted_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  format TEXT NOT NULL,
  key_id TEXT NOT NULL,
  finalized_at_ms INTEGER NOT NULL,
  PRIMARY KEY (occurrence_id, attempt),
  CHECK (length(handle) BETWEEN 1 AND 128 AND handle NOT GLOB '*[^a-z0-9]*'),
  CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (duration_ms >= 0),
  CHECK (finalized_at_ms >= 0)
) STRICT;

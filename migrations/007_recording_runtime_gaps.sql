-- The runtime reports media-timeline gaps with bigint timestamps and reason
-- tokens. They are different facts from bridge_recovery_gaps/recording_gaps,
-- whose timestamps are bridge-observed wall-clock instants with directions.
-- Decimal TEXT preserves bigint values exactly across SQLite/JavaScript.
CREATE TABLE recording_runtime_gaps (
  occurrence_id TEXT NOT NULL REFERENCES recordings(occurrence_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  started_at_ms TEXT NOT NULL,
  ended_at_ms TEXT,
  reason TEXT NOT NULL,
  PRIMARY KEY (occurrence_id, ordinal),
  CHECK (ordinal >= 0),
  CHECK (length(started_at_ms) >= 1 AND started_at_ms NOT GLOB '*[^0-9]*'),
  CHECK (ended_at_ms IS NULL OR (length(ended_at_ms) >= 1 AND ended_at_ms NOT GLOB '*[^0-9]*'))
) STRICT;

CREATE TABLE bridge_failure_recording_runtime_gaps (
  occurrence_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  started_at_ms TEXT NOT NULL,
  ended_at_ms TEXT,
  reason TEXT NOT NULL,
  PRIMARY KEY (occurrence_id, attempt, ordinal),
  FOREIGN KEY (occurrence_id, attempt)
    REFERENCES bridge_failure_recordings(occurrence_id, attempt) ON DELETE CASCADE,
  CHECK (attempt >= 1),
  CHECK (ordinal >= 0),
  CHECK (length(started_at_ms) >= 1 AND started_at_ms NOT GLOB '*[^0-9]*'),
  CHECK (ended_at_ms IS NULL OR (length(ended_at_ms) >= 1 AND ended_at_ms NOT GLOB '*[^0-9]*'))
) STRICT;

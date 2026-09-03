-- A bridge-session is terminal after left, but a bridge failure can recover
-- with a fresh bridge session/lease for the same occurrence.
CREATE TABLE bridge_recoveries (
  occurrence_id TEXT NOT NULL PRIMARY KEY REFERENCES sessions(occurrence_id),
  failure_count INTEGER NOT NULL,
  last_failed_at_ms INTEGER NOT NULL,
  CHECK (failure_count >= 1),
  CHECK (last_failed_at_ms >= 0)
) STRICT;

CREATE TABLE bridge_recovery_gaps (
  occurrence_id TEXT NOT NULL REFERENCES bridge_recoveries(occurrence_id),
  attempt INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  direction TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (occurrence_id, attempt, ordinal),
  CHECK (attempt >= 1),
  CHECK (ordinal >= 0),
  CHECK (direction IN ('capture', 'playback'))
) STRICT;

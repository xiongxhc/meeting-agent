-- Local-only evidence required to reconstruct speaker reconciliation after a
-- coordinator restart. This is not a Team Vault or TeamMem projection: no
-- production path outside reconciliation storage reads these transcript words.
-- Current Runtime declarations expose no trustworthy wall-clock-to-media-zero
-- pair, so alignment is deliberately represented by its durable absence.

CREATE TABLE reconciliation_sessions (
  occurrence_id TEXT NOT NULL PRIMARY KEY REFERENCES sessions(occurrence_id) ON DELETE CASCADE,
  runtime_session_id TEXT,
  alignment_status TEXT NOT NULL DEFAULT 'unavailable_current_sdk',
  CHECK (alignment_status = 'unavailable_current_sdk'),
  CHECK (runtime_session_id IS NULL OR (length(runtime_session_id) >= 1 AND runtime_session_id NOT GLOB '*[^0-9]*'))
) STRICT;

CREATE TABLE reconciliation_bridge_events (
  occurrence_id TEXT NOT NULL REFERENCES reconciliation_sessions(occurrence_id) ON DELETE CASCADE,
  bridge_session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  schema TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  type TEXT NOT NULL,
  feishu_user_id TEXT,
  display_name TEXT,
  confidence TEXT,
  PRIMARY KEY (occurrence_id, bridge_session_id, sequence),
  CHECK (type IN ('active_speaker', 'participant_joined', 'participant_left')),
  CHECK (schema = 'bridge-session/v1'),
  CHECK (confidence IS NULL OR confidence IN ('ui_exact', 'ambiguous')),
  CHECK ((type = 'active_speaker') = (confidence IS NOT NULL)),
  CHECK (length(observed_at) BETWEEN 1 AND 40 AND observed_at NOT GLOB '* *')
) STRICT;

CREATE TABLE reconciliation_live_segments (
  occurrence_id TEXT NOT NULL REFERENCES reconciliation_sessions(occurrence_id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL,
  text TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  PRIMARY KEY (occurrence_id, segment_id),
  CHECK (length(started_at) BETWEEN 1 AND 40 AND started_at NOT GLOB '* *'),
  CHECK (length(ended_at) BETWEEN 1 AND 40 AND ended_at NOT GLOB '* *')
) STRICT;

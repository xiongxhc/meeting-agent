-- Migration 008 could not safely associate occurrence-wide evidence with a
-- recovered bridge/runtime generation. Its unassociated scratch rows are
-- deliberately purged rather than guessed into a recording target.
DROP TABLE reconciliation_live_segments;
DROP TABLE reconciliation_bridge_events;
DROP TABLE reconciliation_sessions;

CREATE TABLE reconciliation_generations (
  generation_id TEXT NOT NULL PRIMARY KEY,
  occurrence_id TEXT NOT NULL REFERENCES sessions(occurrence_id) ON DELETE CASCADE,
  bridge_session_id TEXT NOT NULL,
  runtime_session_id TEXT,
  recording_handle TEXT,
  alignment_status TEXT NOT NULL DEFAULT 'unavailable_current_sdk',
  capture_complete INTEGER NOT NULL DEFAULT 1,
  incomplete_reason TEXT,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  UNIQUE (occurrence_id, bridge_session_id),
  CHECK (runtime_session_id IS NULL OR (length(runtime_session_id) >= 1 AND runtime_session_id NOT GLOB '*[^0-9]*')),
  CHECK (alignment_status = 'unavailable_current_sdk'),
  CHECK (capture_complete IN (0, 1)),
  CHECK (incomplete_reason IS NULL OR incomplete_reason IN ('event_limit_exceeded', 'live_text_limit_exceeded')),
  CHECK ((capture_complete = 1 AND incomplete_reason IS NULL) OR (capture_complete = 0 AND incomplete_reason IS NOT NULL)),
  CHECK (created_at_ms >= 0 AND expires_at_ms >= created_at_ms)
) STRICT;

CREATE TABLE reconciliation_bridge_events (
  generation_id TEXT NOT NULL REFERENCES reconciliation_generations(generation_id) ON DELETE CASCADE,
  bridge_session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  schema TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  type TEXT NOT NULL,
  feishu_user_id TEXT,
  display_name TEXT,
  confidence TEXT,
  PRIMARY KEY (generation_id, sequence),
  CHECK (sequence BETWEEN 1 AND 9007199254740991),
  CHECK (schema = 'bridge-session/v1'),
  CHECK (observed_at GLOB '????-??-??T??:??:??Z' OR observed_at GLOB '????-??-??T??:??:??.???Z'),
  CHECK (strftime('%s', observed_at) IS NOT NULL),
  CHECK (type IN ('active_speaker', 'participant_joined', 'participant_left')),
  CHECK (confidence IS NULL OR confidence IN ('ui_exact', 'ambiguous')),
  CHECK (
    (type = 'active_speaker' AND display_name IS NULL AND ((confidence = 'ui_exact' AND feishu_user_id IS NOT NULL) OR (confidence = 'ambiguous' AND feishu_user_id IS NULL)))
    OR (type = 'participant_joined' AND confidence IS NULL AND feishu_user_id IS NOT NULL AND display_name IS NOT NULL)
    OR (type = 'participant_left' AND confidence IS NULL AND feishu_user_id IS NOT NULL AND display_name IS NULL)
  )
) STRICT;

CREATE TABLE reconciliation_live_segments (
  generation_id TEXT NOT NULL REFERENCES reconciliation_generations(generation_id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL,
  text TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  PRIMARY KEY (generation_id, segment_id),
  CHECK (length(CAST(text AS BLOB)) BETWEEN 1 AND 16384),
  CHECK (started_at GLOB '????-??-??T??:??:??Z' OR started_at GLOB '????-??-??T??:??:??.???Z'),
  CHECK (ended_at GLOB '????-??-??T??:??:??Z' OR ended_at GLOB '????-??-??T??:??:??.???Z'),
  CHECK (strftime('%s', started_at) IS NOT NULL AND strftime('%s', ended_at) IS NOT NULL)
) STRICT;

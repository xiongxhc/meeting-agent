-- Schema 009 evidence was bounded by application-side counts and keyed by an
-- externally supplied generation id.  It is local recovery scratch, so rows
-- that cannot prove the new occurrence-scoped identity are discarded rather
-- than guessed into a new recording generation.
DROP TABLE reconciliation_live_segments;
DROP TABLE reconciliation_bridge_events;
DROP TABLE reconciliation_generations;

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
  terminal_at_ms INTEGER,
  expires_at_ms INTEGER,
  UNIQUE (occurrence_id, bridge_session_id),
  CHECK (runtime_session_id IS NULL OR (length(runtime_session_id) >= 1 AND runtime_session_id NOT GLOB '*[^0-9]*')),
  CHECK (alignment_status = 'unavailable_current_sdk'),
  CHECK (capture_complete IN (0, 1)),
  CHECK (incomplete_reason IS NULL OR incomplete_reason IN ('event_limit_exceeded', 'live_text_limit_exceeded')),
  CHECK ((capture_complete = 1 AND incomplete_reason IS NULL) OR (capture_complete = 0 AND incomplete_reason IS NOT NULL)),
  CHECK (created_at_ms >= 0),
  CHECK ((terminal_at_ms IS NULL AND expires_at_ms IS NULL) OR
         (terminal_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL AND expires_at_ms >= terminal_at_ms))
) STRICT;

CREATE TABLE reconciliation_bridge_events (
  generation_id TEXT NOT NULL REFERENCES reconciliation_generations(generation_id) ON DELETE CASCADE,
  bridge_session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  schema TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  type TEXT NOT NULL,
  feishu_user_id TEXT,
  display_name TEXT,
  confidence TEXT,
  PRIMARY KEY (generation_id, sequence),
  CHECK (sequence BETWEEN 1 AND 9007199254740991),
  CHECK (schema = 'bridge-session/v1'),
  CHECK (
    observed_at = strftime('%Y-%m-%dT%H:%M:%SZ', julianday(observed_at))
    OR observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(observed_at))
  ),
  CHECK (observed_at_ms >= 0),
  CHECK (type IN ('active_speaker', 'participant_joined', 'participant_left')),
  CHECK (confidence IS NULL OR confidence IN ('ui_exact', 'ambiguous')),
  CHECK (
    (type = 'active_speaker' AND display_name IS NULL AND ((confidence = 'ui_exact' AND feishu_user_id IS NOT NULL AND length(feishu_user_id) > 0) OR (confidence = 'ambiguous' AND feishu_user_id IS NULL)))
    OR (type = 'participant_joined' AND confidence IS NULL AND feishu_user_id IS NOT NULL AND length(feishu_user_id) > 0 AND display_name IS NOT NULL AND length(display_name) > 0)
    OR (type = 'participant_left' AND confidence IS NULL AND feishu_user_id IS NOT NULL AND length(feishu_user_id) > 0 AND display_name IS NULL)
  )
) STRICT;

CREATE TABLE reconciliation_live_segments (
  generation_id TEXT NOT NULL REFERENCES reconciliation_generations(generation_id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL,
  text TEXT NOT NULL,
  started_at TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  ended_at TEXT NOT NULL,
  ended_at_ms INTEGER NOT NULL,
  PRIMARY KEY (generation_id, segment_id),
  CHECK (length(CAST(text AS BLOB)) BETWEEN 1 AND 16384),
  CHECK (
    started_at = strftime('%Y-%m-%dT%H:%M:%SZ', julianday(started_at))
    OR started_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(started_at))
  ),
  CHECK (
    ended_at = strftime('%Y-%m-%dT%H:%M:%SZ', julianday(ended_at))
    OR ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(ended_at))
  ),
  CHECK (started_at_ms >= 0 AND ended_at_ms >= started_at_ms)
) STRICT;

-- SQLite serializes writers.  The triggers therefore observe the count at
-- the insert boundary, not a stale application-side preflight.  RAISE(FAIL)
-- preserves the prior trigger update, making the rejected overrun durable.
CREATE TRIGGER reconciliation_bridge_events_limit
BEFORE INSERT ON reconciliation_bridge_events
WHEN (SELECT count(*) FROM reconciliation_bridge_events WHERE generation_id = NEW.generation_id) >= 256
BEGIN
  UPDATE reconciliation_generations
     SET capture_complete = 0, incomplete_reason = 'event_limit_exceeded'
   WHERE generation_id = NEW.generation_id AND capture_complete = 1;
  SELECT RAISE(FAIL, 'reconciliation event limit exceeded');
END;

CREATE TRIGGER reconciliation_live_segments_limit
BEFORE INSERT ON reconciliation_live_segments
WHEN length(CAST(NEW.text AS BLOB)) > 16384
  OR (SELECT count(*) FROM reconciliation_live_segments WHERE generation_id = NEW.generation_id) >= 256
BEGIN
  UPDATE reconciliation_generations
     SET capture_complete = 0,
         incomplete_reason = CASE
           WHEN length(CAST(NEW.text AS BLOB)) > 16384 THEN 'live_text_limit_exceeded'
           ELSE 'event_limit_exceeded'
         END
   WHERE generation_id = NEW.generation_id AND capture_complete = 1;
  SELECT RAISE(FAIL, 'reconciliation live evidence limit exceeded');
END;

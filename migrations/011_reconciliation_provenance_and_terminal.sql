-- Schema 010 accepted caller-writable numeric ordering columns beside the
-- retained UTC provenance and did not record how terminal time was observed.
-- Preserve every generation, represent terminal provenance honestly as
-- legacy_unknown, and copy only children whose text and numeric instants can
-- prove one truth. A generation with an untrustworthy child remains associated
-- with its recording but is marked incomplete explicitly.
CREATE TABLE reconciliation_generations_v11 (
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
  terminal_source TEXT,
  expires_at_ms INTEGER,
  UNIQUE (occurrence_id, bridge_session_id),
  CHECK (runtime_session_id IS NULL OR (length(runtime_session_id) >= 1 AND runtime_session_id NOT GLOB '*[^0-9]*')),
  CHECK (alignment_status = 'unavailable_current_sdk'),
  CHECK (capture_complete IN (0, 1)),
  CHECK (incomplete_reason IS NULL OR incomplete_reason IN ('event_limit_exceeded', 'live_text_limit_exceeded', 'legacy_evidence_invalid_on_migration')),
  CHECK ((capture_complete = 1 AND incomplete_reason IS NULL) OR (capture_complete = 0 AND incomplete_reason IS NOT NULL)),
  CHECK (created_at_ms >= 0),
  CHECK ((terminal_at_ms IS NULL AND terminal_source IS NULL AND expires_at_ms IS NULL) OR
         (terminal_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL AND (
           (terminal_source IN ('bridge_observed', 'local_clock') AND expires_at_ms = terminal_at_ms + 1209600000)
           OR (terminal_source = 'legacy_unknown' AND expires_at_ms >= terminal_at_ms)
         )))
) STRICT;

CREATE TABLE reconciliation_bridge_events_v11 (
  generation_id TEXT NOT NULL REFERENCES reconciliation_generations_v11(generation_id) ON DELETE CASCADE,
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
  CHECK (julianday(observed_at) IS NOT NULL AND strftime('%s', observed_at) IS NOT NULL),
  CHECK (observed_at = strftime('%Y-%m-%dT%H:%M:%SZ', julianday(observed_at)) OR observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(observed_at))),
  CHECK (observed_at_ms >= 0 AND observed_at_ms = CAST(strftime('%s', observed_at) AS INTEGER) * 1000 + CASE length(observed_at) WHEN 24 THEN CAST(substr(observed_at, 21, 3) AS INTEGER) ELSE 0 END),
  CHECK (type IN ('active_speaker', 'participant_joined', 'participant_left')),
  CHECK (confidence IS NULL OR confidence IN ('ui_exact', 'ambiguous')),
  CHECK (
    (type = 'active_speaker' AND display_name IS NULL AND ((confidence = 'ui_exact' AND feishu_user_id IS NOT NULL AND length(feishu_user_id) > 0) OR (confidence = 'ambiguous' AND feishu_user_id IS NULL)))
    OR (type = 'participant_joined' AND confidence IS NULL AND feishu_user_id IS NOT NULL AND length(feishu_user_id) > 0 AND display_name IS NOT NULL AND length(display_name) > 0)
    OR (type = 'participant_left' AND confidence IS NULL AND feishu_user_id IS NOT NULL AND length(feishu_user_id) > 0 AND display_name IS NULL)
  )
) STRICT;

CREATE TABLE reconciliation_live_segments_v11 (
  generation_id TEXT NOT NULL REFERENCES reconciliation_generations_v11(generation_id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL,
  text TEXT NOT NULL,
  started_at TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  ended_at TEXT NOT NULL,
  ended_at_ms INTEGER NOT NULL,
  PRIMARY KEY (generation_id, segment_id),
  CHECK (length(CAST(text AS BLOB)) BETWEEN 1 AND 16384),
  CHECK (julianday(started_at) IS NOT NULL AND strftime('%s', started_at) IS NOT NULL),
  CHECK (julianday(ended_at) IS NOT NULL AND strftime('%s', ended_at) IS NOT NULL),
  CHECK (started_at = strftime('%Y-%m-%dT%H:%M:%SZ', julianday(started_at)) OR started_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(started_at))),
  CHECK (ended_at = strftime('%Y-%m-%dT%H:%M:%SZ', julianday(ended_at)) OR ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(ended_at))),
  CHECK (started_at_ms >= 0 AND started_at_ms = CAST(strftime('%s', started_at) AS INTEGER) * 1000 + CASE length(started_at) WHEN 24 THEN CAST(substr(started_at, 21, 3) AS INTEGER) ELSE 0 END),
  CHECK (ended_at_ms >= 0 AND ended_at_ms = CAST(strftime('%s', ended_at) AS INTEGER) * 1000 + CASE length(ended_at) WHEN 24 THEN CAST(substr(ended_at, 21, 3) AS INTEGER) ELSE 0 END),
  CHECK (ended_at_ms >= started_at_ms)
) STRICT;

CREATE TEMP TABLE reconciliation_invalid_generations_v11 (
  generation_id TEXT NOT NULL PRIMARY KEY
) STRICT;

INSERT OR IGNORE INTO reconciliation_invalid_generations_v11
SELECT generation_id
  FROM reconciliation_bridge_events AS event
 WHERE julianday(event.observed_at) IS NULL
    OR strftime('%s', event.observed_at) IS NULL
    OR NOT (event.observed_at = strftime('%Y-%m-%dT%H:%M:%SZ', julianday(event.observed_at))
      OR event.observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(event.observed_at)))
    OR event.observed_at_ms < 0
    OR event.observed_at_ms != CAST(strftime('%s', event.observed_at) AS INTEGER) * 1000 + CASE length(event.observed_at) WHEN 24 THEN CAST(substr(event.observed_at, 21, 3) AS INTEGER) ELSE 0 END;

INSERT OR IGNORE INTO reconciliation_invalid_generations_v11
SELECT generation_id
  FROM reconciliation_live_segments AS segment
 WHERE julianday(segment.started_at) IS NULL
    OR strftime('%s', segment.started_at) IS NULL
    OR julianday(segment.ended_at) IS NULL
    OR strftime('%s', segment.ended_at) IS NULL
    OR NOT (segment.started_at = strftime('%Y-%m-%dT%H:%M:%SZ', julianday(segment.started_at))
      OR segment.started_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(segment.started_at)))
    OR NOT (segment.ended_at = strftime('%Y-%m-%dT%H:%M:%SZ', julianday(segment.ended_at))
      OR segment.ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(segment.ended_at)))
    OR segment.started_at_ms < 0
    OR segment.ended_at_ms < segment.started_at_ms
    OR segment.started_at_ms != CAST(strftime('%s', segment.started_at) AS INTEGER) * 1000 + CASE length(segment.started_at) WHEN 24 THEN CAST(substr(segment.started_at, 21, 3) AS INTEGER) ELSE 0 END
    OR segment.ended_at_ms != CAST(strftime('%s', segment.ended_at) AS INTEGER) * 1000 + CASE length(segment.ended_at) WHEN 24 THEN CAST(substr(segment.ended_at, 21, 3) AS INTEGER) ELSE 0 END;

INSERT INTO reconciliation_generations_v11
  (generation_id, occurrence_id, bridge_session_id, runtime_session_id, recording_handle, alignment_status,
   capture_complete, incomplete_reason, created_at_ms, terminal_at_ms, terminal_source, expires_at_ms)
SELECT generation.generation_id, occurrence_id, bridge_session_id, runtime_session_id, recording_handle, alignment_status,
       CASE WHEN invalid.generation_id IS NULL THEN capture_complete ELSE 0 END,
       CASE WHEN invalid.generation_id IS NULL THEN incomplete_reason ELSE 'legacy_evidence_invalid_on_migration' END,
       created_at_ms, terminal_at_ms,
       CASE WHEN terminal_at_ms IS NULL THEN NULL ELSE 'legacy_unknown' END,
       expires_at_ms
  FROM reconciliation_generations AS generation
  LEFT JOIN reconciliation_invalid_generations_v11 AS invalid USING (generation_id);

INSERT INTO reconciliation_bridge_events_v11
SELECT event.generation_id, event.bridge_session_id, event.sequence, event.schema, event.observed_at, event.observed_at_ms, event.type, event.feishu_user_id, event.display_name, event.confidence
  FROM reconciliation_bridge_events AS event
  JOIN reconciliation_generations_v11 AS generation ON generation.generation_id = event.generation_id
 WHERE julianday(event.observed_at) IS NOT NULL
   AND strftime('%s', event.observed_at) IS NOT NULL
   AND (event.observed_at = strftime('%Y-%m-%dT%H:%M:%SZ', julianday(event.observed_at))
     OR event.observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(event.observed_at)))
   AND event.observed_at_ms >= 0
   AND event.observed_at_ms = CAST(strftime('%s', event.observed_at) AS INTEGER) * 1000 + CASE length(event.observed_at) WHEN 24 THEN CAST(substr(event.observed_at, 21, 3) AS INTEGER) ELSE 0 END;

INSERT INTO reconciliation_live_segments_v11
SELECT segment.generation_id, segment.segment_id, segment.text, segment.started_at, segment.started_at_ms, segment.ended_at, segment.ended_at_ms
  FROM reconciliation_live_segments AS segment
  JOIN reconciliation_generations_v11 AS generation ON generation.generation_id = segment.generation_id
 WHERE julianday(segment.started_at) IS NOT NULL
   AND strftime('%s', segment.started_at) IS NOT NULL
   AND julianday(segment.ended_at) IS NOT NULL
   AND strftime('%s', segment.ended_at) IS NOT NULL
   AND (segment.started_at = strftime('%Y-%m-%dT%H:%M:%SZ', julianday(segment.started_at))
     OR segment.started_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(segment.started_at)))
   AND (segment.ended_at = strftime('%Y-%m-%dT%H:%M:%SZ', julianday(segment.ended_at))
     OR segment.ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(segment.ended_at)))
   AND segment.started_at_ms >= 0
   AND segment.ended_at_ms >= segment.started_at_ms
   AND segment.started_at_ms = CAST(strftime('%s', segment.started_at) AS INTEGER) * 1000 + CASE length(segment.started_at) WHEN 24 THEN CAST(substr(segment.started_at, 21, 3) AS INTEGER) ELSE 0 END
   AND segment.ended_at_ms = CAST(strftime('%s', segment.ended_at) AS INTEGER) * 1000 + CASE length(segment.ended_at) WHEN 24 THEN CAST(substr(segment.ended_at, 21, 3) AS INTEGER) ELSE 0 END;

DROP TABLE reconciliation_invalid_generations_v11;
DROP TABLE reconciliation_live_segments;
DROP TABLE reconciliation_bridge_events;
DROP TABLE reconciliation_generations;
ALTER TABLE reconciliation_generations_v11 RENAME TO reconciliation_generations;
ALTER TABLE reconciliation_bridge_events_v11 RENAME TO reconciliation_bridge_events;
ALTER TABLE reconciliation_live_segments_v11 RENAME TO reconciliation_live_segments;

CREATE TRIGGER reconciliation_bridge_events_limit
BEFORE INSERT ON reconciliation_bridge_events
WHEN (SELECT count(*) FROM reconciliation_bridge_events WHERE generation_id = NEW.generation_id) >= 256
BEGIN
  UPDATE reconciliation_generations SET capture_complete = 0, incomplete_reason = 'event_limit_exceeded'
   WHERE generation_id = NEW.generation_id AND capture_complete = 1;
  SELECT RAISE(FAIL, 'reconciliation event limit exceeded');
END;

CREATE TRIGGER reconciliation_live_segments_limit
BEFORE INSERT ON reconciliation_live_segments
WHEN length(CAST(NEW.text AS BLOB)) > 16384
  OR (SELECT count(*) FROM reconciliation_live_segments WHERE generation_id = NEW.generation_id) >= 256
BEGIN
  UPDATE reconciliation_generations
     SET capture_complete = 0, incomplete_reason = CASE WHEN length(CAST(NEW.text AS BLOB)) > 16384 THEN 'live_text_limit_exceeded' ELSE 'event_limit_exceeded' END
   WHERE generation_id = NEW.generation_id AND capture_complete = 1;
  SELECT RAISE(FAIL, 'reconciliation live evidence limit exceeded');
END;

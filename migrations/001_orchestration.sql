-- Migration 001: orchestration control state.
--
-- This database holds ONLY session lifecycle, its audit trail, and bridge
-- leases -- never transcript text and never audio bytes. That is not just a
-- comment: every table is STRICT (a declared column type is enforced, not
-- advisory), no column is declared BLOB or ANY, and every free-text-shaped
-- column (reason / terminal_reason / release_reason) is bounded to a short
-- lowercase token by CHECK, which structurally rejects prose, transcript
-- excerpts, or anything else that isn't a short machine-readable code.
--
-- State machine (src/sessions/coordinator.ts owns the transition graph):
--   discovered -> joining -> listening -> finalizing -> awaiting_teammem
--     -> published -> notified
-- "failed" is reachable from any non-terminal state. "notified" and "failed"
-- are terminal: bridge-session/v1 has no re-open, so resuming a meeting
-- after a terminal state means a brand new occurrence/session, never
-- reopening this one.

CREATE TABLE schema_migrations (
  version       INTEGER NOT NULL PRIMARY KEY,
  name          TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (
  occurrence_id          TEXT NOT NULL PRIMARY KEY,
  occurrence_segment     TEXT NOT NULL UNIQUE,
  provider_meeting_id    TEXT NOT NULL,
  occurrence_started_at  TEXT NOT NULL,
  state                  TEXT NOT NULL,
  terminal_reason        TEXT,
  created_at_ms          INTEGER NOT NULL,
  updated_at_ms          INTEGER NOT NULL,
  CHECK (length(occurrence_id) BETWEEN 1 AND 500),
  CHECK (length(occurrence_segment) BETWEEN 1 AND 500),
  CHECK (length(provider_meeting_id) BETWEEN 1 AND 300),
  CHECK (length(occurrence_started_at) BETWEEN 1 AND 40),
  CHECK (state IN (
    'discovered', 'joining', 'listening', 'finalizing',
    'awaiting_teammem', 'published', 'notified', 'failed'
  )),
  -- terminal_reason is set if and only if the session is failed, and is a
  -- short lowercase_snake token, never free text.
  CHECK (
    (state = 'failed') = (terminal_reason IS NOT NULL)
  ),
  CHECK (
    terminal_reason IS NULL OR (
      length(terminal_reason) BETWEEN 1 AND 40
      AND terminal_reason GLOB '[a-z]*'
      AND terminal_reason NOT GLOB '*[^a-z0-9_]*'
    )
  ),
  CHECK (updated_at_ms >= created_at_ms)
) STRICT;

-- One append-only audit row per transition, including the synthetic
-- "creation" transition (from_state NULL -> to_state 'discovered'). A
-- transition and its audit row are always written in the same SQLite
-- transaction by the adapter, so a crash mid-write leaves neither.
CREATE TABLE transitions (
  id               INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  occurrence_id    TEXT NOT NULL REFERENCES sessions(occurrence_id),
  from_state       TEXT,
  to_state         TEXT NOT NULL,
  reason           TEXT,
  terminal_reason  TEXT,
  occurred_at_ms   INTEGER NOT NULL,
  CHECK (from_state IS NULL OR from_state IN (
    'discovered', 'joining', 'listening', 'finalizing',
    'awaiting_teammem', 'published', 'notified', 'failed'
  )),
  CHECK (to_state IN (
    'discovered', 'joining', 'listening', 'finalizing',
    'awaiting_teammem', 'published', 'notified', 'failed'
  )),
  -- A short lowercase_snake token or NULL. Never long enough, or shaped
  -- enough, to hold a sentence -- let alone a transcript segment.
  CHECK (
    reason IS NULL OR (
      length(reason) BETWEEN 1 AND 40
      AND reason GLOB '[a-z]*'
      AND reason NOT GLOB '*[^a-z0-9_]*'
    )
  ),
  CHECK (
    terminal_reason IS NULL OR (
      length(terminal_reason) BETWEEN 1 AND 40
      AND terminal_reason GLOB '[a-z]*'
      AND terminal_reason NOT GLOB '*[^a-z0-9_]*'
    )
  ),
  CHECK ((to_state = 'failed') = (terminal_reason IS NOT NULL))
) STRICT;

CREATE INDEX idx_transitions_occurrence ON transitions (occurrence_id, id);

-- One row per bridge-session/v1 lease attempt. A `left` (including a
-- synthesized `left(reason: "bridge_failure")`) is terminal for that bridge
-- session per the bridge protocol: it always RELEASES the lease rather than
-- reusing it, and resuming a meeting acquires a brand new lease against a
-- brand new bridge_session_id. released_at_ms/release_reason are therefore
-- set together, and only ever once, for a given lease row.
CREATE TABLE bridge_leases (
  lease_id           TEXT NOT NULL PRIMARY KEY,
  occurrence_id      TEXT NOT NULL REFERENCES sessions(occurrence_id),
  bridge_id          TEXT NOT NULL,
  bridge_session_id  TEXT NOT NULL,
  acquired_at_ms     INTEGER NOT NULL,
  expires_at_ms      INTEGER NOT NULL,
  released_at_ms     INTEGER,
  release_reason     TEXT,
  CHECK (length(lease_id) BETWEEN 1 AND 200),
  CHECK (length(bridge_id) BETWEEN 1 AND 200),
  CHECK (length(bridge_session_id) BETWEEN 1 AND 200),
  CHECK (expires_at_ms >= acquired_at_ms),
  CHECK ((released_at_ms IS NULL) = (release_reason IS NULL)),
  CHECK (release_reason IS NULL OR release_reason IN ('left', 'bridge_failure', 'stale_recovered'))
) STRICT;

-- At most one live (unreleased) lease per occurrence: bridge-session/v1's
-- "no re-open" rule means a lease is unique per occurrence for as long as it
-- is live, enforced structurally rather than only by application code.
CREATE UNIQUE INDEX idx_bridge_leases_active_per_occurrence
  ON bridge_leases (occurrence_id)
  WHERE released_at_ms IS NULL;

CREATE INDEX idx_bridge_leases_occurrence ON bridge_leases (occurrence_id, acquired_at_ms);

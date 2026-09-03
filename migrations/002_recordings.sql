-- Migration 002: the finalized recording's metadata.
--
-- WHY THIS IS CONTROL STATE AND NOT SOMEBODY ELSE'S PROBLEM. The handle the
-- Conversation Runtime returns from finalizeRecording is the ONLY reference to
-- the encrypted audio, and it is not recoverable: the runtime port exposes no
-- lookup, and after a crash the runtime session is gone. Held in memory it is
-- a string that dies with the process, leaving encrypted audio nothing points
-- at. Every later stage consumes this handle; none of them can re-derive it.
--
-- Same discipline as 001, for the same reason -- this database holds session
-- lifecycle and now the recording's METADATA, never transcript text and never
-- audio bytes:
--   * every table STRICT, so a declared column type is enforced;
--   * no BLOB and no ANY column anywhere;
--   * every free-text-shaped column bounded AND token-formatted by CHECK, so
--     it is structurally incapable of holding prose. `handle` in particular
--     admits no whitespace at all, which is what stops an opaque-reference
--     column from being abused as a transcript field.
--
-- Gaps are ordered CHILD ROWS, not a JSON blob: "exact gap recording" means
-- the same gaps in the same order, and a queryable ordinal is what preserves
-- that across a restart. A JSON string column would also be exactly the
-- prose-shaped column the rules above exist to forbid.

CREATE TABLE recordings (
  occurrence_id    TEXT NOT NULL PRIMARY KEY REFERENCES sessions(occurrence_id),
  -- An opaque reference to the ENCRYPTED recording. Meeting Agent never holds
  -- the recording key and never sees plaintext audio.
  handle           TEXT NOT NULL,
  sha256           TEXT NOT NULL,
  duration_ms      INTEGER NOT NULL,
  finalized_at_ms  INTEGER NOT NULL,
  -- A token: no whitespace, no punctuation beyond what an id, a path or a URI
  -- needs. Prose cannot satisfy this, and neither can a transcript excerpt.
  CHECK (
    length(handle) BETWEEN 1 AND 200
    AND handle NOT GLOB '*[^A-Za-z0-9_./:@+=~%-]*'
  ),
  CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (duration_ms >= 0),
  CHECK (finalized_at_ms >= 0)
) STRICT;

CREATE TABLE recording_gaps (
  id             INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  occurrence_id  TEXT NOT NULL REFERENCES recordings(occurrence_id),
  -- Zero-based position in the observed order. UNIQUE with occurrence_id, so
  -- two gaps can never claim the same slot and the order is a fact of the
  -- schema rather than of whatever the reader happens to sort by.
  ordinal        INTEGER NOT NULL,
  direction      TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  -- NULL means the gap was still open when the recording was finalized. That
  -- distinction is preserved, never collapsed to the finalization instant.
  ended_at       TEXT,
  CHECK (ordinal >= 0),
  CHECK (direction IN ('capture', 'playback')),
  CHECK (length(started_at) BETWEEN 1 AND 40 AND started_at NOT GLOB '* *'),
  CHECK (ended_at IS NULL OR (length(ended_at) BETWEEN 1 AND 40 AND ended_at NOT GLOB '* *')),
  UNIQUE (occurrence_id, ordinal)
) STRICT;

CREATE INDEX recording_gaps_by_occurrence ON recording_gaps (occurrence_id, ordinal);

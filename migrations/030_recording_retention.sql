-- Retention for an encrypted Runtime recording that no deletion policy covers.
--
-- A recording is covered when a delivery journal row, a delivery recording
-- owner, a backfill seed or an unknown-end custody row names its handle; each
-- of those already deletes it by ended_at + 14 days or on a complete receipt.
-- A recording whose stop, finalize or finalize transaction failed, or whose
-- process crashed mid-meeting, has none of those. The retention sweep records
-- it here with one immutable deadline: its last write (never later than first
-- detection) plus 14 days, but never less than 72 hours after first detection.
-- The floor keeps a file found long after its last write (the first start after
-- this migration, or a restart after a long outage) for an operator-visible
-- grace period instead of deleting it in the same sweep that finds it.
--
-- The identity columns are the last observation and change while the row is
-- assigned, so the sweep deletes exactly the inode it last saw. A row is
-- released when a covering policy later claims the handle, and deleted once
-- the file is gone at or after its deadline. Rows are never removed.
CREATE TABLE recording_retention (
  recording_handle TEXT NOT NULL PRIMARY KEY CHECK(length(recording_handle)=32 AND recording_handle NOT GLOB '*[^0-9a-f]*'),
  recording_path TEXT NOT NULL CHECK(length(CAST(recording_path AS BLOB)) BETWEEN 1 AND 4096),
  recording_device TEXT NOT NULL CHECK(length(recording_device) BETWEEN 1 AND 40 AND recording_device NOT GLOB '*[^0-9]*'),
  recording_inode TEXT NOT NULL CHECK(length(recording_inode) BETWEEN 1 AND 40 AND recording_inode NOT GLOB '*[^0-9]*'),
  recording_bytes INTEGER NOT NULL CHECK(recording_bytes BETWEEN 0 AND 8589934592),
  detected_at_ms INTEGER NOT NULL CHECK(detected_at_ms BETWEEN 0 AND 9007199254740991),
  retention_from_ms INTEGER NOT NULL CHECK(retention_from_ms BETWEEN 0 AND detected_at_ms),
  deadline_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('assigned','released','deleted')),
  settled_at_ms INTEGER CHECK(settled_at_ms IS NULL OR settled_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (deadline_ms = MAX(retention_from_ms + 1209600000, detected_at_ms + 259200000)),
  CHECK ((state='assigned') = (settled_at_ms IS NULL)),
  CHECK (state!='deleted' OR settled_at_ms >= deadline_ms)
) STRICT;

CREATE TRIGGER recording_retention_immutable_deadline
BEFORE UPDATE OF recording_handle,detected_at_ms,retention_from_ms,deadline_ms ON recording_retention
WHEN OLD.recording_handle!=NEW.recording_handle OR OLD.detected_at_ms!=NEW.detected_at_ms
  OR OLD.retention_from_ms!=NEW.retention_from_ms OR OLD.deadline_ms!=NEW.deadline_ms
BEGIN SELECT RAISE(ABORT, 'recording retention deadline is immutable'); END;

CREATE TRIGGER recording_retention_settled_final BEFORE UPDATE ON recording_retention
WHEN OLD.state!='assigned'
BEGIN SELECT RAISE(ABORT, 'recording retention settlement is final'); END;

CREATE TRIGGER recording_retention_never_deleted BEFORE DELETE ON recording_retention
BEGIN SELECT RAISE(ABORT, 'recording retention is never deleted'); END;

CREATE INDEX recording_retention_due ON recording_retention(state, deadline_ms);

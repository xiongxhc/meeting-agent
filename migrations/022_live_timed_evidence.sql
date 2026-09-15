-- Private live evidence, never final speaker identity or a wall-clock timeline.
-- RESTRICT deliberately prevents a retention cascade over a large UI history.
CREATE TABLE timed_evidence_owners (
  generation_id TEXT PRIMARY KEY NOT NULL REFERENCES reconciliation_generations(generation_id) ON DELETE RESTRICT,
  owner_token TEXT NOT NULL CHECK(length(owner_token) = 36),
  state TEXT NOT NULL CHECK(state IN ('active', 'recovering', 'closed')),
  ui_rows INTEGER NOT NULL DEFAULT 0 CHECK(ui_rows BETWEEN 0 AND 65536),
  ui_bytes INTEGER NOT NULL DEFAULT 0 CHECK(ui_bytes BETWEEN 0 AND 268435456),
  live_rows INTEGER NOT NULL DEFAULT 0 CHECK(live_rows BETWEEN 0 AND 256),
  ui_loss_reason TEXT CHECK(ui_loss_reason IS NULL OR ui_loss_reason IN ('ui_limit_exceeded', 'ui_invalid', 'ui_sequence_gap')),
  wording_loss_reason TEXT CHECK(wording_loss_reason IS NULL OR wording_loss_reason IN ('text_limit_exceeded', 'live_limit_exceeded', 'runtime_queue_overflow'))
) STRICT;
CREATE TABLE timed_ui_evidence (
  generation_id TEXT NOT NULL REFERENCES timed_evidence_owners(generation_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991),
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 4096),
  PRIMARY KEY(generation_id, sequence)
) STRICT;
CREATE TABLE timed_live_evidence (
  generation_id TEXT NOT NULL REFERENCES timed_evidence_owners(generation_id) ON DELETE RESTRICT,
  segment_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) BETWEEN 1 AND 16384),
  evidence TEXT NOT NULL CHECK(length(CAST(evidence AS BLOB)) BETWEEN 1 AND 4096),
  result TEXT CHECK(result IS NULL OR length(CAST(result AS BLOB)) BETWEEN 1 AND 4096),
  PRIMARY KEY(generation_id, segment_id)
) STRICT;
CREATE INDEX timed_pending ON timed_live_evidence(generation_id, segment_id) WHERE result IS NULL;
CREATE INDEX reconciliation_expiry ON reconciliation_generations(expires_at_ms, generation_id) WHERE terminal_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL;
CREATE TRIGGER timed_ui_insert AFTER INSERT ON timed_ui_evidence BEGIN
  UPDATE timed_evidence_owners SET ui_rows = ui_rows + 1, ui_bytes = ui_bytes + length(CAST(NEW.payload AS BLOB)) WHERE generation_id = NEW.generation_id;
END;
CREATE TRIGGER timed_ui_delete AFTER DELETE ON timed_ui_evidence BEGIN
  UPDATE timed_evidence_owners SET ui_rows = ui_rows - 1, ui_bytes = ui_bytes - length(CAST(OLD.payload AS BLOB)) WHERE generation_id = OLD.generation_id;
END;
CREATE TRIGGER timed_live_insert AFTER INSERT ON timed_live_evidence BEGIN
  UPDATE timed_evidence_owners SET live_rows = live_rows + 1 WHERE generation_id = NEW.generation_id;
END;
CREATE TRIGGER timed_live_delete AFTER DELETE ON timed_live_evidence BEGIN
  UPDATE timed_evidence_owners SET live_rows = live_rows - 1 WHERE generation_id = OLD.generation_id;
END;
CREATE TRIGGER timed_ui_immutable BEFORE UPDATE ON timed_ui_evidence BEGIN SELECT RAISE(ABORT, 'timed UI evidence is immutable'); END;
CREATE TRIGGER timed_live_immutable BEFORE UPDATE ON timed_live_evidence
WHEN NEW.generation_id != OLD.generation_id OR NEW.segment_id != OLD.segment_id OR NEW.text != OLD.text OR NEW.evidence != OLD.evidence OR OLD.result IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'timed live evidence is immutable'); END;

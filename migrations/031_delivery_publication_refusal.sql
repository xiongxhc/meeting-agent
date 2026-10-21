-- TeamMem refuses a revision for good when no re-render of it can ever pass,
-- and says so in `<segment>/<revision>.refused.json` with a reason code. The
-- delivery row keeps that code: the revision stops polling on its retry
-- backoff and the operator is alerted once. Retention is unchanged, and a
-- higher revision of the same occurrence still publishes.
ALTER TABLE delivery_journal ADD COLUMN refusal_reason TEXT
  CHECK (refusal_reason IS NULL OR (length(refusal_reason) BETWEEN 1 AND 64
    AND refusal_reason GLOB '[a-z]*' AND refusal_reason NOT GLOB '*[^a-z0-9_]*'));

-- A refusal is recorded only for a revision still waiting on TeamMem, and once
-- recorded it is never cleared or replaced.
CREATE TRIGGER delivery_journal_refusal_monotonic
BEFORE UPDATE OF refusal_reason ON delivery_journal
WHEN OLD.refusal_reason IS NOT NULL AND NEW.refusal_reason IS NOT OLD.refusal_reason
BEGIN SELECT RAISE(ABORT, 'delivery refusal reason is immutable'); END;

CREATE TRIGGER delivery_journal_refusal_pending_only
BEFORE UPDATE OF refusal_reason ON delivery_journal
WHEN OLD.refusal_reason IS NULL AND NEW.refusal_reason IS NOT NULL
  AND (OLD.published_at_ms IS NOT NULL OR OLD.deleted_at_ms IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'delivery refusal requires an unpublished pending revision'); END;

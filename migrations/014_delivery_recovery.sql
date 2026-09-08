-- Delivery recovery is retained only until the same evidence is deleted.  The
-- exact canonical artifact lets a restarted worker recreate a never-visible
-- or incomplete local handoff without inventing a second transcript store.
ALTER TABLE delivery_journal ADD COLUMN recovery_artifact TEXT;
ALTER TABLE delivery_journal ADD COLUMN stage_token TEXT;

-- A physical encrypted file has one occurrence owner.  Multiple revisions of
-- that occurrence may reference it; another occurrence cannot delete it.
CREATE TABLE delivery_recording_owners (
  recording_path TEXT NOT NULL PRIMARY KEY,
  occurrence_id TEXT NOT NULL REFERENCES recordings(occurrence_id) ON DELETE CASCADE
) STRICT;

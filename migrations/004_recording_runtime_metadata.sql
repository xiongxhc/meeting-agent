-- Runtime-issued encrypted recording metadata. The locator is a durable
-- reference only: Meeting Agent stores neither audio bytes nor key material.
-- Existing recordings predate these runtime fields. NULL truthfully means
-- unavailable legacy metadata; a fabricated token would look valid to later
-- recovery/export code. New finalizations always supply all three values.
ALTER TABLE recordings ADD COLUMN encrypted_path TEXT;
ALTER TABLE recordings ADD COLUMN format TEXT;
ALTER TABLE recordings ADD COLUMN key_id TEXT;

-- Runtime-issued encrypted recording metadata. The locator is a durable
-- reference only: Meeting Agent stores neither audio bytes nor key material.
ALTER TABLE recordings ADD COLUMN encrypted_path TEXT NOT NULL DEFAULT 'legacy-unavailable';
ALTER TABLE recordings ADD COLUMN format TEXT NOT NULL DEFAULT 'legacy-unavailable';
ALTER TABLE recordings ADD COLUMN key_id TEXT NOT NULL DEFAULT 'legacy-unavailable';

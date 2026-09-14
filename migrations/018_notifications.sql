CREATE TABLE notification_intents (
  occurrence_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  artifact_hash TEXT NOT NULL,
  publication_url TEXT NOT NULL,
  vault_commit TEXT NOT NULL,
  recipient_id TEXT,
  title TEXT,
  message_text TEXT,
  request_uuid TEXT,
  state TEXT NOT NULL,
  terminal_reason TEXT,
  first_attempt_at_ms INTEGER,
  last_attempt_at_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER NOT NULL,
  claim_token TEXT,
  claim_expires_at_ms INTEGER,
  delivery_ambiguous INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  sent_at_ms INTEGER,
  PRIMARY KEY (occurrence_id, revision),
  FOREIGN KEY (occurrence_id, revision) REFERENCES delivery_journal(occurrence_id, revision) ON DELETE CASCADE,
  CHECK (revision BETWEEN 1 AND 1000000),
  CHECK (artifact_hash GLOB 'sha256:[0-9a-f]*' AND length(artifact_hash) = 71),
  CHECK (length(vault_commit) = 40 AND vault_commit NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(CAST(publication_url AS BLOB)) BETWEEN 1 AND 8192),
  CHECK (recipient_id IS NULL OR length(CAST(recipient_id AS BLOB)) BETWEEN 1 AND 400),
  CHECK (title IS NULL OR length(CAST(title AS BLOB)) BETWEEN 1 AND 800),
  CHECK (message_text IS NULL OR length(CAST(message_text AS BLOB)) BETWEEN 1 AND 16384),
  CHECK (request_uuid IS NULL OR (length(request_uuid) = 36 AND request_uuid NOT GLOB '*[^0-9a-f-]*' AND request_uuid GLOB '????????-????-????-????-????????????')),
  CHECK (claim_token IS NULL OR (length(claim_token) = 32 AND claim_token NOT GLOB '*[^0-9a-f]*')),
  CHECK (provider_message_id IS NULL OR length(CAST(provider_message_id AS BLOB)) BETWEEN 1 AND 1024),
  CHECK (state IN ('pending', 'claimed', 'sent', 'terminal')),
  CHECK (terminal_reason IS NULL OR terminal_reason IN ('organizer_unresolved', 'notification_inputs_unavailable', 'notification_delivery_uncertain', 'notification_retry_exhausted')),
  CHECK (attempt_count >= 0),
  CHECK (next_attempt_at_ms >= 0),
  CHECK (first_attempt_at_ms IS NULL OR first_attempt_at_ms >= 0),
  CHECK (last_attempt_at_ms IS NULL OR last_attempt_at_ms >= first_attempt_at_ms),
  CHECK (claim_expires_at_ms IS NULL OR claim_expires_at_ms >= last_attempt_at_ms),
  CHECK (sent_at_ms IS NULL OR sent_at_ms >= first_attempt_at_ms),
  CHECK ((attempt_count = 0 AND first_attempt_at_ms IS NULL AND last_attempt_at_ms IS NULL) OR
         (attempt_count > 0 AND first_attempt_at_ms IS NOT NULL AND last_attempt_at_ms IS NOT NULL)),
  CHECK (delivery_ambiguous IN (0, 1)),
  CHECK ((recipient_id IS NOT NULL AND title IS NOT NULL AND message_text IS NOT NULL AND request_uuid IS NOT NULL) OR
         (state = 'terminal' AND terminal_reason IN ('organizer_unresolved', 'notification_inputs_unavailable'))),
  CHECK ((state = 'claimed' AND claim_token IS NOT NULL AND claim_expires_at_ms IS NOT NULL) OR
         (state != 'claimed' AND claim_token IS NULL AND claim_expires_at_ms IS NULL)),
  CHECK ((state = 'sent' AND provider_message_id IS NOT NULL AND sent_at_ms IS NOT NULL AND terminal_reason IS NULL) OR
         (state != 'sent' AND provider_message_id IS NULL AND sent_at_ms IS NULL)),
  CHECK ((state = 'terminal' AND terminal_reason IS NOT NULL) OR (state != 'terminal' AND terminal_reason IS NULL))
) STRICT;

CREATE INDEX notification_intents_due_idx
  ON notification_intents(state, next_attempt_at_ms, occurrence_id, revision);

-- Only publications whose canonical artifact bytes were already erased are
-- irrecoverable. Retained bytes are validated and upgraded by the outbox
-- before its cleanup path is allowed to run.
INSERT INTO notification_intents
  (occurrence_id, revision, artifact_hash, publication_url, vault_commit,
   recipient_id, title, message_text, request_uuid, state, terminal_reason,
   next_attempt_at_ms)
SELECT occurrence_id, revision, artifact_hash, publication_url, vault_commit,
       NULL, NULL, NULL, NULL, 'terminal', 'notification_inputs_unavailable',
       published_at_ms
  FROM delivery_journal
 WHERE published_at_ms IS NOT NULL AND recovery_artifact IS NULL;

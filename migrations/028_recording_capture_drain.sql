-- D029: persist the bridge-observed capture-drain outcome per recording.
--
-- The producer's claim that the encrypted recorder drained every ordered
-- record through its declared boundary exists only at the moment the bridge
-- publishes `media_disconnected`, and only for a media-v3 lease. Meeting
-- stores it as evidence beside the recording it describes; it is never a gate
-- on finalization, which proceeds on the SDK's own stop acknowledgement
-- whatever the drain said.
--
-- NULL means "not applicable / pre-028": a media-v2 lease made no claim, or
-- the row predates this migration. It is never reinterpreted as either
-- outcome, and no local fact -- a completed write, a confirmed native
-- cleanup, a closed connection, an intact PCM stream -- may upgrade it.
--
-- SQLite ALTER cannot add a table-level CHECK, so the column CHECKs bound each
-- domain here and the store enforces the correlations in the same transaction
-- as the recording row: the reason is non-null exactly when the outcome is
-- 'unconfirmed', and the four boundary integers are non-null exactly when it
-- is 'confirmed'.
--
-- The boundary integers are TEXT in the canonical decimal spelling, the same
-- convention recording_recovery_bindings.source_session_id uses: a capture
-- epoch or an output sample can exceed 2^53, which SQLite's INTEGER would
-- still hold but every JSON reader between here and the bridge would not.
-- An absent final capture frame is spelled '0' in both frame members, exactly
-- the zero-frame body the media-v3 codec puts on the wire; a real frame
-- sequence is never 0.
ALTER TABLE recordings ADD COLUMN capture_drain TEXT
  CHECK (capture_drain IS NULL OR capture_drain IN ('confirmed', 'unconfirmed'));
ALTER TABLE recordings ADD COLUMN capture_drain_reason TEXT
  CHECK (capture_drain_reason IS NULL OR length(capture_drain_reason) BETWEEN 1 AND 200);
ALTER TABLE recordings ADD COLUMN capture_drain_epoch TEXT
  CHECK (capture_drain_epoch IS NULL OR (length(capture_drain_epoch) BETWEEN 1 AND 20
    AND capture_drain_epoch NOT GLOB '*[^0-9]*' AND capture_drain_epoch != '0'
    AND (length(capture_drain_epoch) = 1 OR substr(capture_drain_epoch, 1, 1) != '0')));
ALTER TABLE recordings ADD COLUMN capture_drain_last_frame_sequence TEXT
  CHECK (capture_drain_last_frame_sequence IS NULL OR (length(capture_drain_last_frame_sequence) BETWEEN 1 AND 20
    AND capture_drain_last_frame_sequence NOT GLOB '*[^0-9]*'
    AND (length(capture_drain_last_frame_sequence) = 1 OR substr(capture_drain_last_frame_sequence, 1, 1) != '0')));
ALTER TABLE recordings ADD COLUMN capture_drain_output_end_sample TEXT
  CHECK (capture_drain_output_end_sample IS NULL OR (length(capture_drain_output_end_sample) BETWEEN 1 AND 20
    AND capture_drain_output_end_sample NOT GLOB '*[^0-9]*'
    AND (length(capture_drain_output_end_sample) = 1 OR substr(capture_drain_output_end_sample, 1, 1) != '0')));
ALTER TABLE recordings ADD COLUMN capture_drain_final_pair_sequence TEXT
  CHECK (capture_drain_final_pair_sequence IS NULL OR (length(capture_drain_final_pair_sequence) BETWEEN 1 AND 20
    AND capture_drain_final_pair_sequence NOT GLOB '*[^0-9]*' AND capture_drain_final_pair_sequence != '0'
    AND (length(capture_drain_final_pair_sequence) = 1 OR substr(capture_drain_final_pair_sequence, 1, 1) != '0')));

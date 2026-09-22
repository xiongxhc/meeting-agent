-- D027: persist the bridge's terminal reason on the reconciliation generation.
--
-- The session terminates EVERY bridge `left` as a bridge_observed terminal,
-- whatever its reason, so `terminal_source` alone cannot say whether the
-- meeting positively ended. Custody classification keys on this reason:
-- only 'ended' is an authoritative known end.
--
-- SQLite ALTER cannot add a table-level CHECK, so the column CHECK bounds the
-- domain here and the store enforces "non-null iff terminal_source =
-- 'bridge_observed'" for completions written after this migration. Existing
-- rows keep NULL: a pre-027 bridge_observed terminal with a NULL reason stays
-- fail-closed (refused as a possible known end), never reinterpreted.
ALTER TABLE reconciliation_generations ADD COLUMN terminal_reason TEXT
  CHECK (terminal_reason IS NULL OR terminal_reason IN ('ended', 'removed', 'bridge_failure'));

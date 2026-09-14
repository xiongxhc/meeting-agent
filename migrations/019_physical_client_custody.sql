CREATE TABLE physical_client_custody (
  physical_client_id TEXT NOT NULL CHECK(length(physical_client_id) BETWEEN 1 AND 128),
  physical_generation_id TEXT NOT NULL CHECK(length(physical_generation_id) = 32),
  occurrence_id TEXT NOT NULL CHECK(length(CAST(occurrence_id AS BLOB)) BETWEEN 1 AND 4096),
  bridge_session_id TEXT NOT NULL CHECK(length(CAST(bridge_session_id AS BLOB)) BETWEEN 1 AND 4096),
  state TEXT NOT NULL CHECK(state IN ('quarantined', 'cleared')),
  claimed_at_ms INTEGER NOT NULL CHECK(claimed_at_ms >= 0),
  outcome_json TEXT CHECK(length(CAST(outcome_json AS BLOB)) <= 4096),
  outcome_failure TEXT CHECK(outcome_failure IN ('launch_failed','protocol_failed','outcome_missing','child_failed','reap_failed','cleanup_failed')),
  exit_diagnostic TEXT CHECK(exit_diagnostic IN ('nonzero_exit')),
  outcome_recorded_at_ms INTEGER,
  cleared_at_ms INTEGER,
  clear_reason TEXT CHECK(clear_reason IN ('departure_observed','join_not_issued','operator_inspected_idle')),
  clear_operator TEXT CHECK(length(CAST(clear_operator AS BLOB)) BETWEEN 1 AND 128),
  PRIMARY KEY(physical_client_id, physical_generation_id),
  CHECK((state = 'quarantined' AND cleared_at_ms IS NULL) OR (state = 'cleared' AND cleared_at_ms IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX physical_client_unresolved ON physical_client_custody(physical_client_id) WHERE state = 'quarantined';

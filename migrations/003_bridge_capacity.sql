-- A physical bridge is a one-meeting resource. The per-occurrence index in
-- 001 prevents duplicate leases for one occurrence; this index prevents two
-- different occurrences from simultaneously commanding the same bridge.
CREATE UNIQUE INDEX idx_bridge_leases_active_per_bridge
  ON bridge_leases (bridge_id)
  WHERE released_at_ms IS NULL;

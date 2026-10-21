// PRIVATE join-latency observation. Only a test entry can pass an observer
// (composition option); production composition never does, so every call
// below is a single undefined check. The observer receives a fixed phase
// token only: no ids, paths, leases or payloads. It is called synchronously,
// is never awaited, and anything it throws is swallowed, so it cannot change
// the join's control flow. `vault_index_built` is emitted when the
// asynchronous Team Vault build settles, which may be after the join is sent;
// every other phase is emitted in the order listed.
export const JOIN_TIMING_PHASES = [
  "runtime_connected",
  "create_session_entered",
  "custody_claimed",
  "bridge_launch_started",
  "bridge_launch_returned",
  "session_construct_started",
  "vault_index_started",
  "vault_index_built",
  "session_constructed",
  "session_created",
  "join_called",
  "join_entered",
  "lease_acquired",
  "reconciliation_started",
  "timed_control_ready",
  "subscriptions_ready",
  "join_send_started",
  "join_send_resolved",
  "runtime_admission_started",
  "runtime_admission_resolved",
  "connect_media_send_started",
  "join_settled",
] as const;

export type JoinTimingPhase = (typeof JOIN_TIMING_PHASES)[number];
export type JoinTimingObserver = (phase: JoinTimingPhase) => void;

export function markJoinTiming(observer: JoinTimingObserver | undefined, phase: JoinTimingPhase): void {
  if (observer === undefined) return;
  try { observer(phase); } catch { /* Observation never alters the join. */ }
}

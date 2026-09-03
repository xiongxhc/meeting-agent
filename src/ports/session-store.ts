// Orchestration session store: a PORT. Defines the state values, row shapes,
// and error surface that src/sessions/coordinator.ts (the application layer)
// depends on, and that src/adapters/sqlite-session-store.ts (the ONLY
// production file allowed to import better-sqlite3) implements.
//
// This split exists for more than layering taste: the dependency-boundary
// test (test/boundaries.test.ts) flags any import specifier matching
// /sqlite/i outside the sanctioned adapter file -- including a path like
// "../adapters/sqlite-session-store.ts" itself. If the coordinator imported
// its types directly from the adapter by that path, the gate the plan
// deliberately kept alive for this task would trip on the coordinator's own
// legitimate type imports. Depending on this port instead (no "sqlite" in
// its name or path) keeps the coordinator's dependency on ORCHESTRATION
// STATE explicit while staying structurally clear of the SQLite gate. No
// SQLite driver, and no other database concern, lives here.

/** The orchestration state machine's states. The transition GRAPH (which
 * edges are legal) is owned by src/sessions/coordinator.ts -- this port only
 * declares the physical set of values a `state` column may hold. */
export type SessionState =
  | "discovered"
  | "joining"
  | "listening"
  | "finalizing"
  | "awaiting_teammem"
  | "published"
  | "notified"
  | "failed";

export const SESSION_STATE_VALUES: readonly SessionState[] = [
  "discovered",
  "joining",
  "listening",
  "finalizing",
  "awaiting_teammem",
  "published",
  "notified",
  "failed",
];

/** Why a bridge lease was released. `stale_recovered` is set only by
 * acquireLease's own stale-recovery path, never by an explicit release
 * call -- bridge-session/v1 has no re-open, so the only ways a live lease
 * ends are an observed `left` (including a synthesized `left(reason:
 * "bridge_failure")`) or another bridge recovering it after its lease
 * expired unreleased. */
export type LeaseReleaseReason = "left" | "bridge_failure" | "stale_recovered";

export type SessionRow = {
  readonly occurrenceId: string;
  readonly occurrenceSegment: string;
  readonly providerMeetingId: string;
  readonly occurrenceStartedAt: string;
  readonly state: SessionState;
  readonly terminalReason: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
};

export type TransitionRow = {
  readonly id: number;
  readonly occurrenceId: string;
  readonly fromState: SessionState | null;
  readonly toState: SessionState;
  readonly reason: string | null;
  readonly terminalReason: string | null;
  readonly occurredAtMs: number;
};

export type LeaseRow = {
  readonly leaseId: string;
  readonly occurrenceId: string;
  readonly bridgeId: string;
  readonly bridgeSessionId: string;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
  readonly releasedAtMs: number | null;
  readonly releaseReason: LeaseReleaseReason | null;
};

export type MigrationRow = {
  readonly version: number;
  readonly name: string;
  readonly appliedAtMs: number;
};

export type ColumnDescription = { readonly name: string; readonly type: string };
export type TableSchema = {
  readonly name: string;
  readonly sql: string;
  readonly columns: readonly ColumnDescription[];
};

export type OrchestrationErrorCode =
  | "duplicate_session"
  | "unknown_session"
  | "state_conflict"
  | "constraint_violation"
  | "unknown_lease"
  | "lease_held"
  | "illegal_transition"
  | "invalid_configuration";

/** Every failure the session store and the coordinator can raise. Never
 * carries transcript text or audio bytes -- only occurrence/lease
 * identifiers and short reason tokens. */
export class OrchestrationError extends Error {
  readonly code: OrchestrationErrorCode;

  constructor(code: OrchestrationErrorCode, message: string) {
    super(message);
    this.name = "OrchestrationError";
    this.code = code;
  }
}

/** occurrenceSegment is deliberately NOT a field here: the adapter derives it
 * from occurrenceId itself (via occurrencePathSegment), so there is no way
 * for a caller to persist a segment that doesn't correspond to its
 * occurrence id -- removing the mismatch is strictly better than adding a
 * test that catches it after the fact. */
export type CreateSessionInput = {
  readonly occurrenceId: string;
  readonly providerMeetingId: string;
  readonly occurrenceStartedAt: string;
  readonly nowMs: number;
};

export type TransitionInput = {
  readonly occurrenceId: string;
  /** The state the caller believes the session is currently in. The update
   * is a compare-and-swap against this value: if the persisted state
   * differs, the write is refused with `state_conflict` rather than
   * silently overwriting a state the caller never actually observed. */
  readonly fromState: SessionState;
  readonly toState: SessionState;
  readonly reason: string | null;
  readonly terminalReason: string | null;
  readonly nowMs: number;
};

export type AcquireLeaseInput = {
  readonly occurrenceId: string;
  readonly bridgeId: string;
  readonly bridgeSessionId: string;
  readonly nowMs: number;
  readonly ttlMs: number;
};

/**
 * The durable orchestration store. Every method takes an explicit `nowMs`
 * (or derives its timing from one already recorded) rather than reading a
 * clock itself, so every timing decision in the system stays testable with
 * an injected clock.
 */
export type SessionStore = {
  readonly schemaVersion: number;
  appliedMigrations(): MigrationRow[];
  foreignKeysEnabled(): boolean;
  /** `PRAGMA foreign_key_check` results. Empty means no violations. */
  foreignKeyCheck(): ReadonlyArray<Record<string, unknown>>;
  describeSchema(): TableSchema[];

  createSession(input: CreateSessionInput): SessionRow;
  getSession(occurrenceId: string): SessionRow | null;
  transition(input: TransitionInput): SessionRow;
  listTransitions(occurrenceId: string): TransitionRow[];

  acquireLease(input: AcquireLeaseInput): LeaseRow;
  releaseLease(
    occurrenceId: string,
    leaseId: string,
    reason: Exclude<LeaseReleaseReason, "stale_recovered">,
    nowMs: number,
  ): LeaseRow;
  getActiveLease(occurrenceId: string): LeaseRow | null;
  listLeases(occurrenceId: string): LeaseRow[];

  close(): void;
};

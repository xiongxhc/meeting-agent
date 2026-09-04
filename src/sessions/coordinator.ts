// The session coordinator: owns the orchestration state machine (the legal
// transition GRAPH -- src/adapters/sqlite-session-store.ts only knows the
// physical set of state values) and the bridge-lease and concurrency
// policies layered on top of the durable store.
//
// bridge-session/v1 has no re-open: a `left` event (including a synthesized
// `left(reason: "bridge_failure")`) is terminal for that bridge session, so
// session recovery is this module's concern, not the bridge's. Resuming a
// meeting after a lease ends means acquiring a NEW lease against a NEW
// bridge_session_id -- never reusing or "un-leaving" the old one.
//
// Every timing decision here takes its instant from an injected Clock, never
// from Date.now() directly, so lease-expiry and restart behavior stay
// deterministic under test.

import type { MeetingIdentity } from "../domain/meeting.ts";
import {
  OrchestrationError,
  SESSION_STATE_VALUES,
  type RecordingInput,
  type RecordingRow,
  type ReconciliationBridgeEventRow,
  type ReconciliationEvidenceRow,
  type ReconciliationLiveSegmentRow,
  type BridgeRecoveryResult,
  type BridgeFailureRecordingRow,
  type TransitionInput,
  type LeaseRow,
  type LeaseReleaseReason,
  type SessionRow,
  type SessionState,
  type SessionStore,
  type TransitionRow,
} from "../ports/session-store.ts";

// Depends on the PORT, not the adapter: src/adapters/sqlite-session-store.ts
// is the ONLY file allowed to import better-sqlite3 (and, structurally, the
// only file whose path may even contain the word "sqlite" -- see that
// port's header comment). The coordinator only ever sees SessionStore as an
// interface, wired up by whoever constructs a coordinator.
export { OrchestrationError } from "../ports/session-store.ts";
export type {
  LeaseRow,
  LeaseReleaseReason,
  OrchestrationErrorCode,
  RecordingGapRow,
  RecordingInput,
  RecordingRow,
  BridgeRecoveryResult,
  BridgeFailureRecordingRow,
  SessionRow,
  SessionState,
  SessionStore,
  TransitionRow,
} from "../ports/session-store.ts";

/** Injected wall-clock source. Production wires `{ now: () => Date.now() }`;
 * tests inject a fake so lease expiry and restart timing are deterministic
 * rather than depending on real elapsed time. */
export type Clock = {
  now(): number;
};

export const SESSION_STATES: readonly SessionState[] = SESSION_STATE_VALUES;

/** States that accept no further transition at all. bridge-session/v1's
 * "no re-open" rule means "notified" and "failed" are both dead ends here:
 * resuming after either means a brand new occurrence/session. */
export const TERMINAL_STATES: readonly SessionState[] = ["notified", "failed"];

/** The forward path, in order, excluding the initial "discovered" state.
 * Used by advance() callers to walk a session from discovery to notified. */
export const HAPPY_PATH_STATES: readonly SessionState[] = [
  "joining",
  "listening",
  "finalizing",
  "awaiting_teammem",
  "published",
  "notified",
];

/** The legal transition graph. "failed" is reachable from every non-terminal
 * state (via fail(), never via advance() -- see below) and is itself
 * terminal, like "notified". */
export const ALLOWED_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  discovered: ["joining", "failed"],
  joining: ["listening", "failed"],
  listening: ["finalizing", "failed"],
  finalizing: ["awaiting_teammem", "failed"],
  awaiting_teammem: ["published", "failed"],
  published: ["notified", "failed"],
  notified: [],
  failed: [],
};

const ADVANCE_REASON = "advance";
const FAIL_REASON = "fail";

export type CreateCoordinatorOptions = {
  readonly store: SessionStore;
  readonly clock: Clock;
  /** How long an acquired bridge lease stays valid before another bridge may
   * recover it as stale. */
  readonly bridgeLeaseTtlMs: number;
  /** The concurrency semaphore. `1` is a valid, deliberate deployment
   * setting (e.g. a single Mac bridge); it is not a hard-coded
   * architectural maximum -- pass whatever the deployed bridge/CPU/GPU/
   * network/provider capacity supports. */
  readonly maxConcurrentSessions: number;
};

/** Which terminal edge a session-ending caller wants applied. A discriminated
 * union rather than two methods, because it is passed straight through to
 * finalizeWithRecording, where the recording write and the transition have to
 * be one call to be one transaction. */
export type TerminalOutcome =
  | { readonly kind: "advance"; readonly toState: SessionState }
  | { readonly kind: "fail"; readonly terminalReason: string };

export type BridgeLeaseRequest = {
  readonly bridgeId: string;
  readonly bridgeSessionId: string;
};

/** A live (unreleased) lease row, plus whether it is CURRENTLY past its
 * bounded timeout, computed from the coordinator's own injected clock. The
 * stored row has no such column (expiry is a live judgement, not persisted
 * state) -- exposing only `expiresAtMs` and leaving the caller to remember
 * to compare it against "now" produced two different truths about liveness
 * from one API: acquireBridgeLease() already treats an unreleased-but-past-
 * TTL lease as recoverable, while activeBridgeLease() reported it as
 * unqualified "active", which a caller answering "is a bridge attached?"
 * would misread as true for a dead bridge. */
export type ActiveBridgeLease = LeaseRow & { readonly isExpired: boolean };

export type SessionCoordinator = {
  readonly maxConcurrentSessions: number;

  /** Creates the session row for a newly discovered occurrence, in state
   * "discovered". Throws `duplicate_session` if this occurrence already has
   * a session -- discovery never silently re-creates or resets one. */
  discover(identity: MeetingIdentity): SessionRow;
  get(occurrenceId: string): SessionRow | null;

  /** Moves the session forward one edge of the happy path. Rejects
   * (`illegal_transition`) any edge not declared in ALLOWED_TRANSITIONS for
   * the session's CURRENT persisted state -- including a restart-resumed
   * process attempting to replay a transition already applied. Never
   * accepts "failed" as a target; use fail() instead, which alone carries a
   * terminal reason. */
  advance(occurrenceId: string, toState: SessionState): SessionRow;

  /** Moves the session to "failed" from any non-terminal state, recording
   * `terminalReason` (a short lowercase_snake token; the store's CHECK
   * constraints reject anything else). */
  fail(occurrenceId: string, terminalReason: string): SessionRow;

  /** Applies a terminal transition AND persists the finalized recording in ONE
   * store transaction. The edge is validated exactly as advance()/fail()
   * validate theirs.
   *
   * This exists as one call rather than two because the recording handle is
   * the only reference to the encrypted audio and cannot be re-derived after a
   * crash: a transition that committed without its recording would leave audio
   * nothing points at, and a recording without its transition would claim a
   * session finalized when it had not. */
  finalizeWithRecording(
    occurrenceId: string,
    outcome: TerminalOutcome,
    recording: RecordingInput,
    reconciliationBridgeSessionId?: string,
    reconciliationTerminalAtMs?: number,
    reconciliationTerminalSource?: "bridge_observed" | "local_clock",
  ): SessionRow;

  /** The persisted recording for an occurrence, or null if it never finalized
   * (or finalization failed). */
  recording(occurrenceId: string): RecordingRow | null;
  beginReconciliationGeneration(occurrenceId: string, bridgeSessionId: string): void;
  setReconciliationRuntimeSession(occurrenceId: string, bridgeSessionId: string, runtimeSessionId: bigint): void;
  completeReconciliationGeneration(occurrenceId: string, bridgeSessionId: string, terminalAtMs?: number, terminalSource?: "bridge_observed" | "local_clock"): void;
  appendReconciliationBridgeEvent(occurrenceId: string, event: ReconciliationBridgeEventRow): void;
  appendReconciliationLiveSegment(occurrenceId: string, segment: ReconciliationLiveSegmentRow): void;
  reconciliationEvidence(occurrenceId: string, recordingHandle: string | null): ReconciliationEvidenceRow | null;
  purgeExpiredReconciliationEvidence(): number;
  recordBridgeFailure(
    occurrenceId: string,
    maxRetries: number,
    gaps: RecordingInput["gaps"],
    recording: RecordingInput | null,
  ): BridgeRecoveryResult;
  bridgeFailureRecording(occurrenceId: string, attempt: number): BridgeFailureRecordingRow | null;

  /** The full, append-only audit trail in order, including the synthetic
   * creation transition (`fromState: null`). */
  history(occurrenceId: string): TransitionRow[];

  /** Acquires the occurrence's bridge lease. Throws `lease_held` if a live,
   * unexpired lease already exists; automatically recovers (releases with
   * reason "stale_recovered") a lease that is still unreleased but past its
   * bounded timeout, then issues a fresh one. */
  acquireBridgeLease(occurrenceId: string, request: BridgeLeaseRequest): LeaseRow;

  /** Explicitly ends a live lease -- "left" for an observed bridge-session/v1
   * `left` event, "bridge_failure" for a synthesized one. Resuming
   * afterwards takes a NEW lease; this never reopens the released one. */
  releaseBridgeLease(
    occurrenceId: string,
    leaseId: string,
    reason: Exclude<LeaseReleaseReason, "stale_recovered">,
  ): LeaseRow;

  /** The occurrence's current live (unreleased) lease, if any, WITH an
   * `isExpired` flag computed against the coordinator's own clock right now.
   * A lease is only actually recovered (released and replaced) by a
   * subsequent acquireBridgeLease call, never swept in the background --
   * `isExpired: true` here means "nobody has recovered it yet", not "it was
   * released". Callers that need to know "is a bridge genuinely attached
   * right now" must check `isExpired`, not merely non-null. */
  activeBridgeLease(occurrenceId: string): ActiveBridgeLease | null;

  /** Runs `fn` while holding one of `maxConcurrentSessions` global slots,
   * queueing FIFO when none are free. The slot is released whether `fn`
   * resolves or rejects. Throws `unknown_session` up front if no session
   * exists for `occurrenceId` -- no slot is consumed in that case. */
  withSession<T>(occurrenceId: string, fn: () => Promise<T>): Promise<T>;

  /** The number of `withSession` calls currently holding a slot. */
  activeSessionCount(): number;
};

export function createCoordinator(options: CreateCoordinatorOptions): SessionCoordinator {
  if (!Number.isInteger(options.maxConcurrentSessions) || options.maxConcurrentSessions < 1) {
    throw new OrchestrationError(
      "invalid_configuration",
      `maxConcurrentSessions must be a positive integer, got ${options.maxConcurrentSessions}`,
    );
  }
  if (!Number.isFinite(options.bridgeLeaseTtlMs) || options.bridgeLeaseTtlMs <= 0) {
    throw new OrchestrationError(
      "invalid_configuration",
      `bridgeLeaseTtlMs must be a positive number, got ${options.bridgeLeaseTtlMs}`,
    );
  }

  const { store, clock, bridgeLeaseTtlMs, maxConcurrentSessions } = options;
  const semaphore = createSemaphore(maxConcurrentSessions);

  /** Validates one terminal/forward edge against ALLOWED_TRANSITIONS for the
   * session's CURRENT persisted state and builds the store input for it. The
   * single place the transition graph is enforced, so advance(), fail() and
   * finalizeWithRecording() cannot drift apart on which edges are legal. */
  function transitionFor(occurrenceId: string, outcome: TerminalOutcome): TransitionInput {
    const current = requireSession(occurrenceId);
    if (outcome.kind === "fail") {
      if (!ALLOWED_TRANSITIONS[current.state].includes("failed")) {
        throw new OrchestrationError(
          "illegal_transition",
          `occurrence "${occurrenceId}" cannot fail from terminal state "${current.state}"`,
        );
      }
      return {
        occurrenceId,
        fromState: current.state,
        toState: "failed",
        reason: FAIL_REASON,
        terminalReason: outcome.terminalReason,
        nowMs: clock.now(),
      };
    }
    if (outcome.toState === "failed") {
      throw new OrchestrationError(
        "illegal_transition",
        `advance() never targets "failed"; call fail() with a terminal reason instead`,
      );
    }
    if (!ALLOWED_TRANSITIONS[current.state].includes(outcome.toState)) {
      throw new OrchestrationError(
        "illegal_transition",
        `"${current.state}" -> "${outcome.toState}" is not a legal transition for occurrence "${occurrenceId}"`,
      );
    }
    return {
      occurrenceId,
      fromState: current.state,
      toState: outcome.toState,
      reason: ADVANCE_REASON,
      terminalReason: null,
      nowMs: clock.now(),
    };
  }

  function requireSession(occurrenceId: string): SessionRow {
    const row = store.getSession(occurrenceId);
    if (row === null) {
      throw new OrchestrationError("unknown_session", `no session exists for occurrence "${occurrenceId}"`);
    }
    return row;
  }

  return {
    maxConcurrentSessions,

    discover(identity: MeetingIdentity): SessionRow {
      // occurrenceSegment is not passed here: the store derives it from
      // occurrenceId itself, so segment and occurrence id can never
      // disagree (see CreateSessionInput's doc comment in the port).
      return store.createSession({
        occurrenceId: identity.occurrenceId,
        providerMeetingId: identity.providerMeetingId,
        occurrenceStartedAt: identity.occurrenceStartedAt,
        nowMs: clock.now(),
      });
    },

    get(occurrenceId: string): SessionRow | null {
      return store.getSession(occurrenceId);
    },

    advance(occurrenceId: string, toState: SessionState): SessionRow {
      return store.transition(transitionFor(occurrenceId, { kind: "advance", toState }));
    },

    fail(occurrenceId: string, terminalReason: string): SessionRow {
      return store.transition(transitionFor(occurrenceId, { kind: "fail", terminalReason }));
    },

    finalizeWithRecording(
    occurrenceId: string,
    outcome: TerminalOutcome,
    recording: RecordingInput,
    reconciliationBridgeSessionId?: string,
    reconciliationTerminalAtMs?: number,
    reconciliationTerminalSource?: "bridge_observed" | "local_clock",
    ): SessionRow {
      return store.finalizeSession({
        transition: transitionFor(occurrenceId, outcome),
        recording,
        ...(reconciliationBridgeSessionId === undefined ? {} : { reconciliationBridgeSessionId }),
        ...(reconciliationTerminalAtMs === undefined ? {} : { reconciliationTerminalAtMs }),
        ...(reconciliationTerminalSource === undefined ? {} : { reconciliationTerminalSource }),
      }).session;
    },

    recording(occurrenceId: string): RecordingRow | null {
      return store.getRecording(occurrenceId);
    },

    beginReconciliationGeneration(occurrenceId: string, bridgeSessionId: string): void {
      const nowMs = clock.now();
      store.beginReconciliationGeneration(occurrenceId, bridgeSessionId, nowMs);
    },
    setReconciliationRuntimeSession(occurrenceId: string, bridgeSessionId: string, runtimeSessionId: bigint): void {
      store.setReconciliationRuntimeSession(occurrenceId, bridgeSessionId, runtimeSessionId);
    },
    completeReconciliationGeneration(occurrenceId: string, bridgeSessionId: string, terminalAtMs = clock.now(), terminalSource = "local_clock"): void {
      store.completeReconciliationGeneration(occurrenceId, bridgeSessionId, terminalAtMs, terminalSource);
    },
    appendReconciliationBridgeEvent(occurrenceId: string, event: ReconciliationBridgeEventRow): void {
      store.appendReconciliationBridgeEvent(occurrenceId, event);
    },
    appendReconciliationLiveSegment(occurrenceId: string, segment: ReconciliationLiveSegmentRow): void {
      store.appendReconciliationLiveSegment(occurrenceId, segment);
    },
    reconciliationEvidence(occurrenceId: string, recordingHandle: string | null): ReconciliationEvidenceRow | null {
      return store.getReconciliationEvidence(occurrenceId, recordingHandle);
    },
    purgeExpiredReconciliationEvidence(): number {
      return store.purgeExpiredReconciliationEvidence(clock.now());
    },

    recordBridgeFailure(
      occurrenceId: string,
      maxRetries: number,
      gaps: RecordingInput["gaps"],
      recording: RecordingInput | null,
    ): BridgeRecoveryResult {
      if (!Number.isInteger(maxRetries) || maxRetries < 0) {
        throw new OrchestrationError("invalid_configuration", "max bridge retries must be a non-negative integer");
      }
      return store.recordBridgeFailure({ occurrenceId, nowMs: clock.now(), maxRetries, gaps, recording });
    },

    bridgeFailureRecording(occurrenceId: string, attempt: number): BridgeFailureRecordingRow | null {
      return store.getBridgeFailureRecording(occurrenceId, attempt);
    },

    history(occurrenceId: string): TransitionRow[] {
      return store.listTransitions(occurrenceId);
    },

    acquireBridgeLease(occurrenceId: string, request: BridgeLeaseRequest): LeaseRow {
      return store.acquireLease({
        occurrenceId,
        bridgeId: request.bridgeId,
        bridgeSessionId: request.bridgeSessionId,
        nowMs: clock.now(),
        ttlMs: bridgeLeaseTtlMs,
      });
    },

    releaseBridgeLease(
      occurrenceId: string,
      leaseId: string,
      reason: Exclude<LeaseReleaseReason, "stale_recovered">,
    ): LeaseRow {
      return store.releaseLease(occurrenceId, leaseId, reason, clock.now());
    },

    activeBridgeLease(occurrenceId: string): ActiveBridgeLease | null {
      const lease = store.getActiveLease(occurrenceId);
      if (lease === null) return null;
      return { ...lease, isExpired: lease.expiresAtMs <= clock.now() };
    },

    async withSession<T>(occurrenceId: string, fn: () => Promise<T>): Promise<T> {
      requireSession(occurrenceId);
      await semaphore.acquire();
      try {
        return await fn();
      } finally {
        semaphore.release();
      }
    },

    activeSessionCount(): number {
      return semaphore.activeCount();
    },
  };
}

// ---------------------------------------------------------------------------
// Concurrency semaphore
// ---------------------------------------------------------------------------
//
// A freed permit is handed DIRECTLY to the next queued waiter (rather than
// returned to the shared pool and re-claimed by whichever caller happens to
// run next), so there is no window in which a fresh acquire() and a woken
// waiter could both believe they hold the same permit.

type Semaphore = {
  acquire(): Promise<void>;
  release(): void;
  activeCount(): number;
};

function createSemaphore(maxPermits: number): Semaphore {
  let permits = maxPermits;
  const waiters: Array<() => void> = [];

  return {
    acquire(): Promise<void> {
      if (permits > 0) {
        permits -= 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    release(): void {
      const next = waiters.shift();
      if (next) {
        next(); // Hand this permit straight to the next waiter.
      } else {
        permits += 1;
      }
    },
    activeCount(): number {
      return maxPermits - permits;
    },
  };
}

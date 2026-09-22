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

import type { CustodyBinding, BridgeProcessOutcome } from "../contracts/bridge-process-outcome-v1.ts";
import type { MeetingIdentity } from "../domain/meeting.ts";
import type { AlignmentRecoveryPermit } from "./recording-alignment-authority.ts";
import type { BridgeShutdownResult, BridgeProcessFailure } from "./bridge-process.ts";
import type { FinalizedRecordingCapability, RecordingAlignmentPage, RecordingAlignmentComplete } from "./conversation-runtime.ts";
import type { OperatorWarningPayload } from "./operator-warning.ts";

/** Private application authority. Never returned by ordinary recording/evidence getters. */
export type RecordingRecovery = {
  readonly generationId: string;
  readonly occurrenceId: string;
  readonly bridgeSessionId: string;
  readonly capability: FinalizedRecordingCapability;
  readonly recordingKind: "final" | "bridge_failure";
  readonly failureAttempt: number | null;
};

export type AlignmentAttempt = {
  readonly storeIdentity: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly ownerId: string;
  readonly token: string;
};
export type AlignmentFailure = "read_failed" | "cancelled" | "cleanup_failed" | "recovered_owner";
/** Safe identity/reference only; never includes restart authorization or pages. */
export type SelectedAlignment = {
  readonly generationId: string;
  readonly attemptId: string;
  readonly source: RecordingAlignmentPage["source"];
  readonly timingContract: "capture-clock/v1";
  readonly policyId: "local-wall-estimate/v1" | null;
  readonly coverageStatus: RecordingAlignmentComplete["coverageStatus"];
  readonly pageCount: number;
  readonly entryCount: number;
  readonly storedBytes: number;
  readonly warnings: readonly string[];
};

export type PhysicalCustodyRow = CustodyBinding & {
  readonly state: "quarantined" | "cleared";
  readonly claimedAtMs: number;
  readonly outcome: BridgeProcessOutcome | null;
  readonly outcomeFailure: BridgeProcessFailure | null;
  readonly exitDiagnostic: "nonzero_exit" | null;
  readonly outcomeRecordedAtMs: number | null;
  readonly clearedAtMs: number | null;
  readonly clearReason: string | null;
  readonly clearOperator: string | null;
};
export type PhysicalClientClear = CustodyBinding & { readonly operator: string; readonly assertInspectedIdle: true; readonly nowMs: number };

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

/** One gap in the finalized recording, as a persisted child row. `ordinal` is
 * the zero-based position in the order the bridge observed them -- "exact gap
 * recording" means the same gaps in the same order, so the order is stored,
 * not re-derived. */
export type RecordingGapRow = {
  readonly ordinal: number;
  readonly direction: "capture" | "playback";
  readonly startedAt: string;
  /** null when the gap was still open at finalization. Never collapsed to the
   * finalization instant. */
  readonly endedAt: string | null;
};

/** One exact SDK RecordingSummary gap. This is deliberately separate from
 * RecordingGapRow: runtime gaps use a bigint media timeline plus a reason,
 * while bridge gaps use wall-clock instants plus a direction. */
export type RuntimeRecordingGapRow = {
  readonly ordinal: number;
  readonly startedAtMs: bigint;
  readonly endedAtMs: bigint | null;
  readonly reason: string;
};

/** The finalized recording's METADATA. Never audio bytes: `handle` is an
 * opaque reference to the ENCRYPTED recording, and Meeting Agent never holds
 * the recording key. */
export type RecordingRow = {
  readonly occurrenceId: string;
  readonly handle: string;
  readonly encryptedPath: string | null;
  readonly sha256: string;
  readonly durationMs: number;
  readonly format: string | null;
  readonly keyId: string | null;
  readonly finalizedAtMs: number;
  readonly gaps: readonly RecordingGapRow[];
  readonly runtimeGaps: readonly RuntimeRecordingGapRow[];
};

/** Local-only reconciliation input. It is deliberately separate from the
 * Team Vault/output path: live words are retained only so post-meeting
 * reconciliation survives a coordinator restart. */
export type ReconciliationBridgeEventRow = {
  readonly bridgeSessionId: string;
  readonly sequence: number;
  /** Original bridge envelope schema, retained with the payload and order. */
  readonly schema: "bridge-session/v1";
  readonly observedAt: string;
  /** Validated at persistence time; recovery readers do not reparse text. */
  readonly observedAtMs?: number;
  readonly type: "active_speaker" | "participant_joined" | "participant_left";
  readonly feishuUserId: string | null;
  readonly displayName: string | null;
  readonly confidence: "ui_exact" | "ambiguous" | null;
};
export type ReconciliationLiveSegmentRow = {
  readonly bridgeSessionId: string;
  readonly segmentId: string;
  readonly text: string;
  readonly startedAt: string;
  readonly endedAt: string;
};
export type TimedEvidenceBinding = { readonly occurrenceId: string; readonly bridgeSessionId: string; readonly runtimeSessionId: bigint };
/** Read-only identity; never a live writer/recovery permit or recording capability. */
export type TimedEvidenceBindingResult =
  | { readonly kind: "absent" | "legacy" | "expired" }
  | { readonly kind: "timed"; readonly generationId: string; readonly binding: TimedEvidenceBinding;
      readonly recordingHandle: string | null; readonly terminalAtMs: number | null; readonly expiresAtMs: number | null;
      readonly state: TimedEvidenceStatus["state"] };
export type TimedEvidenceOwner = TimedEvidenceBinding & { readonly generationId: string; readonly token: string; readonly storeIdentity: string };
export type ProvisionalResult =
  | { readonly kind: "provisional_ui_observed"; readonly feishuUserId: string }
  | { readonly kind: "anonymous"; readonly reason: "coverage_missing" | "timing_unavailable" | "coverage_barrier" | "identity_ambiguous" | "activation_not_fresh" | "attendance_missing" | "catchup_timeout" | "pending_limit" | "observation_limit" | "generation_changed" | "owner_closed" | "owner_restarted" | "evidence_expired" | "ui_storage_loss" };
export type TimedEvidenceStatus = { readonly state: "active" | "recovering" | "closed"; readonly uiRows: number; readonly uiBytes: number; readonly liveRows: number;
  readonly uiLossReason: "ui_limit_exceeded" | "ui_invalid" | "ui_sequence_gap" | null;
  readonly wordingLossReason: "text_limit_exceeded" | "live_limit_exceeded" | "runtime_queue_overflow" | null };
export type TimedLiveRow = { readonly event: import("@conversation/runtime").VersionFourVoiceTranscriptFinalEvent; readonly result: ProvisionalResult | null };
export type TimedAppendResult = "inserted" | "duplicate" | "overflow" | "expired";
export type TimedPurgeProgress = { readonly removedRows: number; readonly removedGenerations: number; readonly pending: boolean };

export type ReconciliationEvidenceRow = {
  readonly occurrenceId: string;
  readonly generationId: string;
  readonly runtimeSessionId: bigint | null;
  /** Current Runtime SDK does not expose a wall-clock/media-zero pair. */
  readonly alignment: null;
  /** Durable reason that `alignment` is absent rather than caller supplied. */
  readonly alignmentStatus: "unavailable_current_sdk";
  readonly captureComplete: boolean;
  readonly incompleteReason: "event_limit_exceeded" | "live_text_limit_exceeded" | "legacy_evidence_invalid_on_migration" | null;
  readonly expiresAtMs: number | null;
  readonly terminalAtMs: number | null;
  /** legacy_unknown is migration provenance only: schema 010 retained the
   * terminal instant but no fact proving whether bridge or local clock set it. */
  readonly terminalSource: "bridge_observed" | "local_clock" | "legacy_unknown" | null;
  readonly bridgeEvents: readonly ReconciliationBridgeEventRow[];
  readonly liveSegments: readonly ReconciliationLiveSegmentRow[];
};

/** What a caller supplies to persist a recording. `occurrenceId` and
 * `finalizedAtMs` are not fields here: both come from the transition the
 * recording is written with, so the two halves cannot disagree about which
 * occurrence finalized, or when. */
export type RecordingInput = {
  readonly recovery?: { readonly bridgeSessionId: string; readonly capability: FinalizedRecordingCapability };
  readonly handle: string;
  readonly encryptedPath: string;
  readonly sha256: string;
  readonly durationMs: number;
  readonly format: string;
  readonly keyId: string;
  readonly gaps: ReadonlyArray<{
    readonly direction: "capture" | "playback";
    readonly startedAt: string;
    readonly endedAt: string | null;
  }>;
  readonly runtimeGaps: ReadonlyArray<{
    readonly startedAtMs: bigint;
    readonly endedAtMs: bigint | null;
    readonly reason: string;
  }>;
};

/** Immutable, non-secret build configuration available at the exact
 * finalization boundary. `processedAt` is deliberately absent: it belongs to
 * each later revision, not to the original seed. */
export type BackfillSeedConfig = {
  readonly provider: string;
  readonly encryption: string;
  readonly processingWarnings: readonly { readonly code: string; readonly detail: string }[];
  readonly provenance: {
    readonly runtimeProfile: "offline" | "online";
    readonly sttProvider: string;
    readonly sttModel: string;
    readonly liveStreamModel: string;
    readonly finalBatchModel: string;
    readonly textProvider: string;
    readonly textModel: string;
    readonly agentVersion: string;
  };
};

/** Supplied only by the bridge-observed `left(reason:"ended")` path. The
 * store revalidates this discriminant and its exact timestamp against the
 * reconciliation terminal association before committing a seed. */
export type BackfillSeedFinalizationInput = BackfillSeedConfig & {
  readonly terminalReason: "ended";
  readonly terminalSource: "bridge_observed";
  readonly endedAt: string;
  readonly identity: MeetingIdentity;
};

export type BackfillSeed = {
  readonly occurrenceId: string;
  readonly provider: string;
  readonly providerMeetingId: string;
  readonly meetingNo: string;
  readonly occurrenceStartedAt: string;
  readonly title: string;
  readonly organizer: MeetingIdentity["organizer"];
  readonly endedAt: string;
  readonly endedAtMs: number;
  readonly stopAtMs: number;
  readonly expiresAtMs: number;
  readonly bridgeSessionId: string;
  readonly generationId: string;
  readonly capability: FinalizedRecordingCapability;
  readonly recordingPath: string;
  readonly recordingFormat: string;
  readonly recordingEncryption: string;
  readonly recordingBytes: number;
  readonly recordingDevice: string;
  readonly recordingInode: string;
  readonly recordingDurationMs: number;
  readonly recordingSha256: string;
  readonly recordingKeyId: string;
  readonly bridgeGaps: RecordingInput["gaps"];
  readonly runtimeGaps: RecordingInput["runtimeGaps"];
  readonly processingWarnings: BackfillSeedConfig["processingWarnings"];
  readonly provenance: BackfillSeedConfig["provenance"];
};

export type ClaimBackfillSeedBuildInput = {
  readonly nowMs: number;
  readonly claimToken: string;
  /** Accepted Runtime operation budget. The store derives the lease as this
   * value plus 60 seconds; callers cannot configure a shorter independent
   * lease. */
  readonly operationBudgetMs: number;
};

export type BackfillSeedBuildClaim = {
  readonly seed: BackfillSeed;
  readonly claimToken: string;
  readonly claimExpiresAtMs: number;
  readonly attempt: number;
  readonly targetRevision: number;
  readonly observedAtMs: number;
};

export type BackfillDeliveryAuthority =
  | { readonly kind: "initial"; readonly claimToken: string; readonly nowMs: number }
  | { readonly kind: "retry"; readonly claimToken: string; readonly targetRevision: number; readonly nowMs: number };

export type SavePendingDeliveryResult = {
  readonly kind: "inserted" | "replay";
  /** The persisted canonical intent. On replay this deliberately ignores all
   * mutable caller fields and is the only authority for READY materialization. */
  readonly row: DeliveryRow;
};

export type ClaimBackfillJobInput = {
  readonly nowMs: number;
  readonly claimToken: string;
  /** The store derives a lease of operationBudgetMs + 60 seconds. */
  readonly operationBudgetMs: number;
};

export type BackfillJobClaim = {
  readonly seed: BackfillSeed;
  readonly claimToken: string;
  readonly claimExpiresAtMs: number;
  readonly attempt: number;
  readonly targetRevision: number;
  readonly stopAtMs: number;
  readonly observedAtMs: number;
};

export type BackfillFailureReason = "runtime_failed" | "alignment_failed" | "build_failed" | "cleanup_failed";
export type BackfillBuildFailure =
  | { readonly kind: "initial"; readonly occurrenceId: string; readonly claimToken: string;
      readonly nowMs: number; readonly retryDelayMs: number; readonly reason: BackfillFailureReason }
  | { readonly kind: "retry"; readonly occurrenceId: string; readonly claimToken: string;
      readonly targetRevision: number; readonly nowMs: number; readonly retryDelayMs: number;
      readonly reason: BackfillFailureReason };
export type BackfillFailureResult = { readonly kind: "rescheduled" | "stopped" };

export type BeginBackfillProcessInput =
  | { readonly kind: "initial"; readonly occurrenceId: string; readonly claimToken: string; readonly nowMs: number }
  | { readonly kind: "retry"; readonly occurrenceId: string; readonly claimToken: string;
      readonly targetRevision: number; readonly nowMs: number };

export type SettleBackfillProcessInput = {
  readonly occurrenceId: string;
  readonly processOwnerToken: string;
  readonly outcome: "confirmed" | "failed";
  readonly nowMs: number;
};

export type BackfillWarningClaim = {
  readonly occurrenceId: string;
  readonly claimToken: string;
  readonly claimExpiresAtMs: number;
  readonly attempt: number;
  readonly payload: OperatorWarningPayload;
  readonly key: string;
};

export type BackfillSeedCleanupClaim = {
  readonly occurrenceId: string;
  readonly claimToken: string;
  readonly claimExpiresAtMs: number;
  readonly recordingPath: string;
  readonly recordingHandle: string;
  readonly recordingBytes: number;
  readonly recordingDevice: string;
  readonly recordingInode: string;
};

export type FinalizeSessionInput = {
  readonly transition: TransitionInput;
  readonly recording: RecordingInput;
  /** Immutable bridge/runtime generation whose evidence this exact recording
   * finalizes. The store links both in the same transaction. */
  readonly reconciliationBridgeSessionId?: string;
  /** Observed bridge terminal instant when available; never generation start. */
  readonly reconciliationTerminalAtMs?: number;
  readonly reconciliationTerminalSource?: "bridge_observed" | "local_clock";
  readonly backfillSeed?: BackfillSeedFinalizationInput;
};

export type FinalizeSessionResult = {
  readonly session: SessionRow;
  readonly recording: RecordingRow;
};

export type BridgeRecoveryResult = {
  readonly attempt: number;
  readonly retryAllowed: boolean;
};
export type BridgeFailureRecordingRow = RecordingRow & { readonly attempt: number };

export type MigrationRow = {
  readonly version: number;
  readonly name: string;
  readonly appliedAtMs: number;
};

/** Task 9's local control-plane record. It contains no transcript or audio
 * bytes: those are confined to the encrypted recording and four-file bundle. */
export type DeliveryRow = {
  readonly occurrenceId: string;
  readonly revision: number;
  readonly artifactHash: string;
  readonly recordingPath: string;
  readonly bundlePath: string;
  readonly endedAtMs: number;
  readonly transcriptComplete: boolean;
  readonly retryCount: number;
  readonly nextRetryAtMs: number;
  readonly retryReason: "receipt_unavailable" | "recovery_unavailable" | null;
  readonly publishedAtMs: number | null;
  readonly deletedAtMs: number | null;
  readonly publicationUrl: string | null;
  readonly vaultCommit: string | null;
  readonly recoveryArtifact: string | null;
  readonly stageToken: string | null;
  readonly recordingHandle?: string | null;
};

export type NotificationTerminalReason =
  | "organizer_unresolved"
  | "notification_inputs_unavailable"
  | "notification_delivery_uncertain"
  | "notification_retry_exhausted";

export type NotificationIntent =
  | {
      readonly recipientId: string;
      readonly title: string;
      readonly messageText: string;
      readonly requestUuid: string;
    }
  | { readonly terminalReason: "organizer_unresolved" | "notification_inputs_unavailable" };

export type AcceptPublicationInput = {
  readonly occurrenceId: string;
  readonly revision: number;
  readonly artifactHash: string;
  readonly publishedAtMs: number;
  readonly publicationUrl: string;
  readonly vaultCommit: string;
  readonly notification: NotificationIntent;
};

export type NotificationRow = {
  readonly occurrenceId: string;
  readonly revision: number;
  readonly artifactHash: string;
  readonly publicationUrl: string;
  readonly vaultCommit: string;
  readonly recipientId: string | null;
  readonly title: string | null;
  readonly messageText: string | null;
  readonly requestUuid: string | null;
  readonly state: "pending" | "claimed" | "sent" | "terminal";
  readonly terminalReason: NotificationTerminalReason | null;
  readonly firstAttemptAtMs: number | null;
  readonly lastAttemptAtMs: number | null;
  readonly attemptCount: number;
  readonly nextAttemptAtMs: number;
  readonly claimToken: string | null;
  readonly claimExpiresAtMs: number | null;
  readonly deliveryAmbiguous: boolean;
  readonly providerMessageId: string | null;
  readonly sentAtMs: number | null;
};

export type ClaimNotificationInput = {
  readonly nowMs: number;
  readonly claimToken: string;
  readonly claimTtlMs: number;
  readonly requestTimeoutMs: number;
  readonly dedupWindowMs: number;
  readonly dedupSafetyMarginMs: number;
};

export type FailNotificationInput = {
  readonly occurrenceId: string;
  readonly revision: number;
  readonly claimToken: string;
  readonly nowMs: number;
  readonly nextAttemptAtMs: number;
  readonly ambiguous: boolean;
  readonly terminalReason: "notification_delivery_uncertain" | "notification_retry_exhausted" | null;
};

export type CompleteNotificationInput = {
  readonly occurrenceId: string;
  readonly revision: number;
  readonly claimToken: string;
  readonly providerMessageId: string;
  readonly sentAtMs: number;
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
  acceptInvite(invite: import("./feishu-ingress.ts").NormalizedInvite, nowMs: number): "accepted" | "replay" | "existing_occurrence";
  getInviteOccurrence(occurrenceId: string): import("./feishu-ingress.ts").InviteOccurrence | null;
  listInviteOccurrences(after?: string, limit?: number): readonly import("./feishu-ingress.ts").InviteOccurrence[];
  claimInviteMetadata(nowMs: number): import("./feishu-ingress.ts").InviteClaim | null;
  failInviteClaim(claim: import("./feishu-ingress.ts").InviteClaim, result: Extract<import("./feishu.ts").OrganizerResolution, {status: "blocked"}>, nowMs: number, retryDelayMs: number): void;
  completeInviteClaim(claim: import("./feishu-ingress.ts").InviteClaim, result: Extract<import("./feishu.ts").OrganizerResolution, {status: "resolved"}>, nowMs: number): void;
  retryInviteMetadata(occurrenceId: string, operator: string, nowMs: number): "pending" | "already_pending" | "counter_exhausted";
  claimPhysicalClient(binding: CustodyBinding, nowMs: number): PhysicalCustodyRow;
  listPhysicalCustody(): readonly PhysicalCustodyRow[];
  recordPhysicalOutcome(binding: CustodyBinding, result: BridgeShutdownResult, nowMs: number): void;
  clearPhysicalClient(input: PhysicalClientClear): void;
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

  /** Applies the session's terminal transition AND writes the finalized
   * recording in ONE transaction. The handle is the only reference to the
   * encrypted audio and cannot be re-derived after a crash -- the runtime
   * exposes no lookup and its session is gone -- so a transition that landed
   * without its recording would leave audio nothing points at. Neither half
   * may land alone. */
  finalizeSession(input: FinalizeSessionInput): FinalizeSessionResult;
  getRecording(occurrenceId: string): RecordingRow | null;
  getBackfillSeed(occurrenceId: string): BackfillSeed | null;
  claimBackfillSeedBuild(input: ClaimBackfillSeedBuildInput): BackfillSeedBuildClaim | null;
  claimBackfillJob(input: ClaimBackfillJobInput): BackfillJobClaim | null;
  beginBackfillProcess(input: BeginBackfillProcessInput): { readonly processOwnerToken: string };
  settleBackfillProcess(input: SettleBackfillProcessInput): { readonly outcome: "confirmed" | "failed" };
  failBackfillBuild(input: BackfillBuildFailure): BackfillFailureResult;
  stopDueBackfill(input: { readonly nowMs: number }): { readonly occurrenceId: string } | null;
  claimBackfillWarning(input: { readonly nowMs: number; readonly claimToken: string }): BackfillWarningClaim | null;
  acceptBackfillWarning(input: { readonly occurrenceId: string; readonly claimToken: string;
    readonly key: string; readonly nowMs: number }): void;
  failBackfillWarning(input: { readonly occurrenceId: string; readonly claimToken: string;
    readonly nowMs: number; readonly retryDelayMs: number; readonly reason: "sink_failed" }): void;
  claimExpiredBackfillSeedCleanup(input: { readonly nowMs: number;
    readonly claimToken: string }): BackfillSeedCleanupClaim | null;
  completeBackfillSeedCleanup(input: { readonly occurrenceId: string;
    readonly claimToken: string; readonly nowMs: number }): void;
  authorizeDeliveryEvidenceCleanup(input: { readonly occurrenceId: string; readonly nowMs: number }): boolean;
  getRecordingRecovery(occurrenceId: string, bridgeSessionId: string, recordingHandle: string): RecordingRecovery | null;
  beginRecordingAlignment(generationId: string, ownerId: string, replace?: boolean):
    { readonly kind: "selected"; readonly selected: SelectedAlignment } | { readonly kind: "claimed"; readonly attempt: AlignmentAttempt };
  appendRecordingAlignment(attempt: AlignmentAttempt, page: RecordingAlignmentPage): void;
  completeRecordingAlignment(attempt: AlignmentAttempt, completion: RecordingAlignmentComplete): SelectedAlignment;
  getSelectedAlignment(generationId: string): SelectedAlignment | null;
  readSelectedAlignmentPage(selected: SelectedAlignment, afterPageIndex: number): RecordingAlignmentPage | null;
  getPendingAlignment(generationId: string): AlignmentAttempt | null;
  getReclaimableAlignment(generationId: string): AlignmentAttempt | null;
  markAlignmentCleanupFailed(attempt: AlignmentAttempt): void;
  abandonRecordingAlignment(attempt: AlignmentAttempt, permit: AlignmentRecoveryPermit, reason?: AlignmentFailure): void;
  reclaimRecordingAlignment(attempt: AlignmentAttempt, limit?: number): boolean;
  getRecordingAlignmentFailure(generationId: string): AlignmentFailure | null;
  beginReconciliationGeneration(occurrenceId: string, bridgeSessionId: string, createdAtMs: number): void;
  setReconciliationRuntimeSession(occurrenceId: string, bridgeSessionId: string, runtimeSessionId: bigint): void;
  completeReconciliationGeneration(occurrenceId: string, bridgeSessionId: string, terminalAtMs: number, terminalSource: "bridge_observed" | "local_clock"): void;
  appendReconciliationBridgeEvent(occurrenceId: string, event: ReconciliationBridgeEventRow): void;
  appendReconciliationLiveSegment(occurrenceId: string, segment: ReconciliationLiveSegmentRow): void;
  getReconciliationEvidence(occurrenceId: string, recordingHandle: string | null): ReconciliationEvidenceRow | null;
  purgeExpiredReconciliationEvidence(nowMs: number): number;
  beginTimedEvidence(binding: TimedEvidenceBinding, nowMs: number): TimedEvidenceOwner;
  appendTimedUi(owner: TimedEvidenceOwner, event: import("../contracts/bridge-session-v2.ts").BridgeEventMessageV2, nowMs: number): TimedAppendResult;
  appendTimedFinal(owner: TimedEvidenceOwner, event: import("@conversation/runtime").VersionFourVoiceTranscriptFinalEvent, nowMs: number): TimedAppendResult;
  resolveTimedFinal(owner: TimedEvidenceOwner, segmentId: string, result: ProvisionalResult, nowMs: number): boolean;
  readTimedUi(binding: TimedEvidenceBinding, afterSequence: number, nowMs: number): readonly import("../contracts/bridge-session-v2.ts").BridgeEventMessageV2[];
  readTimedFinal(binding: TimedEvidenceBinding, afterSegmentId: string, nowMs: number): TimedLiveRow | null;
  getTimedEvidenceStatus(binding: TimedEvidenceBinding, nowMs: number): TimedEvidenceStatus | null;
  getTimedEvidenceBinding(generationId: string, nowMs: number): TimedEvidenceBindingResult;
  closeTimedEvidence(owner: TimedEvidenceOwner, nowMs: number): void;
  markTimedUiLoss(owner: TimedEvidenceOwner, reason: NonNullable<TimedEvidenceStatus["uiLossReason"]>, nowMs: number): void;
  markTimedWordingLoss(owner: TimedEvidenceOwner, reason: NonNullable<TimedEvidenceStatus["wordingLossReason"]>, nowMs: number): void;
  getTimedRecoveryOwner(binding: TimedEvidenceBinding, nowMs: number): TimedEvidenceOwner | null;
  beginTimedRecovery(owner: TimedEvidenceOwner, permit: import("./live-evidence-authority.ts").LiveRecoveryPermit, nowMs: number): TimedEvidenceOwner;
  settleTimedRecoveryBatch(owner: TimedEvidenceOwner, nowMs: number): boolean;
  purgeExpiredTimedEvidenceBatch(nowMs: number): TimedPurgeProgress;
  recordBridgeFailure(input: {
    readonly occurrenceId: string;
    readonly nowMs: number;
    readonly maxRetries: number;
    readonly gaps: RecordingInput["gaps"];
    readonly recording: RecordingInput | null;
  }): BridgeRecoveryResult;
  getBridgeFailureRecording(occurrenceId: string, attempt: number): BridgeFailureRecordingRow | null;

  savePending(row: DeliveryRow, authority?: BackfillDeliveryAuthority): SavePendingDeliveryResult;
  pending(): readonly DeliveryRow[];
  recoverablePublications(): readonly DeliveryRow[];
  update(row: DeliveryRow): void;
  acceptPublication(input: AcceptPublicationInput): void;
  notifications(): readonly NotificationRow[];
  claimNotification(input: ClaimNotificationInput): NotificationRow | null;
  failNotification(input: FailNotificationInput): void;
  completeNotification(input: CompleteNotificationInput): void;

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

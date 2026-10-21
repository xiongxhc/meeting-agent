// The sanctioned SQLite driver for Meeting Agent's own orchestration control
// database. This is the ONLY file in production code allowed to import
// better-sqlite3 -- test/boundaries.test.ts enforces that structurally, and
// test/lib/import-scanner.ts documents why (SANCTIONED_SQLITE_IMPORTER_RELATIVE_PATH).
//
// Row shapes, state values, and the OrchestrationError surface live in the
// PORT (src/ports/session-store.ts), not here, so src/sessions/coordinator.ts
// never has to import anything by a path naming "sqlite" -- see that port
// file's header comment for why that split is load-bearing, not just taste.
//
// This module is a thin, honest wrapper over migrations/001_orchestration.sql:
// every method takes an explicit `nowMs` rather than reading a clock itself,
// so every timing decision in the system stays testable with an injected
// clock (see src/sessions/coordinator.ts). Its control tables hold session
// lifecycle, audit trail, and bridge leases. Task 7 additionally has an
// explicit local-only reconciliation ledger for final live wording; it never
// stores audio and is not a Team Vault/output path.

import Database from "better-sqlite3";
import { validateNormalizedInvite, boundedInviteString, type NormalizedInvite, type InviteOccurrence, type InviteClaim } from "../ports/feishu-ingress.ts";
import type { OrganizerResolution } from "../ports/feishu.ts";
import { validateOrganizerReferenceKeys } from "../ports/feishu.ts";
import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { validateCustodyBinding, parseBridgeProcessOutcome, sameCustodyBinding, type CustodyBinding } from "../contracts/bridge-process-outcome-v1.ts";
import type { BridgeShutdownResult } from "../ports/bridge-process.ts";
import { consumeAlignmentRecoveryPermit, type AlignmentRecoveryPermit } from "../ports/recording-alignment-authority.ts";
import type { RecordingAlignmentPage, RecordingAlignmentComplete } from "../ports/conversation-runtime.ts";
import { ALIGNMENT_LIMITS, encodeAlignmentPage, decodeAlignmentPage, validateAlignmentComplete, pageWarnings } from "../sessions/recording-alignment.ts";
import type { PhysicalCustodyRow, PhysicalClientClear } from "../ports/session-store.ts";
import type { TimedEvidenceBinding, TimedEvidenceBindingResult, TimedEvidenceOwner, TimedEvidenceStatus, ProvisionalResult, TimedAppendResult, TimedLiveRow, TimedPurgeProgress } from "../ports/session-store.ts";
import type { VersionFourVoiceTranscriptFinalEvent } from "@conversation/runtime";
import { parseEventV2, type BridgeEventMessageV2 } from "../contracts/bridge-session-v2.ts";
import { parseEventShape, type CaptureDrain } from "../contracts/bridge-session-v1.ts";
import { encodeLiveEvidence, decodeLiveEvidence, encodeProvisionalResult, decodeProvisionalResult } from "../sessions/live-evidence-codec.ts";
import { consumeLiveRecoveryPermit, type LiveRecoveryPermit } from "../ports/live-evidence-authority.ts";
import { audioFormatToken, canonicalArtifactHash, canonicalArtifactJson, isUnicodeScalarString } from "../contracts/teammem-meeting-v1.ts";
import { parseSupportedTeamMemMeetingArtifact, type SupportedTeamMemMeetingArtifact } from "../contracts/teammem-meeting-v2.ts";
import { operatorWarningKey } from "../ports/operator-warning.ts";

import { occurrencePathSegment, type OccurrenceId } from "../domain/occurrence-id.ts";
import {
  OrchestrationError,
  type AcquireLeaseInput,
  type CreateSessionInput,
  type FinalizeSessionInput,
  type FinalizeSessionResult,
  type LeaseReleaseReason,
  type LeaseRow,
  type RecordingGapRow,
  type RuntimeRecordingGapRow,
  type RecordingRow,
  type RecordingRecovery,
  type RecordingInput,
  type BackfillSeed,
  type BackfillSeedBuildClaim,
  type BackfillDeliveryAuthority,
  type SavePendingDeliveryResult,
  type ClaimBackfillJobInput,
  type BackfillJobClaim,
  type BackfillBuildFailure,
  type BackfillFailureResult,
  type BeginBackfillProcessInput,
  type SettleBackfillProcessInput,
  type BackfillWarningClaim,
  type BackfillSeedCleanupClaim,
  type OpenCaptureRows,
  type RecordingFileObservation,
  type RecordingRetention,
  type UnknownEndCustody,
  type UnknownEndCustodyAssignment,
  type UnknownEndCustodyCleanupClaim,
  type UnknownEndCustodyFailureReason,
  type UnknownEndCustodyIdentity,
  type UnknownEndCustodySource,
  type BackfillSeedFinalizationInput,
  type ClaimBackfillSeedBuildInput,
  type AlignmentAttempt,
  type AlignmentFailure,
  type SelectedAlignment,
  type ReconciliationBridgeEventRow,
  type ReconciliationEvidenceRow,
  type ReconciliationLiveSegmentRow,
  type BridgeRecoveryResult,
  type BridgeFailureRecordingRow,
  type StoredRecordingGeneration,
  type PublishStoredGenerationsInput,
  type PublishStoredGenerationsResult,
  type DeliveryRow,
  type PublicationRefusalInput,
  type AcceptPublicationInput,
  type ClaimNotificationInput,
  type CompleteNotificationInput,
  type FailNotificationInput,
  type NotificationRow,
  type MigrationRow,
  type SessionRow,
  type SessionState,
  type SessionStore,
  type TableSchema,
  type TransitionInput,
  type TransitionRow,
} from "../ports/session-store.ts";

// Deliberately NOT `export * from "../ports/session-store.ts"`: the port is
// the canonical, sqlite-free surface every consumer (including tests) should
// depend on. Re-exporting it here would let callers keep depending on this
// adapter by name for types that have nothing to do with SQLite -- the exact
// coupling the port split exists to remove. Import row/error types straight
// from "../ports/session-store.ts"; import only `openSessionStore` and
// `OpenSessionStoreOptions` (the adapter's own additions) from here.

export type OpenSessionStoreOptions = {
  readonly filename: string;
  /** Directory containing numbered `NNN_name.sql` migration files. Defaults
   * to the repo's own migrations/ directory, resolved relative to this
   * module -- overridable so tests (and, later, a packaged build) can point
   * at a different location. */
  readonly migrationsDir?: string;
  /** Timestamp recorded against a migration actually applied by this call.
   * Only affects migration bookkeeping, never business logic: every other
   * method on SessionStore takes its own explicit `nowMs`. Defaults to
   * `Date.now()`. */
  readonly nowMs?: number;
  /** Test-only checkpoint between two observations of a durable recording
   * path. Production callers leave this unset. */
  readonly deliveryIdentityCheckpoint?: (canonicalPath: string) => void;
  /** Test-only checkpoint after the seed transaction has staged every row and
   * immediately before its final filesystem identity observation. */
  readonly seedIdentityCheckpoint?: (canonicalPath: string) => void;
};

const DEFAULT_MIGRATIONS_DIR = path.resolve(import.meta.dirname, "..", "..", "migrations");
const privateStateGuards = new WeakMap<Database.Database, () => string>();

/** Private recovery is opt-in by use, not a change to legacy SQLite opening.
 * No permission repair and no Windows/ACL confidentiality claim. */
function privateStateGuard(filename: string): () => string {
  const resolved = path.resolve(filename);
  const inspect = () => {
    if (filename === ":memory:" || typeof process.getuid !== "function") throw new Error("unsupported private state");
    const uid = BigInt(process.getuid());
    const file = lstatSync(resolved, { bigint: true });
    const parent = lstatSync(path.dirname(resolved), { bigint: true });
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1n || file.uid !== uid ||
      !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o077n) !== 0n) {
      throw new Error("unsupported private state");
    }
    return `${parent.dev}:${parent.ino}:${parent.birthtimeNs}:${file.dev}:${file.ino}:${file.birthtimeNs}`;
  };
  let original: string | null = null;
  try { original = inspect(); } catch { /* Legacy open remains available. */ }
  return () => {
    try { if (original === null || inspect() !== original) throw new Error("identity changed"); }
    catch { throw new Error("Recovery requires private persistent recording state with stable owned file identity"); }
    return original;
  };
}

function requirePrivateState(db: Database.Database): string {
  const guard = privateStateGuards.get(db);
  if (!guard) throw new Error("Recovery requires private persistent recording state");
  return guard();
}

export function openSessionStore(options: OpenSessionStoreOptions): SessionStore {
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const db = new Database(options.filename);
  privateStateGuards.set(db, privateStateGuard(options.filename));
  db.pragma("foreign_keys = ON"); // better-sqlite3 does NOT enable this by default; must be set per connection.

  applyMigrations(db, migrationsDir, options.nowMs ?? Date.now());
  repairDeliveryRecordingOwners(db);

  return {
    acceptInvite: (invite, nowMs) => acceptInvite(db, invite, nowMs),
    getInviteOccurrence: (id) => getInviteOccurrence(db, id),
    listInviteOccurrences: (after = "", limit = 64) => listInviteOccurrences(db, after, limit),
    claimInviteMetadata: (nowMs) => claimInviteMetadata(db, nowMs),
    failInviteClaim: (claim, result, nowMs, retryDelayMs) => failInviteClaim(db, claim, result, nowMs, retryDelayMs),
    completeInviteClaim: (claim, result, nowMs) => completeInviteClaim(db, claim, result, nowMs),
    retryInviteMetadata: (id, operator, nowMs) => retryInviteMetadata(db, id, operator, nowMs),
    claimPhysicalClient: (binding, nowMs) => claimPhysicalClient(db, binding, nowMs),
    listPhysicalCustody: () => listPhysicalCustody(db),
    recordPhysicalOutcome: (binding, result, nowMs) => recordPhysicalOutcome(db, binding, result, nowMs),
    clearPhysicalClient: (input) => clearPhysicalClient(db, input),
    get schemaVersion() {
      return currentSchemaVersion(db);
    },
    appliedMigrations: () => appliedMigrations(db),
    foreignKeysEnabled: () => (db.pragma("foreign_keys", { simple: true }) as number) === 1,
    foreignKeyCheck: () => db.pragma("foreign_key_check") as ReadonlyArray<Record<string, unknown>>,
    describeSchema: () => describeSchema(db),

    createSession: (input) => createSession(db, input),
    getSession: (occurrenceId) => getSession(db, occurrenceId),
    transition: (input) => transition(db, input),
    listTransitions: (occurrenceId) => listTransitions(db, occurrenceId),

    finalizeSession: (input) => finalizeSession(db, input, options.seedIdentityCheckpoint),
    getRecording: (occurrenceId) => getRecording(db, occurrenceId),
    getBackfillSeed: (occurrenceId) => getBackfillSeed(db, occurrenceId),
    claimBackfillSeedBuild: (input) => claimBackfillSeedBuild(db, input),
    claimBackfillJob: (input) => claimBackfillJob(db, input),
    beginBackfillProcess: (input) => beginBackfillProcess(db, input),
    settleBackfillProcess: (input) => settleBackfillProcess(db, input),
    failBackfillBuild: (input) => failBackfillBuild(db, input),
    stopDueBackfill: (input) => stopDueBackfill(db, input.nowMs),
    claimBackfillWarning: (input) => claimBackfillWarning(db, input.nowMs, input.claimToken),
    acceptBackfillWarning: (input) => acceptBackfillWarning(db, input),
    failBackfillWarning: (input) => failBackfillWarning(db, input),
    claimExpiredBackfillSeedCleanup: (input) => claimExpiredBackfillSeedCleanup(db, input.nowMs, input.claimToken),
    completeBackfillSeedCleanup: (input) => completeBackfillSeedCleanup(db, input),
    assignUnknownEndCustody: (source, detectedAtMs, exactIdentity) => assignUnknownEndCustody(db, source, detectedAtMs, exactIdentity),
    getUnknownEndCustody: (source) => getUnknownEndCustody(db, source),
    claimDueUnknownEndCustodyCleanup: (nowMs, claimToken) => claimDueUnknownEndCustodyCleanup(db, nowMs, claimToken),
    completeUnknownEndCustodyCleanup: (claim, deletedAtMs) => completeUnknownEndCustodyCleanup(db, claim, deletedAtMs),
    failUnknownEndCustodyCleanup: (claim, failedAtMs, reason) => failUnknownEndCustodyCleanup(db, claim, failedAtMs, reason),
    authorizeDeliveryEvidenceCleanup: (input) => authorizeDeliveryEvidenceCleanup(db, input.occurrenceId, input.nowMs),
    observeRecordingRetention: (file, nowMs) => observeRecordingRetention(db, file, nowMs),
    listAssignedRecordingRetention: () => listAssignedRecordingRetention(db),
    settleRecordingRetention: (handle, outcome, nowMs) => settleRecordingRetention(db, handle, outcome, nowMs),
    listOpenCaptureRows: () => listOpenCaptureRows(db),
    getRecordingRecovery: (occurrenceId, bridgeSessionId, recordingHandle) => getRecordingRecovery(db, occurrenceId, bridgeSessionId, recordingHandle),
    beginRecordingAlignment: (generationId, ownerId, replace) => beginRecordingAlignment(db, generationId, ownerId, replace),
    appendRecordingAlignment: (attempt, page) => appendRecordingAlignment(db, attempt, page),
    completeRecordingAlignment: (attempt, complete) => completeRecordingAlignment(db, attempt, complete),
    getSelectedAlignment: (generationId) => getSelectedAlignment(db, generationId),
    readSelectedAlignmentPage: (selected, after) => readSelectedAlignmentPage(db, selected, after),
    getPendingAlignment: (generationId) => getPendingAlignment(db, generationId),
    getReclaimableAlignment: (generationId) => getReclaimableAlignment(db, generationId),
    markAlignmentCleanupFailed: (attempt) => markAlignmentCleanupFailed(db, attempt),
    abandonRecordingAlignment: (attempt, permit, reason) => abandonRecordingAlignment(db, attempt, permit, reason),
    reclaimRecordingAlignment: (attempt, limit) => reclaimRecordingAlignment(db, attempt, limit),
    getRecordingAlignmentFailure: (generationId) => getRecordingAlignmentFailure(db, generationId),
    beginReconciliationGeneration: (occurrenceId, bridgeSessionId, createdAtMs) => beginReconciliationGeneration(db, occurrenceId, bridgeSessionId, createdAtMs),
    setReconciliationRuntimeSession: (occurrenceId, bridgeSessionId, runtimeSessionId) => setReconciliationRuntimeSession(db, occurrenceId, bridgeSessionId, runtimeSessionId),
    completeReconciliationGeneration: (occurrenceId, bridgeSessionId, terminalAtMs, terminalSource, terminalReason) => completeReconciliationGeneration(db, occurrenceId, bridgeSessionId, terminalAtMs, terminalSource, terminalReason),
    appendReconciliationBridgeEvent: (occurrenceId, event) => appendReconciliationBridgeEvent(db, occurrenceId, event),
    appendReconciliationLiveSegment: (occurrenceId, segment) => appendReconciliationLiveSegment(db, occurrenceId, segment),
    getReconciliationEvidence: (occurrenceId, recordingHandle) => getReconciliationEvidence(db, occurrenceId, recordingHandle),
    purgeExpiredReconciliationEvidence: (nowMs) => purgeExpiredReconciliationEvidence(db, nowMs),
    beginTimedEvidence: (binding, nowMs) => beginTimedEvidence(db, binding, nowMs),
    appendTimedUi: (owner, event, nowMs) => appendTimedUi(db, owner, event, nowMs),
    appendTimedFinal: (owner, event, nowMs) => appendTimedFinal(db, owner, event, nowMs),
    resolveTimedFinal: (owner, segmentId, result, nowMs) => resolveTimedFinal(db, owner, segmentId, result, nowMs),
    readTimedUi: (binding, after, nowMs) => readTimedUi(db, binding, after, nowMs),
    getTimedEvidenceBinding: (generationId, nowMs) => getTimedEvidenceBinding(db, generationId, nowMs),
    readTimedFinal: (binding, after, nowMs) => readTimedFinal(db, binding, after, nowMs),
    getTimedEvidenceStatus: (binding, nowMs) => {
      const row = timedHeader(db, binding, nowMs);
      return row === null ? null : { state: row.state, uiRows: row.uiRows, uiBytes: row.uiBytes, liveRows: row.liveRows,
        uiLossReason: row.uiLossReason, wordingLossReason: row.wordingLossReason };
    },
    markTimedUiLoss: (owner, reason, nowMs) => {
      db.transaction(() => {
        if (ownedTimedHeader(db, owner, nowMs)) db.prepare("UPDATE timed_evidence_owners SET ui_loss_reason = COALESCE(ui_loss_reason, ?) WHERE generation_id = ?").run(reason, owner.generationId);
      })();
    },
    markTimedWordingLoss: (owner, reason, nowMs) => {
      db.transaction(() => {
        if (ownedTimedHeader(db, owner, nowMs)) db.prepare("UPDATE timed_evidence_owners SET wording_loss_reason = COALESCE(wording_loss_reason, ?) WHERE generation_id = ?").run(reason, owner.generationId);
      })();
    },
    closeTimedEvidence: (owner, nowMs) => closeTimedEvidence(db, owner, nowMs),
    getTimedRecoveryOwner: (binding, nowMs) => getTimedRecoveryOwner(db, binding, nowMs),
    beginTimedRecovery: (owner, permit, nowMs) => beginTimedRecovery(db, owner, permit, nowMs),
    settleTimedRecoveryBatch: (owner, nowMs) => db.transaction(() => {
      const row = ownedTimedHeader(db, owner, nowMs, true);
      if (row !== null && row.state !== "recovering") throw new Error("live recovery has not been admitted");
      // No expired evidence is exposed to the caller. One exact-owner pending
      // row receives only a fixed anonymous result per transaction.
      const result: ProvisionalResult = { kind: "anonymous", reason: row === null ? "evidence_expired" : "owner_restarted" };
      const changed = db.prepare(`UPDATE timed_live_evidence SET result = ? WHERE generation_id = ? AND segment_id =
        (SELECT segment_id FROM timed_live_evidence WHERE generation_id = ? AND result IS NULL ORDER BY segment_id LIMIT 1) AND result IS NULL`)
        .run(encodeProvisionalResult(result), owner.generationId, owner.generationId).changes;
      return changed !== 0;
    })(),
    purgeExpiredTimedEvidenceBatch: (nowMs) => purgeExpiredTimedEvidenceBatch(db, nowMs),
    recordBridgeFailure: (input) => recordBridgeFailure(db, input),
    getBridgeFailureRecording: (occurrenceId, attempt) => getBridgeFailureRecording(db, occurrenceId, attempt),
    listRecordingGenerations: (occurrenceId) => listRecordingGenerations(db, occurrenceId),
    publishStoredGenerations: (input) => publishStoredGenerations(db, input),
    savePending: (row, authority) => savePendingDelivery(db, row, authority, options.deliveryIdentityCheckpoint),
    pending: () => deliveryRows(db, "active"),
    recoverablePublications: () => deliveryRows(db, "deleted_with_recovery"),
    update: (row) => updateDelivery(db, row),
    publicationResynthesisEligible: (input) => publicationResynthesisEligible(db, input),
    recordPublicationRefusal: (input) => recordPublicationRefusal(db, input),
    acceptPublication: (input) => acceptPublication(db, input),
    notifications: () => notifications(db),
    claimNotification: (input) => claimNotification(db, input),
    failNotification: (input) => failNotification(db, input),
    completeNotification: (input) => completeNotification(db, input),

    acquireLease: (input) => acquireLease(db, input),
    releaseLease: (occurrenceId, leaseId, reason, nowMs) =>
      releaseLease(db, occurrenceId, leaseId, reason, nowMs),
    getActiveLease: (occurrenceId) => getActiveLease(db, occurrenceId),
    listLeases: (occurrenceId) => listLeases(db, occurrenceId),

    close: () => {
      db.close();
      privateStateGuards.delete(db);
    },
  };
}

// ---------------------------------------------------------------------------
// Durable Feishu invite discovery (no network or launch inside transactions)
// ---------------------------------------------------------------------------

const INVITE_SELECT = `SELECT occurrence_id AS occurrenceId, region, tenant_key AS tenantKey, app_id AS appId,
  provider_meeting_id AS providerMeetingId, meeting_no AS meetingNo, occurrence_started_at AS occurrenceStartedAt, title, state,
  accepted_at_ms AS acceptedAtMs, last_observed_at_ms AS lastObservedAtMs,
  first_attempt_at_ms AS firstAttemptAtMs, last_attempt_at_ms AS lastAttemptAtMs, generation_started_at_ms AS generationStartedAtMs,
  next_attempt_at_ms AS nextAttemptAtMs, total_attempts AS totalAttempts, generation_attempts AS generationAttempts,
  retry_generation AS retryGeneration, operator_retry_count AS operatorRetryCount, last_operator AS lastOperator,
  last_operator_retry_at_ms AS lastOperatorRetryAtMs, last_blocked_reason AS lastBlockedReason, last_blocked_at_ms AS lastBlockedAtMs,
  claim_token AS claimToken, claim_expires_at_ms AS claimExpiresAtMs, admitted_at_ms AS admittedAtMs,
  organizer_source AS source, organizer_open_id AS id, organizer_display_name AS displayName, reference_json AS referenceJson
  FROM feishu_invite_occurrences`;
type InviteRaw = Omit<InviteOccurrence, "organizer" | "reference"> & {
  source: "reservation" | "calendar_event" | null; id: string | null; displayName: string | null; referenceJson: string | null;
};
function inviteRow(raw: InviteRaw): InviteOccurrence {
  const { source, id, displayName, referenceJson, ...row } = raw;
  return { ...row, organizer: source === null ? null : { region: row.region, tenantKey: row.tenantKey, appId: row.appId,
    idType: "open_id", source, id: id!, displayName: displayName! }, reference: referenceJson === null ? null : JSON.parse(referenceJson) };
}
function getInviteOccurrence(db: Database.Database, id: string): InviteOccurrence | null {
  const raw = db.prepare(INVITE_SELECT + " WHERE occurrence_id=?").get(id) as InviteRaw | undefined;
  return raw ? inviteRow(raw) : null;
}
function listInviteOccurrences(db: Database.Database, after: string, limit: number): readonly InviteOccurrence[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error("invalid_invite_limit");
  return (db.prepare(INVITE_SELECT + " WHERE occurrence_id>? ORDER BY occurrence_id LIMIT ?").all(after, limit) as InviteRaw[]).map(inviteRow);
}
function inviteTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 600_000) throw new Error("invalid_invite_time");
}
function acceptInvite(db: Database.Database, v: NormalizedInvite, now: number): "accepted" | "replay" | "existing_occurrence" {
  validateNormalizedInvite(v); inviteTime(now);
  return db.transaction(() => {
    const event = db.prepare("SELECT normalized_sha256 AS hash FROM feishu_invite_events WHERE region=? AND tenant_key=? AND app_id=? AND event_id=?")
      .get(v.region, v.tenantKey, v.appId, v.eventId) as {hash: string} | undefined;
    if (event) { if (event.hash !== v.normalizedSha256) throw new Error("invite_conflict"); return "replay" as const; }
    const old = getInviteOccurrence(db, v.occurrenceId);
    if (old) {
      if (["region", "tenantKey", "appId", "providerMeetingId", "meetingNo", "occurrenceStartedAt"].some((key) =>
        old[key as keyof InviteOccurrence] !== v[key as keyof NormalizedInvite])) throw new Error("invite_conflict");
    } else {
      const count = db.prepare("SELECT count(*) AS n FROM feishu_invite_occurrences WHERE state IN ('pending_metadata','metadata_blocked')").get() as {n:number};
      if (count.n >= 256) throw new Error("invite_capacity");
      db.prepare(`INSERT INTO feishu_invite_occurrences(occurrence_id,region,tenant_key,app_id,provider_meeting_id,meeting_no,
        occurrence_started_at,title,state,accepted_at_ms,last_observed_at_ms,next_attempt_at_ms) VALUES(?,?,?,?,?,?,?,?,'pending_metadata',?,?,?)`)
        .run(v.occurrenceId,v.region,v.tenantKey,v.appId,v.providerMeetingId,v.meetingNo,v.occurrenceStartedAt,v.title,now,now,now);
    }
    db.prepare(`INSERT INTO feishu_invite_events(region,tenant_key,app_id,event_id,occurrence_id,envelope_schema,event_type,create_time,
      provider_meeting_id,meeting_no,topic,start_seconds,end_seconds,invite_seconds,call_id,normalized_sha256,normalized_bytes,accepted_at_ms)
      VALUES(?,?,?,?,?,'2.0','vc.bot.meeting_invited_v1',?,?,?,?,?,?,?,?,?,?,?)`)
      .run(v.region,v.tenantKey,v.appId,v.eventId,v.occurrenceId,v.createTime,v.providerMeetingId,v.meetingNo,v.title,v.startSeconds,
        v.endSeconds,v.inviteSeconds,v.callId,v.normalizedSha256,v.normalizedBytes,now);
    db.prepare("UPDATE feishu_invite_occurrences SET last_observed_at_ms=max(last_observed_at_ms,?) WHERE occurrence_id=?").run(now,v.occurrenceId);
    return old ? "existing_occurrence" as const : "accepted" as const;
  }).immediate();
}
function blockInvite(db: Database.Database, id: string, reason: string, now: number): void {
  db.prepare(`UPDATE feishu_invite_occurrences SET state='metadata_blocked',last_blocked_reason=?,last_blocked_at_ms=?,
    claim_token=NULL,claim_expires_at_ms=NULL WHERE occurrence_id=?`).run(reason,now,id);
}
function claimInviteMetadata(db: Database.Database, now: number): InviteClaim | null {
  inviteTime(now);
  return db.transaction(() => {
    const candidates = db.prepare(INVITE_SELECT + " WHERE state='pending_metadata' AND (claim_token IS NULL OR claim_expires_at_ms<=?) ORDER BY next_attempt_at_ms,occurrence_id LIMIT 256").all(now) as InviteRaw[];
    for (const raw of candidates) {
      const row = inviteRow(raw);
      if (now < Math.max(row.acceptedAtMs,row.lastAttemptAtMs ?? 0,row.lastOperatorRetryAtMs ?? 0)) { blockInvite(db,row.occurrenceId,"clock_regression",now); continue; }
      if (row.totalAttempts >= 1_000_000) { blockInvite(db,row.occurrenceId,"counter_exhausted",now); continue; }
      if (row.generationAttempts >= 8 || (row.generationStartedAtMs !== null && now >= row.generationStartedAtMs + 600_000)) {
        blockInvite(db,row.occurrenceId,"retry_exhausted",now); continue;
      }
      if (now < row.nextAttemptAtMs) continue;
      const token = randomUUID().replaceAll("-", "");
      db.prepare(`UPDATE feishu_invite_occurrences SET claim_token=?,claim_expires_at_ms=?,total_attempts=total_attempts+1,
        generation_attempts=generation_attempts+1,first_attempt_at_ms=coalesce(first_attempt_at_ms,?),last_attempt_at_ms=?,
        generation_started_at_ms=coalesce(generation_started_at_ms,?) WHERE occurrence_id=?`).run(token,now+30_000,now,now,now,row.occurrenceId);
      return getInviteOccurrence(db,row.occurrenceId) as InviteClaim;
    }
    return null;
  }).immediate();
}
function fencedInvite(db: Database.Database, claim: InviteClaim, now: number): InviteOccurrence {
  inviteTime(now);
  const row = getInviteOccurrence(db,claim.occurrenceId);
  if (!row || row.state !== "pending_metadata" || row.claimToken !== claim.claimToken || row.claimExpiresAtMs! <= now) throw new Error("invite_claim_fenced");
  return row;
}
function failInviteClaim(db: Database.Database, claim: InviteClaim, result: Extract<OrganizerResolution,{status:"blocked"}>, now: number, delay: number): void {
  if (!Number.isSafeInteger(delay) || delay < 1000 || delay > 60_000) throw new Error("invalid_invite_retry_delay");
  db.transaction(() => {
    const row = fencedInvite(db,claim,now);
    const regression = now < row.lastAttemptAtMs!;
    const exhausted = row.generationAttempts >= 8 || now + delay >= row.generationStartedAtMs! + 600_000;
    if (regression || !result.retryable || exhausted) blockInvite(db,row.occurrenceId,regression ? "clock_regression" : exhausted ? "retry_exhausted" : result.reason,now);
    else db.prepare(`UPDATE feishu_invite_occurrences SET claim_token=NULL,claim_expires_at_ms=NULL,next_attempt_at_ms=?,last_blocked_reason=?,last_blocked_at_ms=? WHERE occurrence_id=?`)
      .run(now+delay,result.reason,now,row.occurrenceId);
  }).immediate();
}
function completeInviteClaim(db: Database.Database, claim: InviteClaim, result: Extract<OrganizerResolution,{status:"resolved"}>, now: number): void {
  db.transaction(() => {
    const row = fencedInvite(db,claim,now), organizer = result.organizer;
    if (now < row.lastAttemptAtMs!) { blockInvite(db,row.occurrenceId,"clock_regression",now); return; }
    if (organizer.region !== row.region || organizer.tenantKey !== row.tenantKey || organizer.appId !== row.appId || organizer.idType !== "open_id" ||
        !["reservation","calendar_event"].includes(organizer.source) || organizer.source !== result.reference.kind) throw new Error("invalid_invite_organizer");
    boundedInviteString(organizer.id); boundedInviteString(organizer.displayName,4096);
    validateOrganizerReferenceKeys(result.reference);
    if(result.reference.kind === "reservation") boundedInviteString(result.reference.reserveId);
    else {
      boundedInviteString(result.reference.calendarId);boundedInviteString(result.reference.eventId);
      if(result.reference.occurrenceId !== row.occurrenceId || result.reference.providerMeetingId !== row.providerMeetingId ||
          result.reference.occurrenceStartedAt !== row.occurrenceStartedAt) throw new Error("invalid_invite_reference");
    }
    const reference = JSON.stringify(result.reference);
    if (Buffer.byteLength(reference)>8192) throw new Error("invalid_invite_reference");
    const session = getSession(db,row.occurrenceId);
    if (session && (session.providerMeetingId !== row.providerMeetingId || session.occurrenceStartedAt !== row.occurrenceStartedAt)) throw new Error("invite_conflict");
    if (!session) createSession(db,{occurrenceId:row.occurrenceId,providerMeetingId:row.providerMeetingId,occurrenceStartedAt:row.occurrenceStartedAt,nowMs:now});
    db.prepare(`UPDATE feishu_invite_occurrences SET state=?,organizer_source=?,organizer_id_type='open_id',organizer_open_id=?,organizer_display_name=?,
      reference_kind=?,reference_json=?,admitted_at_ms=?,claim_token=NULL,claim_expires_at_ms=NULL WHERE occurrence_id=?`)
      .run(session ? "existing_session":"admitted",organizer.source,organizer.id,organizer.displayName,result.reference.kind,reference,now,row.occurrenceId);
  }).immediate();
}
function retryInviteMetadata(db: Database.Database, id: string, operator: string, now: number): "pending" | "already_pending" | "counter_exhausted" {
  inviteTime(now);
  if (!/^[A-Za-z0-9._@-]{1,128}$/.test(operator)) throw new Error("invalid_invite_operator");
  return db.transaction(() => {
    const row = getInviteOccurrence(db,id);
    if (!row || getSession(db,id) || now < Math.max(row.lastAttemptAtMs ?? 0,row.lastOperatorRetryAtMs ?? 0,row.acceptedAtMs)) throw new Error("invite_retry_fenced");
    if (row.state === "pending_metadata") return "already_pending" as const;
    if (row.state !== "metadata_blocked" || row.claimToken !== null) throw new Error("invite_retry_fenced");
    if (row.retryGeneration >= 1_000_000 || row.operatorRetryCount >= 1_000_000 || row.totalAttempts >= 1_000_000) {
      blockInvite(db,id,"counter_exhausted",now); return "counter_exhausted" as const;
    }
    db.prepare(`UPDATE feishu_invite_occurrences SET state='pending_metadata',generation_attempts=0,generation_started_at_ms=NULL,
      retry_generation=retry_generation+1,operator_retry_count=operator_retry_count+1,last_operator=?,last_operator_retry_at_ms=?,next_attempt_at_ms=? WHERE occurrence_id=?`)
      .run(operator,now,now,id);
    return "pending" as const;
  }).immediate();
}

// ---------------------------------------------------------------------------
// Physical client custody
// ---------------------------------------------------------------------------

function custodyTime(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("invalid_custody_audit_time");
}
function listPhysicalCustody(db: Database.Database, binding?: CustodyBinding): PhysicalCustodyRow[] {
  const rows = db.prepare(`SELECT physical_client_id AS physicalClientId, physical_generation_id AS physicalGenerationId,
    occurrence_id AS occurrenceId, bridge_session_id AS bridgeSessionId, state, claimed_at_ms AS claimedAtMs,
    outcome_json AS outcomeJson, outcome_failure AS outcomeFailure, exit_diagnostic AS exitDiagnostic, outcome_recorded_at_ms AS outcomeRecordedAtMs,
    cleared_at_ms AS clearedAtMs, clear_reason AS clearReason, clear_operator AS clearOperator
    FROM physical_client_custody ${binding === undefined ? "" : "WHERE physical_client_id = ? AND physical_generation_id = ?"}
    ORDER BY claimed_at_ms, physical_client_id`).all(...(binding === undefined ? [] : [binding.physicalClientId, binding.physicalGenerationId])) as (Omit<PhysicalCustodyRow, "outcome"> & { outcomeJson: string | null })[];
  return rows.map(({ outcomeJson, ...row }) => ({ ...row, outcome: outcomeJson === null ? null : parseBridgeProcessOutcome(JSON.parse(outcomeJson)) }));
}
function claimPhysicalClient(db: Database.Database, value: CustodyBinding, nowMs: number): PhysicalCustodyRow {
  const binding = validateCustodyBinding(value); custodyTime(nowMs);
  return db.transaction(() => {
    const old = listPhysicalCustody(db, binding)[0];
    if (old) {
      if (!sameCustodyBinding(old, binding)) throw new Error("physical_client_binding_conflict");
      return old;
    }
    if (db.prepare("SELECT 1 FROM physical_client_custody WHERE physical_client_id = ? AND state = 'quarantined'").get(binding.physicalClientId)) throw new Error("physical_client_quarantined");
    db.prepare(`INSERT INTO physical_client_custody (physical_client_id, physical_generation_id, occurrence_id, bridge_session_id, state, claimed_at_ms)
      VALUES (?, ?, ?, ?, 'quarantined', ?)`).run(binding.physicalClientId, binding.physicalGenerationId, binding.occurrenceId, binding.bridgeSessionId, nowMs);
    return listPhysicalCustody(db, binding)[0]!;
  }).immediate();
}
function recordPhysicalOutcome(db: Database.Database, value: CustodyBinding, result: BridgeShutdownResult, nowMs: number): void {
  const binding = validateCustodyBinding(value); custodyTime(nowMs);
  const outcome = result.outcome === null ? null : parseBridgeProcessOutcome(result.outcome);
  if (outcome !== null && !sameCustodyBinding(outcome, binding)) throw new Error("physical_client_binding_conflict");
  if (typeof result.reaped !== "boolean" || result.failure !== null && !["launch_failed", "protocol_failed", "outcome_missing", "child_failed", "reap_failed", "cleanup_failed"].includes(result.failure)) throw new Error("invalid_custody_result");
  if (result.exitDiagnostic !== null && result.exitDiagnostic !== "nonzero_exit") throw new Error("invalid_custody_result");
  const failure = result.failure ?? (!result.reaped ? "reap_failed" : outcome === null ? "outcome_missing" : null);
  db.transaction(() => {
    const old = listPhysicalCustody(db, binding)[0];
    if (old && !sameCustodyBinding(old, binding)) throw new Error("physical_client_binding_conflict");
    if (!old || old.state !== "quarantined" || old.outcomeRecordedAtMs !== null) throw new Error("physical_client_outcome_fenced");
    const clear = result.reaped && failure === null && outcome !== null && outcome.outcome !== "departure_unconfirmed";
    db.prepare(`UPDATE physical_client_custody SET outcome_json = ?, outcome_failure = ?, exit_diagnostic = ?, outcome_recorded_at_ms = ?,
      state = ?, cleared_at_ms = ?, clear_reason = ? WHERE physical_client_id = ? AND physical_generation_id = ? AND state = 'quarantined'`)
      .run(outcome === null ? null : JSON.stringify(outcome), failure, result.exitDiagnostic, nowMs, clear ? "cleared" : "quarantined", clear ? nowMs : null,
        clear ? outcome.reason : null, binding.physicalClientId, binding.physicalGenerationId);
  }).immediate();
}
function clearPhysicalClient(db: Database.Database, input: PhysicalClientClear): void {
  const binding = validateCustodyBinding({ physicalClientId: input.physicalClientId, physicalGenerationId: input.physicalGenerationId, occurrenceId: input.occurrenceId, bridgeSessionId: input.bridgeSessionId });
  custodyTime(input.nowMs);
  if (input.assertInspectedIdle !== true || typeof input.operator !== "string" || !/^[A-Za-z0-9._@-]{1,128}$/.test(input.operator)) throw new Error("invalid_custody_operator_assertion");
  const result = db.prepare(`UPDATE physical_client_custody SET state = 'cleared', cleared_at_ms = ?, clear_reason = 'operator_inspected_idle', clear_operator = ?
    WHERE physical_client_id = ? AND physical_generation_id = ? AND occurrence_id = ? AND bridge_session_id = ? AND state = 'quarantined'`)
    .run(input.nowMs, input.operator, binding.physicalClientId, binding.physicalGenerationId, binding.occurrenceId, binding.bridgeSessionId);
  if (result.changes !== 1) throw new Error("physical_client_clear_fenced");
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

function migrationsTableExists(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { present: number } | undefined;
  return row !== undefined;
}

function appliedMigrations(db: Database.Database): MigrationRow[] {
  if (!migrationsTableExists(db)) return [];
  const rows = db
    .prepare("SELECT version, name, applied_at_ms AS appliedAtMs FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number; name: string; appliedAtMs: number }>;
  return rows.map((row) => ({ version: row.version, name: row.name, appliedAtMs: row.appliedAtMs }));
}

function currentSchemaVersion(db: Database.Database): number {
  const applied = appliedMigrations(db);
  return applied.reduce((max, row) => Math.max(max, row.version), 0);
}

type MigrationFile = { readonly version: number; readonly name: string; readonly sql: string };

function discoverMigrationFiles(migrationsDir: string): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));
  } catch (error) {
    // A missing/unreadable migrations directory is a configuration error,
    // not a bare fs stack trace -- the same failure mode as the
    // badly-named-file case below, and the one a mis-resolved
    // DEFAULT_MIGRATIONS_DIR (e.g. running from a built dist/ tree with no
    // migrations/ copied alongside it) actually hits in practice.
    throw new OrchestrationError(
      "invalid_configuration",
      `could not read migrations directory "${migrationsDir}": ${(error as Error).message}`,
    );
  }
  const files: MigrationFile[] = [];
  for (const name of entries) {
    const match = /^(\d+)_/.exec(name);
    if (!match) {
      throw new OrchestrationError(
        "invalid_configuration",
        `migration file "${name}" does not start with a numeric version prefix like "001_"`,
      );
    }
    files.push({
      version: Number.parseInt(match[1]!, 10),
      name,
      sql: readFileSync(path.join(migrationsDir, name), "utf8"),
    });
  }
  files.sort((a, b) => a.version - b.version);
  return files;
}

function applyMigrations(db: Database.Database, migrationsDir: string, nowMs: number): void {
  const files = discoverMigrationFiles(migrationsDir);
  const already = new Set(migrationsTableExists(db) ? appliedMigrations(db).map((m) => m.version) : []);

  for (const file of files) {
    if (already.has(file.version)) continue;
    const apply = db.transaction(() => {
      db.exec(file.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)",
      ).run(file.version, file.name, nowMs);
    });
    apply();
  }
}

// ---------------------------------------------------------------------------
// Schema introspection
// ---------------------------------------------------------------------------

function describeSchema(db: Database.Database): TableSchema[] {
  const tables = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string; sql: string }>;

  return tables.map((table) => {
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all() as Array<{
      name: string;
      type: string;
    }>;
    return {
      name: table.name,
      sql: table.sql,
      columns: columns.map((c) => ({ name: c.name, type: c.type })),
    };
  });
}

/** Table names here are always our own fixed schema's names, never user
 * input -- this only guards against a stray identifier character breaking
 * the PRAGMA statement's syntax. */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

type SessionRowRaw = {
  occurrence_id: string;
  occurrence_segment: string;
  provider_meeting_id: string;
  occurrence_started_at: string;
  state: string;
  terminal_reason: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

function toSessionRow(raw: SessionRowRaw): SessionRow {
  return {
    occurrenceId: raw.occurrence_id,
    occurrenceSegment: raw.occurrence_segment,
    providerMeetingId: raw.provider_meeting_id,
    occurrenceStartedAt: raw.occurrence_started_at,
    state: raw.state as SessionState,
    terminalReason: raw.terminal_reason,
    createdAtMs: raw.created_at_ms,
    updatedAtMs: raw.updated_at_ms,
  };
}

function selectSessionRaw(db: Database.Database, occurrenceId: string): SessionRowRaw | undefined {
  return db
    .prepare(
      `SELECT occurrence_id, occurrence_segment, provider_meeting_id, occurrence_started_at,
              state, terminal_reason, created_at_ms, updated_at_ms
       FROM sessions WHERE occurrence_id = ?`,
    )
    .get(occurrenceId) as SessionRowRaw | undefined;
}

function getSession(db: Database.Database, occurrenceId: string): SessionRow | null {
  const raw = selectSessionRaw(db, occurrenceId);
  return raw ? toSessionRow(raw) : null;
}

/** Derives the occurrence_segment column from occurrenceId itself, using the
 * same occurrencePathSegment every other layer in the system uses, so
 * segment and occurrence id can never disagree. Wraps
 * occurrencePathSegment's own validation error (a malformed occurrenceId is
 * not the kind of thing that should ever reach here, since
 * buildMeetingIdentity validates it first, but the store's contract should
 * not simply trust its caller) as OrchestrationError rather than letting a
 * generic Error escape this module. */
function deriveOccurrenceSegment(occurrenceId: string): string {
  try {
    return occurrencePathSegment(occurrenceId as OccurrenceId);
  } catch (error) {
    throw new OrchestrationError(
      "invalid_configuration",
      `occurrenceId "${occurrenceId}" is not a valid occurrence id: ${(error as Error).message}`,
    );
  }
}

function createSession(db: Database.Database, input: CreateSessionInput): SessionRow {
  const occurrenceSegment = deriveOccurrenceSegment(input.occurrenceId);
  const run = db.transaction(() => {
    if (selectSessionRaw(db, input.occurrenceId) !== undefined) {
      throw new OrchestrationError(
        "duplicate_session",
        `a session already exists for occurrence "${input.occurrenceId}"`,
      );
    }
    withConstraintTranslation(() => {
      db.prepare(
        `INSERT INTO sessions
           (occurrence_id, occurrence_segment, provider_meeting_id, occurrence_started_at,
            state, terminal_reason, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, 'discovered', NULL, ?, ?)`,
      ).run(
        input.occurrenceId,
        occurrenceSegment,
        input.providerMeetingId,
        input.occurrenceStartedAt,
        input.nowMs,
        input.nowMs,
      );
      db.prepare(
        `INSERT INTO transitions (occurrence_id, from_state, to_state, reason, terminal_reason, occurred_at_ms)
         VALUES (?, NULL, 'discovered', NULL, NULL, ?)`,
      ).run(input.occurrenceId, input.nowMs);
    });
  });
  run();
  return getSession(db, input.occurrenceId)!;
}

function transition(db: Database.Database, input: TransitionInput): SessionRow {
  const run = db.transaction(() => {
    const current = selectSessionRaw(db, input.occurrenceId);
    if (current === undefined) {
      throw new OrchestrationError(
        "unknown_session",
        `no session exists for occurrence "${input.occurrenceId}"`,
      );
    }
    if (current.state !== input.fromState) {
      throw new OrchestrationError(
        "state_conflict",
        `occurrence "${input.occurrenceId}" is in state "${current.state}", not the expected "${input.fromState}"`,
      );
    }

    withConstraintTranslation(() => {
      const result = db
        .prepare(
          `UPDATE sessions
             SET state = ?, terminal_reason = ?, updated_at_ms = ?
           WHERE occurrence_id = ? AND state = ?`,
        )
        .run(input.toState, input.terminalReason, input.nowMs, input.occurrenceId, input.fromState);
      if (result.changes !== 1) {
        // Another writer won the compare-and-swap between our SELECT and
        // this UPDATE. better-sqlite3 is synchronous and single-connection
        // here, so this is defense in depth rather than a reachable race.
        throw new OrchestrationError(
          "state_conflict",
          `occurrence "${input.occurrenceId}" changed state concurrently`,
        );
      }
      db.prepare(
        `INSERT INTO transitions (occurrence_id, from_state, to_state, reason, terminal_reason, occurred_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        input.occurrenceId,
        input.fromState,
        input.toState,
        input.reason,
        input.terminalReason,
        input.nowMs,
      );
    });
  });
  run();
  return getSession(db, input.occurrenceId)!;
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

/**
 * The terminal transition and the finalized recording, in ONE transaction.
 *
 * `transition` is the existing per-transition function, which opens a
 * transaction of its own -- better-sqlite3 nests those as savepoints, so the
 * whole thing still commits or rolls back as a unit. A crash, or a CHECK
 * violation on the recording, therefore cannot leave a session marked
 * finalized with no recording behind it, nor a recording attached to a
 * session that never transitioned.
 *
 * `finalized_at_ms` and `occurrence_id` are taken from the TRANSITION, never
 * from the recording input, so the two halves cannot disagree about which
 * occurrence finalized or when.
 */
function finalizeSession(
  db: Database.Database,
  input: FinalizeSessionInput,
  seedIdentityCheckpoint?: (canonicalPath: string) => void,
): FinalizeSessionResult {
  const { occurrenceId, nowMs } = input.transition;
  const preparedSeed = input.backfillSeed === undefined ? null : prepareBackfillSeed(db, input);
  const run = db.transaction(() => {
    const session = transition(db, input.transition);
    withConstraintTranslation(() => {
      // A database opened against a pre-028 migration set has no drain
      // columns. Writing none of them leaves the legacy insert exactly as it
      // was; an actual claim on such a database is refused rather than
      // silently dropped, because losing the evidence is the whole failure.
      const drain = captureDrainAvailable(db) ? captureDrainColumns(input.recording.captureDrain) : null;
      if (drain === null && input.recording.captureDrain !== undefined) {
        throw new OrchestrationError("constraint_violation", "capture drain requires migration 028");
      }
      db.prepare(
        `INSERT INTO recordings
           (occurrence_id, handle, encrypted_path, sha256, duration_ms, format, key_id, finalized_at_ms${
             drain === null ? "" : `, ${CAPTURE_DRAIN_COLUMNS}`})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?${drain === null ? "" : ", ?, ?, ?, ?, ?, ?"})`,
      ).run(
        occurrenceId,
        input.recording.handle,
        input.recording.encryptedPath,
        input.recording.sha256,
        input.recording.durationMs,
        input.recording.format,
        input.recording.keyId,
        nowMs,
        ...(drain === null ? [] : [
          drain.capture_drain,
          drain.capture_drain_reason,
          drain.capture_drain_epoch,
          drain.capture_drain_last_frame_sequence,
          drain.capture_drain_output_end_sample,
          drain.capture_drain_final_pair_sequence,
        ]),
      );
      const insertGap = db.prepare(
        `INSERT INTO recording_gaps (occurrence_id, ordinal, direction, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      input.recording.gaps.forEach((gap, ordinal) => {
        insertGap.run(occurrenceId, ordinal, gap.direction, gap.startedAt, gap.endedAt);
      });
      insertRuntimeGaps(db, "recording_runtime_gaps", [occurrenceId], input.recording.runtimeGaps);
      if (input.recording.recovery !== undefined && input.recording.recovery.bridgeSessionId !== input.reconciliationBridgeSessionId) {
        throw new OrchestrationError("constraint_violation", "recording recovery generation mismatch");
      }
      bindRecordingRecovery(db, occurrenceId, input.recording, null);
      if (input.reconciliationBridgeSessionId !== undefined) {
        const associated = db.prepare(
          `UPDATE reconciliation_generations
             SET recording_handle = ?, terminal_at_ms = ?, terminal_source = ?, expires_at_ms = ?
           WHERE generation_id = ? AND occurrence_id = ? AND recording_handle IS NULL`,
        ).run(input.recording.handle, input.reconciliationTerminalAtMs ?? nowMs, input.reconciliationTerminalSource ?? "local_clock", (input.reconciliationTerminalAtMs ?? nowMs) + RECONCILIATION_EVIDENCE_RETENTION_MS,
          reconciliationGenerationId(occurrenceId, input.reconciliationBridgeSessionId), occurrenceId).changes;
        if (associated !== 1) throw new OrchestrationError("constraint_violation", "reconciliation generation cannot be associated with finalized recording");
      }
      if (preparedSeed !== null) {
        insertBackfillSeed(db, preparedSeed);
        seedIdentityCheckpoint?.(preparedSeed.binding.canonicalPath);
        assertBackfillRecordingBindingUnchanged(preparedSeed.binding);
      }
    });
    return session;
  });
  const session = run();
  return { session, recording: getRecording(db, occurrenceId)! };
}

/** D029 §2. The whole object is validated by the bridge grammar that produced
 * it -- one definition of "a legal drain claim", not a second one that could
 * drift -- and then spread across the columns. The correlations SQLite's ALTER
 * cannot express as a table CHECK are exactly what that grammar enforces, so a
 * contradictory claim never reaches the row. */
function captureDrainColumns(drain: CaptureDrain | undefined): CaptureDrainColumns {
  if (drain === undefined) return NO_CAPTURE_DRAIN;
  const checked = parseEventShape({ schema: "bridge-session/v1", sessionId: "capture-drain", sequence: 1,
    observedAt: "1970-01-01T00:00:00Z", type: "media_disconnected", reason: "media_stopped", captureDrain: drain });
  if (!checked.ok) {
    throw new OrchestrationError("constraint_violation", `capture drain violates D029: ${checked.rejection.path}`);
  }
  return drain.drain === "confirmed"
    ? { capture_drain: "confirmed", capture_drain_reason: null,
        capture_drain_epoch: drain.boundary.captureEpoch,
        capture_drain_last_frame_sequence: drain.boundary.lastFrameSequence,
        capture_drain_output_end_sample: drain.boundary.outputEndSample,
        capture_drain_final_pair_sequence: drain.boundary.finalClockPairSequence }
    : { capture_drain: "unconfirmed", capture_drain_reason: drain.reason, capture_drain_epoch: null,
        capture_drain_last_frame_sequence: null, capture_drain_output_end_sample: null,
        capture_drain_final_pair_sequence: null };
}
type CaptureDrainColumns = {
  capture_drain: "confirmed" | "unconfirmed" | null;
  capture_drain_reason: string | null;
  capture_drain_epoch: string | null;
  capture_drain_last_frame_sequence: string | null;
  capture_drain_output_end_sample: string | null;
  capture_drain_final_pair_sequence: string | null;
};

/** The inverse. A row whose outcome is NULL made no claim at all; a row whose
 * members contradict its outcome is a corrupted row, refused rather than
 * repaired into whichever half looks more plausible. */
function captureDrainOf(row: CaptureDrainColumns): CaptureDrain | null {
  if (row.capture_drain === null) return null;
  const drain: CaptureDrain = row.capture_drain === "confirmed"
    ? { drain: "confirmed", reason: null,
        boundary: { captureEpoch: row.capture_drain_epoch!, lastFrameSequence: row.capture_drain_last_frame_sequence!,
          outputEndSample: row.capture_drain_output_end_sample!, finalClockPairSequence: row.capture_drain_final_pair_sequence! } }
    : { drain: "unconfirmed", reason: row.capture_drain_reason!, boundary: null };
  const checked = parseEventShape({ schema: "bridge-session/v1", sessionId: "capture-drain", sequence: 1,
    observedAt: "1970-01-01T00:00:00Z", type: "media_disconnected", reason: "media_stopped", captureDrain: drain });
  if (!checked.ok) {
    throw new OrchestrationError("constraint_violation", `stored capture drain violates D029: ${checked.rejection.path}`);
  }
  return drain;
}

const CAPTURE_DRAIN_COLUMNS = `capture_drain, capture_drain_reason, capture_drain_epoch,
  capture_drain_last_frame_sequence, capture_drain_output_end_sample, capture_drain_final_pair_sequence`;

const NO_CAPTURE_DRAIN: CaptureDrainColumns = { capture_drain: null, capture_drain_reason: null,
  capture_drain_epoch: null, capture_drain_last_frame_sequence: null,
  capture_drain_output_end_sample: null, capture_drain_final_pair_sequence: null };

/** Whether migration 028 has been applied to THIS database. Callers may hold a
 * store opened against an older migration set, which is a legal configuration
 * and must keep working, reading and writing exactly the columns it has. */
function captureDrainAvailable(db: Database.Database): boolean {
  return (db.prepare("SELECT COUNT(*) AS present FROM pragma_table_info('recordings') WHERE name = 'capture_drain'")
    .get() as { present: number }).present === 1;
}

function getRecording(db: Database.Database, occurrenceId: string): RecordingRow | null {
  const available = captureDrainAvailable(db);
  const raw = db
    .prepare(
      `SELECT occurrence_id, handle, encrypted_path, sha256, duration_ms, format, key_id, finalized_at_ms${
        available ? `, ${CAPTURE_DRAIN_COLUMNS}` : ""}
         FROM recordings WHERE occurrence_id = ?`,
    )
    .get(occurrenceId) as
    | ({
        occurrence_id: string;
        handle: string;
        encrypted_path: string | null;
        sha256: string;
        duration_ms: number;
        format: string | null;
        key_id: string | null;
        finalized_at_ms: number;
      } & CaptureDrainColumns)
    | undefined;
  if (raw === undefined) return null;

  const gaps = db
    .prepare(
      `SELECT ordinal, direction, started_at, ended_at
         FROM recording_gaps WHERE occurrence_id = ? ORDER BY ordinal`,
    )
    .all(occurrenceId) as Array<{
    ordinal: number;
    direction: string;
    started_at: string;
    ended_at: string | null;
  }>;

  const runtimeGaps = selectRuntimeGaps(db, "recording_runtime_gaps", "occurrence_id = ?", [occurrenceId]);

  return {
    occurrenceId: raw.occurrence_id,
    handle: raw.handle,
    encryptedPath: raw.encrypted_path,
    sha256: raw.sha256,
    durationMs: raw.duration_ms,
    format: raw.format,
    keyId: raw.key_id,
    finalizedAtMs: raw.finalized_at_ms,
    captureDrain: captureDrainOf(available ? raw : NO_CAPTURE_DRAIN),
    captureIntegrity: (available ? raw.capture_drain : null) ?? "unavailable",
    gaps: gaps.map(
      (gap): RecordingGapRow => ({
        ordinal: gap.ordinal,
        direction: gap.direction as RecordingGapRow["direction"],
        startedAt: gap.started_at,
        endedAt: gap.ended_at,
      }),
    ),
    runtimeGaps,
  };
}

function bindRecordingRecovery(db: Database.Database, occurrenceId: string, recording: RecordingInput, failureAttempt: number | null): void {
  const recovery = recording.recovery;
  if (recovery === undefined) return; // Legacy is explicitly unavailable, never reconstructed.
  requirePrivateState(db);
  const { capability: cap, bridgeSessionId } = recovery;
  const invalid = () => new OrchestrationError("constraint_violation", "invalid private recording recovery binding");
  if (typeof cap !== "object" || cap === null || Object.keys(cap).sort().join(",") !== "authorization,keyId,recordingHandle,sha256,sourceSessionId" ||
      typeof cap.sourceSessionId !== "bigint" || cap.sourceSessionId <= 0n || cap.sourceSessionId > 18_446_744_073_709_551_615n ||
      typeof cap.recordingHandle !== "string" || !/^[0-9a-f]{32}$/.test(cap.recordingHandle) ||
      typeof cap.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(cap.sha256) ||
      typeof cap.keyId !== "string" || !/^[0-9a-f]{16}$/.test(cap.keyId) ||
      typeof cap.authorization !== "string" || !/^[0-9a-f]{64}$/.test(cap.authorization) ||
      cap.recordingHandle !== recording.handle || cap.sha256 !== recording.sha256 || cap.keyId !== recording.keyId) throw invalid();
  const id = reconciliationGenerationId(occurrenceId, bridgeSessionId);
  const generation = db.prepare("SELECT runtime_session_id, recording_handle FROM reconciliation_generations WHERE generation_id=? AND occurrence_id=? AND bridge_session_id=?")
    .get(id, occurrenceId, bridgeSessionId) as { runtime_session_id: string | null; recording_handle: string | null } | undefined;
  if (!generation || generation.runtime_session_id !== cap.sourceSessionId.toString() || generation.recording_handle !== null) throw invalid();
  db.prepare(`INSERT INTO recording_recovery_bindings (generation_id,occurrence_id,bridge_session_id,source_session_id,recording_handle,sha256,key_id,authorization,recording_kind,failure_attempt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, occurrenceId, bridgeSessionId, cap.sourceSessionId.toString(), cap.recordingHandle, cap.sha256, cap.keyId, cap.authorization,
      failureAttempt === null ? "final" : "bridge_failure", failureAttempt);
  if (failureAttempt !== null) {
    // No terminal instant is inferred here. Existing observed/local terminal
    // completion remains separate; only exact failed recording identity is bound.
    db.prepare("UPDATE reconciliation_generations SET recording_handle=? WHERE generation_id=? AND recording_handle IS NULL").run(cap.recordingHandle, id);
  }
}

function getRecordingRecovery(db: Database.Database, occurrenceId: string, bridgeSessionId: string, recordingHandle: string): RecordingRecovery | null {
  requirePrivateState(db);
  const row = db.prepare(`SELECT generation_id,source_session_id,recording_handle,sha256,key_id,authorization,recording_kind,failure_attempt
    FROM recording_recovery_bindings WHERE occurrence_id=? AND bridge_session_id=? AND recording_handle=?`)
    .get(occurrenceId, bridgeSessionId, recordingHandle) as { generation_id: string; source_session_id: string; recording_handle: string; sha256: string; key_id: string; authorization: string;
      recording_kind: RecordingRecovery["recordingKind"]; failure_attempt: number | null } | undefined;
  if (!row) return null;
  if (row.generation_id !== reconciliationGenerationId(occurrenceId, bridgeSessionId) ||
    !/^[1-9][0-9]{0,19}$/.test(row.source_session_id) || BigInt(row.source_session_id) > (1n << 64n) - 1n ||
    !/^[0-9a-f]{32}$/.test(row.recording_handle) || !/^[0-9a-f]{64}$/.test(row.sha256) ||
    !/^[0-9a-f]{16}$/.test(row.key_id) || !/^[0-9a-f]{64}$/.test(row.authorization) ||
    (row.recording_kind !== "final" && row.recording_kind !== "bridge_failure") ||
    (row.recording_kind === "final" ? row.failure_attempt !== null : !Number.isSafeInteger(row.failure_attempt) || (row.failure_attempt ?? 0) < 1)) {
    throw new Error("invalid private recording recovery binding");
  }
  return { generationId: row.generation_id, occurrenceId, bridgeSessionId, recordingKind: row.recording_kind, failureAttempt: row.failure_attempt,
    capability: { sourceSessionId: BigInt(row.source_session_id), recordingHandle: row.recording_handle, sha256: row.sha256, keyId: row.key_id, authorization: row.authorization } };
}

const BACKFILL_STOP_MS = 11 * 24 * 60 * 60 * 1000;
const BACKFILL_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_RECORDING_BYTES = 8n * 1024n * 1024n * 1024n;
const MIN_OPERATION_BUDGET_MS = 1_000;
const MAX_OPERATION_BUDGET_MS = 900_000;
const BUILD_CLAIM_MARGIN_MS = 60_000;

type BackfillRecordingBinding = {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly bytes: number;
  readonly handle: string;
};

type PreparedBackfillSeed = {
  readonly input: BackfillSeedFinalizationInput;
  readonly recording: RecordingInput;
  readonly occurrenceId: string;
  readonly bridgeSessionId: string;
  readonly generationId: string;
  readonly endedAtMs: number;
  readonly stopAtMs: number;
  readonly expiresAtMs: number;
  readonly binding: BackfillRecordingBinding;
  readonly bridgeGapsJson: string;
  readonly runtimeGapsJson: string;
  readonly warningsJson: string;
};

function seedViolation(message: string): OrchestrationError {
  return new OrchestrationError("constraint_violation", message);
}

function boundedSeedText(value: unknown, field: string, max: number, maxBytes = max * 4): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || Buffer.byteLength(value, "utf8") > maxBytes || !isUnicodeScalarString(value)) {
    throw seedViolation(`invalid backfill seed ${field}`);
  }
  return value;
}

function exactUtcMillis(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw seedViolation("invalid backfill seed endedAt");
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw seedViolation("invalid backfill seed endedAt");
  const canonical = new Date(parsed).toISOString();
  if (value !== canonical && value !== canonical.replace(".000Z", "Z")) throw seedViolation("invalid backfill seed endedAt");
  return parsed;
}

function boundedSeedJson(value: unknown, field: string): string {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > 262_144) {
    throw seedViolation(`invalid backfill seed ${field}`);
  }
  return encoded;
}

function backfillRecordingBinding(recording: Pick<RecordingInput, "handle" | "encryptedPath">): BackfillRecordingBinding {
  const canonicalPath = path.resolve(recording.encryptedPath);
  if (!/^[0-9a-f]{32}$/.test(recording.handle) || path.basename(canonicalPath) !== `${recording.handle}.crsr`) {
    throw seedViolation("backfill ciphertext path does not match its Runtime handle");
  }
  try {
    const stat = lstatSync(canonicalPath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) throw seedViolation("backfill ciphertext is not a regular Runtime child");
    if (stat.size < 1n || stat.size > MAX_RECORDING_BYTES) throw seedViolation("backfill ciphertext size is outside 1..8GiB");
    return { canonicalPath, device: stat.dev.toString(), inode: stat.ino.toString(), bytes: Number(stat.size), handle: recording.handle };
  } catch (error) {
    if (error instanceof OrchestrationError) throw error;
    throw seedViolation(`backfill ciphertext cannot be inspected: ${(error as Error).message}`);
  }
}

function assertBackfillRecordingBindingUnchanged(expected: BackfillRecordingBinding): void {
  const current = backfillRecordingBinding({ handle: expected.handle, encryptedPath: expected.canonicalPath });
  if (current.canonicalPath !== expected.canonicalPath || current.device !== expected.device ||
      current.inode !== expected.inode || current.bytes !== expected.bytes) {
    throw seedViolation("backfill ciphertext identity or size changed during finalization; retry");
  }
}

function prepareBackfillSeed(db: Database.Database, value: FinalizeSessionInput): PreparedBackfillSeed {
  const input = value.backfillSeed;
  if (input === undefined || (input as { terminalReason?: unknown }).terminalReason !== "ended" ||
      (input as { terminalSource?: unknown }).terminalSource !== "bridge_observed" ||
      value.transition.toState !== "finalizing" || value.transition.terminalReason !== null ||
      value.reconciliationTerminalSource !== "bridge_observed" || value.reconciliationTerminalAtMs === undefined ||
      value.reconciliationBridgeSessionId === undefined || value.recording.recovery === undefined) {
    throw seedViolation("backfill seed requires exact ended and bridge-observed finalization");
  }
  const endedAtMs = exactUtcMillis(input.endedAt);
  if (endedAtMs !== value.reconciliationTerminalAtMs || input.identity.occurrenceId !== value.transition.occurrenceId ||
      value.recording.recovery.bridgeSessionId !== value.reconciliationBridgeSessionId) {
    throw seedViolation("backfill seed end, occurrence or generation mismatch");
  }
  return prepareSeedFields(db, input, value.recording, value.transition.occurrenceId, value.reconciliationBridgeSessionId, endedAtMs);
}

/** Validation and encoding shared by every seed: the bridge-observed end and a
 * publication after the bridge-failure retries ran out. */
function prepareSeedFields(db: Database.Database, input: BackfillSeedFinalizationInput, recording: RecordingInput,
  occurrenceId: string, bridgeSessionId: string, endedAtMs: number, gapsForSeed: RecordingInput["gaps"] = recording.gaps): PreparedBackfillSeed {
  const value = { recording, transition: { occurrenceId }, reconciliationBridgeSessionId: bridgeSessionId };
  const stopAtMs = endedAtMs + BACKFILL_STOP_MS;
  const expiresAtMs = endedAtMs + BACKFILL_EXPIRY_MS;
  if (!Number.isSafeInteger(stopAtMs) || !Number.isSafeInteger(expiresAtMs)) throw seedViolation("backfill seed deadline overflow");
  const session = selectSessionRaw(db, value.transition.occurrenceId);
  if (session === undefined || session.provider_meeting_id !== input.identity.providerMeetingId ||
      session.occurrence_started_at !== input.identity.occurrenceStartedAt) {
    throw seedViolation("backfill seed provider identity mismatch");
  }
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(input.provider)) throw seedViolation("invalid backfill seed provider");
  boundedSeedText(input.identity.providerMeetingId, "providerMeetingId", 4096, 4096);
  boundedSeedText(input.identity.meetingNo, "meetingNo", 4096, 4096);
  boundedSeedText(input.identity.occurrenceStartedAt, "occurrenceStartedAt", 40, 40);
  boundedSeedText(input.identity.title, "title", 200, 800);
  if (input.identity.organizer !== null) {
    boundedSeedText(input.identity.organizer.feishuUserId, "organizer id", 200, 800);
    boundedSeedText(input.identity.organizer.displayName, "organizer display name", 200, 800);
    if (input.identity.organizer.source !== "reservation" && input.identity.organizer.source !== "calendar_event") {
      throw seedViolation("invalid backfill seed organizer source");
    }
  }
  boundedSeedText(input.encryption, "encryption", 200, 800);
  boundedSeedText(value.recording.format, "recording format", 200, 800);
  for (const [field, fieldValue] of Object.entries(input.provenance)) boundedSeedText(fieldValue, `provenance ${field}`, 200, 800);
  if (input.provenance.runtimeProfile !== "offline" && input.provenance.runtimeProfile !== "online") throw seedViolation("invalid backfill seed runtime profile");
  if (!Array.isArray(input.processingWarnings) || input.processingWarnings.length > 500) throw seedViolation("invalid backfill seed processing warnings");
  for (const warning of input.processingWarnings) {
    if (typeof warning !== "object" || warning === null || Object.keys(warning).sort().join(",") !== "code,detail" ||
        !/^[a-z][a-z0-9_]{0,39}$/.test(warning.code)) throw seedViolation("invalid backfill seed processing warning");
    boundedSeedText(warning.detail, "processing warning detail", 500, 2000);
  }
  const bridgeGapsJson = boundedSeedJson(gapsForSeed, "bridge gaps");
  const runtimeGapsJson = boundedSeedJson(value.recording.runtimeGaps.map((gap) => ({
    startedAtMs: gap.startedAtMs.toString(), endedAtMs: gap.endedAtMs?.toString() ?? null, reason: gap.reason,
  })), "runtime gaps");
  const warningsJson = boundedSeedJson(input.processingWarnings, "processing warnings");
  return { input, recording: value.recording, occurrenceId: value.transition.occurrenceId,
    bridgeSessionId: value.reconciliationBridgeSessionId,
    generationId: reconciliationGenerationId(value.transition.occurrenceId, value.reconciliationBridgeSessionId),
    endedAtMs, stopAtMs, expiresAtMs, binding: backfillRecordingBinding(value.recording),
    bridgeGapsJson, runtimeGapsJson, warningsJson };
}

function insertBackfillSeed(db: Database.Database, seed: PreparedBackfillSeed): void {
  const organizer = seed.input.identity.organizer;
  const capability = seed.recording.recovery!.capability;
  withConstraintTranslation(() => db.prepare(`INSERT INTO backfill_seeds (
    occurrence_id,provider,provider_meeting_id,meeting_no,occurrence_started_at,title,
    organizer_person_id,organizer_display_name,organizer_source,ended_at,ended_at_ms,stop_at_ms,expires_at_ms,
    bridge_session_id,generation_id,source_session_id,capability_recording_handle,capability_sha256,capability_key_id,capability_authorization,
    recording_path,recording_format,recording_encryption,recording_bytes,recording_device,recording_inode,recording_duration_ms,
    recording_sha256,recording_key_id,bridge_gaps_json,runtime_gaps_json,processing_warnings_json,runtime_profile,
    stt_provider,stt_model,live_stream_model,final_batch_model,text_provider,text_model,agent_version
  ) VALUES (
    @occurrenceId,@provider,@providerMeetingId,@meetingNo,@occurrenceStartedAt,@title,
    @organizerPersonId,@organizerDisplayName,@organizerSource,@endedAt,@endedAtMs,@stopAtMs,@expiresAtMs,
    @bridgeSessionId,@generationId,@sourceSessionId,@capabilityRecordingHandle,@capabilitySha256,@capabilityKeyId,@capabilityAuthorization,
    @recordingPath,@recordingFormat,@recordingEncryption,@recordingBytes,@recordingDevice,@recordingInode,@recordingDurationMs,
    @recordingSha256,@recordingKeyId,@bridgeGapsJson,@runtimeGapsJson,@warningsJson,@runtimeProfile,
    @sttProvider,@sttModel,@liveStreamModel,@finalBatchModel,@textProvider,@textModel,@agentVersion
  )`).run({
    occurrenceId: seed.occurrenceId, provider: seed.input.provider,
    providerMeetingId: seed.input.identity.providerMeetingId, meetingNo: seed.input.identity.meetingNo,
    occurrenceStartedAt: seed.input.identity.occurrenceStartedAt, title: seed.input.identity.title,
    organizerPersonId: organizer?.feishuUserId ?? null, organizerDisplayName: organizer?.displayName ?? null,
    organizerSource: organizer?.source ?? null, endedAt: seed.input.endedAt, endedAtMs: seed.endedAtMs,
    stopAtMs: seed.stopAtMs, expiresAtMs: seed.expiresAtMs, bridgeSessionId: seed.bridgeSessionId,
    generationId: seed.generationId, sourceSessionId: capability.sourceSessionId.toString(),
    capabilityRecordingHandle: capability.recordingHandle, capabilitySha256: capability.sha256,
    capabilityKeyId: capability.keyId, capabilityAuthorization: capability.authorization,
    recordingPath: seed.binding.canonicalPath, recordingFormat: audioFormatToken(seed.recording.format),
    recordingEncryption: seed.input.encryption, recordingBytes: seed.binding.bytes,
    recordingDevice: seed.binding.device, recordingInode: seed.binding.inode,
    recordingDurationMs: seed.recording.durationMs, recordingSha256: seed.recording.sha256,
    recordingKeyId: seed.recording.keyId, bridgeGapsJson: seed.bridgeGapsJson,
    runtimeGapsJson: seed.runtimeGapsJson, warningsJson: seed.warningsJson,
    runtimeProfile: seed.input.provenance.runtimeProfile, sttProvider: seed.input.provenance.sttProvider,
    sttModel: seed.input.provenance.sttModel, liveStreamModel: seed.input.provenance.liveStreamModel,
    finalBatchModel: seed.input.provenance.finalBatchModel, textProvider: seed.input.provenance.textProvider,
    textModel: seed.input.provenance.textModel, agentVersion: seed.input.provenance.agentVersion,
  }));
  withConstraintTranslation(() => db.prepare(`INSERT INTO backfill_seed_lifecycle
    (occurrence_id,owner,state,stop_at_ms,expires_at_ms,initial_build_next_attempt_at_ms,last_observed_at_ms)
    VALUES (?,'seed','pending',?,?,?,?)`)
    .run(seed.occurrenceId, seed.stopAtMs, seed.expiresAtMs, seed.endedAtMs, seed.endedAtMs));
}

type BackfillSeedRaw = {
  occurrence_id: string; provider: string; provider_meeting_id: string; meeting_no: string; occurrence_started_at: string; title: string;
  organizer_person_id: string | null; organizer_display_name: string | null; organizer_source: "reservation" | "calendar_event" | null;
  ended_at: string; ended_at_ms: number; stop_at_ms: number; expires_at_ms: number; bridge_session_id: string; generation_id: string;
  source_session_id: string; capability_recording_handle: string; capability_sha256: string; capability_key_id: string; capability_authorization: string;
  recording_path: string; recording_format: string; recording_encryption: string; recording_bytes: number; recording_device: string; recording_inode: string;
  recording_duration_ms: number; recording_sha256: string; recording_key_id: string; bridge_gaps_json: string; runtime_gaps_json: string;
  processing_warnings_json: string; runtime_profile: "offline" | "online"; stt_provider: string; stt_model: string; live_stream_model: string;
  final_batch_model: string; text_provider: string; text_model: string; agent_version: string;
};

function getBackfillSeed(db: Database.Database, occurrenceId: string): BackfillSeed | null {
  if (currentSchemaVersion(db) < 23) return null;
  requirePrivateState(db);
  const row = db.prepare("SELECT * FROM backfill_seeds WHERE occurrence_id=?").get(occurrenceId) as BackfillSeedRaw | undefined;
  if (!row) return null;
  const runtimeGaps = JSON.parse(row.runtime_gaps_json) as Array<{ startedAtMs: string; endedAtMs: string | null; reason: string }>;
  return {
    occurrenceId: row.occurrence_id, provider: row.provider, providerMeetingId: row.provider_meeting_id,
    meetingNo: row.meeting_no, occurrenceStartedAt: row.occurrence_started_at, title: row.title,
    organizer: row.organizer_person_id === null ? null : { feishuUserId: row.organizer_person_id,
      displayName: row.organizer_display_name!, source: row.organizer_source! },
    endedAt: row.ended_at, endedAtMs: row.ended_at_ms, stopAtMs: row.stop_at_ms, expiresAtMs: row.expires_at_ms,
    bridgeSessionId: row.bridge_session_id, generationId: row.generation_id,
    capability: { sourceSessionId: BigInt(row.source_session_id), recordingHandle: row.capability_recording_handle,
      sha256: row.capability_sha256, keyId: row.capability_key_id, authorization: row.capability_authorization },
    recordingPath: row.recording_path, recordingFormat: row.recording_format, recordingEncryption: row.recording_encryption,
    recordingBytes: row.recording_bytes, recordingDevice: row.recording_device, recordingInode: row.recording_inode,
    recordingDurationMs: row.recording_duration_ms, recordingSha256: row.recording_sha256, recordingKeyId: row.recording_key_id,
    bridgeGaps: JSON.parse(row.bridge_gaps_json) as RecordingInput["gaps"],
    runtimeGaps: runtimeGaps.map((gap) => ({ startedAtMs: BigInt(gap.startedAtMs),
      endedAtMs: gap.endedAtMs === null ? null : BigInt(gap.endedAtMs), reason: gap.reason })),
    processingWarnings: JSON.parse(row.processing_warnings_json) as BackfillSeed["processingWarnings"],
    provenance: { runtimeProfile: row.runtime_profile, sttProvider: row.stt_provider, sttModel: row.stt_model,
      liveStreamModel: row.live_stream_model, finalBatchModel: row.final_batch_model,
      textProvider: row.text_provider, textModel: row.text_model, agentVersion: row.agent_version },
  };
}

function claimBackfillSeedBuild(db: Database.Database, input: ClaimBackfillSeedBuildInput): BackfillSeedBuildClaim | null {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) throw seedViolation("invalid initial-build claim clock");
  if (!/^[0-9a-f]{32}$/.test(input.claimToken)) throw seedViolation("invalid initial-build claim token");
  if (!Number.isSafeInteger(input.operationBudgetMs) || input.operationBudgetMs < MIN_OPERATION_BUDGET_MS || input.operationBudgetMs > MAX_OPERATION_BUDGET_MS) {
    throw seedViolation("invalid initial-build operation budget");
  }
  return db.transaction(() => {
    if (stopDueBackfillInTransaction(db, input.nowMs) !== null) return null;
    const candidate = db.prepare(`SELECT occurrence_id,MAX(?,last_observed_at_ms) AS observed_at_ms
      FROM backfill_seed_lifecycle
      WHERE owner='seed' AND state='pending' AND initial_build_attempts<1000000
        AND process_cleanup_state IS NULL
        AND initial_build_next_attempt_at_ms<=MAX(?,last_observed_at_ms)
        AND MAX(?,last_observed_at_ms)<stop_at_ms
        AND (build_claim_token IS NULL OR build_claim_expires_at_ms<=MAX(?,last_observed_at_ms))
      ORDER BY initial_build_next_attempt_at_ms,stop_at_ms,occurrence_id LIMIT 1`)
      .get(input.nowMs, input.nowMs, input.nowMs, input.nowMs) as { occurrence_id: string; observed_at_ms: number } | undefined;
    if (!candidate) return null;
    const claimExpiresAtMs = candidate.observed_at_ms + input.operationBudgetMs + BUILD_CLAIM_MARGIN_MS;
    if (!Number.isSafeInteger(claimExpiresAtMs)) throw seedViolation("initial-build claim deadline overflow");
    const next = (db.prepare("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM delivery_journal WHERE occurrence_id=?")
      .get(candidate.occurrence_id) as { revision: number }).revision;
    if (!Number.isSafeInteger(next) || next < 1 || next > 1_000_000) throw seedViolation("backfill target revision exhausted");
    const changed = db.prepare(`UPDATE backfill_seed_lifecycle
      SET build_claim_token=?,build_claim_expires_at_ms=?,initial_build_attempts=initial_build_attempts+1,
          last_observed_at_ms=?
      WHERE occurrence_id=? AND owner='seed' AND state='pending' AND stop_at_ms>?
        AND process_cleanup_state IS NULL
        AND initial_build_next_attempt_at_ms<=? AND initial_build_attempts<1000000
        AND (build_claim_token IS NULL OR build_claim_expires_at_ms<=?)`)
      .run(input.claimToken, claimExpiresAtMs, candidate.observed_at_ms, candidate.occurrence_id,
        candidate.observed_at_ms, candidate.observed_at_ms, candidate.observed_at_ms).changes;
    if (changed !== 1) return null;
    const lifecycle = db.prepare("SELECT initial_build_attempts FROM backfill_seed_lifecycle WHERE occurrence_id=?")
      .get(candidate.occurrence_id) as { initial_build_attempts: number };
    const seed = getBackfillSeed(db, candidate.occurrence_id);
    if (seed === null) throw new Error("claimed backfill seed is missing");
    return { seed, claimToken: input.claimToken, claimExpiresAtMs, attempt: lifecycle.initial_build_attempts,
      targetRevision: next, observedAtMs: candidate.observed_at_ms };
  }).immediate();
}

function claimBackfillJob(db: Database.Database, input: ClaimBackfillJobInput): BackfillJobClaim | null {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) throw seedViolation("invalid backfill-job claim clock");
  if (!/^[0-9a-f]{32}$/.test(input.claimToken)) throw seedViolation("invalid backfill-job claim token");
  if (!Number.isSafeInteger(input.operationBudgetMs) || input.operationBudgetMs < MIN_OPERATION_BUDGET_MS || input.operationBudgetMs > MAX_OPERATION_BUDGET_MS) {
    throw seedViolation("invalid backfill-job operation budget");
  }
  return db.transaction(() => {
    if (stopDueBackfillInTransaction(db, input.nowMs) !== null) return null;
    const candidate = db.prepare(`SELECT job.occurrence_id,job.target_revision,
        MAX(?,lifecycle.last_observed_at_ms) AS observed_at_ms FROM backfill_jobs AS job
      JOIN backfill_seed_lifecycle AS lifecycle ON lifecycle.occurrence_id=job.occurrence_id
        AND lifecycle.owner='delivery' AND lifecycle.state='pending' AND lifecycle.deleted_at_ms IS NULL
        AND lifecycle.process_cleanup_state IS NULL
        AND lifecycle.stop_at_ms=job.stop_at_ms
      WHERE MAX(?,lifecycle.last_observed_at_ms)<job.stop_at_ms AND job.attempt_count<1000000
        AND ((job.state='due' AND job.next_attempt_at_ms<=MAX(?,lifecycle.last_observed_at_ms))
          OR (job.state='claimed' AND job.claim_expires_at_ms<=MAX(?,lifecycle.last_observed_at_ms)))
      ORDER BY job.next_attempt_at_ms,job.occurrence_id LIMIT 1`)
      .get(input.nowMs, input.nowMs, input.nowMs, input.nowMs) as {
        occurrence_id: string; target_revision: number | null; observed_at_ms: number;
      } | undefined;
    if (!candidate) return null;
    const claimExpiresAtMs = candidate.observed_at_ms + input.operationBudgetMs + BUILD_CLAIM_MARGIN_MS;
    if (!Number.isSafeInteger(claimExpiresAtMs)) throw seedViolation("backfill-job claim deadline overflow");
    const next = candidate.target_revision ?? ((db.prepare(
      "SELECT COALESCE(MAX(revision),0)+1 AS revision FROM delivery_journal WHERE occurrence_id=?",
    ).get(candidate.occurrence_id) as { revision: number }).revision);
    if (!Number.isSafeInteger(next) || next < 1 || next > 1_000_000) throw seedViolation("backfill target revision exhausted");
    const changed = db.prepare(`UPDATE backfill_jobs
      SET state='claimed',claim_token=?,claim_expires_at_ms=?,target_revision=?,attempt_count=attempt_count+1
      WHERE occurrence_id=? AND stop_at_ms>? AND attempt_count<1000000
        AND ((state='due' AND next_attempt_at_ms<=?) OR (state='claimed' AND claim_expires_at_ms<=?))
        AND EXISTS (SELECT 1 FROM backfill_seed_lifecycle AS lifecycle
          WHERE lifecycle.occurrence_id=backfill_jobs.occurrence_id
            AND lifecycle.owner='delivery' AND lifecycle.state='pending' AND lifecycle.deleted_at_ms IS NULL
            AND lifecycle.process_cleanup_state IS NULL
            AND lifecycle.stop_at_ms=backfill_jobs.stop_at_ms)`)
      .run(input.claimToken, claimExpiresAtMs, next, candidate.occurrence_id,
        candidate.observed_at_ms, candidate.observed_at_ms, candidate.observed_at_ms).changes;
    if (changed !== 1) return null;
    db.prepare("UPDATE backfill_seed_lifecycle SET last_observed_at_ms=? WHERE occurrence_id=?")
      .run(candidate.observed_at_ms, candidate.occurrence_id);
    const row = db.prepare("SELECT attempt_count,stop_at_ms FROM backfill_jobs WHERE occurrence_id=?")
      .get(candidate.occurrence_id) as { attempt_count: number; stop_at_ms: number };
    const seed = getBackfillSeed(db, candidate.occurrence_id);
    if (seed === null) throw new Error("claimed backfill job seed is missing");
    const noVerbatimQuotes = refusalColumn(db) === "refusal_reason" && db.prepare(`SELECT 1 FROM delivery_journal
      WHERE occurrence_id=? AND refusal_reason='${OWN_TRANSCRIPT_REFUSAL}' LIMIT 1`).get(candidate.occurrence_id) !== undefined;
    return { ...(noVerbatimQuotes ? { noVerbatimQuotes: true as const } : {}), seed, claimToken: input.claimToken, claimExpiresAtMs, attempt: row.attempt_count,
      targetRevision: next, stopAtMs: row.stop_at_ms, observedAtMs: candidate.observed_at_ms };
  }).immediate();
}

function beginBackfillProcess(db: Database.Database, input: BeginBackfillProcessInput): { readonly processOwnerToken: string } {
  validBackfillClock(input.nowMs);
  if (!/^[0-9a-f]{32}$/.test(input.claimToken)) throw seedViolation("invalid backfill process token");
  const deadlineClosed = Symbol("backfill process deadline closed");
  const claimExpired = Symbol("backfill process claim expired");
  const result = db.transaction((): { readonly processOwnerToken: string } | typeof deadlineClosed | typeof claimExpired => {
    const lifecycle = db.prepare(`SELECT owner,state,stop_at_ms,build_claim_token,build_claim_expires_at_ms,
      process_owner_token,process_cleanup_state FROM backfill_seed_lifecycle WHERE occurrence_id=?`)
      .get(input.occurrenceId) as { owner: string; state: string; stop_at_ms: number;
        build_claim_token: string | null; build_claim_expires_at_ms: number | null;
        process_owner_token: string | null; process_cleanup_state: string | null } | undefined;
    if (!lifecycle || lifecycle.state !== "pending" || lifecycle.process_owner_token !== null ||
        lifecycle.process_cleanup_state !== null) throw seedViolation("backfill process owner is unavailable");
    let claimExpiresAtMs: number;
    if (input.kind === "initial") {
      if (lifecycle.owner !== "seed" || lifecycle.build_claim_token !== input.claimToken ||
          lifecycle.build_claim_expires_at_ms === null) {
        throw seedViolation("initial backfill process claim is stale");
      }
      claimExpiresAtMs = lifecycle.build_claim_expires_at_ms;
    } else {
      const job = db.prepare(`SELECT state,claim_token,claim_expires_at_ms,target_revision
        FROM backfill_jobs WHERE occurrence_id=?`).get(input.occurrenceId) as { state: string;
          claim_token: string | null; claim_expires_at_ms: number | null; target_revision: number | null } | undefined;
      if (lifecycle.owner !== "delivery" || !job || job.state !== "claimed" ||
          job.claim_token !== input.claimToken || job.claim_expires_at_ms === null ||
          job.target_revision !== input.targetRevision) {
        throw seedViolation("retry backfill process claim is stale");
      }
      claimExpiresAtMs = job.claim_expires_at_ms;
    }
    const effective = observeBackfillWall(db, input.occurrenceId, input.nowMs);
    if (effective >= lifecycle.stop_at_ms) {
      stopBackfillOccurrence(db, input.occurrenceId, null);
      return deadlineClosed;
    }
    if (claimExpiresAtMs <= effective) return claimExpired;
    const changed = db.prepare(`UPDATE backfill_seed_lifecycle SET process_owner_token=?,process_cleanup_state='active'
      WHERE occurrence_id=? AND state='pending' AND process_cleanup_state IS NULL`)
      .run(input.claimToken, input.occurrenceId).changes;
    if (changed !== 1) throw seedViolation("backfill process owner is unavailable");
    return { processOwnerToken: input.claimToken };
  }).immediate();
  if (result === deadlineClosed) throw seedViolation("backfill process is past its original stop deadline");
  if (result === claimExpired) throw seedViolation("backfill process claim is stale or expired");
  return result;
}

function settleBackfillProcess(db: Database.Database, input: SettleBackfillProcessInput): { readonly outcome: "confirmed" | "failed" } {
  validBackfillClock(input.nowMs);
  if (!/^[0-9a-f]{32}$/.test(input.processOwnerToken)) throw seedViolation("invalid backfill process token");
  return db.transaction(() => {
    observeBackfillWall(db, input.occurrenceId, input.nowMs);
    const marker = db.prepare(`SELECT process_owner_token,process_cleanup_state
      FROM backfill_seed_lifecycle WHERE occurrence_id=?`).get(input.occurrenceId) as {
        process_owner_token: string | null; process_cleanup_state: string | null;
      } | undefined;
    if (!marker || marker.process_cleanup_state !== "active" || marker.process_owner_token !== input.processOwnerToken) {
      throw seedViolation("backfill process owner is not active");
    }
    if (input.outcome === "confirmed") {
      db.prepare(`UPDATE backfill_seed_lifecycle SET process_owner_token=NULL,process_cleanup_state=NULL
        WHERE occurrence_id=? AND process_cleanup_state='active' AND process_owner_token=?`)
        .run(input.occurrenceId, input.processOwnerToken);
    } else {
      db.prepare(`UPDATE backfill_seed_lifecycle SET process_cleanup_state='failed'
        WHERE occurrence_id=? AND process_cleanup_state='active' AND process_owner_token=?`)
        .run(input.occurrenceId, input.processOwnerToken);
      stopBackfillOccurrence(db, input.occurrenceId, "cleanup_failed");
    }
    return { outcome: input.outcome };
  }).immediate();
}

function validBackfillClock(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw seedViolation("invalid backfill clock");
}

function observeBackfillWall(db: Database.Database, occurrenceId: string, nowMs: number): number {
  validBackfillClock(nowMs);
  const row = db.prepare("SELECT last_observed_at_ms FROM backfill_seed_lifecycle WHERE occurrence_id=?")
    .get(occurrenceId) as { last_observed_at_ms: number } | undefined;
  if (!row) throw seedViolation("backfill lifecycle is missing");
  const effective = Math.max(nowMs, row.last_observed_at_ms);
  db.prepare("UPDATE backfill_seed_lifecycle SET last_observed_at_ms=? WHERE occurrence_id=?")
    .run(effective, occurrenceId);
  return effective;
}

function registerBackfillWarning(db: Database.Database, occurrenceId: string): void {
  const lifecycle = db.prepare("SELECT stop_at_ms,expires_at_ms FROM backfill_seed_lifecycle WHERE occurrence_id=?")
    .get(occurrenceId) as { stop_at_ms: number; expires_at_ms: number };
  db.prepare(`INSERT OR IGNORE INTO backfill_warning_intents
    (occurrence_id,stop_at_ms,expires_at_ms,reason,state,attempt_count,next_attempt_at_ms)
    VALUES (?,?,?,'backfill_stopped','pending',0,?)`)
    .run(occurrenceId, lifecycle.stop_at_ms, lifecycle.expires_at_ms, lifecycle.stop_at_ms);
}

function stopBackfillOccurrence(db: Database.Database, occurrenceId: string, reason: "cleanup_failed" | "attempts_exhausted" | null): void {
  db.prepare(`UPDATE backfill_seed_lifecycle SET state='stopped',build_claim_token=NULL,
    build_claim_expires_at_ms=NULL,initial_build_last_reason=COALESCE(?,initial_build_last_reason)
    WHERE occurrence_id=? AND state='pending'`).run(reason, occurrenceId);
  db.prepare(`UPDATE backfill_jobs SET state='stopped',claim_token=NULL,claim_expires_at_ms=NULL,
    last_reason=COALESCE(?,last_reason) WHERE occurrence_id=? AND state!='complete'`)
    .run(reason, occurrenceId);
  registerBackfillWarning(db, occurrenceId);
}

function failBackfillBuild(db: Database.Database, input: BackfillBuildFailure): BackfillFailureResult {
  validBackfillClock(input.nowMs);
  if (!/^[0-9a-f]{32}$/.test(input.claimToken)) {
    throw seedViolation("invalid backfill failure input");
  }
  validateBackfillRetryDelay(input.retryDelayMs);
  const expiredClaim = Symbol("expired backfill claim");
  const result = db.transaction((): BackfillFailureResult | typeof expiredClaim => {
    const effective = observeBackfillWall(db, input.occurrenceId, input.nowMs);
    const lifecycle = db.prepare(`SELECT owner,state,stop_at_ms,initial_build_attempts,
      build_claim_token,build_claim_expires_at_ms FROM backfill_seed_lifecycle WHERE occurrence_id=?`)
      .get(input.occurrenceId) as { owner: string; state: string; stop_at_ms: number; initial_build_attempts: number;
        build_claim_token: string | null; build_claim_expires_at_ms: number | null };
    if (input.kind === "initial") {
      if (lifecycle.owner !== "seed" || lifecycle.state !== "pending" || lifecycle.build_claim_token !== input.claimToken ||
          lifecycle.build_claim_expires_at_ms === null) {
        throw seedViolation("initial backfill claim is stale");
      }
      if (input.reason !== "cleanup_failed" && lifecycle.build_claim_expires_at_ms <= effective) return expiredClaim;
      if (input.reason === "cleanup_failed" || lifecycle.initial_build_attempts >= 1_000_000) {
        stopBackfillOccurrence(db, input.occurrenceId, input.reason === "cleanup_failed" ? "cleanup_failed" : "attempts_exhausted");
        return { kind: "stopped" as const };
      }
      const nextAttemptAtMs = backfillRetryAt(effective, input.retryDelayMs, lifecycle.stop_at_ms);
      db.prepare(`UPDATE backfill_seed_lifecycle SET build_claim_token=NULL,build_claim_expires_at_ms=NULL,
        initial_build_next_attempt_at_ms=?,initial_build_last_reason=? WHERE occurrence_id=?`)
        .run(nextAttemptAtMs, input.reason, input.occurrenceId);
      return { kind: "rescheduled" as const };
    }
    const job = db.prepare(`SELECT state,attempt_count,claim_token,claim_expires_at_ms,target_revision,stop_at_ms
      FROM backfill_jobs WHERE occurrence_id=?`).get(input.occurrenceId) as { state: string; attempt_count: number;
        claim_token: string | null; claim_expires_at_ms: number | null; target_revision: number | null; stop_at_ms: number } | undefined;
    if (lifecycle.owner !== "delivery" || lifecycle.state !== "pending" || !job || job.state !== "claimed" ||
        job.claim_token !== input.claimToken || job.claim_expires_at_ms === null ||
        job.target_revision !== input.targetRevision) throw seedViolation("retry backfill claim is stale");
    if (input.reason !== "cleanup_failed" && job.claim_expires_at_ms <= effective) return expiredClaim;
    if (input.reason === "cleanup_failed" || job.attempt_count >= 1_000_000) {
      stopBackfillOccurrence(db, input.occurrenceId, input.reason === "cleanup_failed" ? "cleanup_failed" : "attempts_exhausted");
      return { kind: "stopped" as const };
    }
    const nextAttemptAtMs = backfillRetryAt(effective, input.retryDelayMs, job.stop_at_ms);
    db.prepare(`UPDATE backfill_jobs SET state='due',next_attempt_at_ms=?,claim_token=NULL,
      claim_expires_at_ms=NULL,last_reason=? WHERE occurrence_id=?`)
      .run(nextAttemptAtMs, input.reason, input.occurrenceId);
    return { kind: "rescheduled" as const };
  }).immediate();
  if (result === expiredClaim) throw seedViolation("backfill claim is stale or expired");
  return result;
}

function validateBackfillRetryDelay(retryDelayMs: number): void {
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1_000 || retryDelayMs > 60_000) {
    throw seedViolation("invalid backfill retry delay");
  }
}

function backfillRetryAt(nowMs: number, retryDelayMs: number, stopAtMs: number): number {
  validateBackfillRetryDelay(retryDelayMs);
  const scheduledAtMs = nowMs + retryDelayMs;
  if (!Number.isSafeInteger(scheduledAtMs)) throw seedViolation("invalid backfill retry delay");
  return Math.min(stopAtMs, scheduledAtMs);
}

function stopDueBackfill(db: Database.Database, nowMs: number): { readonly occurrenceId: string } | null {
  validBackfillClock(nowMs);
  return db.transaction(() => stopDueBackfillInTransaction(db, nowMs)).immediate();
}

function stopDueBackfillInTransaction(db: Database.Database, nowMs: number): { readonly occurrenceId: string } | null {
  const row = db.prepare(`SELECT lifecycle.occurrence_id,
      MAX(?,lifecycle.last_observed_at_ms) AS observed_at_ms,
      CASE WHEN lifecycle.owner='seed' THEN lifecycle.initial_build_attempts
           ELSE COALESCE(job.attempt_count,0) END AS attempts
    FROM backfill_seed_lifecycle AS lifecycle
    LEFT JOIN backfill_jobs AS job ON job.occurrence_id=lifecycle.occurrence_id
    WHERE lifecycle.state='pending'
      AND ((lifecycle.owner='seed' AND (MAX(?,lifecycle.last_observed_at_ms)>=lifecycle.stop_at_ms OR lifecycle.initial_build_attempts>=1000000))
        OR (lifecycle.owner='delivery' AND (
          (job.state!='complete'
            AND (MAX(?,lifecycle.last_observed_at_ms)>=lifecycle.stop_at_ms OR job.attempt_count>=1000000))
          OR (job.occurrence_id IS NULL AND MAX(?,lifecycle.last_observed_at_ms)>=lifecycle.stop_at_ms
            AND EXISTS (SELECT 1 FROM delivery_journal AS delivery
              WHERE delivery.occurrence_id=lifecycle.occurrence_id
                AND delivery.transcript_complete=1 AND delivery.published_at_ms IS NULL
                AND delivery.deleted_at_ms IS NULL)))))
    ORDER BY lifecycle.stop_at_ms,lifecycle.occurrence_id LIMIT 1`)
    .get(nowMs, nowMs, nowMs, nowMs) as { occurrence_id: string; observed_at_ms: number; attempts: number } | undefined;
  if (!row) return null;
  observeBackfillWall(db, row.occurrence_id, row.observed_at_ms);
  stopBackfillOccurrence(db, row.occurrence_id, row.attempts >= 1_000_000 ? "attempts_exhausted" : null);
  return { occurrenceId: row.occurrence_id };
}

const WARNING_CLAIM_MS = 30_000;
function claimBackfillWarning(db: Database.Database, nowMs: number, claimToken: string): BackfillWarningClaim | null {
  validBackfillClock(nowMs);
  if (!/^[0-9a-f]{32}$/.test(claimToken)) throw seedViolation("invalid warning claim token");
  return db.transaction(() => {
    db.prepare(`UPDATE backfill_warning_intents SET state='terminal',terminal_reason='expired',
      claim_token=NULL,claim_expires_at_ms=NULL
      WHERE state IN ('pending','claimed') AND expires_at_ms<=MAX(?,
        (SELECT last_observed_at_ms FROM backfill_seed_lifecycle WHERE occurrence_id=backfill_warning_intents.occurrence_id))`).run(nowMs);
    db.prepare(`UPDATE backfill_warning_intents SET state='terminal',terminal_reason='attempts_exhausted',
      claim_token=NULL,claim_expires_at_ms=NULL
      WHERE attempt_count>=1000000 AND (state='pending' OR (state='claimed' AND claim_expires_at_ms<=MAX(?,
        (SELECT last_observed_at_ms FROM backfill_seed_lifecycle WHERE occurrence_id=backfill_warning_intents.occurrence_id))))`).run(nowMs);
    const row = db.prepare(`SELECT warning.occurrence_id,warning.stop_at_ms,warning.expires_at_ms,warning.attempt_count,
        MAX(?,lifecycle.last_observed_at_ms) AS observed_at_ms
      FROM backfill_warning_intents AS warning JOIN backfill_seed_lifecycle AS lifecycle USING(occurrence_id)
      WHERE warning.state IN ('pending','claimed') AND warning.attempt_count<1000000
        AND MAX(?,lifecycle.last_observed_at_ms)>=warning.stop_at_ms
        AND MAX(?,lifecycle.last_observed_at_ms)<warning.expires_at_ms
        AND warning.next_attempt_at_ms<=MAX(?,lifecycle.last_observed_at_ms)
        AND (warning.state='pending' OR warning.claim_expires_at_ms<=MAX(?,lifecycle.last_observed_at_ms))
      ORDER BY warning.next_attempt_at_ms,warning.occurrence_id LIMIT 1`)
      .get(nowMs, nowMs, nowMs, nowMs, nowMs) as { occurrence_id: string; stop_at_ms: number;
        expires_at_ms: number; attempt_count: number; observed_at_ms: number } | undefined;
    if (!row) return null;
    const claimExpiresAtMs = row.observed_at_ms + WARNING_CLAIM_MS;
    if (!Number.isSafeInteger(claimExpiresAtMs)) throw seedViolation("warning claim deadline overflow");
    const changed = db.prepare(`UPDATE backfill_warning_intents SET state='claimed',claim_token=?,
      claim_expires_at_ms=?,attempt_count=attempt_count+1 WHERE occurrence_id=? AND state IN ('pending','claimed')
      AND attempt_count<1000000 AND (state='pending' OR claim_expires_at_ms<=?)`)
      .run(claimToken, claimExpiresAtMs, row.occurrence_id, row.observed_at_ms).changes;
    if (changed !== 1) return null;
    observeBackfillWall(db, row.occurrence_id, row.observed_at_ms);
    const payload = { schema: "meeting-operator-warning/v1" as const, occurrenceId: row.occurrence_id,
      stopAt: new Date(row.stop_at_ms).toISOString(), expiresAt: new Date(row.expires_at_ms).toISOString(),
      reason: "backfill_stopped" as const };
    return { occurrenceId: row.occurrence_id, claimToken, claimExpiresAtMs,
      attempt: row.attempt_count + 1, payload, key: operatorWarningKey(payload) };
  }).immediate();
}

function acceptBackfillWarning(db: Database.Database, input: {
  occurrenceId: string; claimToken: string; key: string; nowMs: number;
}): void {
  const expiredClaim = Symbol("expired warning claim");
  const result = db.transaction((): void | typeof expiredClaim => {
    const effective = observeBackfillWall(db, input.occurrenceId, input.nowMs);
    const row = db.prepare(`SELECT state,stop_at_ms,expires_at_ms,claim_token,claim_expires_at_ms
      FROM backfill_warning_intents WHERE occurrence_id=?`)
      .get(input.occurrenceId) as { state: string; stop_at_ms: number; expires_at_ms: number;
        claim_token: string | null; claim_expires_at_ms: number | null } | undefined;
    if (!row) throw seedViolation("warning intent is missing");
    const payload = { schema: "meeting-operator-warning/v1" as const, occurrenceId: input.occurrenceId,
      stopAt: new Date(row.stop_at_ms).toISOString(), expiresAt: new Date(row.expires_at_ms).toISOString(),
      reason: "backfill_stopped" as const };
    if (input.key !== operatorWarningKey(payload)) throw seedViolation("warning receipt key mismatch");
    if (row.state === "accepted") return;
    if (row.state !== "claimed" || row.claim_token !== input.claimToken || row.claim_expires_at_ms === null) {
      throw seedViolation("warning claim is stale or expired");
    }
    if (row.expires_at_ms <= effective) {
      db.prepare(`UPDATE backfill_warning_intents SET state='terminal',terminal_reason='expired',
        claim_token=NULL,claim_expires_at_ms=NULL WHERE occurrence_id=? AND state='claimed' AND claim_token=?`)
        .run(input.occurrenceId, input.claimToken);
      return expiredClaim;
    }
    if (row.claim_expires_at_ms <= effective) return expiredClaim;
    const changed = db.prepare(`UPDATE backfill_warning_intents SET state='accepted',accepted_at_ms=?,
      claim_token=NULL,claim_expires_at_ms=NULL WHERE occurrence_id=? AND state='claimed'
      AND claim_token=? AND claim_expires_at_ms>? AND expires_at_ms>?`)
      .run(effective, input.occurrenceId, input.claimToken, effective, effective).changes;
    if (changed !== 1) throw seedViolation("warning claim is stale or expired");
  }).immediate();
  if (result === expiredClaim) throw seedViolation("warning claim is stale or expired");
}

function failBackfillWarning(db: Database.Database, input: {
  occurrenceId: string; claimToken: string; nowMs: number; retryDelayMs: number; reason: "sink_failed";
}): void {
  validateBackfillRetryDelay(input.retryDelayMs);
  const expiredClaim = Symbol("expired warning claim");
  const result = db.transaction((): void | typeof expiredClaim => {
    const effective = observeBackfillWall(db, input.occurrenceId, input.nowMs);
    const row = db.prepare(`SELECT state,attempt_count,claim_token,claim_expires_at_ms,expires_at_ms
      FROM backfill_warning_intents WHERE occurrence_id=?`)
      .get(input.occurrenceId) as { state: string; attempt_count: number; claim_token: string | null;
        claim_expires_at_ms: number | null; expires_at_ms: number } | undefined;
    if (!row) throw seedViolation("warning intent is missing");
    if (row.state !== "claimed" || row.claim_token !== input.claimToken || row.claim_expires_at_ms === null) {
      throw seedViolation("warning claim is stale or expired");
    }
    if (row.expires_at_ms <= effective) {
      db.prepare(`UPDATE backfill_warning_intents SET state='terminal',terminal_reason='expired',
        claim_token=NULL,claim_expires_at_ms=NULL WHERE occurrence_id=? AND state='claimed' AND claim_token=?`)
        .run(input.occurrenceId, input.claimToken);
      return;
    }
    if (row.claim_expires_at_ms <= effective) return expiredClaim;
    if (row.attempt_count >= 1_000_000) {
      db.prepare(`UPDATE backfill_warning_intents SET state='terminal',terminal_reason='attempts_exhausted',
        claim_token=NULL,claim_expires_at_ms=NULL WHERE occurrence_id=? AND state='claimed' AND claim_token=?`)
        .run(input.occurrenceId, input.claimToken);
      return;
    }
    const nextAttemptAtMs = backfillRetryAt(effective, input.retryDelayMs, row.expires_at_ms);
    const changed = db.prepare(`UPDATE backfill_warning_intents SET state='pending',next_attempt_at_ms=?,
      claim_token=NULL,claim_expires_at_ms=NULL WHERE occurrence_id=? AND state='claimed'
      AND claim_token=? AND claim_expires_at_ms>? AND expires_at_ms>?`)
      .run(nextAttemptAtMs, input.occurrenceId, input.claimToken, effective, effective).changes;
    if (changed !== 1) throw seedViolation("warning claim is stale or expired");
  }).immediate();
  if (result === expiredClaim) throw seedViolation("warning claim is stale or expired");
}

function claimExpiredBackfillSeedCleanup(db: Database.Database, nowMs: number, claimToken: string): BackfillSeedCleanupClaim | null {
  validBackfillClock(nowMs);
  if (!/^[0-9a-f]{32}$/.test(claimToken)) throw seedViolation("invalid seed cleanup token");
  return db.transaction(() => {
    const row = db.prepare(`SELECT lifecycle.occurrence_id,seed.recording_path,seed.capability_recording_handle,
        seed.recording_bytes,seed.recording_device,seed.recording_inode,
        MAX(?,lifecycle.last_observed_at_ms) AS observed_at_ms
      FROM backfill_seed_lifecycle AS lifecycle JOIN backfill_seeds AS seed USING(occurrence_id)
      WHERE lifecycle.owner='seed' AND lifecycle.state IN ('pending','stopped','cleanup_claimed')
        AND COALESCE(lifecycle.initial_build_last_reason,'')!='cleanup_failed'
        AND lifecycle.process_cleanup_state IS NULL
        AND MAX(?,lifecycle.last_observed_at_ms)>=lifecycle.expires_at_ms
        AND (lifecycle.state!='cleanup_claimed' OR lifecycle.cleanup_claim_expires_at_ms<=MAX(?,lifecycle.last_observed_at_ms))
      ORDER BY lifecycle.expires_at_ms,lifecycle.occurrence_id LIMIT 1`)
      .get(nowMs, nowMs, nowMs) as { occurrence_id: string; recording_path: string;
        capability_recording_handle: string; recording_bytes: number; recording_device: string;
        recording_inode: string; observed_at_ms: number } | undefined;
    if (!row) return null;
    const claimExpiresAtMs = row.observed_at_ms + WARNING_CLAIM_MS;
    if (!Number.isSafeInteger(claimExpiresAtMs)) throw seedViolation("seed cleanup deadline overflow");
    const changed = db.prepare(`UPDATE backfill_seed_lifecycle SET state='cleanup_claimed',
      build_claim_token=NULL,build_claim_expires_at_ms=NULL,cleanup_claim_token=?,
      cleanup_claim_expires_at_ms=?,last_observed_at_ms=? WHERE occurrence_id=? AND owner='seed'
      AND state IN ('pending','stopped','cleanup_claimed')
      AND process_cleanup_state IS NULL AND COALESCE(initial_build_last_reason,'')!='cleanup_failed'
      AND (state!='cleanup_claimed' OR cleanup_claim_expires_at_ms<=?)`)
      .run(claimToken, claimExpiresAtMs, row.observed_at_ms, row.occurrence_id, row.observed_at_ms).changes;
    if (changed !== 1) return null;
    registerBackfillWarning(db, row.occurrence_id);
    db.prepare(`UPDATE backfill_warning_intents SET state='terminal',terminal_reason='expired',
      claim_token=NULL,claim_expires_at_ms=NULL WHERE occurrence_id=? AND state IN ('pending','claimed')`)
      .run(row.occurrence_id);
    return { occurrenceId: row.occurrence_id, claimToken, claimExpiresAtMs,
      recordingPath: row.recording_path, recordingHandle: row.capability_recording_handle,
      recordingBytes: row.recording_bytes, recordingDevice: row.recording_device, recordingInode: row.recording_inode };
  }).immediate();
}

function completeBackfillSeedCleanup(db: Database.Database, input: {
  occurrenceId: string; claimToken: string; nowMs: number;
}): void {
  const expiredClaim = Symbol("expired seed cleanup claim");
  const result = db.transaction((): void | typeof expiredClaim => {
    const effective = observeBackfillWall(db, input.occurrenceId, input.nowMs);
    const owner = db.prepare(`SELECT owner,state,cleanup_claim_token,cleanup_claim_expires_at_ms
      FROM backfill_seed_lifecycle WHERE occurrence_id=?`).get(input.occurrenceId) as {
        owner: string; state: string; cleanup_claim_token: string | null; cleanup_claim_expires_at_ms: number | null;
      } | undefined;
    if (!owner || owner.owner !== "seed" || owner.state !== "cleanup_claimed" ||
        owner.cleanup_claim_token !== input.claimToken || owner.cleanup_claim_expires_at_ms === null) {
      throw seedViolation("seed cleanup claim is stale");
    }
    if (owner.cleanup_claim_expires_at_ms <= effective) return expiredClaim;
    const changed = db.prepare(`UPDATE backfill_seed_lifecycle SET state='deleted',deleted_at_ms=?,
      cleanup_claim_token=NULL,cleanup_claim_expires_at_ms=NULL WHERE occurrence_id=? AND owner='seed'
      AND state='cleanup_claimed' AND cleanup_claim_token=? AND cleanup_claim_expires_at_ms>?
      AND expires_at_ms<=?`)
      .run(effective, input.occurrenceId, input.claimToken, effective, effective).changes;
    if (changed !== 1) throw seedViolation("seed cleanup claim is stale");
  }).immediate();
  if (result === expiredClaim) throw seedViolation("seed cleanup claim is stale or expired");
}

function authorizeDeliveryEvidenceCleanup(db: Database.Database, occurrenceId: string, nowMs: number): boolean {
  validBackfillClock(nowMs);
  return db.transaction(() => {
    const lifecycle = db.prepare(`SELECT owner,state,expires_at_ms,initial_build_last_reason,
      process_cleanup_state FROM backfill_seed_lifecycle WHERE occurrence_id=?`).get(occurrenceId) as {
        owner: string; state: string; expires_at_ms: number; initial_build_last_reason: string | null;
        process_cleanup_state: string | null;
      } | undefined;
    if (!lifecycle) {
      const seeded = db.prepare("SELECT 1 FROM backfill_seeds WHERE occurrence_id=?").get(occurrenceId);
      return seeded === undefined;
    }
    const effective = observeBackfillWall(db, occurrenceId, nowMs);
    if (effective >= lifecycle.expires_at_ms && lifecycle.state === "pending") {
      stopBackfillOccurrence(db, occurrenceId, null);
    }
    const current = db.prepare(`SELECT owner,state,expires_at_ms,initial_build_last_reason,
      process_cleanup_state FROM backfill_seed_lifecycle WHERE occurrence_id=?`).get(occurrenceId) as {
        owner: string; state: string; expires_at_ms: number; initial_build_last_reason: string | null;
        process_cleanup_state: string | null;
      };
    const acceptedComplete = db.prepare(`SELECT 1 FROM delivery_journal WHERE occurrence_id=?
      AND transcript_complete=1 AND published_at_ms IS NOT NULL AND deleted_at_ms IS NULL LIMIT 1`).get(occurrenceId) !== undefined;
    const job = db.prepare("SELECT last_reason FROM backfill_jobs WHERE occurrence_id=?").get(occurrenceId) as {
      last_reason: string | null;
    } | undefined;
    const closed = effective >= current.expires_at_ms || acceptedComplete;
    return closed && current.owner === "delivery" && ["pending", "stopped"].includes(current.state) &&
      current.process_cleanup_state === null && current.initial_build_last_reason !== "cleanup_failed" &&
      job?.last_reason !== "cleanup_failed";
  }).immediate();
}

type AlignmentHeader = {
  attempt_id: string; generation_id: string; owner_id: string; token: string;
  source_session_id: string; recording_handle: string; sha256: string; key_id: string;
  state: "staging" | "complete" | "cleanup_failed" | "abandoned";
  page_count: number; entry_count: number; stored_bytes: number; warnings_json: string;
  coverage_status: RecordingAlignmentComplete["coverageStatus"] | null;
};

function alignmentHeader(db: Database.Database, attemptId: string): AlignmentHeader {
  const row = db.prepare(`SELECT a.* FROM recording_alignment_attempts a JOIN recording_recovery_bindings b
    ON a.generation_id=b.generation_id AND a.source_session_id=b.source_session_id AND a.recording_handle=b.recording_handle
    AND a.sha256=b.sha256 AND a.key_id=b.key_id WHERE a.attempt_id=? AND a.timing_contract='capture-clock/v1'
    AND length(CAST(a.warnings_json AS BLOB))<=4096`).get(attemptId) as AlignmentHeader | undefined;
  if (!row || !Number.isSafeInteger(row.page_count) || row.page_count < 0 || row.page_count > ALIGNMENT_LIMITS.attemptPages ||
      !Number.isSafeInteger(row.entry_count) || row.entry_count < 0 || row.entry_count > ALIGNMENT_LIMITS.attemptEntries ||
      !Number.isSafeInteger(row.stored_bytes) || row.stored_bytes < 0 || row.stored_bytes > ALIGNMENT_LIMITS.attemptBytes ||
      typeof row.warnings_json !== "string" || Buffer.byteLength(row.warnings_json) > 4096 ||
      !/^[1-9][0-9]{0,19}$/.test(row.source_session_id)) throw new Error("invalid private alignment header");
  // Reuse the bounded parsed-value validator, not a second wire decoder.
  headerCompletion(row);
  return row;
}

function headerCompletion(row: AlignmentHeader): RecordingAlignmentComplete {
  try { return validateAlignmentComplete({ type: "recording_alignment_complete",
    source: { sourceSessionId: BigInt(row.source_session_id), recordingHandle: row.recording_handle, sha256: row.sha256 },
    pageCount: BigInt(row.page_count), coverageStatus: row.coverage_status ?? "partial",
    warnings: JSON.parse(row.warnings_json) as string[], traversalSucceeded: true }); }
  catch { throw new Error("invalid private alignment header"); }
}

function alignmentFence(db: Database.Database, attempt: AlignmentAttempt): AlignmentHeader {
  if (requirePrivateState(db) !== attempt.storeIdentity) throw new Error("alignment owner fence mismatch");
  const row = alignmentHeader(db, attempt.attemptId);
  if (row.generation_id !== attempt.generationId || row.owner_id !== attempt.ownerId || row.token !== attempt.token || row.state !== "staging") {
    throw new Error("alignment owner fence mismatch");
  }
  return row;
}

function selectedReference(row: AlignmentHeader): SelectedAlignment {
  const terminal = headerCompletion(row);
  if (row.state !== "complete" || row.coverage_status === null) throw new Error("invalid selected alignment");
  return { generationId: row.generation_id, attemptId: row.attempt_id, source: terminal.source,
    timingContract: "capture-clock/v1", policyId: row.page_count === 0 ? null : "local-wall-estimate/v1",
    pageCount: row.page_count, entryCount: row.entry_count, storedBytes: row.stored_bytes,
    coverageStatus: terminal.coverageStatus, warnings: terminal.warnings };
}

function getSelectedAlignment(db: Database.Database, generationId: string): SelectedAlignment | null {
  requirePrivateState(db);
  const row = db.prepare("SELECT attempt_id FROM recording_alignment_selected WHERE generation_id=?").get(generationId) as { attempt_id: string } | undefined;
  if (!row) return null;
  const header = alignmentHeader(db, row.attempt_id);
  if (header.generation_id !== generationId) throw new Error("invalid selected alignment binding");
  return selectedReference(header);
}

function beginRecordingAlignment(db: Database.Database, generationId: string, ownerId: string, replace = false):
  { kind: "selected"; selected: SelectedAlignment } | { kind: "claimed"; attempt: AlignmentAttempt } {
  const storeIdentity = requirePrivateState(db);
  if (typeof ownerId !== "string" || ownerId.length === 0 || Buffer.byteLength(ownerId) > 128) throw new Error("invalid alignment owner");
  return db.transaction(() => {
    const selected = getSelectedAlignment(db, generationId);
    if (selected && !replace) return { kind: "selected" as const, selected };
    if (db.prepare(`SELECT 1 FROM recording_alignment_attempts WHERE generation_id=? AND attempt_id!=? LIMIT 1`)
      .get(generationId, selected?.attemptId ?? "")) throw new Error("alignment is owned or has unreclaimed pages");
    const binding = db.prepare("SELECT * FROM recording_recovery_bindings WHERE generation_id=?").get(generationId) as
      { source_session_id: string; recording_handle: string; sha256: string; key_id: string } | undefined;
    if (!binding) throw new Error("missing private recording recovery binding");
    const attempt = { storeIdentity, generationId, attemptId: randomUUID(), ownerId, token: randomUUID() };
    db.prepare(`INSERT INTO recording_alignment_attempts(attempt_id,generation_id,owner_id,token,source_session_id,recording_handle,sha256,key_id,timing_contract,state)
      VALUES(?,?,?,?,?,?,?,?,'capture-clock/v1','staging')`).run(attempt.attemptId, generationId, ownerId, attempt.token,
        binding.source_session_id, binding.recording_handle, binding.sha256, binding.key_id);
    alignmentHeader(db, attempt.attemptId);
    return { kind: "claimed" as const, attempt };
  }).immediate();
}

function sameAlignmentSource(row: AlignmentHeader, source: RecordingAlignmentPage["source"]): boolean {
  return source.sourceSessionId.toString() === row.source_session_id && source.recordingHandle === row.recording_handle && source.sha256 === row.sha256;
}

function appendRecordingAlignment(db: Database.Database, attempt: AlignmentAttempt, page: RecordingAlignmentPage): void {
  const payload = encodeAlignmentPage(page), bytes = Buffer.byteLength(payload);
  db.transaction(() => {
    const row = alignmentFence(db, attempt);
    if (!sameAlignmentSource(row, page.source) || page.pageIndex !== BigInt(row.page_count)) throw new Error("invalid alignment page binding or index");
    if (row.page_count + 1 > ALIGNMENT_LIMITS.attemptPages || row.entry_count + page.entries.length > ALIGNMENT_LIMITS.attemptEntries ||
      row.stored_bytes + bytes > ALIGNMENT_LIMITS.attemptBytes) throw new Error("alignment staging limit exceeded");
    const warnings = [...new Set([...headerCompletion(row).warnings, ...pageWarnings(page)])].sort();
    db.prepare("INSERT INTO recording_alignment_pages(attempt_id,page_index,entry_count,payload) VALUES(?,?,?,?)")
      .run(attempt.attemptId, row.page_count, page.entries.length, payload);
    db.prepare("UPDATE recording_alignment_attempts SET page_count=page_count+1,entry_count=entry_count+?,stored_bytes=stored_bytes+?,warnings_json=? WHERE attempt_id=?")
      .run(page.entries.length, bytes, JSON.stringify(warnings), attempt.attemptId);
  }).immediate();
}

function completeRecordingAlignment(db: Database.Database, attempt: AlignmentAttempt, value: RecordingAlignmentComplete): SelectedAlignment {
  const completion = validateAlignmentComplete(value);
  return db.transaction(() => {
    const row = alignmentFence(db, attempt), observed = headerCompletion(row).warnings;
    if (!sameAlignmentSource(row, completion.source) || completion.pageCount !== BigInt(row.page_count) ||
      observed.some((warning) => !completion.warnings.includes(warning)) ||
      (completion.coverageStatus === "available" && observed.some((warning) => warning !== "local_wall_timestamp_estimate")) ||
      (completion.coverageStatus === "unavailable_legacy" && (row.page_count !== 0 || !completion.warnings.includes("unavailable_legacy")))) {
      throw new Error("invalid alignment completion binding, count or warnings");
    }
    const previous = getSelectedAlignment(db, attempt.generationId);
    db.prepare("UPDATE recording_alignment_attempts SET state='complete',coverage_status=?,warnings_json=? WHERE attempt_id=?")
      .run(completion.coverageStatus, JSON.stringify([...completion.warnings].sort()), attempt.attemptId);
    db.prepare(`INSERT INTO recording_alignment_selected(generation_id,attempt_id) VALUES(?,?)
      ON CONFLICT(generation_id) DO UPDATE SET attempt_id=excluded.attempt_id`).run(attempt.generationId, attempt.attemptId);
    if (previous) {
      // The prior reader already completed cleanup before selection. Retire its
      // payload in the same transaction, not as a failed or unresolved owner.
      const retired = db.prepare(`UPDATE recording_alignment_attempts SET state='abandoned',coverage_status=NULL,failure_reason=NULL
        WHERE attempt_id=? AND generation_id=? AND state='complete'`).run(previous.attemptId, attempt.generationId);
      if (retired.changes !== 1) throw new Error("invalid retired alignment binding");
    }
    db.prepare("UPDATE recording_recovery_bindings SET last_alignment_failure=NULL WHERE generation_id=?").run(attempt.generationId);
    return selectedReference(alignmentHeader(db, attempt.attemptId));
  }).immediate();
}

function readSelectedAlignmentPage(db: Database.Database, selected: SelectedAlignment, after: number): RecordingAlignmentPage | null {
  if (!Number.isSafeInteger(after) || after < -1 || after >= ALIGNMENT_LIMITS.attemptPages) throw new Error("invalid alignment page cursor");
  const current = getSelectedAlignment(db, selected.generationId);
  if (!current || current.attemptId !== selected.attemptId || current.source.sourceSessionId !== selected.source.sourceSessionId ||
    current.source.recordingHandle !== selected.source.recordingHandle || current.source.sha256 !== selected.source.sha256) throw new Error("selected alignment generation changed");
  const row = db.prepare(`SELECT page_index,entry_count,
    CASE WHEN length(CAST(payload AS BLOB)) BETWEEN 1 AND ${ALIGNMENT_LIMITS.privatePageBytes} THEN payload ELSE NULL END AS payload
    FROM recording_alignment_pages WHERE attempt_id=? AND page_index>? ORDER BY page_index LIMIT 1`)
    .get(selected.attemptId, after) as { page_index: number; entry_count: number; payload: string | null } | undefined;
  if (!row) {
    if (after + 1 < current.pageCount) throw new Error("missing selected alignment page");
    return null;
  }
  if (row.payload === null) throw new Error("invalid private alignment page size");
  const page = decodeAlignmentPage(row.payload);
  if (row.page_index !== after + 1 || row.page_index >= current.pageCount || page.pageIndex !== BigInt(row.page_index) || page.entries.length !== row.entry_count ||
    page.source.sourceSessionId !== current.source.sourceSessionId || page.source.recordingHandle !== current.source.recordingHandle || page.source.sha256 !== current.source.sha256) {
    throw new Error("invalid selected alignment page binding");
  }
  return page;
}

function getPendingAlignment(db: Database.Database, generationId: string): AlignmentAttempt | null {
  const storeIdentity = requirePrivateState(db);
  const pending = db.prepare(`SELECT a.attempt_id FROM recording_alignment_attempts a
    LEFT JOIN recording_alignment_selected s ON s.attempt_id=a.attempt_id
    WHERE a.generation_id=? AND a.state IN ('staging','cleanup_failed') AND s.attempt_id IS NULL
    ORDER BY a.attempt_id LIMIT 1`).get(generationId) as { attempt_id: string } | undefined;
  if (!pending) return null;
  const row = alignmentHeader(db, pending.attempt_id);
  return { storeIdentity, generationId, attemptId: row.attempt_id, ownerId: row.owner_id, token: row.token };
}

function getReclaimableAlignment(db: Database.Database, generationId: string): AlignmentAttempt | null {
  const storeIdentity = requirePrivateState(db);
  const released = db.prepare(`SELECT a.attempt_id FROM recording_alignment_attempts a
    LEFT JOIN recording_alignment_selected s ON s.attempt_id=a.attempt_id
    WHERE a.generation_id=? AND a.state='abandoned' AND s.attempt_id IS NULL
    ORDER BY a.attempt_id LIMIT 1`).get(generationId) as { attempt_id: string } | undefined;
  if (!released) return null;
  const row = alignmentHeader(db, released.attempt_id);
  return { storeIdentity, generationId, attemptId: row.attempt_id, ownerId: row.owner_id, token: row.token };
}

function matchAlignmentOwner(db: Database.Database, attempt: AlignmentAttempt): AlignmentHeader {
  if (requirePrivateState(db) !== attempt.storeIdentity) throw new Error("alignment owner fence mismatch");
  const row = alignmentHeader(db, attempt.attemptId);
  if (row.generation_id !== attempt.generationId || row.owner_id !== attempt.ownerId || row.token !== attempt.token) throw new Error("alignment owner fence mismatch");
  return row;
}

function markAlignmentCleanupFailed(db: Database.Database, attempt: AlignmentAttempt): void {
  db.transaction(() => {
    const row = matchAlignmentOwner(db, attempt);
    if (row.state !== "staging" && row.state !== "cleanup_failed") throw new Error("alignment owner fence mismatch");
    db.prepare("UPDATE recording_alignment_attempts SET state='cleanup_failed',failure_reason='cleanup_failed' WHERE attempt_id=?").run(attempt.attemptId);
    db.prepare("UPDATE recording_recovery_bindings SET last_alignment_failure='cleanup_failed' WHERE generation_id=?").run(attempt.generationId);
  }).immediate();
}

function abandonRecordingAlignment(db: Database.Database, attempt: AlignmentAttempt, permit: AlignmentRecoveryPermit, reason: AlignmentFailure = "recovered_owner"): void {
  if (!["read_failed", "cancelled", "cleanup_failed", "recovered_owner"].includes(reason)) throw new Error("invalid alignment failure reason");
  db.transaction(() => {
    const row = matchAlignmentOwner(db, attempt);
    if (db.prepare("SELECT 1 FROM recording_alignment_selected WHERE attempt_id=?").get(attempt.attemptId)) throw new Error("selected alignment cannot be abandoned");
    consumeAlignmentRecoveryPermit(permit, attempt);
    if (row.state === "complete") {
      // Formerly selected immutable evidence is no longer a reader owner.
      db.prepare("UPDATE recording_alignment_attempts SET state='abandoned',coverage_status=NULL,failure_reason=? WHERE attempt_id=?").run(reason, attempt.attemptId);
    } else db.prepare("UPDATE recording_alignment_attempts SET state='abandoned',failure_reason=? WHERE attempt_id=?").run(reason, attempt.attemptId);
    db.prepare("UPDATE recording_recovery_bindings SET last_alignment_failure=? WHERE generation_id=?").run(reason, attempt.generationId);
  }).immediate();
}

function getRecordingAlignmentFailure(db: Database.Database, generationId: string): AlignmentFailure | null {
  requirePrivateState(db);
  const row = db.prepare("SELECT last_alignment_failure FROM recording_recovery_bindings WHERE generation_id=?").get(generationId) as { last_alignment_failure: AlignmentFailure | null } | undefined;
  const value = row?.last_alignment_failure ?? null;
  if (value !== null && !["read_failed", "cancelled", "cleanup_failed", "recovered_owner"].includes(value)) throw new Error("invalid private alignment failure");
  return value;
}

function reclaimRecordingAlignment(db: Database.Database, attempt: AlignmentAttempt, limit = 64): boolean {
  if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error("invalid alignment reclaim limit");
  return db.transaction(() => {
    const row = matchAlignmentOwner(db, attempt);
    if (row.state !== "abandoned" || db.prepare("SELECT 1 FROM recording_alignment_selected WHERE attempt_id=?").get(attempt.attemptId)) {
      throw new Error("alignment reclaim requires confirmed owner cleanup");
    }
    db.prepare(`DELETE FROM recording_alignment_pages WHERE attempt_id=? AND page_index IN
      (SELECT page_index FROM recording_alignment_pages WHERE attempt_id=? ORDER BY page_index LIMIT ?)`).run(attempt.attemptId, attempt.attemptId, limit);
    if (db.prepare("SELECT 1 FROM recording_alignment_pages WHERE attempt_id=? LIMIT 1").get(attempt.attemptId)) return false;
    db.prepare("DELETE FROM recording_alignment_attempts WHERE attempt_id=?").run(attempt.attemptId);
    return true;
  }).immediate();
}

// ---------------------------------------------------------------------------
// Delivery journal (Task 9). This is intentionally an additive local ledger:
// it never contains TeamMem data or becomes visible in the handoff directory.
// ---------------------------------------------------------------------------

function savePendingDelivery(
  db: Database.Database,
  row: DeliveryRow,
  authority?: BackfillDeliveryAuthority,
  identityCheckpoint?: (canonicalPath: string) => void,
): SavePendingDeliveryResult {
  const deadlineClosed = Symbol("backfill deadline closed");
  const claimExpired = Symbol("backfill claim expired");
  const save = db.transaction((): SavePendingDeliveryResult | null | typeof deadlineClosed | typeof claimExpired => {
    const existing = selectDeliveryRow(db, row.occurrenceId, row.revision);
    if (existing !== null) {
      if (existing.deletedAtMs !== null) {
        throw new OrchestrationError("constraint_violation", "deleted delivery intent cannot be replayed after governed cleanup");
      }
      if (row.artifactHash !== existing.artifactHash || row.recoveryArtifact !== existing.recoveryArtifact) {
        throw new OrchestrationError("constraint_violation", "delivery revision has conflicting canonical bytes");
      }
      if (existing.recoveryArtifact === null) {
        throw new OrchestrationError("constraint_violation", "delivery replay has no retained canonical bytes");
      }
      const seed = getBackfillSeed(db, row.occurrenceId);
      if (seed !== null) {
        assertReplayableBackfillLifecycle(db, seed);
        validateSeededDelivery(db, existing, seed);
        assertSeedRecordingBinding(seed);
        advanceSeededDeliveryState(db, existing.occurrenceId, existing.nextRetryAtMs);
      }
      return { kind: "replay", row: existing };
    }
    const recording = db.prepare("SELECT handle, encrypted_path FROM recordings WHERE occurrence_id = ?").get(row.occurrenceId) as { handle: string; encrypted_path: string | null } | undefined;
    if (recording === undefined || path.resolve(recording.encrypted_path ?? "") !== path.resolve(row.recordingPath)) {
      throw new OrchestrationError("constraint_violation", "delivery recording is not the finalized occurrence recording");
    }
    const seed = getBackfillSeed(db, row.occurrenceId);
    if (seed !== null) {
      validateSeededDelivery(db, row, seed);
      const authorityState = validateBackfillAuthority(db, row, seed, authority);
      assertSeedRecordingBinding(seed);
      if (authorityState === "deadline_closed") return deadlineClosed;
      if (authorityState === "claim_expired") return claimExpired;
      authority = authorityState;
    } else if (authority !== undefined) {
      throw new OrchestrationError("constraint_violation", "backfill delivery authority has no immutable seed");
    }
    const binding = claimDeliveryRecordingOwner(
      db,
      row.occurrenceId,
      recording.handle,
      recording.encrypted_path ?? "",
      identityCheckpoint,
    );
    if (binding === null) return null;
    withConstraintTranslation(() => db.prepare(
    `INSERT INTO delivery_journal
       (occurrence_id, revision, artifact_hash, recording_path, bundle_path, ended_at_ms,
        transcript_complete, retry_count, next_retry_at_ms, retry_reason, published_at_ms,
        deleted_at_ms, publication_url, vault_commit, recovery_artifact, stage_token, recording_handle)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.occurrenceId, row.revision, row.artifactHash, row.recordingPath, row.bundlePath,
    row.endedAtMs, row.transcriptComplete ? 1 : 0, row.retryCount, row.nextRetryAtMs,
    row.retryReason, row.publishedAtMs, row.deletedAtMs, row.publicationUrl, row.vaultCommit,
    row.recoveryArtifact, row.stageToken, binding.handle));
    if (seed !== null) {
      commitBackfillHandoff(db, row, seed, authority!);
      assertSeedRecordingBinding(seed);
      advanceSeededDeliveryState(db, row.occurrenceId, authority!.nowMs);
    }
    return { kind: "inserted", row: selectDeliveryRow(db, row.occurrenceId, row.revision)! };
  });
  const result = save.immediate();
  if (result === null) throw new OrchestrationError("constraint_violation", "delivery recording belongs to another occurrence");
  if (result === deadlineClosed) throw seedViolation("backfill delivery is past its original stop deadline");
  if (result === claimExpired) throw seedViolation("backfill delivery claim is stale or expired");
  return result;
}

// The canonical intent and lifecycle transfer are the publication handoff.
// Keep its orchestration edge in that same transaction, including old exact
// replays which committed the intent but never advanced out of finalizing.
function advanceSeededDeliveryState(db: Database.Database, occurrenceId: string, nowMs: number): void {
  const session = selectSessionRaw(db, occurrenceId);
  if (session?.state !== "finalizing") return;
  transition(db, { occurrenceId, fromState: "finalizing", toState: "awaiting_teammem",
    reason: "delivery_handoff", terminalReason: null, nowMs: Math.max(nowMs, session.updated_at_ms) });
}

// Migration 031's column. A store opened on an older schema (a test seam for
// legacy upgrades) reads no refusal and never writes one.
const refusalColumns = new WeakMap<Database.Database, "refusal_reason" | "NULL AS refusal_reason">();
function refusalColumn(db: Database.Database): "refusal_reason" | "NULL AS refusal_reason" {
  let column = refusalColumns.get(db);
  if (column === undefined) {
    const present = (db.prepare("PRAGMA table_info(delivery_journal)").all() as Array<{ name: string }>).some((entry) => entry.name === "refusal_reason");
    column = present ? "refusal_reason" : "NULL AS refusal_reason";
    refusalColumns.set(db, column);
  }
  return column;
}

function selectDeliveryRow(db: Database.Database, occurrenceId: string, revision: number): DeliveryRow | null {
  const row = db.prepare(
    `SELECT occurrence_id, revision, artifact_hash, recording_path, bundle_path, ended_at_ms,
            transcript_complete, retry_count, next_retry_at_ms, retry_reason, published_at_ms,
            deleted_at_ms, publication_url, vault_commit, recovery_artifact, stage_token, recording_handle, ${refusalColumn(db)}
       FROM delivery_journal WHERE occurrence_id=? AND revision=?`,
  ).get(occurrenceId, revision) as { occurrence_id: string; revision: number; artifact_hash: string; recording_path: string; bundle_path: string; ended_at_ms: number; transcript_complete: 0 | 1; retry_count: number; next_retry_at_ms: number; retry_reason: DeliveryRow["retryReason"]; published_at_ms: number | null; deleted_at_ms: number | null; publication_url: string | null; vault_commit: string | null; recovery_artifact: string | null; stage_token: string | null; recording_handle: string | null; refusal_reason: string | null } | undefined;
  if (!row) return null;
  return { occurrenceId: row.occurrence_id, revision: row.revision, artifactHash: row.artifact_hash,
    recordingPath: row.recording_path, bundlePath: row.bundle_path, endedAtMs: row.ended_at_ms,
    transcriptComplete: row.transcript_complete === 1, retryCount: row.retry_count,
    nextRetryAtMs: row.next_retry_at_ms, retryReason: row.retry_reason, publishedAtMs: row.published_at_ms,
    deletedAtMs: row.deleted_at_ms, publicationUrl: row.publication_url, vaultCommit: row.vault_commit,
    recoveryArtifact: row.recovery_artifact, stageToken: row.stage_token, recordingHandle: row.recording_handle,
    ...(row.refusal_reason === null ? {} : { refusalReason: row.refusal_reason }) };
}

function seededArtifact(row: DeliveryRow): SupportedTeamMemMeetingArtifact {
  if (row.recoveryArtifact === null) throw seedViolation("seeded delivery requires canonical recovery bytes");
  let artifact: SupportedTeamMemMeetingArtifact;
  try { artifact = parseSupportedTeamMemMeetingArtifact(JSON.parse(row.recoveryArtifact)); }
  catch { throw seedViolation("seeded delivery recovery artifact is invalid"); }
  if (canonicalArtifactJson(artifact) !== row.recoveryArtifact || canonicalArtifactHash(artifact) !== row.artifactHash) {
    throw seedViolation("seeded delivery canonical bytes or hash mismatch");
  }
  if (artifact.occurrence_id !== row.occurrenceId || artifact.revision !== row.revision ||
      artifact.transcript_complete !== row.transcriptComplete || Date.parse(artifact.ended_at) !== row.endedAtMs) {
    throw seedViolation("seeded delivery row does not match its canonical artifact");
  }
  return artifact;
}

function validateSeededDelivery(db: Database.Database, row: DeliveryRow, seed: BackfillSeed): void {
  const artifact = seededArtifact(row);
  const organizer = seed.organizer === null ? null : { person_id: seed.organizer.feishuUserId, display_name: seed.organizer.displayName };
  const sameOrganizer = JSON.stringify(artifact.organizer) === JSON.stringify(organizer)
    && artifact.organizer_source === (seed.organizer?.source ?? null)
    && artifact.organizer_unresolved_reason === (seed.organizer === null ? "instant_meeting" : null);
  const provenance = artifact.provenance;
  const audio = artifact.audio;
  if (artifact.provider !== seed.provider || artifact.provider_meeting_id !== seed.providerMeetingId ||
      artifact.title !== seed.title || artifact.started_at !== seed.occurrenceStartedAt || artifact.ended_at !== seed.endedAt ||
      !sameOrganizer || row.recordingPath !== seed.recordingPath || row.recordingHandle !== seed.capability.recordingHandle ||
      audio.format !== seed.recordingFormat || audio.encryption !== seed.recordingEncryption ||
      audio.bytes !== seed.recordingBytes || audio.duration_seconds !== seed.recordingDurationMs / 1000 ||
      audio.sha256 !== `sha256:${seed.recordingSha256}` || audio.expires_at !== new Date(seed.expiresAtMs).toISOString() ||
      provenance.runtime_profile !== seed.provenance.runtimeProfile || provenance.stt_provider !== seed.provenance.sttProvider ||
      provenance.stt_model !== seed.provenance.sttModel || provenance.text_provider !== seed.provenance.textProvider ||
      provenance.text_model !== seed.provenance.textModel || provenance.agent_version !== seed.provenance.agentVersion) {
    throw seedViolation("seeded delivery static metadata mismatch");
  }
  for (const [index, warning] of seed.processingWarnings.entries()) {
    const actual = artifact.processing_warnings[index];
    if (actual === undefined || actual.code !== warning.code || actual.detail !== warning.detail) {
      throw seedViolation("seeded delivery base processing warnings mismatch");
    }
  }
  for (const segment of artifact.transcript) {
    const expected = segment.provenance.stage === "live_stream" ? seed.provenance.liveStreamModel : seed.provenance.finalBatchModel;
    if (segment.provenance.model !== expected) throw seedViolation("seeded delivery transcript model provenance mismatch");
  }
  let gapCursor = 0;
  for (const gap of seed.bridgeGaps) {
    const expectedEnd = gap.endedAt ?? seed.endedAt;
    while (gapCursor < artifact.recording_gaps.length &&
      (artifact.recording_gaps[gapCursor]!.started_at !== gap.startedAt || artifact.recording_gaps[gapCursor]!.ended_at !== expectedEnd)) gapCursor += 1;
    if (gapCursor === artifact.recording_gaps.length) throw seedViolation("seeded delivery recording gaps mismatch");
    gapCursor += 1;
  }
  const recovery = db.prepare(`SELECT generation_id,bridge_session_id,source_session_id,recording_handle,sha256,key_id,authorization
    FROM recording_recovery_bindings WHERE occurrence_id=? AND generation_id=?`).get(seed.occurrenceId, seed.generationId) as {
      generation_id: string; bridge_session_id: string; source_session_id: string; recording_handle: string;
      sha256: string; key_id: string; authorization: string;
    } | undefined;
  if (!recovery || recovery.bridge_session_id !== seed.bridgeSessionId || recovery.source_session_id !== seed.capability.sourceSessionId.toString() ||
      recovery.recording_handle !== seed.capability.recordingHandle || recovery.sha256 !== seed.capability.sha256 ||
      recovery.key_id !== seed.capability.keyId || recovery.authorization !== seed.capability.authorization) {
    throw seedViolation("seeded delivery recovery capability mismatch");
  }
}

function assertReplayableBackfillLifecycle(db: Database.Database, seed: BackfillSeed): void {
  const lifecycle = db.prepare(`SELECT owner,state,stop_at_ms,expires_at_ms,deleted_at_ms
    FROM backfill_seed_lifecycle WHERE occurrence_id=?`).get(seed.occurrenceId) as {
      owner: "seed" | "delivery"; state: string; stop_at_ms: number; expires_at_ms: number; deleted_at_ms: number | null;
    } | undefined;
  if (!lifecycle || lifecycle.owner !== "delivery" || !["pending", "stopped"].includes(lifecycle.state) ||
      lifecycle.deleted_at_ms !== null || lifecycle.stop_at_ms !== seed.stopAtMs || lifecycle.expires_at_ms !== seed.expiresAtMs) {
    throw seedViolation("backfill lifecycle cleanup or deletion forbids delivery replay");
  }
}

function assertSeedRecordingBinding(seed: BackfillSeed): void {
  const current = backfillRecordingBinding({ handle: seed.capability.recordingHandle, encryptedPath: seed.recordingPath });
  if (current.canonicalPath !== seed.recordingPath || current.bytes !== seed.recordingBytes ||
      current.device !== seed.recordingDevice || current.inode !== seed.recordingInode) {
    throw seedViolation("seeded delivery recording identity or size changed");
  }
}

function validateBackfillAuthority(
  db: Database.Database,
  row: DeliveryRow,
  seed: BackfillSeed,
  authority: BackfillDeliveryAuthority | undefined,
): BackfillDeliveryAuthority | "deadline_closed" | "claim_expired" {
  if (authority === undefined) throw seedViolation("seeded delivery requires live backfill authority");
  if (!Number.isSafeInteger(authority.nowMs) || authority.nowMs < 0 || !/^[0-9a-f]{32}$/.test(authority.claimToken)) {
    throw seedViolation("invalid backfill delivery authority");
  }
  if (row.retryCount !== 0 || row.retryReason !== null || row.publishedAtMs !== null || row.deletedAtMs !== null ||
      row.publicationUrl !== null || row.vaultCommit !== null || row.stageToken === null) {
    throw seedViolation("new seeded delivery intent is not pending canonical state");
  }
  const lifecycle = db.prepare(`SELECT owner,state,stop_at_ms,expires_at_ms,build_claim_token,build_claim_expires_at_ms,deleted_at_ms,
    process_owner_token,process_cleanup_state
    FROM backfill_seed_lifecycle WHERE occurrence_id=?`).get(seed.occurrenceId) as {
      owner: "seed" | "delivery"; state: string; stop_at_ms: number; expires_at_ms: number;
      build_claim_token: string | null; build_claim_expires_at_ms: number | null; deleted_at_ms: number | null;
      process_owner_token: string | null; process_cleanup_state: string | null;
    } | undefined;
  if (!lifecycle || lifecycle.state !== "pending" || lifecycle.deleted_at_ms !== null || lifecycle.stop_at_ms !== seed.stopAtMs || lifecycle.expires_at_ms !== seed.expiresAtMs) {
    throw seedViolation("backfill lifecycle is stopped or deleted");
  }
  if (lifecycle.process_owner_token !== null || lifecycle.process_cleanup_state !== null) {
    throw seedViolation("backfill process owner must settle before delivery handoff");
  }
  if (authority.kind === "initial") {
    const next = (db.prepare("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM delivery_journal WHERE occurrence_id=?")
      .get(seed.occurrenceId) as { revision: number }).revision;
    if (lifecycle.owner !== "seed" || lifecycle.build_claim_token !== authority.claimToken ||
        lifecycle.build_claim_expires_at_ms === null || row.revision !== next) {
      throw seedViolation("initial backfill claim or first revision is stale");
    }
    const effective = observeBackfillWall(db, seed.occurrenceId, authority.nowMs);
    if (effective >= seed.stopAtMs || effective >= seed.expiresAtMs) return "deadline_closed";
    if (lifecycle.build_claim_expires_at_ms <= effective) return "claim_expired";
    return { ...authority, nowMs: effective };
  }
  const job = db.prepare("SELECT state,claim_token,claim_expires_at_ms,target_revision,stop_at_ms FROM backfill_jobs WHERE occurrence_id=?")
    .get(seed.occurrenceId) as { state: string; claim_token: string | null; claim_expires_at_ms: number | null; target_revision: number | null; stop_at_ms: number } | undefined;
  if (lifecycle.owner !== "delivery" || !job || job.state !== "claimed" || job.stop_at_ms !== seed.stopAtMs ||
      job.claim_token !== authority.claimToken || job.claim_expires_at_ms === null ||
      job.target_revision !== authority.targetRevision || row.revision !== authority.targetRevision) {
    throw seedViolation("retry backfill claim, lease or target revision is stale");
  }
  const effective = observeBackfillWall(db, seed.occurrenceId, authority.nowMs);
  if (effective >= seed.stopAtMs || effective >= seed.expiresAtMs) return "deadline_closed";
  if (job.claim_expires_at_ms <= effective) return "claim_expired";
  return { ...authority, nowMs: effective };
}

function commitBackfillHandoff(db: Database.Database, row: DeliveryRow, seed: BackfillSeed, authority: BackfillDeliveryAuthority): void {
  if (authority.kind === "initial") {
    const changed = db.prepare(`UPDATE backfill_seed_lifecycle
      SET owner='delivery',build_claim_token=NULL,build_claim_expires_at_ms=NULL
      WHERE occurrence_id=? AND owner='seed' AND state='pending' AND build_claim_token=? AND build_claim_expires_at_ms>? AND stop_at_ms>?`)
      .run(seed.occurrenceId, authority.claimToken, authority.nowMs, authority.nowMs).changes;
    if (changed !== 1) throw seedViolation("initial backfill ownership transfer lost its claim");
    if (!row.transcriptComplete) {
      withConstraintTranslation(() => db.prepare(`INSERT INTO backfill_jobs
        (occurrence_id,state,attempt_count,next_attempt_at_ms,claim_token,claim_expires_at_ms,target_revision,last_reason,stop_at_ms,completion_revision,completion_artifact_hash)
        VALUES (?,'due',0,?,NULL,NULL,NULL,NULL,?,NULL,NULL)`)
        .run(seed.occurrenceId, authority.nowMs, seed.stopAtMs));
    }
    return;
  }
  const state = row.transcriptComplete ? "awaiting_complete_receipt" : "due";
  const changed = db.prepare(`UPDATE backfill_jobs
    SET state=?,next_attempt_at_ms=?,claim_token=NULL,claim_expires_at_ms=NULL,
        target_revision=CASE WHEN ? THEN target_revision ELSE NULL END,last_reason=NULL
    WHERE occurrence_id=? AND state='claimed' AND claim_token=? AND claim_expires_at_ms>? AND target_revision=? AND stop_at_ms>?`)
    .run(state, authority.nowMs, row.transcriptComplete ? 1 : 0, seed.occurrenceId, authority.claimToken,
      authority.nowMs, authority.targetRevision, authority.nowMs).changes;
  if (changed !== 1) throw seedViolation("retry backfill handoff lost its claim");
}

function deliveryRows(db: Database.Database, selection: "active" | "deleted_with_recovery"): DeliveryRow[] {
  const predicate = selection === "active"
    ? "deleted_at_ms IS NULL"
    : "deleted_at_ms IS NOT NULL AND published_at_ms IS NOT NULL AND recovery_artifact IS NOT NULL";
  const rows = db.prepare(
    `SELECT occurrence_id, revision, artifact_hash, recording_path, bundle_path, ended_at_ms,
            transcript_complete, retry_count, next_retry_at_ms, retry_reason, published_at_ms,
            deleted_at_ms, publication_url, vault_commit, recovery_artifact, stage_token, recording_handle, ${refusalColumn(db)}
       FROM delivery_journal WHERE ${predicate} ORDER BY next_retry_at_ms, occurrence_id, revision`,
  ).all() as Array<{ occurrence_id: string; revision: number; artifact_hash: string; recording_path: string; bundle_path: string; ended_at_ms: number; transcript_complete: 0 | 1; retry_count: number; next_retry_at_ms: number; retry_reason: DeliveryRow["retryReason"]; published_at_ms: number | null; deleted_at_ms: number | null; publication_url: string | null; vault_commit: string | null; recovery_artifact: string | null; stage_token: string | null; recording_handle: string | null; refusal_reason: string | null }>;
  return rows.map((row) => ({
    occurrenceId: row.occurrence_id, revision: row.revision, artifactHash: row.artifact_hash,
    recordingPath: row.recording_path, bundlePath: row.bundle_path, endedAtMs: row.ended_at_ms,
    transcriptComplete: row.transcript_complete === 1, retryCount: row.retry_count,
    nextRetryAtMs: row.next_retry_at_ms, retryReason: row.retry_reason,
    publishedAtMs: row.published_at_ms, deletedAtMs: row.deleted_at_ms,
    publicationUrl: row.publication_url, vaultCommit: row.vault_commit,
    recoveryArtifact: row.recovery_artifact, stageToken: row.stage_token, recordingHandle: row.recording_handle,
    ...(row.refusal_reason === null ? {} : { refusalReason: row.refusal_reason }),
  }));
}

// TeamMem's only terminal reason: the note quotes its own stored transcript.
const OWN_TRANSCRIPT_REFUSAL = "transcript_text_in_note";

/** One automatic re-synthesis per occurrence: the refused revision is complete,
 * no other revision was refused for its own transcript, no higher revision
 * exists, and the backfill lifecycle still owns the delivery before its stop. */
function publicationResynthesisEligible(db: Database.Database, input: PublicationRefusalInput): boolean {
  const { row } = input;
  if (input.reasonCode !== OWN_TRANSCRIPT_REFUSAL || !row.transcriptComplete || refusalColumn(db) !== "refusal_reason") return false;
  if (db.prepare(`SELECT 1 FROM delivery_journal WHERE occurrence_id=? AND ((revision<>? AND refusal_reason='${OWN_TRANSCRIPT_REFUSAL}') OR revision>?) LIMIT 1`)
    .get(row.occurrenceId, row.revision, row.revision) !== undefined) return false;
  const lifecycle = db.prepare(`SELECT owner,state,stop_at_ms,deleted_at_ms,process_cleanup_state,last_observed_at_ms
    FROM backfill_seed_lifecycle WHERE occurrence_id=?`).get(row.occurrenceId) as { owner: string; state: string; stop_at_ms: number;
      deleted_at_ms: number | null; process_cleanup_state: string | null; last_observed_at_ms: number } | undefined;
  if (!lifecycle || lifecycle.owner !== "delivery" || lifecycle.state !== "pending" || lifecycle.deleted_at_ms !== null ||
      lifecycle.process_cleanup_state !== null || Math.max(input.nowMs, lifecycle.last_observed_at_ms) >= lifecycle.stop_at_ms) return false;
  const job = db.prepare("SELECT state,target_revision FROM backfill_jobs WHERE occurrence_id=?").get(row.occurrenceId) as
    { state: string; target_revision: number | null } | undefined;
  return job === undefined || (job.state === "awaiting_complete_receipt" && job.target_revision === row.revision);
}

function recordPublicationRefusal(db: Database.Database, input: PublicationRefusalInput & { readonly nextRetryAtMs: number; readonly resynthesis: boolean }): void {
  db.transaction(() => {
    if (input.resynthesis && !publicationResynthesisEligible(db, input)) throw seedViolation("publication re-synthesis is no longer eligible");
    updateDelivery(db, { ...input.row, refusalReason: input.reasonCode, nextRetryAtMs: input.nextRetryAtMs });
    if (!input.resynthesis) return;
    const lifecycle = db.prepare("SELECT stop_at_ms,last_observed_at_ms FROM backfill_seed_lifecycle WHERE occurrence_id=?")
      .get(input.row.occurrenceId) as { stop_at_ms: number; last_observed_at_ms: number };
    const due = Math.max(input.nowMs, lifecycle.last_observed_at_ms);
    const changed = db.prepare("SELECT 1 FROM backfill_jobs WHERE occurrence_id=?").get(input.row.occurrenceId) === undefined
      ? withConstraintTranslation(() => db.prepare(`INSERT INTO backfill_jobs
          (occurrence_id,state,attempt_count,next_attempt_at_ms,claim_token,claim_expires_at_ms,target_revision,last_reason,stop_at_ms,completion_revision,completion_artifact_hash)
          VALUES (?,'due',0,?,NULL,NULL,NULL,NULL,?,NULL,NULL)`).run(input.row.occurrenceId, due, lifecycle.stop_at_ms).changes)
      : db.prepare(`UPDATE backfill_jobs SET state='due',next_attempt_at_ms=?,target_revision=NULL,last_reason=NULL
          WHERE occurrence_id=? AND state='awaiting_complete_receipt' AND target_revision=?`).run(due, input.row.occurrenceId, input.row.revision).changes;
    if (changed !== 1) throw seedViolation("publication re-synthesis could not re-arm its backfill job");
  }).immediate();
}

function updateDelivery(db: Database.Database, row: DeliveryRow): void {
  const changed = withConstraintTranslation(() => db.prepare(
    `UPDATE delivery_journal SET retry_count = ?, next_retry_at_ms = ?, retry_reason = ?,
       published_at_ms = ?, deleted_at_ms = ?, publication_url = ?, vault_commit = ?,
       recovery_artifact = ?, stage_token = ?, recording_handle = ?${refusalColumn(db) === "refusal_reason" ? ", refusal_reason = COALESCE(refusal_reason, @refusal)" : ""}
     WHERE occurrence_id = ? AND revision = ? AND artifact_hash = ?`,
  ).run(...[row.retryCount, row.nextRetryAtMs, row.retryReason, row.publishedAtMs, row.deletedAtMs,
    row.publicationUrl, row.vaultCommit, row.recoveryArtifact, row.stageToken,
    row.recordingHandle ?? null, row.occurrenceId, row.revision, row.artifactHash],
    ...(refusalColumn(db) === "refusal_reason" ? [{ refusal: row.refusalReason ?? null }] : [])).changes);
  if (changed !== 1) throw new OrchestrationError("constraint_violation", "delivery journal row is unknown or immutable fields changed");
}

type NotificationRaw = {
  occurrence_id: string; revision: number; artifact_hash: string; publication_url: string; vault_commit: string;
  recipient_id: string | null; title: string | null; message_text: string | null; request_uuid: string | null;
  state: NotificationRow["state"]; terminal_reason: NotificationRow["terminalReason"];
  first_attempt_at_ms: number | null; last_attempt_at_ms: number | null; attempt_count: number;
  next_attempt_at_ms: number; claim_token: string | null; claim_expires_at_ms: number | null;
  delivery_ambiguous: 0 | 1; provider_message_id: string | null; sent_at_ms: number | null;
};

const NOTIFICATION_COLUMNS = `occurrence_id, revision, artifact_hash, publication_url, vault_commit,
  recipient_id, title, message_text, request_uuid, state, terminal_reason, first_attempt_at_ms,
  last_attempt_at_ms, attempt_count, next_attempt_at_ms, claim_token, claim_expires_at_ms,
  delivery_ambiguous, provider_message_id, sent_at_ms`;

function toNotificationRow(row: NotificationRaw): NotificationRow {
  return {
    occurrenceId: row.occurrence_id, revision: row.revision, artifactHash: row.artifact_hash,
    publicationUrl: row.publication_url, vaultCommit: row.vault_commit, recipientId: row.recipient_id,
    title: row.title, messageText: row.message_text, requestUuid: row.request_uuid, state: row.state,
    terminalReason: row.terminal_reason, firstAttemptAtMs: row.first_attempt_at_ms,
    lastAttemptAtMs: row.last_attempt_at_ms, attemptCount: row.attempt_count,
    nextAttemptAtMs: row.next_attempt_at_ms, claimToken: row.claim_token,
    claimExpiresAtMs: row.claim_expires_at_ms, deliveryAmbiguous: row.delivery_ambiguous === 1,
    providerMessageId: row.provider_message_id, sentAtMs: row.sent_at_ms,
  };
}

function notifications(db: Database.Database): NotificationRow[] {
  return (db.prepare(`SELECT ${NOTIFICATION_COLUMNS} FROM notification_intents ORDER BY occurrence_id, revision`).all() as NotificationRaw[]).map(toNotificationRow);
}

function acceptPublication(db: Database.Database, input: AcceptPublicationInput): void {
  const run = db.transaction(() => {
    const deliverable = "recipientId" in input.notification;
    const delivery = db.prepare(
      "SELECT artifact_hash, transcript_complete, published_at_ms, publication_url, vault_commit FROM delivery_journal WHERE occurrence_id = ? AND revision = ?",
    ).get(input.occurrenceId, input.revision) as { artifact_hash: string; transcript_complete: 0 | 1; published_at_ms: number | null; publication_url: string | null; vault_commit: string | null } | undefined;
    if (delivery === undefined || delivery.artifact_hash !== input.artifactHash) {
      throw new OrchestrationError("constraint_violation", "publication delivery identity is unknown or immutable fields changed");
    }
    if (input.consumedInboxAudio && delivery.published_at_ms === null) {
      const row = selectDeliveryRow(db, input.occurrenceId, input.revision)!;
      seededArtifact(row); // Canonical bytes must agree with every durable identity field.
      const recording = db.prepare("SELECT handle, encrypted_path FROM recordings WHERE occurrence_id=?")
        .get(input.occurrenceId) as { handle: string; encrypted_path: string } | undefined;
      if (!recording || path.resolve(recording.encrypted_path) !== row.recordingPath || recording.handle !== row.recordingHandle) {
        throw new OrchestrationError("constraint_violation", "consumed bundle original recording binding changed");
      }
      const binding = claimDeliveryRecordingOwner(db, input.occurrenceId, recording.handle, recording.encrypted_path);
      if (!binding?.physicalIdentity) throw new OrchestrationError("constraint_violation", "consumed bundle original recording ownership unavailable");
      const seed = getBackfillSeed(db, input.occurrenceId);
      if (seed !== null) { validateSeededDelivery(db, row, seed); assertSeedRecordingBinding(seed); }
    }
    const session = selectSessionRaw(db, input.occurrenceId);
    if (session === undefined || !["awaiting_teammem", "published", "notified"].includes(session.state)) {
      throw new OrchestrationError("state_conflict", "publication receipt is not legal for the current session state");
    }
    if (delivery.transcript_complete === 1 && currentSchemaVersion(db) >= 24) {
      db.prepare(`UPDATE backfill_jobs
        SET state='complete',claim_token=NULL,claim_expires_at_ms=NULL,
            target_revision=COALESCE(target_revision,?),completion_revision=?,completion_artifact_hash=?
        WHERE occurrence_id=? AND state!='complete'`)
        .run(input.revision, input.revision, input.artifactHash, input.occurrenceId);
    }
    if (delivery.published_at_ms !== null) {
      if (delivery.publication_url !== input.publicationUrl || delivery.vault_commit !== input.vaultCommit) {
        throw new OrchestrationError("constraint_violation", "publication evidence is immutable");
      }
      const existing = db.prepare("SELECT state, terminal_reason, attempt_count FROM notification_intents WHERE occurrence_id = ? AND revision = ?")
        .get(input.occurrenceId, input.revision) as { state: string; terminal_reason: string | null; attempt_count: number } | undefined;
      if (existing !== undefined) {
        // Repair databases opened by the pre-review Task-10 migration: an
        // unavailable classification made before validating still-retained
        // canonical bytes is replaceable only before any send attempt.
        if (existing.state === "terminal" && existing.terminal_reason === "notification_inputs_unavailable" && existing.attempt_count === 0) {
          if (deliverable) {
            db.prepare(
              `UPDATE notification_intents SET recipient_id = ?, title = ?, message_text = ?, request_uuid = ?,
                 state = 'pending', terminal_reason = NULL, next_attempt_at_ms = ?
               WHERE occurrence_id = ? AND revision = ?`,
            ).run(input.notification.recipientId, input.notification.title, input.notification.messageText,
              input.notification.requestUuid, input.publishedAtMs, input.occurrenceId, input.revision);
          } else if (input.notification.terminalReason === "organizer_unresolved") {
            db.prepare("UPDATE notification_intents SET terminal_reason = 'organizer_unresolved' WHERE occurrence_id = ? AND revision = ?")
              .run(input.occurrenceId, input.revision);
          }
        }
        return;
      }
    } else {
      db.prepare(
        `UPDATE delivery_journal SET published_at_ms = ?, publication_url = ?, vault_commit = ?, retry_reason = NULL
          WHERE occurrence_id = ? AND revision = ? AND artifact_hash = ? AND published_at_ms IS NULL`,
      ).run(input.publishedAtMs, input.publicationUrl, input.vaultCommit, input.occurrenceId, input.revision, input.artifactHash);
    }
    if (session.state === "awaiting_teammem") {
      transition(db, { occurrenceId: input.occurrenceId, fromState: "awaiting_teammem", toState: "published", reason: "receipt", terminalReason: null, nowMs: input.publishedAtMs });
    }
    withConstraintTranslation(() => db.prepare(
      `INSERT INTO notification_intents
        (occurrence_id, revision, artifact_hash, publication_url, vault_commit, recipient_id, title,
         message_text, request_uuid, state, terminal_reason, next_attempt_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.occurrenceId, input.revision, input.artifactHash, input.publicationUrl, input.vaultCommit,
      deliverable ? input.notification.recipientId : null, deliverable ? input.notification.title : null,
      deliverable ? input.notification.messageText : null, deliverable ? input.notification.requestUuid : null,
      deliverable ? "pending" : "terminal", deliverable ? null : input.notification.terminalReason,
      input.publishedAtMs,
    ));
  });
  run();
}

function claimNotification(db: Database.Database, input: ClaimNotificationInput): NotificationRow | null {
  const run = db.transaction(() => {
    const rows = db.prepare(
      `SELECT ${NOTIFICATION_COLUMNS} FROM notification_intents
        WHERE (state = 'pending' AND next_attempt_at_ms <= ?)
           OR (state = 'claimed' AND claim_expires_at_ms <= ?)
        ORDER BY next_attempt_at_ms, occurrence_id, revision`,
    ).all(input.nowMs, input.nowMs) as NotificationRaw[];
    for (const row of rows) {
      if (row.first_attempt_at_ms !== null && input.nowMs < Math.max(row.first_attempt_at_ms, row.last_attempt_at_ms ?? row.first_attempt_at_ms)) continue;
      const safeUntil = row.first_attempt_at_ms === null ? null : row.first_attempt_at_ms + input.dedupWindowMs - input.dedupSafetyMarginMs;
      const deliveryAmbiguous = row.delivery_ambiguous === 1 || row.state === "claimed";
      if (deliveryAmbiguous && safeUntil !== null && input.nowMs + input.requestTimeoutMs > safeUntil) {
        db.prepare(
          `UPDATE notification_intents SET state = 'terminal', terminal_reason = 'notification_delivery_uncertain',
             claim_token = NULL, claim_expires_at_ms = NULL WHERE occurrence_id = ? AND revision = ? AND state != 'sent'`,
        ).run(row.occurrence_id, row.revision);
        continue;
      }
      const changed = withConstraintTranslation(() => db.prepare(
          `UPDATE notification_intents SET state = 'claimed', claim_token = ?, claim_expires_at_ms = ?,
             first_attempt_at_ms = COALESCE(first_attempt_at_ms, ?), last_attempt_at_ms = ?, attempt_count = attempt_count + 1,
             delivery_ambiguous = CASE WHEN state = 'claimed' THEN 1 ELSE delivery_ambiguous END
           WHERE occurrence_id = ? AND revision = ?
             AND ((state = 'pending' AND next_attempt_at_ms <= ?) OR (state = 'claimed' AND claim_expires_at_ms <= ?))`,
        ).run(input.claimToken, input.nowMs + input.claimTtlMs, input.nowMs, input.nowMs,
          row.occurrence_id, row.revision, input.nowMs, input.nowMs).changes);
      if (changed === 1) {
        const claimed = db.prepare(`SELECT ${NOTIFICATION_COLUMNS} FROM notification_intents WHERE occurrence_id = ? AND revision = ?`)
          .get(row.occurrence_id, row.revision) as NotificationRaw;
        return toNotificationRow(claimed);
      }
    }
    return null;
  });
  return run();
}

function failNotification(db: Database.Database, input: FailNotificationInput): void {
  const terminal = input.terminalReason !== null;
  const changed = withConstraintTranslation(() => db.prepare(
    `UPDATE notification_intents SET state = ?, terminal_reason = ?, next_attempt_at_ms = ?,
       claim_token = NULL, claim_expires_at_ms = NULL,
       delivery_ambiguous = CASE WHEN ? THEN 1 ELSE delivery_ambiguous END
     WHERE occurrence_id = ? AND revision = ? AND state = 'claimed' AND claim_token = ?`,
  ).run(terminal ? "terminal" : "pending", input.terminalReason, input.nextAttemptAtMs,
    input.ambiguous ? 1 : 0, input.occurrenceId, input.revision, input.claimToken).changes);
  if (changed !== 1) throw new OrchestrationError("state_conflict", "notification claim is stale or no longer active");
}

function completeNotification(db: Database.Database, input: CompleteNotificationInput): void {
  const run = db.transaction(() => {
    const intent = db.prepare("SELECT state, claim_token FROM notification_intents WHERE occurrence_id = ? AND revision = ?")
      .get(input.occurrenceId, input.revision) as { state: string; claim_token: string | null } | undefined;
    if (intent?.state !== "claimed" || intent.claim_token !== input.claimToken) {
      throw new OrchestrationError("state_conflict", "notification claim is stale or no longer active");
    }
    const session = selectSessionRaw(db, input.occurrenceId);
    if (session?.state === "published") {
      transition(db, { occurrenceId: input.occurrenceId, fromState: "published", toState: "notified", reason: "advance", terminalReason: null, nowMs: input.sentAtMs });
    } else if (session?.state !== "notified") {
      throw new OrchestrationError("state_conflict", "notification completion is not legal for the current session state");
    }
    withConstraintTranslation(() => db.prepare(
        `UPDATE notification_intents SET state = 'sent', provider_message_id = ?, sent_at_ms = ?,
           claim_token = NULL, claim_expires_at_ms = NULL
         WHERE occurrence_id = ? AND revision = ? AND state = 'claimed' AND claim_token = ?`,
      ).run(input.providerMessageId, input.sentAtMs, input.occurrenceId, input.revision, input.claimToken));
  });
  run();
}

type DeliveryRecordingBinding = { readonly canonicalPath: string; readonly physicalIdentity: string | null; readonly handle: string };

function deliveryRecordingBinding(handle: string, encryptedPath: string): DeliveryRecordingBinding {
  const canonicalPath = path.resolve(encryptedPath);
  if (!/^[0-9a-f]{32}$/.test(handle) || path.basename(canonicalPath) !== `${handle}.crsr`) {
    throw new OrchestrationError("constraint_violation", "delivery recording does not match its persisted Runtime handle");
  }
  try {
    const stat = lstatSync(canonicalPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new OrchestrationError("constraint_violation", "delivery recording is not a regular Runtime child");
    return { canonicalPath, physicalIdentity: `inode:${stat.dev}:${stat.ino}`, handle };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { canonicalPath, physicalIdentity: null, handle };
  }
}

function stableDeliveryRecordingBinding(
  handle: string,
  encryptedPath: string,
  identityCheckpoint?: (canonicalPath: string) => void,
): DeliveryRecordingBinding {
  const before = deliveryRecordingBinding(handle, encryptedPath);
  identityCheckpoint?.(before.canonicalPath);
  const after = deliveryRecordingBinding(handle, encryptedPath);
  if (before.canonicalPath !== after.canonicalPath || before.physicalIdentity !== after.physicalIdentity) {
    throw new OrchestrationError("constraint_violation", "delivery recording identity changed during verification; retry");
  }
  return after;
}

function assertDeliveryRecordingBindingUnchanged(
  handle: string,
  encryptedPath: string,
  expected: DeliveryRecordingBinding,
): void {
  const current = deliveryRecordingBinding(handle, encryptedPath);
  if (current.canonicalPath !== expected.canonicalPath || current.physicalIdentity !== expected.physicalIdentity) {
    throw new OrchestrationError("constraint_violation", "delivery recording identity changed during verification; retry");
  }
}

function claimDeliveryRecordingOwner(
  db: Database.Database,
  occurrenceId: string,
  handle: string,
  encryptedPath: string,
  identityCheckpoint?: (canonicalPath: string) => void,
): DeliveryRecordingBinding | null {
  refreshDeliveryRecordingOwners(db, identityCheckpoint);
  const binding = stableDeliveryRecordingBinding(handle, encryptedPath, identityCheckpoint);
  const canonicalOwner = db.prepare(
    "SELECT occurrence_id, owner_state FROM delivery_recording_owners_v17 WHERE canonical_path = ?",
  ).get(binding.canonicalPath) as { occurrence_id: string; owner_state: "observed" | "reserved" | "invalid" } | undefined;
  const physicalOwner = binding.physicalIdentity === null ? undefined : db.prepare(
    "SELECT occurrence_id FROM delivery_recording_owners_v17 WHERE physical_identity = ?",
  ).get(binding.physicalIdentity) as { occurrence_id: string } | undefined;
  if ((canonicalOwner !== undefined && canonicalOwner.occurrence_id !== occurrenceId)
    || (physicalOwner !== undefined && physicalOwner.occurrence_id !== occurrenceId)) return null;
  if (canonicalOwner !== undefined) {
    if (binding.physicalIdentity !== null && physicalOwner === undefined) {
      db.prepare(
        `UPDATE delivery_recording_owners_v17
            SET physical_identity = ?, owner_state = 'observed', failure_reason = NULL
          WHERE canonical_path = ? AND owner_state != 'invalid'`,
      ).run(binding.physicalIdentity, binding.canonicalPath);
    }
    if (canonicalOwner.owner_state === "invalid") return null;
    assertDeliveryRecordingBindingUnchanged(handle, encryptedPath, binding);
    return binding;
  }
  if (physicalOwner !== undefined) {
    assertDeliveryRecordingBindingUnchanged(handle, encryptedPath, binding);
    return binding;
  }
  db.prepare(
    `INSERT INTO delivery_recording_owners_v17
       (canonical_path, physical_identity, occurrence_id, recording_handle, owner_state, failure_reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    binding.canonicalPath,
    binding.physicalIdentity,
    occurrenceId,
    binding.handle,
    binding.physicalIdentity === null ? "reserved" : "observed",
    binding.physicalIdentity === null ? "source_missing" : null,
  );
  assertDeliveryRecordingBindingUnchanged(handle, encryptedPath, binding);
  return binding;
}

function refreshDeliveryRecordingOwners(
  db: Database.Database,
  identityCheckpoint?: (canonicalPath: string) => void,
): void {
  const owners = db.prepare(
    `SELECT canonical_path, occurrence_id, recording_handle
       FROM delivery_recording_owners_v17
      WHERE owner_state IN ('observed', 'reserved')
      ORDER BY rowid`,
  ).all() as Array<{ canonical_path: string; occurrence_id: string; recording_handle: string }>;
  for (const owner of owners) {
    let binding: DeliveryRecordingBinding;
    try {
      binding = stableDeliveryRecordingBinding(owner.recording_handle, owner.canonical_path, identityCheckpoint);
    } catch (error) {
      if (error instanceof OrchestrationError && error.message.includes("changed during verification")) throw error;
      // A missing or newly unsafe durable owner cannot claim a new physical
      // file, but its retained path/identity must remain fail-closed.
      continue;
    }
    if (binding.physicalIdentity === null) continue;
    const physicalOwner = db.prepare(
      "SELECT canonical_path FROM delivery_recording_owners_v17 WHERE physical_identity = ?",
    ).get(binding.physicalIdentity) as { canonical_path: string } | undefined;
    if (physicalOwner !== undefined && physicalOwner.canonical_path !== owner.canonical_path) continue;
    db.prepare(
      `UPDATE delivery_recording_owners_v17
          SET physical_identity = ?, owner_state = 'observed', failure_reason = NULL
        WHERE canonical_path = ? AND owner_state IN ('observed', 'reserved')`,
    ).run(binding.physicalIdentity, owner.canonical_path);
    assertDeliveryRecordingBindingUnchanged(owner.recording_handle, owner.canonical_path, binding);
  }
}

/** SQL migrations cannot resolve filesystem aliases or inspect inode identity.
 * Repair legacy schemas deterministically at reopen: the first retained owner
 * wins; every conflicting or malformed row becomes durably fail-closed and
 * can never silently hand the physical source to a later occurrence. */
function repairDeliveryRecordingOwners(db: Database.Database): void {
  if (currentSchemaVersion(db) < 17) return;
  const rows = db.prepare(
    `SELECT j.rowid AS journal_rowid, j.occurrence_id, r.handle, r.encrypted_path
       FROM delivery_journal j JOIN recordings r ON r.occurrence_id = j.occurrence_id
      ORDER BY j.rowid`,
  ).all() as Array<{ journal_rowid: number; occurrence_id: string; handle: string; encrypted_path: string }>;
  const repair = db.transaction(() => {
    for (const row of rows) {
      try {
        const binding = claimDeliveryRecordingOwner(db, row.occurrence_id, row.handle, row.encrypted_path);
        if (binding === null) {
          db.prepare("UPDATE delivery_journal SET retry_reason = 'recovery_unavailable' WHERE rowid = ?").run(row.journal_rowid);
          continue;
        }
        // Once publication is durable in both ledgers, an owned missing
        // source can be a completed deletion awaiting its journal commit.
        // Repair old missing-source markers only after ownership succeeds;
        // conflicts and malformed bindings remain fail-closed above/below.
        db.prepare(
          `UPDATE delivery_journal
              SET recording_path = ?, recording_handle = ?,
                  retry_reason = CASE WHEN ? IS NULL THEN
                    CASE WHEN published_at_ms IS NOT NULL AND EXISTS (
                      SELECT 1 FROM sessions s WHERE s.occurrence_id = delivery_journal.occurrence_id AND s.state IN ('published', 'notified')
                    ) THEN NULL ELSE 'recovery_unavailable' END
                    ELSE retry_reason END
            WHERE rowid = ?`,
        ).run(binding.canonicalPath, binding.handle, binding.physicalIdentity, row.journal_rowid);
      } catch {
        const canonicalPath = path.resolve(row.encrypted_path);
        db.prepare(
          `INSERT OR IGNORE INTO delivery_recording_owners_v17
             (canonical_path, physical_identity, occurrence_id, recording_handle, owner_state, failure_reason)
           VALUES (?, NULL, ?, NULL, 'invalid', 'invalid_runtime_recording_binding')`,
        ).run(canonicalPath, row.occurrence_id);
        db.prepare("UPDATE delivery_journal SET recording_path = ?, retry_reason = 'recovery_unavailable' WHERE rowid = ?")
          .run(canonicalPath, row.journal_rowid);
      }
    }
  });
  repair();
}

const RECONCILIATION_EVIDENCE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** A collision-free, internal identity for the public occurrence/session pair.
 * Neither bridge adapters nor callers choose it, so bridge-session IDs retain
 * their contract-local scope while children can use ordinary single-column
 * foreign keys. */
function reconciliationGenerationId(occurrenceId: string, bridgeSessionId: string): string {
  return `${Buffer.from(occurrenceId, "utf8").toString("hex")}:${Buffer.from(bridgeSessionId, "utf8").toString("hex")}`;
}

function beginReconciliationGeneration(db: Database.Database, occurrenceId: string, bridgeSessionId: string, createdAtMs: number): void {
  withConstraintTranslation(() => db.prepare(
    `INSERT INTO reconciliation_generations
       (generation_id, occurrence_id, bridge_session_id, created_at_ms)
     VALUES (?, ?, ?, ?)`,
  ).run(reconciliationGenerationId(occurrenceId, bridgeSessionId), occurrenceId, bridgeSessionId, createdAtMs));
}

function setReconciliationRuntimeSession(db: Database.Database, occurrenceId: string, bridgeSessionId: string, runtimeSessionId: bigint): void {
  const changed = db.prepare(
    `UPDATE reconciliation_generations SET runtime_session_id = ?
     WHERE generation_id = ? AND occurrence_id = ? AND runtime_session_id IS NULL`,
  ).run(runtimeSessionId.toString(), reconciliationGenerationId(occurrenceId, bridgeSessionId), occurrenceId).changes;
  if (changed !== 1) throw new OrchestrationError("constraint_violation", "reconciliation generation is unknown or already has a runtime session");
}

const GENERATION_TERMINAL_REASONS: ReadonlySet<string> = new Set(["ended", "removed", "bridge_failure"]);

/** D027: a bridge_observed completion carries the bridge's own reason; a
 * local_clock completion carries none. `finalizeSession` may already have
 * written the same bridge_observed terminal without a reason (the session's
 * `finally` completes the generation afterwards), so the reason is also
 * filled onto that exact terminal when it is still NULL. */
function completeReconciliationGeneration(db: Database.Database, occurrenceId: string, bridgeSessionId: string, terminalAtMs: number,
  terminalSource: "bridge_observed" | "local_clock", terminalReason?: "ended" | "removed" | "bridge_failure"): void {
  if (terminalSource === "bridge_observed"
    ? (typeof terminalReason !== "string" || !GENERATION_TERMINAL_REASONS.has(terminalReason))
    : terminalReason !== undefined) {
    throw new OrchestrationError("constraint_violation", "reconciliation terminal reason must accompany exactly a bridge-observed terminal");
  }
  const generationId = reconciliationGenerationId(occurrenceId, bridgeSessionId);
  let changed = db.prepare(
    `UPDATE reconciliation_generations SET terminal_at_ms = ?, terminal_source = ?, terminal_reason = ?, expires_at_ms = ?
     WHERE generation_id = ? AND occurrence_id = ? AND terminal_at_ms IS NULL`,
  ).run(terminalAtMs, terminalSource, terminalReason ?? null, terminalAtMs + RECONCILIATION_EVIDENCE_RETENTION_MS,
    generationId, occurrenceId).changes;
  if (changed !== 1 && terminalReason !== undefined) {
    changed = db.prepare(
      `UPDATE reconciliation_generations SET terminal_reason = ?
       WHERE generation_id = ? AND occurrence_id = ? AND terminal_at_ms = ? AND terminal_source = 'bridge_observed' AND terminal_reason IS NULL`,
    ).run(terminalReason, generationId, occurrenceId, terminalAtMs).changes;
  }
  if (changed !== 1) {
    const existing = db.prepare("SELECT 1 FROM reconciliation_generations WHERE generation_id = ? AND occurrence_id = ?")
      .get(reconciliationGenerationId(occurrenceId, bridgeSessionId), occurrenceId);
    if (existing === undefined) throw new OrchestrationError("constraint_violation", "reconciliation generation is unknown");
  }
}

function appendReconciliationBridgeEvent(
  db: Database.Database,
  occurrenceId: string,
  event: ReconciliationBridgeEventRow,
): void {
  const observedAtMs = parseCanonicalUtc(event.observedAt, "bridge event observedAt");
  const generationId = reconciliationGenerationId(occurrenceId, event.bridgeSessionId);
  const run = () => {
    const generation = db.prepare("SELECT bridge_session_id FROM reconciliation_generations WHERE generation_id = ? AND occurrence_id = ?")
      .get(generationId, occurrenceId) as { bridge_session_id: string } | undefined;
    if (generation === undefined || generation.bridge_session_id !== event.bridgeSessionId) {
      throw new OrchestrationError("constraint_violation", "bridge event does not belong to reconciliation generation");
    }
    db.prepare(
    `INSERT INTO reconciliation_bridge_events
       (generation_id, bridge_session_id, sequence, schema, observed_at, observed_at_ms, type, feishu_user_id, display_name, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(generationId, event.bridgeSessionId, event.sequence, event.schema, event.observedAt, observedAtMs, event.type,
      event.feishuUserId, event.displayName, event.confidence);
  };
  withConstraintTranslation(run);
}

function appendReconciliationLiveSegment(
  db: Database.Database,
  occurrenceId: string,
  segment: ReconciliationLiveSegmentRow,
): void {
  const startedAtMs = parseCanonicalUtc(segment.startedAt, "live segment startedAt");
  const endedAtMs = parseCanonicalUtc(segment.endedAt, "live segment endedAt");
  if (endedAtMs < startedAtMs) throw new OrchestrationError("constraint_violation", "live segment ends before it starts");
  const generationId = reconciliationGenerationId(occurrenceId, segment.bridgeSessionId);
  const run = () => {
    const generation = db.prepare("SELECT 1 FROM reconciliation_generations WHERE generation_id = ? AND occurrence_id = ?")
      .get(generationId, occurrenceId);
    if (generation === undefined) throw new OrchestrationError("constraint_violation", "live segment does not belong to reconciliation generation");
    db.prepare(
    `INSERT INTO reconciliation_live_segments (generation_id, segment_id, text, started_at, started_at_ms, ended_at, ended_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(generationId, segment.segmentId, segment.text, segment.startedAt, startedAtMs, segment.endedAt, endedAtMs);
  };
  withConstraintTranslation(run);
}

function getReconciliationEvidence(db: Database.Database, occurrenceId: string, recordingHandle: string | null): ReconciliationEvidenceRow | null {
  const generation = db.prepare(
    recordingHandle === null
      ? `SELECT generation_id, bridge_session_id, runtime_session_id, alignment_status, capture_complete, incomplete_reason, terminal_at_ms, terminal_source, expires_at_ms
           FROM reconciliation_generations WHERE occurrence_id = ? ORDER BY created_at_ms DESC, generation_id DESC LIMIT 1`
      : `SELECT generation_id, bridge_session_id, runtime_session_id, alignment_status, capture_complete, incomplete_reason, terminal_at_ms, terminal_source, expires_at_ms
           FROM reconciliation_generations WHERE occurrence_id = ? AND recording_handle = ?`,
  ).get(...(recordingHandle === null ? [occurrenceId] : [occurrenceId, recordingHandle])) as { generation_id: string; bridge_session_id: string; runtime_session_id: string | null; alignment_status: "unavailable_current_sdk"; capture_complete: 0 | 1; incomplete_reason: ReconciliationEvidenceRow["incompleteReason"]; terminal_at_ms: number | null; terminal_source: ReconciliationEvidenceRow["terminalSource"]; expires_at_ms: number | null } | undefined;
  if (generation === undefined) return null;
  const bridgeEvents = db.prepare(
    `SELECT bridge_session_id, sequence, schema, observed_at, observed_at_ms, type, feishu_user_id, display_name, confidence
       FROM reconciliation_bridge_events WHERE generation_id = ?`,
  ).all(generation.generation_id) as Array<{ bridge_session_id: string; sequence: number; schema: "bridge-session/v1"; observed_at: string; observed_at_ms: number; type: ReconciliationBridgeEventRow["type"]; feishu_user_id: string | null; display_name: string | null; confidence: ReconciliationBridgeEventRow["confidence"] }>;
  const liveSegments = db.prepare(
    `SELECT segment_id, text, started_at, started_at_ms, ended_at, ended_at_ms FROM reconciliation_live_segments
       WHERE generation_id = ?`,
  ).all(generation.generation_id) as Array<{ segment_id: string; text: string; started_at: string; started_at_ms: number; ended_at: string; ended_at_ms: number }>;
  return {
    occurrenceId,
    generationId: generation.generation_id,
    runtimeSessionId: generation.runtime_session_id === null ? null : BigInt(generation.runtime_session_id),
    alignment: null,
    alignmentStatus: generation.alignment_status,
    captureComplete: generation.capture_complete === 1,
    incompleteReason: generation.incomplete_reason,
    expiresAtMs: generation.expires_at_ms,
    terminalAtMs: generation.terminal_at_ms,
    terminalSource: generation.terminal_source,
    bridgeEvents: bridgeEvents
      .sort((a, b) => a.observed_at_ms - b.observed_at_ms
        || a.sequence - b.sequence || a.bridge_session_id.localeCompare(b.bridge_session_id))
      .map((row) => ({ bridgeSessionId: row.bridge_session_id, sequence: row.sequence, schema: row.schema,
        observedAt: row.observed_at, observedAtMs: row.observed_at_ms, type: row.type, feishuUserId: row.feishu_user_id,
        displayName: row.display_name, confidence: row.confidence })),
    liveSegments: liveSegments
      .sort((a, b) => a.started_at_ms - b.started_at_ms || a.segment_id.localeCompare(b.segment_id))
      .map((row) => ({ bridgeSessionId: generation.bridge_session_id, segmentId: row.segment_id, text: row.text,
        startedAt: row.started_at, endedAt: row.ended_at })),
  };
}

function purgeExpiredReconciliationEvidence(db: Database.Database, nowMs: number): number {
  const legacy = db.prepare(`DELETE FROM reconciliation_generations WHERE terminal_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?
    AND NOT EXISTS (SELECT 1 FROM timed_evidence_owners WHERE timed_evidence_owners.generation_id = reconciliation_generations.generation_id)`).run(nowMs).changes;
  return legacy + purgeExpiredTimedEvidenceBatch(db, nowMs).removedGenerations;
}

type TimedHeader = TimedEvidenceStatus & { generationId: string; token: string; expiresAtMs: number | null };
// An inspected durable descriptor is not a current writer capability. The
// object admission is private/process-local; exact-token SQL CAS is final.
const timedWriterPermits = new WeakSet<object>();
function getTimedEvidenceBinding(db: Database.Database, generationId: string, nowMs: number): TimedEvidenceBindingResult {
  requirePrivateState(db);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("invalid timed evidence clock");
  const row = db.prepare(`SELECT g.occurrence_id, g.bridge_session_id, g.runtime_session_id, g.recording_handle,
      g.terminal_at_ms, g.expires_at_ms, o.state
    FROM reconciliation_generations g LEFT JOIN timed_evidence_owners o USING(generation_id)
    WHERE g.generation_id = ?`).get(generationId) as { occurrence_id: string; bridge_session_id: string; runtime_session_id: string | null;
      recording_handle: string | null; terminal_at_ms: number | null; expires_at_ms: number | null; state: string | null } | undefined;
  if (!row) return { kind: "absent" };
  if (generationId !== reconciliationGenerationId(row.occurrence_id, row.bridge_session_id) ||
    [row.terminal_at_ms, row.expires_at_ms].some((value) => value !== null && (!Number.isSafeInteger(value) || value < 0))) throw new Error("invalid timed evidence identity");
  if (row.expires_at_ms !== null && row.expires_at_ms <= nowMs) return { kind: "expired" };
  if (row.state === null) return { kind: "legacy" };
  if (row.runtime_session_id === null || !/^[1-9][0-9]{0,19}$/.test(row.runtime_session_id) || BigInt(row.runtime_session_id) > (1n << 64n) - 1n ||
    (row.recording_handle !== null && !/^[0-9a-f]{32}$/.test(row.recording_handle)) ||
    (row.state !== "active" && row.state !== "recovering" && row.state !== "closed")) throw new Error("invalid timed evidence identity");
  return { kind: "timed", generationId, binding: { occurrenceId: row.occurrence_id, bridgeSessionId: row.bridge_session_id, runtimeSessionId: BigInt(row.runtime_session_id) },
    recordingHandle: row.recording_handle, terminalAtMs: row.terminal_at_ms, expiresAtMs: row.expires_at_ms, state: row.state };
}
function timedHeader(db: Database.Database, binding: TimedEvidenceBinding, nowMs: number, includeExpired = false): TimedHeader | null {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || binding.runtimeSessionId <= 0n) throw new Error("invalid timed evidence binding");
  const row = db.prepare(`SELECT o.generation_id AS generationId, o.owner_token AS token, o.state, o.ui_rows AS uiRows, o.ui_bytes AS uiBytes,
      o.live_rows AS liveRows, o.ui_loss_reason AS uiLossReason, o.wording_loss_reason AS wordingLossReason, g.expires_at_ms AS expiresAtMs
    FROM timed_evidence_owners o JOIN reconciliation_generations g USING(generation_id)
    WHERE g.occurrence_id = ? AND g.bridge_session_id = ? AND g.runtime_session_id = ?`).get(binding.occurrenceId, binding.bridgeSessionId, binding.runtimeSessionId.toString()) as TimedHeader | undefined;
  return !row || (!includeExpired && row.expiresAtMs !== null && row.expiresAtMs <= nowMs) ? null : row;
}
function ownedTimedHeader(db: Database.Database, owner: TimedEvidenceOwner, nowMs: number, recovering = false, recoveryProbe = false): TimedHeader | null {
  if (!recoveryProbe && !timedWriterPermits.has(owner)) throw new Error("missing live writer authority");
  if (requirePrivateState(db) !== owner.storeIdentity) throw new Error("timed evidence owner changed store");
  const row = timedHeader(db, owner, nowMs, true);
  if (!row || row.generationId !== owner.generationId || row.token !== owner.token || (row.state !== "active" && !(recovering && row.state === "recovering"))) throw new Error("timed evidence owner is stale or closed");
  return row.expiresAtMs !== null && row.expiresAtMs <= nowMs ? null : row;
}
function beginTimedEvidence(db: Database.Database, binding: TimedEvidenceBinding, nowMs: number): TimedEvidenceOwner {
  const storeIdentity = requirePrivateState(db), generationId = reconciliationGenerationId(binding.occurrenceId, binding.bridgeSessionId);
  return db.transaction(() => {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("invalid timed evidence clock");
    const generation = db.prepare(`SELECT 1 FROM reconciliation_generations WHERE generation_id = ? AND runtime_session_id = ? AND terminal_at_ms IS NULL`).get(generationId, binding.runtimeSessionId.toString());
    if (!generation || binding.runtimeSessionId <= 0n) throw new Error("timed evidence generation is not current");
    if (db.prepare("SELECT 1 FROM timed_evidence_owners WHERE generation_id = ?").get(generationId)) throw new Error("timed evidence owner already exists");
    const token = randomUUID();
    db.prepare("INSERT INTO timed_evidence_owners(generation_id, owner_token, state) VALUES (?, ?, 'active')").run(generationId, token);
    const owner = Object.freeze({ ...binding, generationId, token, storeIdentity });
    timedWriterPermits.add(owner); return owner;
  })();
}
function appendTimedUi(db: Database.Database, owner: TimedEvidenceOwner, event: BridgeEventMessageV2, nowMs: number): TimedAppendResult {
  return db.transaction((): TimedAppendResult => {
    const row = ownedTimedHeader(db, owner, nowMs); if (!row) return "expired";
    const parsed = parseEventV2(event);
    if (parsed.sessionId !== owner.bridgeSessionId) throw new Error("invalid timed UI evidence");
    const payload = JSON.stringify(parsed), bytes = Buffer.byteLength(payload);
    const previous = db.prepare("SELECT payload FROM timed_ui_evidence WHERE generation_id = ? AND sequence = ?").get(owner.generationId, event.sequence) as { payload: string } | undefined;
    if (previous) { if (previous.payload !== payload) throw new Error("timed UI duplicate changed evidence"); return "duplicate"; }
    if (row.uiRows >= 65536 || row.uiBytes + bytes > 268435456) {
      db.prepare("UPDATE timed_evidence_owners SET ui_loss_reason = COALESCE(ui_loss_reason, 'ui_limit_exceeded') WHERE generation_id = ?").run(owner.generationId);
      return "overflow";
    }
    db.prepare("INSERT INTO timed_ui_evidence(generation_id, sequence, payload) VALUES (?, ?, ?)").run(owner.generationId, event.sequence, payload);
    return "inserted";
  })();
}
function appendTimedFinal(db: Database.Database, owner: TimedEvidenceOwner, event: VersionFourVoiceTranscriptFinalEvent, nowMs: number): TimedAppendResult {
  return db.transaction((): TimedAppendResult => {
    const row = ownedTimedHeader(db, owner, nowMs); if (!row) return "expired";
    if (event.sessionId !== owner.runtimeSessionId || event.type !== "voice_transcript_final") throw new Error("timed final changed live source");
    const previous = db.prepare("SELECT text, evidence FROM timed_live_evidence WHERE generation_id = ? AND segment_id = ?").get(owner.generationId, event.segmentId) as { text: string; evidence: string } | undefined;
    const evidence = encodeLiveEvidence(event);
    if (previous) { if (previous.text !== event.text || previous.evidence !== evidence) throw new Error("timed final duplicate changed evidence"); return "duplicate"; }
    if (Buffer.byteLength(event.text) > 16384 || row.liveRows >= 256) {
      db.prepare("UPDATE timed_evidence_owners SET wording_loss_reason = COALESCE(wording_loss_reason, ?) WHERE generation_id = ?")
        .run(Buffer.byteLength(event.text) > 16384 ? "text_limit_exceeded" : "live_limit_exceeded", owner.generationId);
      return "overflow";
    }
    db.prepare("INSERT INTO timed_live_evidence(generation_id, segment_id, text, evidence) VALUES (?, ?, ?, ?)").run(owner.generationId, event.segmentId, event.text, evidence);
    return "inserted";
  })();
}
function resolveTimedFinal(db: Database.Database, owner: TimedEvidenceOwner, segmentId: string, result: ProvisionalResult, nowMs: number): boolean {
  return db.transaction(() => {
    const row = ownedTimedHeader(db, owner, nowMs, result.kind === "anonymous" && (result.reason === "owner_restarted" || result.reason === "evidence_expired"));
    const actual: ProvisionalResult = row === null ? { kind: "anonymous", reason: "evidence_expired" } : result;
    return db.prepare("UPDATE timed_live_evidence SET result = ? WHERE generation_id = ? AND segment_id = ? AND result IS NULL")
      .run(encodeProvisionalResult(actual), owner.generationId, segmentId).changes === 1;
  })();
}
function readTimedUi(db: Database.Database, binding: TimedEvidenceBinding, afterSequence: number, nowMs: number): readonly BridgeEventMessageV2[] {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("invalid timed UI cursor");
  const row = timedHeader(db, binding, nowMs); if (!row) return [];
  return (db.prepare("SELECT payload FROM timed_ui_evidence WHERE generation_id = ? AND sequence > ? ORDER BY sequence LIMIT 8").all(row.generationId, afterSequence) as { payload: string }[]).map(({ payload }) => {
    const parsed = parseEventV2(JSON.parse(payload) as unknown);
    if (parsed.sessionId !== binding.bridgeSessionId) throw new Error("corrupt timed UI evidence");
    return parsed;
  });
}
function closeTimedEvidence(db: Database.Database, owner: TimedEvidenceOwner, nowMs: number): void {
  db.transaction(() => {
    ownedTimedHeader(db, owner, nowMs, true);
    if (db.prepare("SELECT 1 FROM timed_live_evidence WHERE generation_id = ? AND result IS NULL LIMIT 1").get(owner.generationId)) throw new Error("timed owner still has unresolved evidence");
    db.prepare("UPDATE timed_evidence_owners SET state = 'closed' WHERE generation_id = ? AND owner_token = ?").run(owner.generationId, owner.token);
  })();
  timedWriterPermits.delete(owner);
}
function getTimedRecoveryOwner(db: Database.Database, binding: TimedEvidenceBinding, nowMs: number): TimedEvidenceOwner | null {
  const storeIdentity = requirePrivateState(db), row = timedHeader(db, binding, nowMs);
  if (!row || row.state === "closed") return null;
  return { ...binding, generationId: row.generationId, token: row.token, storeIdentity };
}
function beginTimedRecovery(db: Database.Database, owner: TimedEvidenceOwner, permit: LiveRecoveryPermit, nowMs: number): TimedEvidenceOwner {
  return db.transaction(() => {
    ownedTimedHeader(db, owner, nowMs, true, true);
    consumeLiveRecoveryPermit(permit, owner);
    const token = randomUUID();
    const changed = db.prepare("UPDATE timed_evidence_owners SET state = 'recovering', owner_token = ? WHERE generation_id = ? AND owner_token = ? AND state != 'closed'")
      .run(token, owner.generationId, owner.token).changes;
    if (changed !== 1) throw new Error("live recovery owner changed");
    const admitted = Object.freeze({ ...owner, token });
    timedWriterPermits.add(admitted); return admitted;
  })();
}
function readTimedFinal(db: Database.Database, binding: TimedEvidenceBinding, afterSegmentId: string, nowMs: number): TimedLiveRow | null {
  const row = timedHeader(db, binding, nowMs); if (!row) return null;
  const stored = db.prepare("SELECT segment_id, text, evidence, result FROM timed_live_evidence WHERE generation_id = ? AND segment_id > ? ORDER BY segment_id LIMIT 1")
    .get(row.generationId, afterSegmentId) as { segment_id: string; text: string; evidence: string; result: string | null } | undefined;
  if (!stored) return null;
  const event = decodeLiveEvidence(stored.evidence, stored.text);
  if (event.sessionId !== binding.runtimeSessionId || event.segmentId !== stored.segment_id) throw new Error("corrupt timed live binding");
  return { event, result: stored.result === null ? null : decodeProvisionalResult(stored.result) };
}
function purgeExpiredTimedEvidenceBatch(db: Database.Database, nowMs: number): TimedPurgeProgress {
  return db.transaction(() => {
    const row = db.prepare(`SELECT g.generation_id FROM reconciliation_generations g JOIN timed_evidence_owners o USING(generation_id)
      WHERE g.terminal_at_ms IS NOT NULL AND g.expires_at_ms <= ? ORDER BY g.expires_at_ms, g.generation_id LIMIT 1`).get(nowMs) as { generation_id: string } | undefined;
    if (!row) return { removedRows: 0, removedGenerations: 0, pending: false };
    const removedUi = db.prepare(`DELETE FROM timed_ui_evidence WHERE generation_id = ? AND sequence IN
      (SELECT sequence FROM timed_ui_evidence WHERE generation_id = ? ORDER BY sequence LIMIT 8)`).run(row.generation_id, row.generation_id).changes;
    const removedLive = db.prepare(`DELETE FROM timed_live_evidence WHERE generation_id = ? AND segment_id IN
      (SELECT segment_id FROM timed_live_evidence WHERE generation_id = ? ORDER BY segment_id LIMIT 1)`).run(row.generation_id, row.generation_id).changes;
    let removedGenerations = 0;
    if (!db.prepare("SELECT 1 FROM timed_ui_evidence WHERE generation_id = ? LIMIT 1").get(row.generation_id) && !db.prepare("SELECT 1 FROM timed_live_evidence WHERE generation_id = ? LIMIT 1").get(row.generation_id)) {
      db.prepare("DELETE FROM timed_evidence_owners WHERE generation_id = ?").run(row.generation_id);
      removedGenerations = db.prepare("DELETE FROM reconciliation_generations WHERE generation_id = ?").run(row.generation_id).changes;
    }
    const pending = !!db.prepare(`SELECT 1 FROM reconciliation_generations g JOIN timed_evidence_owners o USING(generation_id) WHERE g.terminal_at_ms IS NOT NULL AND g.expires_at_ms <= ? LIMIT 1`).get(nowMs);
    return { removedRows: removedUi + removedLive, removedGenerations, pending };
  })();
}

function parseCanonicalUtc(value: string, field: string): number {
  const milliseconds = Date.parse(value);
  const canonical = Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : "";
  if (value !== canonical && value !== canonical.replace(".000Z", "Z")) {
    throw new OrchestrationError("constraint_violation", `${field} must be a canonical UTC instant`);
  }
  return milliseconds;
}

function recordBridgeFailure(
  db: Database.Database,
  input: {
    readonly occurrenceId: string;
    readonly nowMs: number;
    readonly maxRetries: number;
    readonly gaps: FinalizeSessionInput["recording"]["gaps"];
    readonly recording: FinalizeSessionInput["recording"] | null;
    readonly deferExhaustion?: boolean;
  },
): BridgeRecoveryResult {
  const run = db.transaction(() => withConstraintTranslation(() => {
    if (selectSessionRaw(db, input.occurrenceId) === undefined) {
      throw new OrchestrationError("unknown_session", `no session exists for occurrence "${input.occurrenceId}"`);
    }
    const current = db
      .prepare("SELECT failure_count FROM bridge_recoveries WHERE occurrence_id = ?")
      .get(input.occurrenceId) as { failure_count: number } | undefined;
    const attempt = (current?.failure_count ?? 0) + 1;
    db.prepare(
      `INSERT INTO bridge_recoveries (occurrence_id, failure_count, last_failed_at_ms) VALUES (?, ?, ?)
       ON CONFLICT(occurrence_id) DO UPDATE SET failure_count = excluded.failure_count,
         last_failed_at_ms = excluded.last_failed_at_ms`,
    ).run(input.occurrenceId, attempt, input.nowMs);
    const insertGap = db.prepare(
      `INSERT INTO bridge_recovery_gaps (occurrence_id, attempt, ordinal, direction, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    input.gaps.forEach((gap, ordinal) => {
      insertGap.run(input.occurrenceId, attempt, ordinal, gap.direction, gap.startedAt, gap.endedAt);
    });
    if (input.recording !== null) {
      db.prepare(
        `INSERT INTO bridge_failure_recordings
          (occurrence_id, attempt, handle, encrypted_path, sha256, duration_ms, format, key_id, finalized_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.occurrenceId, attempt, input.recording.handle, input.recording.encryptedPath,
        input.recording.sha256, input.recording.durationMs, input.recording.format, input.recording.keyId, input.nowMs);
      insertRuntimeGaps(
        db,
        "bridge_failure_recording_runtime_gaps",
        [input.occurrenceId, attempt],
        input.recording.runtimeGaps,
      );
      bindRecordingRecovery(db, input.occurrenceId, input.recording, attempt);
    }
    const retryAllowed = attempt <= input.maxRetries;
    // Deferred: the caller publishes what was recorded, then ends the row.
    if (!retryAllowed && input.deferExhaustion !== true) {
      // This nested transaction is a SQLite savepoint: the failure count,
      // failed-generation evidence, and terminal occurrence edge commit or
      // roll back together.
      transition(db, {
        occurrenceId: input.occurrenceId,
        fromState: "listening",
        toState: "failed",
        reason: "fail",
        terminalReason: "bridge_failure_exhausted",
        nowMs: input.nowMs,
      });
    }
    return { attempt, retryAllowed };
  }));
  return run();
}

function getBridgeFailureRecording(
  db: Database.Database, occurrenceId: string, attempt: number,
): BridgeFailureRecordingRow | null {
  const row = db.prepare(
    `SELECT handle, encrypted_path, sha256, duration_ms, format, key_id, finalized_at_ms
       FROM bridge_failure_recordings WHERE occurrence_id = ? AND attempt = ?`,
  ).get(occurrenceId, attempt) as { handle: string; encrypted_path: string; sha256: string; duration_ms: number; format: string; key_id: string; finalized_at_ms: number } | undefined;
  if (row === undefined) return null;
  const gaps = db.prepare(
    `SELECT ordinal, direction, started_at, ended_at FROM bridge_recovery_gaps
       WHERE occurrence_id = ? AND attempt = ? ORDER BY ordinal`,
  ).all(occurrenceId, attempt) as Array<{ ordinal: number; direction: string; started_at: string; ended_at: string | null }>;
  const runtimeGaps = selectRuntimeGaps(
    db,
    "bridge_failure_recording_runtime_gaps",
    "occurrence_id = ? AND attempt = ?",
    [occurrenceId, attempt],
  );
  return { occurrenceId, attempt, handle: row.handle, encryptedPath: row.encrypted_path, sha256: row.sha256,
    durationMs: row.duration_ms, format: row.format, keyId: row.key_id, finalizedAtMs: row.finalized_at_ms,
    // Migration 028 added the drain columns to `recordings` only. A bridge
    // failure recording carries no drain claim at all, which is what
    // `unavailable` says; nothing here infers one from the failure.
    captureDrain: null, captureIntegrity: "unavailable",
    gaps: gaps.map((gap) => ({ ordinal: gap.ordinal, direction: gap.direction as RecordingGapRow["direction"], startedAt: gap.started_at, endedAt: gap.ended_at })),
    runtimeGaps };
}

type RuntimeGapInput = FinalizeSessionInput["recording"]["runtimeGaps"];

/** Every finalized generation of an occurrence that has a private recovery
 * binding, in order: failed attempts by attempt number, then the final one. */
function listRecordingGenerations(db: Database.Database, occurrenceId: string): readonly StoredRecordingGeneration[] {
  const rows = db.prepare(`SELECT binding.bridge_session_id, binding.recording_handle, generation.created_at_ms, generation.terminal_at_ms
    FROM recording_recovery_bindings AS binding JOIN reconciliation_generations AS generation ON generation.generation_id = binding.generation_id
    WHERE binding.occurrence_id = ? ORDER BY binding.failure_attempt IS NULL, binding.failure_attempt, generation.created_at_ms`)
    .all(occurrenceId) as Array<{ bridge_session_id: string; recording_handle: string; created_at_ms: number; terminal_at_ms: number | null }>;
  return rows.map((row) => ({ ...getRecordingRecovery(db, occurrenceId, row.bridge_session_id, row.recording_handle)!,
    recordingHandle: row.recording_handle, startedAtMs: row.created_at_ms, terminalAtMs: row.terminal_at_ms }));
}

/**
 * Publishes an occurrence whose bridge generations all failed: the longest
 * failed recording becomes the occurrence's recording and backfill seed, the
 * end is the last generation's terminal (the end of what was captured, with
 * `meeting_end_unobserved` saying so), and the row advances to finalizing.
 * Returns null, changing nothing, when no failed generation was recorded.
 */
function publishStoredGenerations(db: Database.Database, input: PublishStoredGenerationsInput): PublishStoredGenerationsResult | null {
  const failed = (db.prepare(`SELECT failure_attempt FROM recording_recovery_bindings
    WHERE occurrence_id = ? AND recording_kind = 'bridge_failure' ORDER BY failure_attempt`).all(input.occurrenceId) as Array<{ failure_attempt: number }>)
    .map((row) => getBridgeFailureRecording(db, input.occurrenceId, row.failure_attempt))
    .filter((row): row is BridgeFailureRecordingRow & { encryptedPath: string; format: string; keyId: string } =>
      row !== null && row.encryptedPath !== null && row.format !== null && row.keyId !== null);
  if (failed.length === 0) return null;
  const anchor = failed.reduce((best, row) => row.durationMs >= best.durationMs ? row : best);
  const binding = db.prepare(`SELECT bridge_session_id FROM recording_recovery_bindings WHERE occurrence_id = ? AND failure_attempt = ?`)
    .get(input.occurrenceId, anchor.attempt) as { bridge_session_id: string };
  const recovery = getRecordingRecovery(db, input.occurrenceId, binding.bridge_session_id, anchor.handle)!;
  // The end of capture: the last terminal of a generation that left a recording
  // (a generation completed later, e.g. by a restart sweep, did not capture).
  const terminal = db.prepare(`SELECT max(generation.terminal_at_ms) AS at FROM reconciliation_generations AS generation
    JOIN recording_recovery_bindings AS binding ON binding.generation_id = generation.generation_id
    WHERE generation.occurrence_id = ?`).get(input.occurrenceId) as { at: number | null };
  const endedAtMs = terminal.at ?? input.nowMs;
  const endedAt = new Date(endedAtMs).toISOString();
  const recording: RecordingInput = {
    recovery: { bridgeSessionId: binding.bridge_session_id, capability: recovery.capability },
    handle: anchor.handle, encryptedPath: anchor.encryptedPath, sha256: anchor.sha256, durationMs: anchor.durationMs,
    format: anchor.format, keyId: anchor.keyId,
    gaps: anchor.gaps.map((gap) => ({ direction: gap.direction, startedAt: gap.startedAt, endedAt: gap.endedAt })),
    runtimeGaps: anchor.runtimeGaps.map((gap) => ({ startedAtMs: gap.startedAtMs, endedAtMs: gap.endedAtMs, reason: gap.reason })),
  };
  const seedInput = { ...input.seed, terminalReason: "ended" as const, terminalSource: "bridge_observed" as const, endedAt,
    processingWarnings: [...input.seed.processingWarnings, { code: "meeting_end_unobserved", detail: input.reason }] };
  // Every gap is derived from the stored generations at build time.
  const prepared = prepareSeedFields(db, seedInput, recording, input.occurrenceId, binding.bridge_session_id, endedAtMs, []);
  db.transaction(() => withConstraintTranslation(() => {
    transition(db, { occurrenceId: input.occurrenceId, fromState: "listening", toState: "finalizing", reason: "advance", terminalReason: null, nowMs: input.nowMs });
    db.prepare(`INSERT INTO recordings (occurrence_id, handle, encrypted_path, sha256, duration_ms, format, key_id, finalized_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.occurrenceId, anchor.handle, anchor.encryptedPath, anchor.sha256, anchor.durationMs, anchor.format, anchor.keyId, input.nowMs);
    const insertGap = db.prepare("INSERT INTO recording_gaps (occurrence_id, ordinal, direction, started_at, ended_at) VALUES (?, ?, ?, ?, ?)");
    recording.gaps.forEach((gap, ordinal) => { insertGap.run(input.occurrenceId, ordinal, gap.direction, gap.startedAt, gap.endedAt); });
    insertRuntimeGaps(db, "recording_runtime_gaps", [input.occurrenceId], recording.runtimeGaps);
    insertBackfillSeed(db, prepared);
    assertBackfillRecordingBindingUnchanged(prepared.binding);
  }))();
  return { attempt: anchor.attempt, endedAt, generations: failed.length };
}

function insertRuntimeGaps(
  db: Database.Database,
  table: "recording_runtime_gaps" | "bridge_failure_recording_runtime_gaps",
  parentValues: readonly [string] | readonly [string, number],
  gaps: RuntimeGapInput,
): void {
  const parentColumns = table === "recording_runtime_gaps"
    ? "occurrence_id"
    : "occurrence_id, attempt";
  const placeholders = parentValues.map(() => "?").join(", ");
  const insert = db.prepare(
    `INSERT INTO ${table}
       (${parentColumns}, ordinal, started_at_ms, ended_at_ms, reason)
     VALUES (${placeholders}, ?, ?, ?, ?)`,
  );
  gaps.forEach((gap, ordinal) => {
    insert.run(
      ...parentValues,
      ordinal,
      gap.startedAtMs.toString(),
      gap.endedAtMs?.toString() ?? null,
      gap.reason,
    );
  });
}

function selectRuntimeGaps(
  db: Database.Database,
  table: "recording_runtime_gaps" | "bridge_failure_recording_runtime_gaps",
  where: string,
  values: readonly [string] | readonly [string, number],
): RuntimeRecordingGapRow[] {
  const rows = db.prepare(
    `SELECT ordinal, started_at_ms, ended_at_ms, reason
       FROM ${table} WHERE ${where} ORDER BY ordinal`,
  ).all(...values) as Array<{
    ordinal: number;
    started_at_ms: string;
    ended_at_ms: string | null;
    reason: string;
  }>;
  return rows.map((row) => ({
    ordinal: row.ordinal,
    startedAtMs: BigInt(row.started_at_ms),
    endedAtMs: row.ended_at_ms === null ? null : BigInt(row.ended_at_ms),
    reason: row.reason,
  }));
}

function toTransitionRow(raw: {
  id: number;
  occurrence_id: string;
  from_state: string | null;
  to_state: string;
  reason: string | null;
  terminal_reason: string | null;
  occurred_at_ms: number;
}): TransitionRow {
  return {
    id: raw.id,
    occurrenceId: raw.occurrence_id,
    fromState: raw.from_state as SessionState | null,
    toState: raw.to_state as SessionState,
    reason: raw.reason,
    terminalReason: raw.terminal_reason,
    occurredAtMs: raw.occurred_at_ms,
  };
}

function listTransitions(db: Database.Database, occurrenceId: string): TransitionRow[] {
  const rows = db
    .prepare(
      `SELECT id, occurrence_id, from_state, to_state, reason, terminal_reason, occurred_at_ms
       FROM transitions WHERE occurrence_id = ? ORDER BY id`,
    )
    .all(occurrenceId) as Array<{
    id: number;
    occurrence_id: string;
    from_state: string | null;
    to_state: string;
    reason: string | null;
    terminal_reason: string | null;
    occurred_at_ms: number;
  }>;
  return rows.map(toTransitionRow);
}

// ---------------------------------------------------------------------------
// Bridge leases
// ---------------------------------------------------------------------------

type LeaseRowRaw = {
  lease_id: string;
  occurrence_id: string;
  bridge_id: string;
  bridge_session_id: string;
  acquired_at_ms: number;
  expires_at_ms: number;
  released_at_ms: number | null;
  release_reason: string | null;
};

function toLeaseRow(raw: LeaseRowRaw): LeaseRow {
  return {
    leaseId: raw.lease_id,
    occurrenceId: raw.occurrence_id,
    bridgeId: raw.bridge_id,
    bridgeSessionId: raw.bridge_session_id,
    acquiredAtMs: raw.acquired_at_ms,
    expiresAtMs: raw.expires_at_ms,
    releasedAtMs: raw.released_at_ms,
    releaseReason: raw.release_reason as LeaseReleaseReason | null,
  };
}

function selectActiveLeaseRaw(db: Database.Database, occurrenceId: string): LeaseRowRaw | undefined {
  return db
    .prepare(
      `SELECT lease_id, occurrence_id, bridge_id, bridge_session_id, acquired_at_ms, expires_at_ms,
              released_at_ms, release_reason
       FROM bridge_leases WHERE occurrence_id = ? AND released_at_ms IS NULL`,
    )
    .get(occurrenceId) as LeaseRowRaw | undefined;
}

function selectActiveLeaseForBridgeRaw(db: Database.Database, bridgeId: string): LeaseRowRaw | undefined {
  return db
    .prepare(
      `SELECT lease_id, occurrence_id, bridge_id, bridge_session_id, acquired_at_ms, expires_at_ms,
              released_at_ms, release_reason
       FROM bridge_leases WHERE bridge_id = ? AND released_at_ms IS NULL`,
    )
    .get(bridgeId) as LeaseRowRaw | undefined;
}

function getActiveLease(db: Database.Database, occurrenceId: string): LeaseRow | null {
  const raw = selectActiveLeaseRaw(db, occurrenceId);
  return raw ? toLeaseRow(raw) : null;
}

function acquireLease(db: Database.Database, input: AcquireLeaseInput): LeaseRow {
  const run = db.transaction(() => {
    if (selectSessionRaw(db, input.occurrenceId) === undefined) {
      throw new OrchestrationError(
        "unknown_session",
        `no session exists for occurrence "${input.occurrenceId}"`,
      );
    }

    const active = selectActiveLeaseRaw(db, input.occurrenceId);
    if (active !== undefined) {
      if (active.expires_at_ms > input.nowMs) {
        throw new OrchestrationError(
          "lease_held",
          `occurrence "${input.occurrenceId}" already has a live bridge lease (expires at ${active.expires_at_ms})`,
        );
      }
      // Stale: unreleased but past its bounded timeout. Recover it rather
      // than leaving it dangling forever.
      withConstraintTranslation(() => {
        db.prepare(
          `UPDATE bridge_leases SET released_at_ms = ?, release_reason = 'stale_recovered' WHERE lease_id = ?`,
        ).run(input.nowMs, active.lease_id);
      });
    }

    const bridgeActive = selectActiveLeaseForBridgeRaw(db, input.bridgeId);
    if (bridgeActive !== undefined) {
      if (bridgeActive.expires_at_ms > input.nowMs) {
        throw new OrchestrationError(
          "lease_held",
          `bridge "${input.bridgeId}" already leases occurrence "${bridgeActive.occurrence_id}" (expires at ${bridgeActive.expires_at_ms})`,
        );
      }
      withConstraintTranslation(() => {
        db.prepare(
          `UPDATE bridge_leases SET released_at_ms = ?, release_reason = 'stale_recovered' WHERE lease_id = ?`,
        ).run(input.nowMs, bridgeActive.lease_id);
      });
    }

    const leaseId = randomUUID();
    withConstraintTranslation(() => {
      db.prepare(
        `INSERT INTO bridge_leases
           (lease_id, occurrence_id, bridge_id, bridge_session_id, acquired_at_ms, expires_at_ms,
            released_at_ms, release_reason)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(
        leaseId,
        input.occurrenceId,
        input.bridgeId,
        input.bridgeSessionId,
        input.nowMs,
        input.nowMs + input.ttlMs,
      );
    });
    return leaseId;
  });
  const leaseId = run();
  return toLeaseRow(selectLeaseRawById(db, leaseId)!);
}

function selectLeaseRawById(db: Database.Database, leaseId: string): LeaseRowRaw | undefined {
  return db
    .prepare(
      `SELECT lease_id, occurrence_id, bridge_id, bridge_session_id, acquired_at_ms, expires_at_ms,
              released_at_ms, release_reason
       FROM bridge_leases WHERE lease_id = ?`,
    )
    .get(leaseId) as LeaseRowRaw | undefined;
}

function releaseLease(
  db: Database.Database,
  occurrenceId: string,
  leaseId: string,
  reason: Exclude<LeaseReleaseReason, "stale_recovered">,
  nowMs: number,
): LeaseRow {
  const run = db.transaction(() => {
    const existing = selectLeaseRawById(db, leaseId);
    if (existing === undefined || existing.occurrence_id !== occurrenceId || existing.released_at_ms !== null) {
      throw new OrchestrationError(
        "unknown_lease",
        `no live bridge lease "${leaseId}" for occurrence "${occurrenceId}"`,
      );
    }
    withConstraintTranslation(() => {
      db.prepare(`UPDATE bridge_leases SET released_at_ms = ?, release_reason = ? WHERE lease_id = ?`).run(
        nowMs,
        reason,
        leaseId,
      );
    });
  });
  run();
  return toLeaseRow(selectLeaseRawById(db, leaseId)!);
}

function listLeases(db: Database.Database, occurrenceId: string): LeaseRow[] {
  const rows = db
    .prepare(
      `SELECT lease_id, occurrence_id, bridge_id, bridge_session_id, acquired_at_ms, expires_at_ms,
              released_at_ms, release_reason
       FROM bridge_leases WHERE occurrence_id = ? ORDER BY acquired_at_ms, lease_id`,
    )
    .all(occurrenceId) as LeaseRowRaw[];
  return rows.map(toLeaseRow);
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/** Runs `fn`, translating a raw better-sqlite3 constraint failure (CHECK,
 * UNIQUE, NOT NULL, FOREIGN KEY, ...) into an OrchestrationError so callers
 * outside this module never see a driver-specific error shape. */
function withConstraintTranslation<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof Database.SqliteError && error.code.startsWith("SQLITE_CONSTRAINT")) {
      throw new OrchestrationError("constraint_violation", error.message);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Unknown-end custody (D002/D007): one immutable detection per EXACT stopped
// encrypted source. Store-only. Nothing here is an occurrence end, an artifact,
// a delivery/job/receipt, or deletion authority; the store only records the
// write-once T / T + 14d and fences the later exact tombstone deletion.
// ---------------------------------------------------------------------------

const UNKNOWN_END_CUSTODY_MS = 14 * 24 * 60 * 60 * 1000;
const UNKNOWN_END_CLEANUP_CLAIM_MS = 30_000;
const UNKNOWN_END_FAILURE_REASONS: ReadonlySet<string> = new Set<UnknownEndCustodyFailureReason>([
  "identity_mismatch", "source_missing", "unsafe_source", "detach_failed", "reader_active", "quiescence_unproven",
]);

type UnknownEndCustodyKey = { readonly occurrenceId: string; readonly kind: UnknownEndCustodySource["kind"]; readonly attempt: number };

type UnknownEndCustodyRaw = {
  occurrence_id: string; source_kind: UnknownEndCustodySource["kind"]; failure_attempt: number;
  recording_handle: string; recording_path: string; recording_sha256: string; recording_key_id: string;
  recording_bytes: number; recording_device: string; recording_inode: string;
  unknown_end_detected_at_ms: number; unknown_end_deadline_ms: number; state: UnknownEndCustody["state"];
  cleanup_claim_token: string | null; cleanup_claim_expires_at_ms: number | null;
  cleanup_failure_reason: UnknownEndCustodyFailureReason | null; deleted_at_ms: number | null; last_observed_at_ms: number;
};

const UNKNOWN_END_CUSTODY_COLUMNS = `occurrence_id,source_kind,failure_attempt,recording_handle,recording_path,recording_sha256,
  recording_key_id,recording_bytes,recording_device,recording_inode,unknown_end_detected_at_ms,unknown_end_deadline_ms,state,
  cleanup_claim_token,cleanup_claim_expires_at_ms,cleanup_failure_reason,deleted_at_ms,last_observed_at_ms`;
const UNKNOWN_END_CUSTODY_KEY = "occurrence_id=? AND source_kind=? AND failure_attempt=?";

function custodyViolation(message: string): OrchestrationError {
  return new OrchestrationError("constraint_violation", message);
}

/** The exact source key. The canonical final source is attempt 0; a failed
 * generation is its own attempt >= 1. Never an occurrence-wide selector. */
function unknownEndCustodyKey(source: UnknownEndCustodySource): UnknownEndCustodyKey {
  if (typeof source !== "object" || source === null || typeof source.occurrenceId !== "string" || source.occurrenceId.length === 0) {
    throw custodyViolation("invalid unknown-end custody source");
  }
  if (source.kind === "final") return { occurrenceId: source.occurrenceId, kind: "final", attempt: 0 };
  if (source.kind === "bridge_failure" && Number.isSafeInteger(source.attempt) && source.attempt >= 1) {
    return { occurrenceId: source.occurrenceId, kind: "bridge_failure", attempt: source.attempt };
  }
  throw custodyViolation("invalid unknown-end custody source");
}

function validUnknownEndClock(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw custodyViolation("invalid unknown-end custody clock");
}

function validUnknownEndClaimToken(claimToken: string): void {
  if (typeof claimToken !== "string" || !/^[0-9a-f]{32}$/.test(claimToken)) throw custodyViolation("invalid unknown-end custody cleanup token");
}

function selectUnknownEndCustodyRaw(db: Database.Database, key: UnknownEndCustodyKey): UnknownEndCustodyRaw | undefined {
  return db.prepare(`SELECT ${UNKNOWN_END_CUSTODY_COLUMNS} FROM unknown_end_custody WHERE ${UNKNOWN_END_CUSTODY_KEY}`)
    .get(key.occurrenceId, key.kind, key.attempt) as UnknownEndCustodyRaw | undefined;
}

function toUnknownEndCustody(raw: UnknownEndCustodyRaw): UnknownEndCustody {
  const source: UnknownEndCustodySource = raw.source_kind === "final"
    ? { kind: "final", occurrenceId: raw.occurrence_id }
    : { kind: "bridge_failure", occurrenceId: raw.occurrence_id, attempt: raw.failure_attempt };
  return { source, recordingHandle: raw.recording_handle, recordingPath: raw.recording_path, recordingSha256: raw.recording_sha256,
    recordingKeyId: raw.recording_key_id, recordingBytes: raw.recording_bytes, recordingDevice: raw.recording_device,
    recordingInode: raw.recording_inode, detectedAtMs: raw.unknown_end_detected_at_ms, deadlineMs: raw.unknown_end_deadline_ms,
    state: raw.state, cleanupFailureReason: raw.cleanup_failure_reason, deletedAtMs: raw.deleted_at_ms };
}

function getUnknownEndCustody(db: Database.Database, source: UnknownEndCustodySource): UnknownEndCustody | null {
  const raw = selectUnknownEndCustodyRaw(db, unknownEndCustodyKey(source));
  return raw === undefined ? null : toUnknownEndCustody(raw);
}

type FinalizedSourceDescriptor = { readonly handle: string; readonly canonicalPath: string; readonly sha256: string; readonly keyId: string };

/** Stopped-writing evidence is the persisted Runtime finalization descriptor
 * for that exact source: the canonical `recordings` row with its Runtime
 * locator, or the `recordBridgeFailure(... recording ...)` row for that
 * attempt. A failure recorded without a recording, or a legacy canonical row
 * without a locator, is a live/unknown writer and yields null. */
function selectFinalizedSourceDescriptor(db: Database.Database, key: UnknownEndCustodyKey): FinalizedSourceDescriptor | null {
  const row = (key.kind === "final"
    ? db.prepare("SELECT handle, encrypted_path, sha256, key_id FROM recordings WHERE occurrence_id=?").get(key.occurrenceId)
    : db.prepare("SELECT handle, encrypted_path, sha256, key_id FROM bridge_failure_recordings WHERE occurrence_id=? AND attempt=?")
      .get(key.occurrenceId, key.attempt)) as { handle: string; encrypted_path: string | null; sha256: string; key_id: string | null } | undefined;
  if (row === undefined || row.encrypted_path === null || row.key_id === null) return null;
  return { handle: row.handle, canonicalPath: path.resolve(row.encrypted_path), sha256: row.sha256, keyId: row.key_id };
}

function validUnknownEndIdentity(value: UnknownEndCustodyIdentity): void {
  if (typeof value !== "object" || value === null || Object.keys(value).sort().join(",") !== "encryptedPath,keyId,recordingHandle,sha256" ||
      typeof value.recordingHandle !== "string" || !/^[0-9a-f]{32}$/.test(value.recordingHandle) ||
      typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256) ||
      typeof value.keyId !== "string" || !/^[0-9a-f]{16}$/.test(value.keyId) ||
      typeof value.encryptedPath !== "string" || value.encryptedPath.length === 0) {
    throw custodyViolation("invalid unknown-end custody identity");
  }
}

function assertUnknownEndIdentityMatches(expected: { handle: string; canonicalPath: string; sha256: string; keyId: string }, value: UnknownEndCustodyIdentity): void {
  if (value.recordingHandle !== expected.handle || value.sha256 !== expected.sha256 || value.keyId !== expected.keyId ||
      path.resolve(value.encryptedPath) !== expected.canonicalPath) {
    throw custodyViolation("unknown-end custody identity does not match the persisted Runtime source");
  }
}

/** Exact regular-child filesystem identity at first detection. */
function inspectUnknownEndSource(canonicalPath: string): { readonly bytes: number; readonly device: string; readonly inode: string } {
  try {
    const stat = lstatSync(canonicalPath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) throw custodyViolation("unknown-end custody source is not a regular Runtime child");
    if (stat.size < 1n || stat.size > MAX_RECORDING_BYTES) throw custodyViolation("unknown-end custody source size is outside 1..8GiB");
    return { bytes: Number(stat.size), device: stat.dev.toString(), inode: stat.ino.toString() };
  } catch (error) {
    if (error instanceof OrchestrationError) throw error;
    throw custodyViolation(`unknown-end custody source cannot be inspected: ${(error as Error).message}`);
  }
}

/** Only a positively observed meeting end is an authoritative end (D027). The
 * session terminates EVERY bridge `left` as a bridge_observed terminal
 * whatever its reason, so the persisted generation `terminal_reason` decides:
 * `ended` is a known end; `removed` and `bridge_failure` are not, regardless
 * of the session's advance/fail split; a pre-027 bridge_observed row with a
 * NULL reason stays fail-closed. Local-clock and finalization instants are not
 * ends. A failed attempt's own recording row proves its generation ended in
 * bridge failure, so no observed end is possible for it. A legacy terminal of
 * unknown provenance is ambiguous and refused. */
function refuseUnknownEndIfKnownOrOwned(db: Database.Database, key: UnknownEndCustodyKey, handle: string): void {
  const terminals = (key.kind === "final"
    ? db.prepare("SELECT terminal_source, terminal_reason FROM reconciliation_generations WHERE occurrence_id=? AND terminal_source IS NOT NULL").all(key.occurrenceId)
    : db.prepare("SELECT terminal_source, terminal_reason FROM reconciliation_generations WHERE occurrence_id=? AND recording_handle=? AND terminal_source IS NOT NULL")
      .all(key.occurrenceId, handle)) as Array<{ terminal_source: string; terminal_reason: string | null }>;
  if (key.kind === "final" && terminals.some((row) => row.terminal_source === "bridge_observed" &&
      (row.terminal_reason === "ended" || row.terminal_reason === null))) {
    throw custodyViolation("unknown-end custody refuses a source with an authoritative known end");
  }
  if (terminals.some((row) => row.terminal_source === "legacy_unknown")) {
    throw custodyViolation("unknown-end custody refuses an ambiguous legacy end");
  }
  if (key.kind !== "final") return;
  if (db.prepare("SELECT 1 FROM backfill_seeds WHERE occurrence_id=?").get(key.occurrenceId) !== undefined) {
    throw custodyViolation("unknown-end custody refuses a seeded known-ended source");
  }
  if (db.prepare("SELECT 1 FROM delivery_journal WHERE occurrence_id=? LIMIT 1").get(key.occurrenceId) !== undefined) {
    throw custodyViolation("unknown-end custody refuses a delivery-owned source");
  }
}

function assignUnknownEndCustody(
  db: Database.Database, source: UnknownEndCustodySource, detectedAtMs: number, exactIdentity: UnknownEndCustodyIdentity,
): UnknownEndCustodyAssignment {
  const key = unknownEndCustodyKey(source);
  validUnknownEndClock(detectedAtMs);
  validUnknownEndIdentity(exactIdentity);
  const deadlineMs = detectedAtMs + UNKNOWN_END_CUSTODY_MS;
  if (!Number.isSafeInteger(deadlineMs)) throw custodyViolation("unknown-end custody deadline overflow");
  const existingOf = (raw: UnknownEndCustodyRaw): UnknownEndCustodyAssignment => {
    assertUnknownEndIdentityMatches({ handle: raw.recording_handle, canonicalPath: raw.recording_path, sha256: raw.recording_sha256, keyId: raw.recording_key_id }, exactIdentity);
    return { outcome: "existing", custody: toUnknownEndCustody(raw) };
  };
  const stored = selectUnknownEndCustodyRaw(db, key);
  if (stored !== undefined) return existingOf(stored);
  const descriptor = selectFinalizedSourceDescriptor(db, key);
  if (descriptor === null) throw custodyViolation("unknown-end custody requires a finalized Runtime source descriptor");
  assertUnknownEndIdentityMatches(descriptor, exactIdentity);
  if (path.basename(descriptor.canonicalPath) !== `${descriptor.handle}.crsr`) {
    throw custodyViolation("unknown-end custody source path does not match its Runtime handle");
  }
  const identity = inspectUnknownEndSource(descriptor.canonicalPath);
  return db.transaction((): UnknownEndCustodyAssignment => {
    const raced = selectUnknownEndCustodyRaw(db, key);
    if (raced !== undefined) return existingOf(raced);
    if (selectFinalizedSourceDescriptor(db, key)?.handle !== descriptor.handle) {
      throw custodyViolation("unknown-end custody requires a finalized Runtime source descriptor");
    }
    refuseUnknownEndIfKnownOrOwned(db, key, descriptor.handle);
    withConstraintTranslation(() => db.prepare(`INSERT INTO unknown_end_custody (occurrence_id,source_kind,failure_attempt,
        final_occurrence_id,failure_occurrence_id,recording_handle,recording_path,recording_sha256,recording_key_id,
        recording_bytes,recording_device,recording_inode,unknown_end_detected_at_ms,unknown_end_deadline_ms,state,last_observed_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'assigned',?)`)
      .run(key.occurrenceId, key.kind, key.attempt, key.kind === "final" ? key.occurrenceId : null, key.kind === "final" ? null : key.occurrenceId,
        descriptor.handle, descriptor.canonicalPath, descriptor.sha256, descriptor.keyId, identity.bytes, identity.device, identity.inode,
        detectedAtMs, deadlineMs, detectedAtMs));
    return { outcome: "assigned", custody: toUnknownEndCustody(selectUnknownEndCustodyRaw(db, key)!) };
  }).immediate();
}

/** Persists the nondecreasing wall for one custody row and returns it. */
function observeUnknownEndWall(db: Database.Database, key: UnknownEndCustodyKey, nowMs: number): number {
  validUnknownEndClock(nowMs);
  const row = db.prepare(`SELECT last_observed_at_ms FROM unknown_end_custody WHERE ${UNKNOWN_END_CUSTODY_KEY}`)
    .get(key.occurrenceId, key.kind, key.attempt) as { last_observed_at_ms: number } | undefined;
  if (row === undefined) throw custodyViolation("unknown-end custody cleanup claim is stale");
  const effective = Math.max(nowMs, row.last_observed_at_ms);
  db.prepare(`UPDATE unknown_end_custody SET last_observed_at_ms=? WHERE ${UNKNOWN_END_CUSTODY_KEY}`)
    .run(effective, key.occurrenceId, key.kind, key.attempt);
  return effective;
}

function claimDueUnknownEndCustodyCleanup(db: Database.Database, nowMs: number, claimToken: string): UnknownEndCustodyCleanupClaim | null {
  validUnknownEndClock(nowMs);
  validUnknownEndClaimToken(claimToken);
  return db.transaction((): UnknownEndCustodyCleanupClaim | null => {
    // One due exact source. A retained durable alignment claim on that source,
    // or a canonical source that meanwhile became seeded/delivery-owned, is
    // fail-closed: it is never leased, and its assignment is never touched.
    const row = db.prepare(`SELECT ${UNKNOWN_END_CUSTODY_COLUMNS}, MAX(?,last_observed_at_ms) AS observed_at_ms
      FROM unknown_end_custody AS custody
      WHERE custody.state IN ('assigned','cleanup_claimed')
        AND MAX(?,custody.last_observed_at_ms)>=custody.unknown_end_deadline_ms
        AND (custody.state!='cleanup_claimed' OR custody.cleanup_claim_expires_at_ms<=MAX(?,custody.last_observed_at_ms))
        AND NOT EXISTS (
          SELECT 1 FROM recording_recovery_bindings AS binding
          JOIN recording_alignment_attempts AS alignment ON alignment.generation_id=binding.generation_id
          WHERE binding.occurrence_id=custody.occurrence_id AND binding.recording_handle=custody.recording_handle
            AND alignment.state IN ('staging','cleanup_failed'))
        AND (custody.source_kind!='final' OR (
          NOT EXISTS (SELECT 1 FROM backfill_seeds WHERE occurrence_id=custody.occurrence_id)
          AND NOT EXISTS (SELECT 1 FROM delivery_journal WHERE occurrence_id=custody.occurrence_id)))
      ORDER BY custody.unknown_end_deadline_ms, custody.occurrence_id, custody.source_kind, custody.failure_attempt LIMIT 1`)
      .get(nowMs, nowMs, nowMs) as (UnknownEndCustodyRaw & { observed_at_ms: number }) | undefined;
    if (row === undefined) return null;
    const claimExpiresAtMs = row.observed_at_ms + UNKNOWN_END_CLEANUP_CLAIM_MS;
    if (!Number.isSafeInteger(claimExpiresAtMs)) throw custodyViolation("unknown-end custody claim deadline overflow");
    const changed = db.prepare(`UPDATE unknown_end_custody SET state='cleanup_claimed',cleanup_claim_token=?,
      cleanup_claim_expires_at_ms=?,last_observed_at_ms=? WHERE ${UNKNOWN_END_CUSTODY_KEY}
      AND state IN ('assigned','cleanup_claimed') AND (state!='cleanup_claimed' OR cleanup_claim_expires_at_ms<=?)`)
      .run(claimToken, claimExpiresAtMs, row.observed_at_ms, row.occurrence_id, row.source_kind, row.failure_attempt, row.observed_at_ms).changes;
    if (changed !== 1) return null;
    return { source: toUnknownEndCustody(row).source, claimToken, claimExpiresAtMs, recordingPath: row.recording_path,
      recordingHandle: row.recording_handle, recordingBytes: row.recording_bytes, recordingDevice: row.recording_device,
      recordingInode: row.recording_inode, detectedAtMs: row.unknown_end_detected_at_ms, deadlineMs: row.unknown_end_deadline_ms };
  }).immediate();
}

/** Fenced transition out of `cleanup_claimed`. The wall observation persists
 * on an expired claim so a clock regression cannot revive it; a stale claim
 * rolls back without touching the row. */
function settleUnknownEndCustodyCleanup(
  db: Database.Database, claim: Pick<UnknownEndCustodyCleanupClaim, "source" | "claimToken">, nowMs: number,
  update: (effective: number, key: UnknownEndCustodyKey) => number,
): void {
  const key = unknownEndCustodyKey(claim.source);
  validUnknownEndClaimToken(claim.claimToken);
  const expiredClaim = Symbol("expired unknown-end custody cleanup claim");
  const result = db.transaction((): void | typeof expiredClaim => {
    const effective = observeUnknownEndWall(db, key, nowMs);
    const row = selectUnknownEndCustodyRaw(db, key);
    if (row === undefined || row.state !== "cleanup_claimed" || row.cleanup_claim_token !== claim.claimToken ||
        row.cleanup_claim_expires_at_ms === null) {
      throw custodyViolation("unknown-end custody cleanup claim is stale");
    }
    if (row.cleanup_claim_expires_at_ms <= effective) return expiredClaim;
    if (update(effective, key) !== 1) throw custodyViolation("unknown-end custody cleanup claim is stale");
  }).immediate();
  if (result === expiredClaim) throw custodyViolation("unknown-end custody cleanup claim is stale or expired");
}

function completeUnknownEndCustodyCleanup(
  db: Database.Database, claim: Pick<UnknownEndCustodyCleanupClaim, "source" | "claimToken">, deletedAtMs: number,
): void {
  settleUnknownEndCustodyCleanup(db, claim, deletedAtMs, (effective, key) => withConstraintTranslation(() =>
    db.prepare(`UPDATE unknown_end_custody SET state='deleted',deleted_at_ms=?,cleanup_claim_token=NULL,
      cleanup_claim_expires_at_ms=NULL WHERE ${UNKNOWN_END_CUSTODY_KEY} AND state='cleanup_claimed'
      AND cleanup_claim_token=? AND cleanup_claim_expires_at_ms>? AND unknown_end_deadline_ms<=?`)
      .run(effective, key.occurrenceId, key.kind, key.attempt, claim.claimToken, effective, effective).changes));
}

function failUnknownEndCustodyCleanup(
  db: Database.Database, claim: Pick<UnknownEndCustodyCleanupClaim, "source" | "claimToken">, failedAtMs: number,
  reason: UnknownEndCustodyFailureReason,
): void {
  if (!UNKNOWN_END_FAILURE_REASONS.has(reason)) throw custodyViolation("invalid unknown-end custody failure reason");
  settleUnknownEndCustodyCleanup(db, claim, failedAtMs, (effective, key) => withConstraintTranslation(() =>
    db.prepare(`UPDATE unknown_end_custody SET state='cleanup_failed',cleanup_failure_reason=?,cleanup_claim_token=NULL,
      cleanup_claim_expires_at_ms=NULL WHERE ${UNKNOWN_END_CUSTODY_KEY} AND state='cleanup_claimed'
      AND cleanup_claim_token=? AND cleanup_claim_expires_at_ms>?`)
      .run(reason, key.occurrenceId, key.kind, key.attempt, claim.claimToken, effective).changes));
}

// ---------------------------------------------------------------------------
// Recording retention (migration 030): files no deletion policy covers
// ---------------------------------------------------------------------------

const RECORDING_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** Floor after first detection, so a file found already past its window is not deleted by the sweep that finds it. */
const RECORDING_RETENTION_GRACE_MS = 72 * 60 * 60 * 1000;
type RecordingRetentionRaw = { recording_handle: string; recording_path: string; recording_device: string; recording_inode: string;
  recording_bytes: number; detected_at_ms: number; retention_from_ms: number; deadline_ms: number; state: RecordingRetention["state"]; referenced_by: string | null };
const RECORDING_RETENTION_SELECT = `SELECT r.recording_handle,r.recording_path,r.recording_device,r.recording_inode,r.recording_bytes,
  r.detected_at_ms,r.retention_from_ms,r.deadline_ms,r.state,
  (SELECT occurrence_id FROM recordings WHERE handle=r.recording_handle
   UNION ALL SELECT occurrence_id FROM bridge_failure_recordings WHERE handle=r.recording_handle
   UNION ALL SELECT occurrence_id FROM reconciliation_generations WHERE recording_handle=r.recording_handle LIMIT 1) AS referenced_by
  FROM recording_retention AS r`;

function toRecordingRetention(row: RecordingRetentionRaw): RecordingRetention {
  return { recordingHandle: row.recording_handle, recordingPath: row.recording_path, recordingDevice: row.recording_device,
    recordingInode: row.recording_inode, recordingBytes: row.recording_bytes, detectedAtMs: row.detected_at_ms, retentionFromMs: row.retention_from_ms,
    deadlineMs: row.deadline_ms, state: row.state, referencedBy: row.referenced_by };
}

/** A delivery, seed or unknown-end custody row owns deletion of this file. */
function recordingCoveredByPolicy(db: Database.Database, handle: string, recordingPath: string): boolean {
  return db.prepare(`SELECT EXISTS(SELECT 1 FROM delivery_journal WHERE recording_handle=@handle OR recording_path=@path)
      OR EXISTS(SELECT 1 FROM delivery_recording_owners_v17 WHERE recording_handle=@handle OR canonical_path=@path)
      OR EXISTS(SELECT 1 FROM backfill_seeds WHERE capability_recording_handle=@handle OR recording_path=@path)
      OR EXISTS(SELECT 1 FROM unknown_end_custody WHERE recording_handle=@handle) AS covered`)
    .pluck().get({ handle, path: recordingPath }) === 1;
}

function observeRecordingRetention(db: Database.Database, file: RecordingFileObservation, nowMs: number): { outcome: "adopted" | "existing"; retention: RecordingRetention } | null {
  if (!/^[0-9a-f]{32}$/.test(file.handle) || path.basename(file.recordingPath) !== `${file.handle}.crsr`) throw new Error("invalid recording retention observation");
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isFinite(file.lastWriteMs)) throw new Error("invalid recording retention clock");
  return db.transaction((): { outcome: "adopted" | "existing"; retention: RecordingRetention } | null => {
    const existing = db.prepare(`${RECORDING_RETENTION_SELECT} WHERE r.recording_handle=?`).get(file.handle) as RecordingRetentionRaw | undefined;
    if (recordingCoveredByPolicy(db, file.handle, file.recordingPath)) {
      if (existing?.state === "assigned") settleRecordingRetention(db, file.handle, "released", nowMs);
      return null;
    }
    if (existing !== undefined) {
      if (existing.state !== "assigned") return { outcome: "existing", retention: toRecordingRetention(existing) };
      db.prepare(`UPDATE recording_retention SET recording_path=?,recording_device=?,recording_inode=?,recording_bytes=?
        WHERE recording_handle=? AND state='assigned'`).run(file.recordingPath, file.device, file.inode, file.bytes, file.handle);
    } else {
      const from = Math.max(0, Math.min(nowMs, Math.floor(file.lastWriteMs)));
      db.prepare(`INSERT INTO recording_retention (recording_handle,recording_path,recording_device,recording_inode,recording_bytes,
          detected_at_ms,retention_from_ms,deadline_ms,state) VALUES (?,?,?,?,?,?,?,?,'assigned')`)
        .run(file.handle, file.recordingPath, file.device, file.inode, file.bytes, nowMs, from, Math.max(from + RECORDING_RETENTION_MS, nowMs + RECORDING_RETENTION_GRACE_MS));
    }
    return { outcome: existing === undefined ? "adopted" : "existing",
      retention: toRecordingRetention(db.prepare(`${RECORDING_RETENTION_SELECT} WHERE r.recording_handle=?`).get(file.handle) as RecordingRetentionRaw) };
  }).immediate();
}

function listAssignedRecordingRetention(db: Database.Database): readonly RecordingRetention[] {
  return (db.prepare(`${RECORDING_RETENTION_SELECT} WHERE r.state='assigned' ORDER BY r.deadline_ms,r.recording_handle`).all() as RecordingRetentionRaw[])
    .map(toRecordingRetention);
}

function settleRecordingRetention(db: Database.Database, handle: string, outcome: "released" | "deleted", nowMs: number): void {
  const changed = db.prepare(`UPDATE recording_retention SET state=?,settled_at_ms=? WHERE recording_handle=? AND state='assigned'
      AND (?='released' OR ?>=deadline_ms)`).run(outcome, nowMs, handle, outcome, nowMs).changes;
  if (changed !== 1) throw new Error("recording retention settlement refused");
}

function listOpenCaptureRows(db: Database.Database): OpenCaptureRows {
  return {
    sessions: db.prepare("SELECT occurrence_id AS occurrenceId, state FROM sessions WHERE state IN ('joining','listening') ORDER BY occurrence_id")
      .all() as OpenCaptureRows["sessions"][number][],
    generations: db.prepare(`SELECT occurrence_id AS occurrenceId, bridge_session_id AS bridgeSessionId FROM reconciliation_generations
      WHERE terminal_at_ms IS NULL ORDER BY occurrence_id, bridge_session_id`)
      .all() as OpenCaptureRows["generations"][number][],
  };
}

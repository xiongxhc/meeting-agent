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
  type AlignmentAttempt,
  type AlignmentFailure,
  type SelectedAlignment,
  type ReconciliationBridgeEventRow,
  type ReconciliationEvidenceRow,
  type ReconciliationLiveSegmentRow,
  type BridgeRecoveryResult,
  type BridgeFailureRecordingRow,
  type DeliveryRow,
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

    finalizeSession: (input) => finalizeSession(db, input),
    getRecording: (occurrenceId) => getRecording(db, occurrenceId),
    getRecordingRecovery: (occurrenceId, bridgeSessionId, recordingHandle) => getRecordingRecovery(db, occurrenceId, bridgeSessionId, recordingHandle),
    beginRecordingAlignment: (generationId, ownerId, replace) => beginRecordingAlignment(db, generationId, ownerId, replace),
    appendRecordingAlignment: (attempt, page) => appendRecordingAlignment(db, attempt, page),
    completeRecordingAlignment: (attempt, complete) => completeRecordingAlignment(db, attempt, complete),
    getSelectedAlignment: (generationId) => getSelectedAlignment(db, generationId),
    readSelectedAlignmentPage: (selected, after) => readSelectedAlignmentPage(db, selected, after),
    getPendingAlignment: (generationId) => getPendingAlignment(db, generationId),
    markAlignmentCleanupFailed: (attempt) => markAlignmentCleanupFailed(db, attempt),
    abandonRecordingAlignment: (attempt, permit, reason) => abandonRecordingAlignment(db, attempt, permit, reason),
    reclaimRecordingAlignment: (attempt, limit) => reclaimRecordingAlignment(db, attempt, limit),
    getRecordingAlignmentFailure: (generationId) => getRecordingAlignmentFailure(db, generationId),
    beginReconciliationGeneration: (occurrenceId, bridgeSessionId, createdAtMs) => beginReconciliationGeneration(db, occurrenceId, bridgeSessionId, createdAtMs),
    setReconciliationRuntimeSession: (occurrenceId, bridgeSessionId, runtimeSessionId) => setReconciliationRuntimeSession(db, occurrenceId, bridgeSessionId, runtimeSessionId),
    completeReconciliationGeneration: (occurrenceId, bridgeSessionId, terminalAtMs, terminalSource) => completeReconciliationGeneration(db, occurrenceId, bridgeSessionId, terminalAtMs, terminalSource),
    appendReconciliationBridgeEvent: (occurrenceId, event) => appendReconciliationBridgeEvent(db, occurrenceId, event),
    appendReconciliationLiveSegment: (occurrenceId, segment) => appendReconciliationLiveSegment(db, occurrenceId, segment),
    getReconciliationEvidence: (occurrenceId, recordingHandle) => getReconciliationEvidence(db, occurrenceId, recordingHandle),
    purgeExpiredReconciliationEvidence: (nowMs) => purgeExpiredReconciliationEvidence(db, nowMs),
    recordBridgeFailure: (input) => recordBridgeFailure(db, input),
    getBridgeFailureRecording: (occurrenceId, attempt) => getBridgeFailureRecording(db, occurrenceId, attempt),
    savePending: (row) => savePendingDelivery(db, row, options.deliveryIdentityCheckpoint),
    pending: () => deliveryRows(db, "active"),
    recoverablePublications: () => deliveryRows(db, "deleted_with_recovery"),
    update: (row) => updateDelivery(db, row),
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
): FinalizeSessionResult {
  const { occurrenceId, nowMs } = input.transition;
  const run = db.transaction(() => {
    const session = transition(db, input.transition);
    withConstraintTranslation(() => {
      db.prepare(
        `INSERT INTO recordings
           (occurrence_id, handle, encrypted_path, sha256, duration_ms, format, key_id, finalized_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        occurrenceId,
        input.recording.handle,
        input.recording.encryptedPath,
        input.recording.sha256,
        input.recording.durationMs,
        input.recording.format,
        input.recording.keyId,
        nowMs,
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
    });
    return session;
  });
  const session = run();
  return { session, recording: getRecording(db, occurrenceId)! };
}

function getRecording(db: Database.Database, occurrenceId: string): RecordingRow | null {
  const raw = db
    .prepare(
      `SELECT occurrence_id, handle, encrypted_path, sha256, duration_ms, format, key_id, finalized_at_ms
         FROM recordings WHERE occurrence_id = ?`,
    )
    .get(occurrenceId) as
    | {
        occurrence_id: string;
        handle: string;
        encrypted_path: string | null;
        sha256: string;
        duration_ms: number;
        format: string | null;
        key_id: string | null;
        finalized_at_ms: number;
      }
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
    db.prepare("UPDATE recording_alignment_attempts SET state='complete',coverage_status=?,warnings_json=? WHERE attempt_id=?")
      .run(completion.coverageStatus, JSON.stringify([...completion.warnings].sort()), attempt.attemptId);
    db.prepare(`INSERT INTO recording_alignment_selected(generation_id,attempt_id) VALUES(?,?)
      ON CONFLICT(generation_id) DO UPDATE SET attempt_id=excluded.attempt_id`).run(attempt.generationId, attempt.attemptId);
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
    CASE WHEN length(CAST(payload AS BLOB)) BETWEEN 1 AND 32768 THEN payload ELSE NULL END AS payload
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
    WHERE a.generation_id=? AND s.attempt_id IS NULL ORDER BY a.attempt_id LIMIT 1`).get(generationId) as { attempt_id: string } | undefined;
  if (!pending) return null;
  const row = alignmentHeader(db, pending.attempt_id);
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
  identityCheckpoint?: (canonicalPath: string) => void,
): void {
  const save = db.transaction(() => {
    const recording = db.prepare("SELECT handle, encrypted_path FROM recordings WHERE occurrence_id = ?").get(row.occurrenceId) as { handle: string; encrypted_path: string | null } | undefined;
    if (recording === undefined || path.resolve(recording.encrypted_path ?? "") !== path.resolve(row.recordingPath)) {
      throw new OrchestrationError("constraint_violation", "delivery recording is not the finalized occurrence recording");
    }
    const binding = claimDeliveryRecordingOwner(
      db,
      row.occurrenceId,
      recording.handle,
      recording.encrypted_path ?? "",
      identityCheckpoint,
    );
    if (binding === null) return false;
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
    return true;
  });
  if (!save()) throw new OrchestrationError("constraint_violation", "delivery recording belongs to another occurrence");
}

function deliveryRows(db: Database.Database, selection: "active" | "deleted_with_recovery"): DeliveryRow[] {
  const predicate = selection === "active"
    ? "deleted_at_ms IS NULL"
    : "deleted_at_ms IS NOT NULL AND published_at_ms IS NOT NULL AND recovery_artifact IS NOT NULL";
  const rows = db.prepare(
    `SELECT occurrence_id, revision, artifact_hash, recording_path, bundle_path, ended_at_ms,
            transcript_complete, retry_count, next_retry_at_ms, retry_reason, published_at_ms,
            deleted_at_ms, publication_url, vault_commit, recovery_artifact, stage_token, recording_handle
       FROM delivery_journal WHERE ${predicate} ORDER BY next_retry_at_ms, occurrence_id, revision`,
  ).all() as Array<{ occurrence_id: string; revision: number; artifact_hash: string; recording_path: string; bundle_path: string; ended_at_ms: number; transcript_complete: 0 | 1; retry_count: number; next_retry_at_ms: number; retry_reason: DeliveryRow["retryReason"]; published_at_ms: number | null; deleted_at_ms: number | null; publication_url: string | null; vault_commit: string | null; recovery_artifact: string | null; stage_token: string | null; recording_handle: string | null }>;
  return rows.map((row) => ({
    occurrenceId: row.occurrence_id, revision: row.revision, artifactHash: row.artifact_hash,
    recordingPath: row.recording_path, bundlePath: row.bundle_path, endedAtMs: row.ended_at_ms,
    transcriptComplete: row.transcript_complete === 1, retryCount: row.retry_count,
    nextRetryAtMs: row.next_retry_at_ms, retryReason: row.retry_reason,
    publishedAtMs: row.published_at_ms, deletedAtMs: row.deleted_at_ms,
    publicationUrl: row.publication_url, vaultCommit: row.vault_commit,
    recoveryArtifact: row.recovery_artifact, stageToken: row.stage_token, recordingHandle: row.recording_handle,
  }));
}

function updateDelivery(db: Database.Database, row: DeliveryRow): void {
  const changed = withConstraintTranslation(() => db.prepare(
    `UPDATE delivery_journal SET retry_count = ?, next_retry_at_ms = ?, retry_reason = ?,
       published_at_ms = ?, deleted_at_ms = ?, publication_url = ?, vault_commit = ?,
       recovery_artifact = ?, stage_token = ?, recording_handle = ?
     WHERE occurrence_id = ? AND revision = ? AND artifact_hash = ?`,
  ).run(row.retryCount, row.nextRetryAtMs, row.retryReason, row.publishedAtMs, row.deletedAtMs,
    row.publicationUrl, row.vaultCommit, row.recoveryArtifact, row.stageToken,
    row.recordingHandle ?? null, row.occurrenceId, row.revision, row.artifactHash).changes);
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
      "SELECT artifact_hash, published_at_ms, publication_url, vault_commit FROM delivery_journal WHERE occurrence_id = ? AND revision = ?",
    ).get(input.occurrenceId, input.revision) as { artifact_hash: string; published_at_ms: number | null; publication_url: string | null; vault_commit: string | null } | undefined;
    if (delivery === undefined || delivery.artifact_hash !== input.artifactHash) {
      throw new OrchestrationError("constraint_violation", "publication delivery identity is unknown or immutable fields changed");
    }
    const session = selectSessionRaw(db, input.occurrenceId);
    if (session === undefined || !["awaiting_teammem", "published", "notified"].includes(session.state)) {
      throw new OrchestrationError("state_conflict", "publication receipt is not legal for the current session state");
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

function completeReconciliationGeneration(db: Database.Database, occurrenceId: string, bridgeSessionId: string, terminalAtMs: number, terminalSource: "bridge_observed" | "local_clock"): void {
  const changed = db.prepare(
    `UPDATE reconciliation_generations SET terminal_at_ms = ?, terminal_source = ?, expires_at_ms = ?
     WHERE generation_id = ? AND occurrence_id = ? AND terminal_at_ms IS NULL`,
  ).run(terminalAtMs, terminalSource, terminalAtMs + RECONCILIATION_EVIDENCE_RETENTION_MS,
    reconciliationGenerationId(occurrenceId, bridgeSessionId), occurrenceId).changes;
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
  return db.prepare("DELETE FROM reconciliation_generations WHERE terminal_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?").run(nowMs).changes;
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
    if (!retryAllowed) {
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
    gaps: gaps.map((gap) => ({ ordinal: gap.ordinal, direction: gap.direction as RecordingGapRow["direction"], startedAt: gap.started_at, endedAt: gap.ended_at })),
    runtimeGaps };
}

type RuntimeGapInput = FinalizeSessionInput["recording"]["runtimeGaps"];

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

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
import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

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

export function openSessionStore(options: OpenSessionStoreOptions): SessionStore {
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const db = new Database(options.filename);
  db.pragma("foreign_keys = ON"); // better-sqlite3 does NOT enable this by default; must be set per connection.

  applyMigrations(db, migrationsDir, options.nowMs ?? Date.now());
  repairDeliveryRecordingOwners(db);

  return {
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
    pending: () => pendingDeliveries(db),
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
    },
  };
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

function pendingDeliveries(db: Database.Database): DeliveryRow[] {
  const rows = db.prepare(
    `SELECT occurrence_id, revision, artifact_hash, recording_path, bundle_path, ended_at_ms,
            transcript_complete, retry_count, next_retry_at_ms, retry_reason, published_at_ms,
            deleted_at_ms, publication_url, vault_commit, recovery_artifact, stage_token, recording_handle
       FROM delivery_journal WHERE deleted_at_ms IS NULL ORDER BY next_retry_at_ms, occurrence_id, revision`,
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
      const existing = db.prepare("SELECT 1 FROM notification_intents WHERE occurrence_id = ? AND revision = ?").get(input.occurrenceId, input.revision);
      if (existing !== undefined) return;
    } else {
      db.prepare(
        `UPDATE delivery_journal SET published_at_ms = ?, publication_url = ?, vault_commit = ?, retry_reason = NULL
          WHERE occurrence_id = ? AND revision = ? AND artifact_hash = ? AND published_at_ms IS NULL`,
      ).run(input.publishedAtMs, input.publicationUrl, input.vaultCommit, input.occurrenceId, input.revision, input.artifactHash);
    }
    if (session.state === "awaiting_teammem") {
      transition(db, { occurrenceId: input.occurrenceId, fromState: "awaiting_teammem", toState: "published", reason: "receipt", terminalReason: null, nowMs: input.publishedAtMs });
    }
    const deliverable = "recipientId" in input.notification;
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
      const changed = db.prepare(
        `UPDATE notification_intents SET state = 'claimed', claim_token = ?, claim_expires_at_ms = ?,
           first_attempt_at_ms = COALESCE(first_attempt_at_ms, ?), last_attempt_at_ms = ?, attempt_count = attempt_count + 1
           , delivery_ambiguous = CASE WHEN state = 'claimed' THEN 1 ELSE delivery_ambiguous END
         WHERE occurrence_id = ? AND revision = ?
           AND ((state = 'pending' AND next_attempt_at_ms <= ?) OR (state = 'claimed' AND claim_expires_at_ms <= ?))`,
      ).run(input.claimToken, input.nowMs + input.claimTtlMs, input.nowMs, input.nowMs,
        row.occurrence_id, row.revision, input.nowMs, input.nowMs).changes;
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
    db.prepare(
      `UPDATE notification_intents SET state = 'sent', provider_message_id = ?, sent_at_ms = ?,
         claim_token = NULL, claim_expires_at_ms = NULL
       WHERE occurrence_id = ? AND revision = ? AND state = 'claimed' AND claim_token = ?`,
    ).run(input.providerMessageId, input.sentAtMs, input.occurrenceId, input.revision, input.claimToken);
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

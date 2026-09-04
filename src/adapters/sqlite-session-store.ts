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
import { readdirSync, readFileSync } from "node:fs";
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
};

const DEFAULT_MIGRATIONS_DIR = path.resolve(import.meta.dirname, "..", "..", "migrations");

export function openSessionStore(options: OpenSessionStoreOptions): SessionStore {
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const db = new Database(options.filename);
  db.pragma("foreign_keys = ON"); // better-sqlite3 does NOT enable this by default; must be set per connection.

  applyMigrations(db, migrationsDir, options.nowMs ?? Date.now());

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
    beginReconciliationGeneration: (occurrenceId, generationId, bridgeSessionId, createdAtMs, expiresAtMs) => beginReconciliationGeneration(db, occurrenceId, generationId, bridgeSessionId, createdAtMs, expiresAtMs),
    setReconciliationRuntimeSession: (occurrenceId, generationId, runtimeSessionId) => setReconciliationRuntimeSession(db, occurrenceId, generationId, runtimeSessionId),
    appendReconciliationBridgeEvent: (occurrenceId, event) => appendReconciliationBridgeEvent(db, occurrenceId, event),
    appendReconciliationLiveSegment: (occurrenceId, segment) => appendReconciliationLiveSegment(db, occurrenceId, segment),
    getReconciliationEvidence: (occurrenceId, recordingHandle) => getReconciliationEvidence(db, occurrenceId, recordingHandle),
    purgeExpiredReconciliationEvidence: (nowMs) => purgeExpiredReconciliationEvidence(db, nowMs),
    recordBridgeFailure: (input) => recordBridgeFailure(db, input),
    getBridgeFailureRecording: (occurrenceId, attempt) => getBridgeFailureRecording(db, occurrenceId, attempt),

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
      if (input.reconciliationGenerationId !== undefined) {
        const associated = db.prepare(
          `UPDATE reconciliation_generations SET recording_handle = ?
           WHERE generation_id = ? AND occurrence_id = ? AND recording_handle IS NULL`,
        ).run(input.recording.handle, input.reconciliationGenerationId, occurrenceId).changes;
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

const MAX_RECONCILIATION_EVENTS_PER_GENERATION = 256;

function beginReconciliationGeneration(db: Database.Database, occurrenceId: string, generationId: string, bridgeSessionId: string, createdAtMs: number, expiresAtMs: number): void {
  withConstraintTranslation(() => db.prepare(
    `INSERT INTO reconciliation_generations
       (generation_id, occurrence_id, bridge_session_id, created_at_ms, expires_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(generationId, occurrenceId, bridgeSessionId, createdAtMs, expiresAtMs));
}

function setReconciliationRuntimeSession(db: Database.Database, occurrenceId: string, generationId: string, runtimeSessionId: bigint): void {
  const changed = db.prepare(
    `UPDATE reconciliation_generations SET runtime_session_id = ?
     WHERE generation_id = ? AND occurrence_id = ? AND runtime_session_id IS NULL`,
  ).run(runtimeSessionId.toString(), generationId, occurrenceId).changes;
  if (changed !== 1) throw new OrchestrationError("constraint_violation", "reconciliation generation is unknown or already has a runtime session");
}

function appendReconciliationBridgeEvent(
  db: Database.Database,
  occurrenceId: string,
  event: ReconciliationBridgeEventRow,
): void {
  const count = db.prepare("SELECT count(*) AS count FROM reconciliation_bridge_events WHERE generation_id = ?")
    .get(event.generationId) as { count: number };
  if (count.count >= MAX_RECONCILIATION_EVENTS_PER_GENERATION) {
    db.prepare("UPDATE reconciliation_generations SET capture_complete = 0, incomplete_reason = 'event_limit_exceeded' WHERE generation_id = ? AND occurrence_id = ?")
      .run(event.generationId, occurrenceId);
    throw new OrchestrationError("constraint_violation", "reconciliation event limit exceeded");
  }
  const run = db.transaction(() => {
    const generation = db.prepare("SELECT bridge_session_id FROM reconciliation_generations WHERE generation_id = ? AND occurrence_id = ?")
      .get(event.generationId, occurrenceId) as { bridge_session_id: string } | undefined;
    if (generation === undefined || generation.bridge_session_id !== event.bridgeSessionId) {
      throw new OrchestrationError("constraint_violation", "bridge event does not belong to reconciliation generation");
    }
    db.prepare(
    `INSERT INTO reconciliation_bridge_events
       (generation_id, bridge_session_id, sequence, schema, observed_at, type, feishu_user_id, display_name, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(event.generationId, event.bridgeSessionId, event.sequence, event.schema, event.observedAt, event.type,
      event.feishuUserId, event.displayName, event.confidence);
  });
  withConstraintTranslation(run);
}

function appendReconciliationLiveSegment(
  db: Database.Database,
  occurrenceId: string,
  segment: ReconciliationLiveSegmentRow,
): void {
  const count = db.prepare("SELECT count(*) AS count FROM reconciliation_live_segments WHERE generation_id = ?")
    .get(segment.generationId) as { count: number };
  if (count.count >= MAX_RECONCILIATION_EVENTS_PER_GENERATION || Buffer.byteLength(segment.text, "utf8") > 16_384) {
    db.prepare("UPDATE reconciliation_generations SET capture_complete = 0, incomplete_reason = ? WHERE generation_id = ? AND occurrence_id = ?")
      .run(count.count >= MAX_RECONCILIATION_EVENTS_PER_GENERATION ? "event_limit_exceeded" : "live_text_limit_exceeded", segment.generationId, occurrenceId);
    throw new OrchestrationError("constraint_violation", "reconciliation live evidence limit exceeded");
  }
  const run = db.transaction(() => {
    const generation = db.prepare("SELECT 1 FROM reconciliation_generations WHERE generation_id = ? AND occurrence_id = ?")
      .get(segment.generationId, occurrenceId);
    if (generation === undefined) throw new OrchestrationError("constraint_violation", "live segment does not belong to reconciliation generation");
    db.prepare(
    `INSERT INTO reconciliation_live_segments (generation_id, segment_id, text, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?)`,
    ).run(segment.generationId, segment.segmentId, segment.text, segment.startedAt, segment.endedAt);
  });
  withConstraintTranslation(run);
}

function getReconciliationEvidence(db: Database.Database, occurrenceId: string, recordingHandle: string | null): ReconciliationEvidenceRow | null {
  const generation = db.prepare(
    recordingHandle === null
      ? `SELECT generation_id, runtime_session_id, alignment_status, capture_complete, incomplete_reason, expires_at_ms
           FROM reconciliation_generations WHERE occurrence_id = ? ORDER BY created_at_ms DESC, generation_id DESC LIMIT 1`
      : `SELECT generation_id, runtime_session_id, alignment_status, capture_complete, incomplete_reason, expires_at_ms
           FROM reconciliation_generations WHERE occurrence_id = ? AND recording_handle = ?`,
  ).get(...(recordingHandle === null ? [occurrenceId] : [occurrenceId, recordingHandle])) as { generation_id: string; runtime_session_id: string | null; alignment_status: "unavailable_current_sdk"; capture_complete: 0 | 1; incomplete_reason: ReconciliationEvidenceRow["incompleteReason"]; expires_at_ms: number } | undefined;
  if (generation === undefined) return null;
  const bridgeEvents = db.prepare(
    `SELECT bridge_session_id, sequence, schema, observed_at, type, feishu_user_id, display_name, confidence
       FROM reconciliation_bridge_events WHERE generation_id = ?`,
  ).all(generation.generation_id) as Array<{ bridge_session_id: string; sequence: number; schema: "bridge-session/v1"; observed_at: string; type: ReconciliationBridgeEventRow["type"]; feishu_user_id: string | null; display_name: string | null; confidence: ReconciliationBridgeEventRow["confidence"] }>;
  const liveSegments = db.prepare(
    `SELECT segment_id, text, started_at, ended_at FROM reconciliation_live_segments
       WHERE generation_id = ?`,
  ).all(generation.generation_id) as Array<{ segment_id: string; text: string; started_at: string; ended_at: string }>;
  return {
    occurrenceId,
    generationId: generation.generation_id,
    runtimeSessionId: generation.runtime_session_id === null ? null : BigInt(generation.runtime_session_id),
    alignment: null,
    alignmentStatus: generation.alignment_status,
    captureComplete: generation.capture_complete === 1,
    incompleteReason: generation.incomplete_reason,
    expiresAtMs: generation.expires_at_ms,
    bridgeEvents: bridgeEvents
      .sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at)
        || a.sequence - b.sequence || a.bridge_session_id.localeCompare(b.bridge_session_id))
      .map((row) => ({ generationId: generation.generation_id, bridgeSessionId: row.bridge_session_id, sequence: row.sequence, schema: row.schema,
        observedAt: row.observed_at, type: row.type, feishuUserId: row.feishu_user_id,
        displayName: row.display_name, confidence: row.confidence })),
    liveSegments: liveSegments
      .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at) || a.segment_id.localeCompare(b.segment_id))
      .map((row) => ({ generationId: generation.generation_id, segmentId: row.segment_id, text: row.text,
        startedAt: row.started_at, endedAt: row.ended_at })),
  };
}

function purgeExpiredReconciliationEvidence(db: Database.Database, nowMs: number): number {
  return db.prepare("DELETE FROM reconciliation_generations WHERE expires_at_ms <= ?").run(nowMs).changes;
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

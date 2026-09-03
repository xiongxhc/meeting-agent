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
// clock (see src/sessions/coordinator.ts). It holds orchestration state only
// -- session lifecycle, its audit trail, and bridge leases -- never
// transcript text and never audio bytes; migrations/001_orchestration.sql's
// STRICT tables and CHECK constraints make that structural, not just a
// convention followed here.

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
  type RecordingRow,
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
        `INSERT INTO recordings (occurrence_id, handle, sha256, duration_ms, finalized_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        occurrenceId,
        input.recording.handle,
        input.recording.sha256,
        input.recording.durationMs,
        nowMs,
      );
      const insertGap = db.prepare(
        `INSERT INTO recording_gaps (occurrence_id, ordinal, direction, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      input.recording.gaps.forEach((gap, ordinal) => {
        insertGap.run(occurrenceId, ordinal, gap.direction, gap.startedAt, gap.endedAt);
      });
    });
    return session;
  });
  const session = run();
  return { session, recording: getRecording(db, occurrenceId)! };
}

function getRecording(db: Database.Database, occurrenceId: string): RecordingRow | null {
  const raw = db
    .prepare(
      `SELECT occurrence_id, handle, sha256, duration_ms, finalized_at_ms
         FROM recordings WHERE occurrence_id = ?`,
    )
    .get(occurrenceId) as
    | {
        occurrence_id: string;
        handle: string;
        sha256: string;
        duration_ms: number;
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

  return {
    occurrenceId: raw.occurrence_id,
    handle: raw.handle,
    sha256: raw.sha256,
    durationMs: raw.duration_ms,
    finalizedAtMs: raw.finalized_at_ms,
    gaps: gaps.map(
      (gap): RecordingGapRow => ({
        ordinal: gap.ordinal,
        direction: gap.direction as RecordingGapRow["direction"],
        startedAt: gap.started_at,
        endedAt: gap.ended_at,
      }),
    ),
  };
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

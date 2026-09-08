// Orchestration state: the durable, per-occurrence session lifecycle, its
// bridge leases, and the concurrency semaphore that bounds how many
// occurrences run at once.
//
// What this suite exists to prove:
//   1. Restart safety. A process that dies between ANY two states resumes
//      from the persisted row, not from memory. Every boundary is
//      exercised, not just the interesting-looking ones.
//   2. Isolation. Occurrence A's activity never reads or mutates occurrence
//      B's rows -- proved with a full row-level snapshot of B taken before a
//      long burst of A activity (including a rolled-back failure) and
//      compared after, not by "two ids were used and nothing blew up".
//   3. Atomicity. A transition and its audit record commit together --
//      proved by making the audit-record write fail after the state write
//      would already have landed if they were not one transaction.
//   4. Determinism. Lease expiry is driven by an injected clock, never by
//      sleeping. No test in this file waits on wall-clock time.
//
// Every database lives in a fresh temp directory and is removed afterwards.
// Nothing here touches a live TeamMem installation.

import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Raw better-sqlite3, used ONLY in the dedicated FK-enforcement test below to
// open a second, low-level connection against the same database file and
// prove the schema's FOREIGN KEY constraints themselves reject an orphan
// row -- independent of any check the store's own API performs first. This
// is a *.test.ts file, so test/lib/import-scanner.ts's SQLite gate (which
// scans production code only) does not apply to it.
import Database from "better-sqlite3";

import { buildMeetingIdentity, type MeetingIdentity } from "../src/domain/meeting.ts";
import { occurrencePathSegment } from "../src/domain/occurrence-id.ts";
import {
  OrchestrationError,
  type LeaseRow,
  type SessionRow,
  type SessionState,
  type SessionStore,
  type TransitionRow,
} from "../src/ports/session-store.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import {
  ALLOWED_TRANSITIONS,
  HAPPY_PATH_STATES,
  SESSION_STATES,
  TERMINAL_STATES,
  createCoordinator,
  type Clock,
  type SessionCoordinator,
} from "../src/sessions/coordinator.ts";

const BASE_MS = 1_700_000_000_000;
const LEASE_TTL_MS = 30_000;
const RECONCILIATION_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "..", "migrations");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Harness = {
  readonly dbPath: string;
  open(nowMs?: number): SessionStore;
  cleanup(): void;
};

function harness(): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-agent-orchestration-"));
  const dbPath = path.join(dir, "orchestration.db");
  return {
    dbPath,
    open(nowMs = BASE_MS) {
      return openSessionStore({ filename: dbPath, nowMs });
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Builds a real historical schema fixture by executing the repository's
 * numbered migrations and recording them exactly as the production runner
 * does. The caller can then seed rows that only the historical schema would
 * accept before openSessionStore applies the remaining migrations. */
function migrateFixtureThrough(db: Database.Database, latestVersion: number): void {
  db.pragma("foreign_keys = ON");
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql") && Number.parseInt(name, 10) <= latestVersion)
    .sort();
  for (const name of migrations) {
    const version = Number.parseInt(name, 10);
    db.transaction(() => {
      db.exec(readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)")
        .run(version, name, BASE_MS);
    })();
  }
}

function seedRawSession(db: Database.Database, id: MeetingIdentity): void {
  db.prepare(
    `INSERT INTO sessions
       (occurrence_id, occurrence_segment, provider_meeting_id, occurrence_started_at,
        state, terminal_reason, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 'finalizing', NULL, ?, ?)`,
  ).run(
    id.occurrenceId,
    occurrencePathSegment(id.occurrenceId),
    id.providerMeetingId,
    id.occurrenceStartedAt,
    BASE_MS,
    BASE_MS,
  );
}

type TestClock = Clock & { advance(ms: number): void };

function fakeClock(startMs = BASE_MS): TestClock {
  let now = startMs;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function coordinatorFor(store: SessionStore, clock: Clock, maxConcurrentSessions = 4): SessionCoordinator {
  return createCoordinator({ store, clock, bridgeLeaseTtlMs: LEASE_TTL_MS, maxConcurrentSessions });
}

/** Synthetic, obviously fake occurrence identity. */
function identity(seq: number, startedAt = "2026-09-02T14:00:00Z"): MeetingIdentity {
  return buildMeetingIdentity({
    providerMeetingId: `fake-meeting-${String(seq).padStart(3, "0")}`,
    meetingNo: "000000000",
    occurrenceStartedAt: startedAt,
    title: "Fake Occurrence",
    organizer: null,
  });
}

function isOrchestrationError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof OrchestrationError && error.code === code;
}

/** Composes the shape coordinator.activeBridgeLease() actually returns (the
 * lease row plus a live-computed isExpired flag) from a plain LeaseRow
 * returned by acquireBridgeLease/releaseBridgeLease, so assertions can stay
 * readable instead of spelling out `{ ...lease, isExpired: ... }` everywhere. */
function withExpiry<T extends { readonly expiresAtMs: number }>(
  lease: T,
  isExpired: boolean,
): T & { isExpired: boolean } {
  return { ...lease, isExpired };
}

/** Every durable row that belongs to one occurrence, in a comparable shape. */
type OccurrenceSnapshot = {
  readonly session: SessionRow | null;
  readonly transitions: readonly TransitionRow[];
  readonly leases: readonly LeaseRow[];
};

function snapshot(store: SessionStore, occurrenceId: string): OccurrenceSnapshot {
  return {
    session: store.getSession(occurrenceId),
    transitions: store.listTransitions(occurrenceId),
    leases: store.listLeases(occurrenceId),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drains the microtask/immediate queue. Not a sleep: no timer duration is
 * involved, so this never depends on wall-clock timing. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Walks the happy path far enough to sit in `target`. Only used for states
 * on the linear path; "failed" is reached via fail() by the test itself. */
function driveTo(coordinator: SessionCoordinator, occurrenceId: string, target: SessionState): void {
  if (target === "discovered") return;
  for (const next of HAPPY_PATH_STATES) {
    coordinator.advance(occurrenceId, next);
    if (next === target) return;
  }
  throw new Error(`cannot drive to ${target}`);
}

// ---------------------------------------------------------------------------
// Migration and schema
// ---------------------------------------------------------------------------

test("the migrations apply in order, report the latest schema version, and pass foreign_key_check", () => {
  const h = harness();
  try {
    const store = h.open();
    try {
      assert.equal(store.schemaVersion, 17);
      assert.deepEqual(store.appliedMigrations(), [
        { version: 1, name: "001_orchestration.sql", appliedAtMs: BASE_MS },
        { version: 2, name: "002_recordings.sql", appliedAtMs: BASE_MS },
        { version: 3, name: "003_bridge_capacity.sql", appliedAtMs: BASE_MS },
        { version: 4, name: "004_recording_runtime_metadata.sql", appliedAtMs: BASE_MS },
        { version: 5, name: "005_bridge_recovery.sql", appliedAtMs: BASE_MS },
        { version: 6, name: "006_bridge_failure_recordings.sql", appliedAtMs: BASE_MS },
        { version: 7, name: "007_recording_runtime_gaps.sql", appliedAtMs: BASE_MS },
        { version: 8, name: "008_reconciliation_evidence.sql", appliedAtMs: BASE_MS },
        { version: 9, name: "009_reconciliation_generations.sql", appliedAtMs: BASE_MS },
        { version: 10, name: "010_reconciliation_evidence_hardening.sql", appliedAtMs: BASE_MS },
        { version: 11, name: "011_reconciliation_provenance_and_terminal.sql", appliedAtMs: BASE_MS },
        { version: 12, name: "012_reconciliation_upgrade_safety.sql", appliedAtMs: BASE_MS },
        { version: 13, name: "013_delivery_journal.sql", appliedAtMs: BASE_MS },
        { version: 14, name: "014_delivery_recovery.sql", appliedAtMs: BASE_MS },
        { version: 15, name: "015_delivery_recovery_reason.sql", appliedAtMs: BASE_MS },
        { version: 16, name: "016_delivery_recording_identity.sql", appliedAtMs: BASE_MS },
        { version: 17, name: "017_delivery_recording_reservations.sql", appliedAtMs: BASE_MS },
      ]);
      assert.equal(store.foreignKeysEnabled(), true);
      assert.deepEqual(store.foreignKeyCheck(), []);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("a missing migrations directory raises a clean invalid_configuration error, not a bare ENOENT stack trace", () => {
  // This is exactly the failure mode DEFAULT_MIGRATIONS_DIR would hit if it
  // ever resolved to a directory that doesn't exist (e.g. a built dist/
  // tree with no migrations/ copied alongside it, before `npm run build`
  // learned to copy that directory) -- see the "dist/ finds its migrations"
  // demonstration in the task report for the positive case.
  const h = harness();
  try {
    const missingDir = path.join(os.tmpdir(), "meeting-agent-no-such-migrations-dir-" + Date.now());
    assert.throws(
      () => openSessionStore({ filename: h.dbPath, migrationsDir: missingDir, nowMs: BASE_MS }),
      isOrchestrationError("invalid_configuration"),
    );
  } finally {
    h.cleanup();
  }
});

test("reopening an existing database does not re-apply the migrations", () => {
  const h = harness();
  try {
    const id = identity(1);
    const first = h.open(BASE_MS);
    const created = first.createSession({
      occurrenceId: id.occurrenceId,
      providerMeetingId: id.providerMeetingId,
      occurrenceStartedAt: id.occurrenceStartedAt,
      nowMs: BASE_MS,
    });
    first.close();

    const second = h.open(BASE_MS + 999_999);
    try {
      assert.equal(second.schemaVersion, 17);
      // applied_at is the FIRST application's stamp, proving the migrations
      // did not run a second time.
      assert.deepEqual(second.appliedMigrations(), [
        { version: 1, name: "001_orchestration.sql", appliedAtMs: BASE_MS },
        { version: 2, name: "002_recordings.sql", appliedAtMs: BASE_MS },
        { version: 3, name: "003_bridge_capacity.sql", appliedAtMs: BASE_MS },
        { version: 4, name: "004_recording_runtime_metadata.sql", appliedAtMs: BASE_MS },
        { version: 5, name: "005_bridge_recovery.sql", appliedAtMs: BASE_MS },
        { version: 6, name: "006_bridge_failure_recordings.sql", appliedAtMs: BASE_MS },
        { version: 7, name: "007_recording_runtime_gaps.sql", appliedAtMs: BASE_MS },
        { version: 8, name: "008_reconciliation_evidence.sql", appliedAtMs: BASE_MS },
        { version: 9, name: "009_reconciliation_generations.sql", appliedAtMs: BASE_MS },
        { version: 10, name: "010_reconciliation_evidence_hardening.sql", appliedAtMs: BASE_MS },
        { version: 11, name: "011_reconciliation_provenance_and_terminal.sql", appliedAtMs: BASE_MS },
        { version: 12, name: "012_reconciliation_upgrade_safety.sql", appliedAtMs: BASE_MS },
        { version: 13, name: "013_delivery_journal.sql", appliedAtMs: BASE_MS },
        { version: 14, name: "014_delivery_recovery.sql", appliedAtMs: BASE_MS },
        { version: 15, name: "015_delivery_recovery_reason.sql", appliedAtMs: BASE_MS },
        { version: 16, name: "016_delivery_recording_identity.sql", appliedAtMs: BASE_MS },
        { version: 17, name: "017_delivery_recording_reservations.sql", appliedAtMs: BASE_MS },
      ]);
      assert.deepEqual(second.getSession(created.occurrenceId), created);
    } finally {
      second.close();
    }
  } finally {
    h.cleanup();
  }
});

test("schema 13 and 14 missing recording owners fail closed and reserve later physical identity", () => {
  for (const legacyVersion of [13, 14]) {
    for (const createFromReservedPath of [true, false]) {
      const h = harness();
      const recordings = path.join(path.dirname(h.dbPath), "recordings");
      mkdirSync(recordings);
      const reservedHandle = "a".repeat(32);
      const laterHandle = "b".repeat(32);
      const unrelatedHandle = "c".repeat(32);
      const reservedPath = `${recordings}/./${reservedHandle}.crsr`;
      const laterPath = path.join(recordings, `${laterHandle}.crsr`);
      const unrelatedPath = path.join(recordings, `${unrelatedHandle}.crsr`);
      const reserved = identity(130 + legacyVersion + (createFromReservedPath ? 0 : 20));
      const later = identity(230 + legacyVersion + (createFromReservedPath ? 0 : 20));
      const unrelated = identity(330 + legacyVersion + (createFromReservedPath ? 0 : 20));
      const artifactHash = `sha256:${"a".repeat(64)}`;
      try {
        const raw = new Database(h.dbPath);
        try {
          migrateFixtureThrough(raw, legacyVersion);
          seedRawSession(raw, reserved);
          raw.prepare("UPDATE sessions SET state = 'awaiting_teammem' WHERE occurrence_id = ?")
            .run(reserved.occurrenceId);
          raw.prepare(
            `INSERT INTO recordings
               (occurrence_id, handle, sha256, duration_ms, finalized_at_ms, encrypted_path, format, key_id)
             VALUES (?, ?, ?, 1, ?, ?, 'opus', 'fake-key')`,
          ).run(reserved.occurrenceId, reservedHandle, "a".repeat(64), BASE_MS, reservedPath);
          const recoveryColumns = legacyVersion >= 14 ? ", recovery_artifact, stage_token" : "";
          const recoveryValues = legacyVersion >= 14 ? ", NULL, NULL" : "";
          raw.prepare(
            `INSERT INTO delivery_journal
               (occurrence_id, revision, artifact_hash, recording_path, bundle_path, ended_at_ms,
                transcript_complete, retry_count, next_retry_at_ms, retry_reason, published_at_ms,
                deleted_at_ms, publication_url, vault_commit${recoveryColumns})
             VALUES (?, 3, ?, ?, ?, ?, 1, 7, ?, 'receipt_unavailable', ?, NULL, ?, ?${recoveryValues})`,
          ).run(
            reserved.occurrenceId,
            artifactHash,
            reservedPath,
            path.join(path.dirname(h.dbPath), "outbox", occurrencePathSegment(reserved.occurrenceId), "3"),
            BASE_MS,
            BASE_MS + 99,
            BASE_MS + 1,
            "https://example.test/vault/-/blob/" + "d".repeat(40) + "/Meetings/reserved.md",
            "d".repeat(40),
          );
        } finally {
          raw.close();
        }

        const store = h.open(BASE_MS + 2);
        try {
          assert.equal(store.schemaVersion, 17);
          assert.deepEqual(store.foreignKeyCheck(), []);
          const migrated = store.pending().find((row) => row.occurrenceId === reserved.occurrenceId)!;
          assert.equal(migrated.retryReason, "recovery_unavailable");
          assert.equal(migrated.recordingPath, path.resolve(reservedPath));
          assert.equal(migrated.recordingHandle, reservedHandle);
          assert.equal(migrated.retryCount, 7);
          assert.equal(migrated.nextRetryAtMs, BASE_MS + 99);
          assert.equal(migrated.publishedAtMs, BASE_MS + 1);
          assert.equal(migrated.vaultCommit, "d".repeat(40));

          const inspectReservation = new Database(h.dbPath, { readonly: true });
          try {
            assert.deepEqual(inspectReservation.prepare(
              `SELECT canonical_path, physical_identity, occurrence_id, recording_handle, owner_state, failure_reason
                 FROM delivery_recording_owners_v17 WHERE canonical_path = ?`,
            ).get(path.resolve(reservedPath)), {
              canonical_path: path.resolve(reservedPath),
              physical_identity: null,
              occurrence_id: reserved.occurrenceId,
              recording_handle: reservedHandle,
              owner_state: "reserved",
              failure_reason: "source_missing",
            });
          } finally {
            inspectReservation.close();
          }

          writeFileSync(unrelatedPath, "unrelated encrypted bytes");
          store.createSession({ occurrenceId: unrelated.occurrenceId, providerMeetingId: unrelated.providerMeetingId, occurrenceStartedAt: unrelated.occurrenceStartedAt, nowMs: BASE_MS });
          store.finalizeSession({
            transition: { occurrenceId: unrelated.occurrenceId, fromState: "discovered", toState: "awaiting_teammem", reason: "test", terminalReason: null, nowMs: BASE_MS },
            recording: { handle: unrelatedHandle, encryptedPath: unrelatedPath, sha256: "c".repeat(64), durationMs: 1, format: "opus", keyId: "fake-key", gaps: [], runtimeGaps: [] },
          });
          assert.doesNotThrow(() => store.savePending({
            ...migrated,
            occurrenceId: unrelated.occurrenceId,
            recordingPath: unrelatedPath,
            bundlePath: path.join(path.dirname(h.dbPath), "outbox", occurrencePathSegment(unrelated.occurrenceId), "3"),
            artifactHash: `sha256:${"c".repeat(64)}`,
            retryCount: 0,
            retryReason: null,
            publishedAtMs: null,
            publicationUrl: null,
            vaultCommit: null,
            recordingHandle: unrelatedHandle,
          }));

          if (createFromReservedPath) {
            writeFileSync(path.resolve(reservedPath), "shared encrypted bytes");
            linkSync(path.resolve(reservedPath), laterPath);
          } else {
            writeFileSync(laterPath, "shared encrypted bytes");
            linkSync(laterPath, path.resolve(reservedPath));
          }
          const reservedStat = statSync(path.resolve(reservedPath));
          const laterStat = statSync(laterPath);
          assert.equal(reservedStat.dev, laterStat.dev);
          assert.equal(reservedStat.ino, laterStat.ino);

          assert.doesNotThrow(() => store.savePending({
            ...migrated,
            revision: 4,
            artifactHash: `sha256:${"e".repeat(64)}`,
            bundlePath: path.join(path.dirname(h.dbPath), "outbox", occurrencePathSegment(reserved.occurrenceId), "4"),
            retryCount: 0,
            retryReason: null,
            publishedAtMs: null,
            publicationUrl: null,
            vaultCommit: null,
          }));

          const inspectObservedOwner = new Database(h.dbPath, { readonly: true });
          try {
            assert.deepEqual(inspectObservedOwner.prepare(
              `SELECT physical_identity, owner_state, failure_reason
                 FROM delivery_recording_owners_v17 WHERE canonical_path = ?`,
            ).get(path.resolve(reservedPath)), {
              physical_identity: `inode:${reservedStat.dev}:${reservedStat.ino}`,
              owner_state: "observed",
              failure_reason: null,
            });
          } finally {
            inspectObservedOwner.close();
          }

          store.createSession({ occurrenceId: later.occurrenceId, providerMeetingId: later.providerMeetingId, occurrenceStartedAt: later.occurrenceStartedAt, nowMs: BASE_MS });
          store.finalizeSession({
            transition: { occurrenceId: later.occurrenceId, fromState: "discovered", toState: "awaiting_teammem", reason: "test", terminalReason: null, nowMs: BASE_MS },
            recording: { handle: laterHandle, encryptedPath: laterPath, sha256: "b".repeat(64), durationMs: 1, format: "opus", keyId: "fake-key", gaps: [], runtimeGaps: [] },
          });
          assert.throws(() => store.savePending({
            ...migrated,
            occurrenceId: later.occurrenceId,
            recordingPath: laterPath,
            bundlePath: path.join(path.dirname(h.dbPath), "outbox", occurrencePathSegment(later.occurrenceId), "3"),
            artifactHash: `sha256:${"b".repeat(64)}`,
            retryCount: 0,
            retryReason: null,
            publishedAtMs: null,
            publicationUrl: null,
            vaultCommit: null,
            recordingHandle: laterHandle,
          }), /another occurrence/i);
        } finally {
          store.close();
        }

        const reopened = h.open(BASE_MS + 3);
        try {
          assert.equal(reopened.schemaVersion, 17);
          assert.deepEqual(reopened.foreignKeyCheck(), []);
          assert.equal(reopened.pending().filter((row) => row.occurrenceId === reserved.occurrenceId).length, 2);
          assert.equal(reopened.pending().filter((row) => row.occurrenceId === unrelated.occurrenceId).length, 1);
          assert.equal(reopened.pending().some((row) => row.occurrenceId === later.occurrenceId), false);
        } finally {
          reopened.close();
        }
      } finally {
        h.cleanup();
      }
    }
  }
});

test("reconciliation evidence survives reopening with exact bigint identity, envelope sequence, attendance, and live wording", () => {
  const h = harness();
  try {
    const id = identity(92);
    const first = h.open();
    first.createSession({ occurrenceId: id.occurrenceId, providerMeetingId: id.providerMeetingId, occurrenceStartedAt: id.occurrenceStartedAt, nowMs: BASE_MS });
    first.beginReconciliationGeneration(id.occurrenceId, "bridge_1", BASE_MS);
    first.setReconciliationRuntimeSession(id.occurrenceId, "bridge_1", 9_007_199_254_740_993n);
    // Lexically, .500Z sorts before Z. The read path must use parsed instants
    // and only then bridge sequence, so attendance reaches the reconciler first.
    first.appendReconciliationBridgeEvent(id.occurrenceId, { bridgeSessionId: "bridge_1", sequence: 7, schema: "bridge-session/v1", observedAt: "2026-09-02T14:00:00Z", type: "participant_joined", feishuUserId: "ou_a", displayName: "Synthetic", confidence: null });
    first.appendReconciliationBridgeEvent(id.occurrenceId, { bridgeSessionId: "bridge_1", sequence: 8, schema: "bridge-session/v1", observedAt: "2026-09-02T14:00:00.500Z", type: "active_speaker", feishuUserId: "ou_a", displayName: null, confidence: "ui_exact" });
    first.appendReconciliationLiveSegment(id.occurrenceId, { bridgeSessionId: "bridge_1", segmentId: "seg_1", text: "local-only wording", startedAt: "2026-09-02T14:00:00Z", endedAt: "2026-09-02T14:00:01Z" });
    first.close();
    const second = h.open();
    try {
      assert.deepEqual(second.getReconciliationEvidence(id.occurrenceId, null), {
        occurrenceId: id.occurrenceId, generationId: `${Buffer.from(id.occurrenceId).toString("hex")}:${Buffer.from("bridge_1").toString("hex")}`, runtimeSessionId: 9_007_199_254_740_993n,
        alignment: null, alignmentStatus: "unavailable_current_sdk", captureComplete: true, incompleteReason: null, terminalAtMs: null, terminalSource: null, expiresAtMs: null,
        bridgeEvents: [
          { bridgeSessionId: "bridge_1", sequence: 7, schema: "bridge-session/v1", observedAt: "2026-09-02T14:00:00Z", observedAtMs: Date.parse("2026-09-02T14:00:00Z"), type: "participant_joined", feishuUserId: "ou_a", displayName: "Synthetic", confidence: null },
          { bridgeSessionId: "bridge_1", sequence: 8, schema: "bridge-session/v1", observedAt: "2026-09-02T14:00:00.500Z", observedAtMs: Date.parse("2026-09-02T14:00:00.500Z"), type: "active_speaker", feishuUserId: "ou_a", displayName: null, confidence: "ui_exact" },
        ],
        liveSegments: [{ bridgeSessionId: "bridge_1", segmentId: "seg_1", text: "local-only wording", startedAt: "2026-09-02T14:00:00Z", endedAt: "2026-09-02T14:00:01Z" }],
      });
      assert.deepEqual(second.foreignKeyCheck(), []);
    } finally { second.close(); }
  } finally { h.cleanup(); }
});

test("a finalized recording reads only its immutable reconciliation generation after reopen", () => {
  const h = harness();
  try {
    const id = identity(93);
    const clock = fakeClock();
    const first = h.open();
    const coordinator = coordinatorFor(first, clock);
    coordinator.discover(id);
    coordinator.advance(id.occurrenceId, "joining");
    coordinator.advance(id.occurrenceId, "listening");
    coordinator.beginReconciliationGeneration(id.occurrenceId, "bridge_old");
    coordinator.setReconciliationRuntimeSession(id.occurrenceId, "bridge_old", 17n);
    coordinator.appendReconciliationLiveSegment(id.occurrenceId, { bridgeSessionId: "bridge_old", segmentId: "same_segment", text: "old wording", startedAt: "2026-09-02T14:00:00Z", endedAt: "2026-09-02T14:00:01Z" });
    coordinator.beginReconciliationGeneration(id.occurrenceId, "bridge_final");
    coordinator.setReconciliationRuntimeSession(id.occurrenceId, "bridge_final", 19n);
    coordinator.appendReconciliationLiveSegment(id.occurrenceId, { bridgeSessionId: "bridge_final", segmentId: "same_segment", text: "final wording", startedAt: "2026-09-02T14:00:02Z", endedAt: "2026-09-02T14:00:03Z" });
    coordinator.finalizeWithRecording(id.occurrenceId, { kind: "advance", toState: "finalizing" }, {
      handle: "finalrecording1", encryptedPath: "/enc/final", sha256: "f".repeat(64), durationMs: 1,
      format: "ogg/opus", keyId: "key", gaps: [], runtimeGaps: [],
    }, "bridge_final");
    first.close();
    const second = h.open();
    try {
      assert.deepEqual(second.getReconciliationEvidence(id.occurrenceId, "finalrecording1")?.liveSegments.map((segment) => segment.text), ["final wording"]);
      assert.equal(second.getReconciliationEvidence(id.occurrenceId, "finalrecording1")?.runtimeSessionId, 19n);
    } finally { second.close(); }
  } finally { h.cleanup(); }
});

test("expired bounded reconciliation evidence purges generation children atomically", () => {
  const h = harness();
  try {
    const id = identity(94);
    const store = h.open();
    store.createSession({ occurrenceId: id.occurrenceId, providerMeetingId: id.providerMeetingId, occurrenceStartedAt: id.occurrenceStartedAt, nowMs: BASE_MS });
    store.beginReconciliationGeneration(id.occurrenceId, "bridge_expired", BASE_MS);
    store.appendReconciliationLiveSegment(id.occurrenceId, { bridgeSessionId: "bridge_expired", segmentId: "seg", text: "bounded scratch", startedAt: "2026-09-02T14:00:00Z", endedAt: "2026-09-02T14:00:01Z" });
    // Only a terminal lifecycle timestamp makes recovery scratch eligible.
    const raw = new Database(h.dbPath);
    raw.prepare("UPDATE reconciliation_generations SET terminal_at_ms = ?, terminal_source = 'local_clock', expires_at_ms = ? WHERE occurrence_id = ?").run(BASE_MS, BASE_MS + 14 * 24 * 60 * 60 * 1000, id.occurrenceId);
    raw.close();
    assert.equal(store.purgeExpiredReconciliationEvidence(BASE_MS + 14 * 24 * 60 * 60 * 1000), 1);
    assert.equal(store.getReconciliationEvidence(id.occurrenceId, null), null);
    assert.deepEqual(store.foreignKeyCheck(), []);
    store.close();
  } finally { h.cleanup(); }
});

test("oversized live wording marks its generation durably incomplete instead of silently dropping it", () => {
  const h = harness();
  try {
    const id = identity(95);
    const store = h.open();
    store.createSession({ occurrenceId: id.occurrenceId, providerMeetingId: id.providerMeetingId, occurrenceStartedAt: id.occurrenceStartedAt, nowMs: BASE_MS });
    store.beginReconciliationGeneration(id.occurrenceId, "bridge_bound", BASE_MS);
    assert.throws(
      () => store.appendReconciliationLiveSegment(id.occurrenceId, { bridgeSessionId: "bridge_bound", segmentId: "too_large", text: "x".repeat(16_385), startedAt: "2026-09-02T14:00:00Z", endedAt: "2026-09-02T14:00:01Z" }),
      isOrchestrationError("constraint_violation"),
    );
    assert.deepEqual(store.getReconciliationEvidence(id.occurrenceId, null)?.incompleteReason, "live_text_limit_exceeded");
    store.close();
  } finally { h.cleanup(); }
});

test("reconciliation evidence rejects impossible UTC instants, empty identities, illegal envelopes, and reversed live intervals", () => {
  const h = harness();
  try {
    const id = identity(96);
    const store = h.open();
    store.createSession({ occurrenceId: id.occurrenceId, providerMeetingId: id.providerMeetingId, occurrenceStartedAt: id.occurrenceStartedAt, nowMs: BASE_MS });
    store.beginReconciliationGeneration(id.occurrenceId, "semantic_bridge", BASE_MS);
    const raw = new Database(h.dbPath);
    try {
      const generation = raw.prepare("SELECT generation_id FROM reconciliation_generations WHERE occurrence_id = ?").get(id.occurrenceId) as { generation_id: string };
      const event = raw.prepare("INSERT INTO reconciliation_bridge_events (generation_id, bridge_session_id, sequence, schema, observed_at, observed_at_ms, type, feishu_user_id, display_name, confidence) VALUES (?, 'semantic_bridge', ?, 'bridge-session/v1', ?, ?, ?, ?, ?, ?)");
      assert.throws(() => event.run(generation.generation_id, 1, "2026-02-31T14:00:00Z", Date.parse("2026-02-31T14:00:00Z"), "participant_joined", "ou_a", "Ada", null));
      assert.throws(() => event.run(generation.generation_id, 2, "2026-09-02T14:00:00Z", Date.parse("2026-09-02T14:00:00Z"), "participant_joined", "", "Ada", null));
      assert.throws(() => event.run(generation.generation_id, 3, "2026-09-02T14:00:00Z", Date.parse("2026-09-02T14:00:00Z"), "active_speaker", "ou_a", "Ada", "ui_exact"));
      assert.throws(() => event.run(generation.generation_id, 0, "2026-09-02T14:00:00Z", Date.parse("2026-09-02T14:00:00Z"), "participant_left", "ou_a", null, null));
      assert.throws(() => event.run(generation.generation_id, 4, "2026-09-02T14:00:00+00:00", Date.parse("2026-09-02T14:00:00+00:00"), "participant_left", "ou_a", null, null));
      assert.throws(() => event.run(generation.generation_id, 5, "2026-09-02T14:00:00.12Z", Date.parse("2026-09-02T14:00:00.12Z"), "participant_left", "ou_a", null, null));
      const live = raw.prepare("INSERT INTO reconciliation_live_segments (generation_id, segment_id, text, started_at, started_at_ms, ended_at, ended_at_ms) VALUES (?, 'reverse', 'wording', '2026-09-02T14:00:01Z', ?, '2026-09-02T14:00:00Z', ?)");
      assert.throws(() => live.run(generation.generation_id, Date.parse("2026-09-02T14:00:01Z"), Date.parse("2026-09-02T14:00:00Z")));
    } finally { raw.close(); store.close(); }
  } finally { h.cleanup(); }
});

test("raw reconciliation rows cannot disagree between retained UTC provenance and numeric ordering instants", () => {
  const h = harness();
  try {
    const id = identity(101);
    const store = h.open();
    store.createSession({ occurrenceId: id.occurrenceId, providerMeetingId: id.providerMeetingId, occurrenceStartedAt: id.occurrenceStartedAt, nowMs: BASE_MS });
    store.beginReconciliationGeneration(id.occurrenceId, "provenance_bridge", BASE_MS);
    const raw = new Database(h.dbPath);
    try {
      const generation = raw.prepare("SELECT generation_id FROM reconciliation_generations WHERE occurrence_id = ?").get(id.occurrenceId) as { generation_id: string };
      const event = raw.prepare("INSERT INTO reconciliation_bridge_events (generation_id, bridge_session_id, sequence, schema, observed_at, observed_at_ms, type, feishu_user_id, display_name, confidence) VALUES (?, 'provenance_bridge', ?, 'bridge-session/v1', ?, ?, 'participant_joined', 'ou_a', 'Ada', NULL)");
      assert.throws(() => event.run(generation.generation_id, 1, "2026-09-02T14:00:00Z", 0));
      assert.throws(() => event.run(generation.generation_id, 3, "not-a-date", 123));
      event.run(generation.generation_id, 2, "2026-09-02T14:00:00.123Z", Date.parse("2026-09-02T14:00:00.123Z"));
      event.run(generation.generation_id, 4, "2026-09-02T14:00:01Z", Date.parse("2026-09-02T14:00:01Z"));
      const live = raw.prepare("INSERT INTO reconciliation_live_segments (generation_id, segment_id, text, started_at, started_at_ms, ended_at, ended_at_ms) VALUES (?, ?, 'wording', ?, ?, ?, ?)");
      assert.throws(() => live.run(generation.generation_id, "bad", "2026-09-02T14:00:00Z", 0, "2026-09-02T14:00:00.001Z", 1));
      assert.throws(() => live.run(generation.generation_id, "bad_start", "not-a-date", 10, "2026-09-02T14:00:00Z", Date.parse("2026-09-02T14:00:00Z")));
      assert.throws(() => live.run(generation.generation_id, "bad_end", "2026-09-02T14:00:00Z", Date.parse("2026-09-02T14:00:00Z"), "not-a-date", Date.parse("2026-09-02T14:00:01Z")));
      live.run(generation.generation_id, "good", "2026-09-02T14:00:00Z", Date.parse("2026-09-02T14:00:00Z"), "2026-09-02T14:00:00.123Z", Date.parse("2026-09-02T14:00:00.123Z"));
      live.run(generation.generation_id, "good_mixed", "2026-09-02T14:00:00.500Z", Date.parse("2026-09-02T14:00:00.500Z"), "2026-09-02T14:00:01Z", Date.parse("2026-09-02T14:00:01Z"));
    } finally { raw.close(); store.close(); }
  } finally { h.cleanup(); }
});

test("a schema-10 terminal recording generation upgrades with honest legacy provenance and exact evidence", () => {
  const h = harness();
  const id = identity(104);
  const bridgeSessionId = "legacy_terminal_bridge";
  const generationId = `${Buffer.from(id.occurrenceId).toString("hex")}:${Buffer.from(bridgeSessionId).toString("hex")}`;
  const recordingHandle = "legacyrecording10";
  const terminalAtMs = Date.parse("2026-09-02T14:00:03Z");
  const expiresAtMs = terminalAtMs + RECONCILIATION_RETENTION_MS;
  try {
    const raw = new Database(h.dbPath);
    try {
      migrateFixtureThrough(raw, 10);
      seedRawSession(raw, id);
      raw.prepare("INSERT INTO recordings (occurrence_id, handle, sha256, duration_ms, finalized_at_ms, encrypted_path, format, key_id) VALUES (?, ?, ?, 3000, ?, '/enc/legacy', 'ogg/opus', 'legacy-key')")
        .run(id.occurrenceId, recordingHandle, "a".repeat(64), terminalAtMs);
      raw.prepare("INSERT INTO reconciliation_generations (generation_id, occurrence_id, bridge_session_id, runtime_session_id, recording_handle, alignment_status, capture_complete, incomplete_reason, created_at_ms, terminal_at_ms, expires_at_ms) VALUES (?, ?, ?, '9007199254740993', ?, 'unavailable_current_sdk', 1, NULL, ?, ?, ?)")
        .run(generationId, id.occurrenceId, bridgeSessionId, recordingHandle, BASE_MS, terminalAtMs, expiresAtMs);
      raw.prepare("INSERT INTO reconciliation_bridge_events (generation_id, bridge_session_id, sequence, schema, observed_at, observed_at_ms, type, feishu_user_id, display_name, confidence) VALUES (?, ?, 1, 'bridge-session/v1', '2026-09-02T14:00:00Z', ?, 'participant_joined', 'ou_legacy', 'Legacy Person', NULL)")
        .run(generationId, bridgeSessionId, Date.parse("2026-09-02T14:00:00Z"));
      raw.prepare("INSERT INTO reconciliation_bridge_events (generation_id, bridge_session_id, sequence, schema, observed_at, observed_at_ms, type, feishu_user_id, display_name, confidence) VALUES (?, ?, 2, 'bridge-session/v1', '2026-09-02T14:00:00.500Z', ?, 'active_speaker', 'ou_legacy', NULL, 'ui_exact')")
        .run(generationId, bridgeSessionId, Date.parse("2026-09-02T14:00:00.500Z"));
      raw.prepare("INSERT INTO reconciliation_live_segments (generation_id, segment_id, text, started_at, started_at_ms, ended_at, ended_at_ms) VALUES (?, 'legacy_segment', 'exact legacy wording', '2026-09-02T14:00:00.500Z', ?, '2026-09-02T14:00:01Z', ?)")
        .run(generationId, Date.parse("2026-09-02T14:00:00.500Z"), Date.parse("2026-09-02T14:00:01Z"));
    } finally {
      raw.close();
    }

    const upgraded = h.open(BASE_MS + 1);
    assert.equal(upgraded.schemaVersion, 17);
    upgraded.close();

    const reopened = h.open(BASE_MS + 2);
    try {
      assert.deepEqual(reopened.getRecording(id.occurrenceId)?.handle, recordingHandle);
      assert.deepEqual(reopened.getReconciliationEvidence(id.occurrenceId, recordingHandle), {
        occurrenceId: id.occurrenceId,
        generationId,
        runtimeSessionId: 9_007_199_254_740_993n,
        alignment: null,
        alignmentStatus: "unavailable_current_sdk",
        captureComplete: true,
        incompleteReason: null,
        terminalAtMs,
        terminalSource: "legacy_unknown",
        expiresAtMs,
        bridgeEvents: [
          { bridgeSessionId, sequence: 1, schema: "bridge-session/v1", observedAt: "2026-09-02T14:00:00Z", observedAtMs: Date.parse("2026-09-02T14:00:00Z"), type: "participant_joined", feishuUserId: "ou_legacy", displayName: "Legacy Person", confidence: null },
          { bridgeSessionId, sequence: 2, schema: "bridge-session/v1", observedAt: "2026-09-02T14:00:00.500Z", observedAtMs: Date.parse("2026-09-02T14:00:00.500Z"), type: "active_speaker", feishuUserId: "ou_legacy", displayName: null, confidence: "ui_exact" },
        ],
        liveSegments: [{ bridgeSessionId, segmentId: "legacy_segment", text: "exact legacy wording", startedAt: "2026-09-02T14:00:00.500Z", endedAt: "2026-09-02T14:00:01Z" }],
      });
      assert.equal(reopened.purgeExpiredReconciliationEvidence(expiresAtMs - 1), 0);
      assert.notEqual(reopened.getReconciliationEvidence(id.occurrenceId, recordingHandle), null);
      assert.equal(reopened.purgeExpiredReconciliationEvidence(expiresAtMs), 1);
      assert.equal(reopened.getReconciliationEvidence(id.occurrenceId, recordingHandle), null);
      assert.deepEqual(reopened.foreignKeyCheck(), []);
    } finally {
      reopened.close();
    }
  } finally {
    h.cleanup();
  }
});

test("a schema-10 malformed child is discarded without deleting its terminal recording generation", () => {
  const h = harness();
  const id = identity(105);
  const bridgeSessionId = "legacy_malformed_bridge";
  const generationId = `${Buffer.from(id.occurrenceId).toString("hex")}:${Buffer.from(bridgeSessionId).toString("hex")}`;
  const terminalAtMs = Date.parse("2026-09-02T14:00:03Z");
  const expiresAtMs = terminalAtMs + RECONCILIATION_RETENTION_MS;
  try {
    const raw = new Database(h.dbPath);
    try {
      migrateFixtureThrough(raw, 10);
      seedRawSession(raw, id);
      raw.prepare("INSERT INTO reconciliation_generations (generation_id, occurrence_id, bridge_session_id, runtime_session_id, recording_handle, alignment_status, capture_complete, incomplete_reason, created_at_ms, terminal_at_ms, expires_at_ms) VALUES (?, ?, ?, '44', 'malformedlegacy10', 'unavailable_current_sdk', 1, NULL, ?, ?, ?)")
        .run(generationId, id.occurrenceId, bridgeSessionId, BASE_MS, terminalAtMs, expiresAtMs);
      raw.prepare("INSERT INTO reconciliation_bridge_events (generation_id, bridge_session_id, sequence, schema, observed_at, observed_at_ms, type, feishu_user_id, display_name, confidence) VALUES (?, ?, 1, 'bridge-session/v1', 'not-a-date', 123, 'participant_joined', 'ou_legacy', 'Legacy Person', NULL)")
        .run(generationId, bridgeSessionId);
      raw.prepare("INSERT INTO reconciliation_live_segments (generation_id, segment_id, text, started_at, started_at_ms, ended_at, ended_at_ms) VALUES (?, 'trusted_segment', 'trusted legacy wording', '2026-09-02T14:00:00Z', ?, '2026-09-02T14:00:01Z', ?)")
        .run(generationId, Date.parse("2026-09-02T14:00:00Z"), Date.parse("2026-09-02T14:00:01Z"));
    } finally {
      raw.close();
    }

    const store = h.open();
    try {
      const evidence = store.getReconciliationEvidence(id.occurrenceId, "malformedlegacy10");
      assert.equal(evidence?.runtimeSessionId, 44n);
      assert.equal(evidence?.terminalAtMs, terminalAtMs);
      assert.equal(evidence?.terminalSource, "legacy_unknown");
      assert.equal(evidence?.expiresAtMs, expiresAtMs);
      assert.equal(evidence?.captureComplete, false);
      assert.equal(evidence?.incompleteReason, "legacy_evidence_invalid_on_migration");
      assert.deepEqual(evidence?.bridgeEvents, []);
      assert.deepEqual(evidence?.liveSegments.map((segment) => segment.text), ["trusted legacy wording"]);
      assert.deepEqual(store.foreignKeyCheck(), []);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("a schema-11 database upgrades to the current constraints without losing retained evidence", () => {
  const h = harness();
  const id = identity(106);
  const bridgeSessionId = "schema_11_bridge";
  const generationId = `${Buffer.from(id.occurrenceId).toString("hex")}:${Buffer.from(bridgeSessionId).toString("hex")}`;
  const terminalAtMs = Date.parse("2026-09-02T14:00:03Z");
  try {
    const raw = new Database(h.dbPath);
    try {
      migrateFixtureThrough(raw, 11);
      seedRawSession(raw, id);
      raw.prepare("INSERT INTO reconciliation_generations (generation_id, occurrence_id, bridge_session_id, runtime_session_id, recording_handle, alignment_status, capture_complete, incomplete_reason, created_at_ms, terminal_at_ms, terminal_source, expires_at_ms) VALUES (?, ?, ?, '45', 'schema11recording', 'unavailable_current_sdk', 1, NULL, ?, ?, 'bridge_observed', ?)")
        .run(generationId, id.occurrenceId, bridgeSessionId, BASE_MS, terminalAtMs, terminalAtMs + RECONCILIATION_RETENTION_MS);
      raw.prepare("INSERT INTO reconciliation_bridge_events (generation_id, bridge_session_id, sequence, schema, observed_at, observed_at_ms, type, feishu_user_id, display_name, confidence) VALUES (?, ?, 1, 'bridge-session/v1', '2026-09-02T14:00:00.125Z', ?, 'participant_joined', 'ou_11', 'Schema Eleven', NULL)")
        .run(generationId, bridgeSessionId, Date.parse("2026-09-02T14:00:00.125Z"));
      raw.prepare("INSERT INTO reconciliation_live_segments (generation_id, segment_id, text, started_at, started_at_ms, ended_at, ended_at_ms) VALUES (?, 'schema_11_segment', 'schema eleven wording', '2026-09-02T14:00:00Z', ?, '2026-09-02T14:00:01.250Z', ?)")
        .run(generationId, Date.parse("2026-09-02T14:00:00Z"), Date.parse("2026-09-02T14:00:01.250Z"));
    } finally {
      raw.close();
    }

    const store = h.open();
    try {
      assert.equal(store.schemaVersion, 17);
      const evidence = store.getReconciliationEvidence(id.occurrenceId, "schema11recording");
      assert.equal(evidence?.runtimeSessionId, 45n);
      assert.equal(evidence?.terminalSource, "bridge_observed");
      assert.deepEqual(evidence?.bridgeEvents.map((event) => event.observedAt), ["2026-09-02T14:00:00.125Z"]);
      assert.deepEqual(evidence?.liveSegments.map((segment) => [segment.startedAt, segment.endedAt]), [["2026-09-02T14:00:00Z", "2026-09-02T14:00:01.250Z"]]);
      assert.deepEqual(store.foreignKeyCheck(), []);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("a schema-11 upgrade quarantines already-admitted garbage without deleting its surviving parent", () => {
  const h = harness();
  const id = identity(107);
  const bridgeSessionId = "schema_11_garbage_bridge";
  const generationId = `${Buffer.from(id.occurrenceId).toString("hex")}:${Buffer.from(bridgeSessionId).toString("hex")}`;
  try {
    const raw = new Database(h.dbPath);
    try {
      migrateFixtureThrough(raw, 11);
      seedRawSession(raw, id);
      raw.prepare("INSERT INTO reconciliation_generations (generation_id, occurrence_id, bridge_session_id, runtime_session_id, recording_handle, alignment_status, capture_complete, incomplete_reason, created_at_ms) VALUES (?, ?, ?, '46', 'schema11garbage', 'unavailable_current_sdk', 1, NULL, ?)")
        .run(generationId, id.occurrenceId, bridgeSessionId, BASE_MS);
      // The historical schema-11 CHECK accepted this row because every date
      // expression evaluated to NULL. The corrected 011 used to create this
      // fixture does not, so bypass only its CHECK to reproduce bytes an
      // already-upgraded database can genuinely contain.
      raw.pragma("ignore_check_constraints = ON");
      raw.prepare("INSERT INTO reconciliation_bridge_events (generation_id, bridge_session_id, sequence, schema, observed_at, observed_at_ms, type, feishu_user_id, display_name, confidence) VALUES (?, ?, 1, 'bridge-session/v1', 'not-a-date', 123, 'participant_joined', 'ou_11', 'Schema Eleven', NULL)")
        .run(generationId, bridgeSessionId);
      raw.pragma("ignore_check_constraints = OFF");
    } finally {
      raw.close();
    }

    const store = h.open();
    try {
      const evidence = store.getReconciliationEvidence(id.occurrenceId, "schema11garbage");
      assert.equal(evidence?.runtimeSessionId, 46n);
      assert.equal(evidence?.captureComplete, false);
      assert.equal(evidence?.incompleteReason, "legacy_evidence_invalid_on_migration");
      assert.deepEqual(evidence?.bridgeEvents, []);
      assert.deepEqual(store.foreignKeyCheck(), []);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("the database atomically marks capture incomplete when direct evidence would exceed its hard bound", () => {
  const h = harness();
  try {
    const id = identity(97);
    const store = h.open();
    store.createSession({ occurrenceId: id.occurrenceId, providerMeetingId: id.providerMeetingId, occurrenceStartedAt: id.occurrenceStartedAt, nowMs: BASE_MS });
    store.beginReconciliationGeneration(id.occurrenceId, "limit_bridge", BASE_MS);
    const raw = new Database(h.dbPath);
    const secondConnection = new Database(h.dbPath);
    try {
      const generation = raw.prepare("SELECT generation_id FROM reconciliation_generations WHERE occurrence_id = ?").get(id.occurrenceId) as { generation_id: string };
      const insert = raw.prepare("INSERT INTO reconciliation_live_segments (generation_id, segment_id, text, started_at, started_at_ms, ended_at, ended_at_ms) VALUES (?, ?, 'wording', '2026-09-02T14:00:00Z', 1788357600000, '2026-09-02T14:00:01Z', 1788357601000)");
      for (let index = 0; index < 255; index += 1) insert.run(generation.generation_id, `segment_${index}`);
      secondConnection.prepare("INSERT INTO reconciliation_live_segments (generation_id, segment_id, text, started_at, started_at_ms, ended_at, ended_at_ms) VALUES (?, 'segment_255', 'wording', '2026-09-02T14:00:00Z', 1788357600000, '2026-09-02T14:00:01Z', 1788357601000)").run(generation.generation_id);
      assert.throws(() => insert.run(generation.generation_id, "segment_overflow"));
      assert.deepEqual(store.getReconciliationEvidence(id.occurrenceId, null)?.incompleteReason, "event_limit_exceeded");
      assert.equal((raw.prepare("SELECT count(*) AS count FROM reconciliation_live_segments WHERE generation_id = ?").get(generation.generation_id) as { count: number }).count, 256);
    } finally { secondConnection.close(); raw.close(); store.close(); }
  } finally { h.cleanup(); }
});

test("a live reconciliation generation is never purge-eligible merely because its creation time is old", () => {
  const h = harness();
  try {
    const id = identity(98);
    const store = h.open();
    store.createSession({ occurrenceId: id.occurrenceId, providerMeetingId: id.providerMeetingId, occurrenceStartedAt: id.occurrenceStartedAt, nowMs: BASE_MS });
    store.beginReconciliationGeneration(id.occurrenceId, "live_bridge", BASE_MS);
    assert.equal(store.purgeExpiredReconciliationEvidence(BASE_MS + 365 * 24 * 60 * 60 * 1000), 0);
    assert.notEqual(store.getReconciliationEvidence(id.occurrenceId, null), null);
    store.close();
  } finally { h.cleanup(); }
});

test("terminalizing an evidence generation is idempotent and cannot move its retention deadline", () => {
  const h = harness();
  try {
    const id = identity(102);
    const store = h.open();
    store.createSession({ occurrenceId: id.occurrenceId, providerMeetingId: id.providerMeetingId, occurrenceStartedAt: id.occurrenceStartedAt, nowMs: BASE_MS });
    store.beginReconciliationGeneration(id.occurrenceId, "idempotent_bridge", BASE_MS);
    store.completeReconciliationGeneration(id.occurrenceId, "idempotent_bridge", BASE_MS, "local_clock");
    store.completeReconciliationGeneration(id.occurrenceId, "idempotent_bridge", BASE_MS + 1, "local_clock");
    const evidence = store.getReconciliationEvidence(id.occurrenceId, null);
    assert.equal(evidence?.terminalAtMs, BASE_MS);
    assert.equal(evidence?.terminalSource, "local_clock");
    assert.equal(evidence?.expiresAtMs, BASE_MS + 14 * 24 * 60 * 60 * 1000);
    store.close();
  } finally { h.cleanup(); }
});

test("occurrences may reuse a bridge-session identifier without mixing their generations after reopen", () => {
  const h = harness();
  try {
    const firstId = identity(99);
    const secondId = identity(100);
    const first = h.open();
    first.createSession({ occurrenceId: firstId.occurrenceId, providerMeetingId: firstId.providerMeetingId, occurrenceStartedAt: firstId.occurrenceStartedAt, nowMs: BASE_MS });
    first.createSession({ occurrenceId: secondId.occurrenceId, providerMeetingId: secondId.providerMeetingId, occurrenceStartedAt: secondId.occurrenceStartedAt, nowMs: BASE_MS });
    first.beginReconciliationGeneration(firstId.occurrenceId, "reused_bridge", BASE_MS);
    first.beginReconciliationGeneration(secondId.occurrenceId, "reused_bridge", BASE_MS);
    first.appendReconciliationLiveSegment(firstId.occurrenceId, { bridgeSessionId: "reused_bridge", segmentId: "same_segment", text: "first wording", startedAt: "2026-09-02T14:00:00Z", endedAt: "2026-09-02T14:00:01Z" });
    first.appendReconciliationLiveSegment(secondId.occurrenceId, { bridgeSessionId: "reused_bridge", segmentId: "same_segment", text: "second wording", startedAt: "2026-09-02T14:00:00Z", endedAt: "2026-09-02T14:00:01Z" });
    first.close();
    const second = h.open();
    try {
      assert.deepEqual(second.getReconciliationEvidence(firstId.occurrenceId, null)?.liveSegments.map((segment) => segment.text), ["first wording"]);
      assert.deepEqual(second.getReconciliationEvidence(secondId.occurrenceId, null)?.liveSegments.map((segment) => segment.text), ["second wording"]);
    } finally { second.close(); }
  } finally { h.cleanup(); }
});

test("migration 004 represents pre-runtime recording metadata as unavailable, never fabricated", () => {
  const h = harness();
  try {
    const id = identity(91);
    const raw = new Database(h.dbPath);
    try {
      const migrationsDir = path.resolve(import.meta.dirname, "..", "migrations");
      raw.exec(readFileSync(path.join(migrationsDir, "001_orchestration.sql"), "utf8"));
      raw.exec(readFileSync(path.join(migrationsDir, "002_recordings.sql"), "utf8"));
      raw.prepare("INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)").run(1, "001_orchestration.sql", BASE_MS);
      raw.prepare("INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)").run(2, "002_recordings.sql", BASE_MS);
      raw.prepare(`INSERT INTO sessions (occurrence_id, occurrence_segment, provider_meeting_id, occurrence_started_at, state, terminal_reason, created_at_ms, updated_at_ms)
                   VALUES (?, ?, ?, ?, 'finalizing', NULL, ?, ?)`)
        .run(id.occurrenceId, occurrencePathSegment(id.occurrenceId), id.providerMeetingId, id.occurrenceStartedAt, BASE_MS, BASE_MS);
      raw.prepare("INSERT INTO recordings (occurrence_id, handle, sha256, duration_ms, finalized_at_ms) VALUES (?, ?, ?, ?, ?)")
        .run(id.occurrenceId, "legacyrecording1", "0".repeat(64), 1, BASE_MS);
    } finally { raw.close(); }
    const store = h.open();
    try {
      assert.equal(store.schemaVersion, 17);
      const legacy = store.getRecording(id.occurrenceId);
      assert.equal(legacy?.encryptedPath, null);
      assert.equal(legacy?.format, null);
      assert.equal(legacy?.keyId, null);
      assert.deepEqual(store.foreignKeyCheck(), []);
    } finally { store.close(); }
  } finally { h.cleanup(); }
});

test("the control tables exclude transcript/audio; local-only reconciliation wording is isolated", () => {
  const h = harness();
  try {
    const store = h.open();
    try {
      const schema = store.describeSchema();
      assert.ok(schema.length >= 4, "expected the orchestration schema to define its tables");

      for (const table of schema) {
        assert.match(table.sql, /\bSTRICT\b/, `table ${table.name} must be STRICT`);
        for (const column of table.columns) {
          assert.notEqual(column.type.toUpperCase(), "BLOB", `${table.name}.${column.name} must not be BLOB`);
          assert.notEqual(column.type.toUpperCase(), "ANY", `${table.name}.${column.name} must not be ANY`);
          assert.ok(
            ["TEXT", "INTEGER", "INT"].includes(column.type.toUpperCase()),
            `${table.name}.${column.name} has unexpected declared type ${column.type}`,
          );
        }
      }

      // Every control-table free-text column is bounded and token-formatted.
      // Task 7's one exception is the explicit local reconciliation ledger;
      // it is never a Team Vault/output table and holds no audio bytes.
      const liveLedger = schema.find((table) => table.name === "reconciliation_live_segments");
      assert.ok(liveLedger !== undefined);
      assert.deepEqual(liveLedger.columns.map((column) => column.name), ["generation_id", "segment_id", "text", "started_at", "started_at_ms", "ended_at", "ended_at_ms"]);
      for (const table of schema.filter((candidate) => !candidate.name.startsWith("reconciliation_") && candidate.name !== "delivery_journal")) {
        assert.ok(!table.columns.some((column) => /transcript|text|audio/i.test(column.name)), `control table ${table.name} must not carry prose`);
      }
      const id = identity(1);
      store.createSession({
        occurrenceId: id.occurrenceId,
        providerMeetingId: id.providerMeetingId,
        occurrenceStartedAt: id.occurrenceStartedAt,
        nowMs: BASE_MS,
      });
      assert.throws(
        () =>
          store.transition({
            occurrenceId: id.occurrenceId,
            fromState: "discovered",
            toState: "joining",
            reason: "the quick brown fox jumped over the lazy dog ".repeat(50),
            terminalReason: null,
            nowMs: BASE_MS + 1,
          }),
        isOrchestrationError("constraint_violation"),
      );
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

// NOTE on the two tests below: the first proves the STORE's own existence
// check (acquireLease looks up the session before ever preparing an INSERT)
// -- it never reaches the schema's FOREIGN KEY constraint at all, and would
// stay green even if every `REFERENCES sessions(occurrence_id)` clause were
// deleted from migrations/001_orchestration.sql. The second is the actual
// FK-enforcement proof: it opens a second, low-level connection to the same
// file and inserts an orphan row directly, bypassing the store's API
// entirely, so only the schema itself can catch it.

test("acquireLease's own existence check rejects an unknown occurrence before any write is attempted", () => {
  const h = harness();
  try {
    const store = h.open();
    try {
      assert.throws(
        () =>
          store.acquireLease({
            occurrenceId: identity(42).occurrenceId,
            bridgeId: "fake-bridge-a",
            bridgeSessionId: "fake-bridge-session-a",
            nowMs: BASE_MS,
            ttlMs: LEASE_TTL_MS,
          }),
        isOrchestrationError("unknown_session"),
      );
      assert.deepEqual(store.foreignKeyCheck(), []);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("the FOREIGN KEY constraints are actually enforced by SQLite -- an orphan row inserted directly, bypassing the store, is rejected", () => {
  const h = harness();
  try {
    const store = h.open(); // applies the migration
    store.close();

    // A second, independent connection to the same file -- never goes
    // through src/adapters/sqlite-session-store.ts's own checks at all.
    const raw = new Database(h.dbPath);
    raw.pragma("foreign_keys = ON");
    try {
      const isForeignKeyViolation = (error: unknown): boolean =>
        error instanceof Database.SqliteError && error.code === "SQLITE_CONSTRAINT_FOREIGNKEY";

      // Every other column is filled with a schema-valid value on purpose,
      // so the ONLY thing that can fail is the FK -- proving specifically
      // that constraint fires, not some other CHECK.
      assert.throws(
        () =>
          raw
            .prepare(
              `INSERT INTO transitions (occurrence_id, from_state, to_state, reason, terminal_reason, occurred_at_ms)
               VALUES ('does-not-exist', NULL, 'discovered', NULL, NULL, 1)`,
            )
            .run(),
        isForeignKeyViolation,
        "an orphan transitions row must be rejected by the FOREIGN KEY constraint",
      );

      assert.throws(
        () =>
          raw
            .prepare(
              `INSERT INTO bridge_leases
                 (lease_id, occurrence_id, bridge_id, bridge_session_id, acquired_at_ms, expires_at_ms)
               VALUES ('orphan-lease', 'does-not-exist', 'fake-bridge', 'fake-bridge-session', 1, 2)`,
            )
            .run(),
        isForeignKeyViolation,
        "an orphan bridge_leases row must be rejected by the FOREIGN KEY constraint",
      );

      assert.throws(
        () => raw.prepare(
          `INSERT INTO reconciliation_generations
             (generation_id, occurrence_id, bridge_session_id, created_at_ms)
           VALUES ('orphan-generation', 'does-not-exist', 'bridge-orphan', 1)`,
        ).run(),
        isForeignKeyViolation,
        "an orphan reconciliation ledger must be rejected by the FOREIGN KEY constraint",
      );
    } finally {
      raw.close();
    }
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

test("the happy path runs discovered -> ... -> notified with a complete audit trail", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      const id = identity(1);
      const created = coordinator.discover(id);
      assert.equal(created.state, "discovered");
      assert.equal(created.occurrenceSegment, occurrencePathSegment(id.occurrenceId));

      for (const next of HAPPY_PATH_STATES) {
        clock.advance(1_000);
        const row = coordinator.advance(id.occurrenceId, next);
        assert.equal(row.state, next);
        assert.equal(row.updatedAtMs, clock.now());
      }

      assert.equal(coordinator.get(id.occurrenceId)?.state, "notified");

      const history = coordinator.history(id.occurrenceId);
      assert.deepEqual(
        history.map((t) => [t.fromState, t.toState]),
        [
          [null, "discovered"],
          ["discovered", "joining"],
          ["joining", "listening"],
          ["listening", "finalizing"],
          ["finalizing", "awaiting_teammem"],
          ["awaiting_teammem", "published"],
          ["published", "notified"],
        ],
      );
      for (let i = 1; i < history.length; i += 1) {
        assert.ok(history[i]!.id > history[i - 1]!.id);
        assert.ok(history[i]!.occurredAtMs >= history[i - 1]!.occurredAtMs);
      }
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("a process that dies at ANY state boundary resumes from the persisted row", () => {
  for (let boundary = 0; boundary <= HAPPY_PATH_STATES.length; boundary += 1) {
    const h = harness();
    try {
      const id = identity(1);
      const clock = fakeClock();

      const before = h.open();
      const first = coordinatorFor(before, clock);
      first.discover(id);
      for (const next of HAPPY_PATH_STATES.slice(0, boundary)) {
        clock.advance(1_000);
        first.advance(id.occurrenceId, next);
      }
      const expectedState: SessionState = boundary === 0 ? "discovered" : HAPPY_PATH_STATES[boundary - 1]!;
      before.close();

      // A brand new process, a brand new coordinator, the same file.
      const after = h.open();
      const resumed = coordinatorFor(after, clock);
      try {
        const row = resumed.get(id.occurrenceId);
        assert.equal(row?.state, expectedState, `restart after ${boundary} transitions must resume in ${expectedState}`);

        for (const next of HAPPY_PATH_STATES.slice(boundary)) {
          clock.advance(1_000);
          resumed.advance(id.occurrenceId, next);
        }
        assert.equal(resumed.get(id.occurrenceId)?.state, "notified");
        assert.equal(
          resumed.history(id.occurrenceId).length,
          HAPPY_PATH_STATES.length + 1,
          "the audit trail must survive the restart intact",
        );
      } finally {
        after.close();
      }
    } finally {
      h.cleanup();
    }
  }
});

test("every edge declared legal is actually accepted by the coordinator", () => {
  let exercised = 0;
  for (const from of SESSION_STATES) {
    for (const to of ALLOWED_TRANSITIONS[from]) {
      const h = harness();
      try {
        const store = h.open();
        const coordinator = coordinatorFor(store, fakeClock());
        try {
          const id = identity(1);
          coordinator.discover(id);
          driveTo(coordinator, id.occurrenceId, from);
          if (from !== "discovered") {
            assert.equal(coordinator.get(id.occurrenceId)?.state, from);
          }

          const row = to === "failed" ? coordinator.fail(id.occurrenceId, "bridge_failure") : coordinator.advance(id.occurrenceId, to);
          assert.equal(row.state, to);
          exercised += 1;
        } finally {
          store.close();
        }
      } finally {
        h.cleanup();
      }
    }
  }
  assert.ok(exercised >= 12, `expected the state machine to declare real edges, got ${exercised}`);
});

test("every (from, to) pair NOT declared in ALLOWED_TRANSITIONS is rejected, leaving state and audit trail untouched", () => {
  // Exhaustive, not hand-picked: every one of the 8x8 = 64 (from, to) pairs
  // is exercised, skipping only the ~12 pairs the "every edge declared
  // legal" test above already proves are ACCEPTED. This also fully covers
  // TERMINAL_STATES behaviorally (every "to" is illegal from a terminal
  // "from", since ALLOWED_TRANSITIONS[terminal] is empty) and every
  // self-transition (e.g. "listening" -> "listening"), neither of which the
  // previous hand-picked 12-pair list happened to include.
  let exercised = 0;
  for (const from of SESSION_STATES) {
    for (const to of SESSION_STATES) {
      if (ALLOWED_TRANSITIONS[from].includes(to)) continue; // legal edge, covered elsewhere

      const h = harness();
      try {
        const store = h.open();
        const coordinator = coordinatorFor(store, fakeClock());
        try {
          const id = identity(1);
          coordinator.discover(id);
          if (from === "failed") {
            coordinator.fail(id.occurrenceId, "bridge_failure");
          } else {
            driveTo(coordinator, id.occurrenceId, from);
          }
          const before = snapshot(store, id.occurrenceId);

          assert.throws(
            () => (to === "failed" ? coordinator.fail(id.occurrenceId, "bridge_failure") : coordinator.advance(id.occurrenceId, to)),
            isOrchestrationError("illegal_transition"),
            `${from} -> ${to} must be rejected`,
          );

          assert.deepEqual(snapshot(store, id.occurrenceId), before, `${from} -> ${to} must leave every row untouched`);
          exercised += 1;
        } finally {
          store.close();
        }
      } finally {
        h.cleanup();
      }
    }
  }
  // 64 total pairs minus the ~12 legal edges (exact count depends on
  // ALLOWED_TRANSITIONS' own shape, asserted elsewhere) leaves roughly 52
  // illegal pairs; this is a sanity floor, not a hand-picked list.
  assert.ok(exercised >= 50, `expected roughly 52 illegal pairs to be exercised, got ${exercised}`);
});

test("TERMINAL_STATES agrees with ALLOWED_TRANSITIONS: both declare notified/failed as dead ends", () => {
  // A fast, narrow data-consistency check between the module's own two
  // constants. The actual RUNTIME behavior for every terminal-state
  // transition attempt (not just a shape assertion over the constant) is
  // proven by the exhaustive pairwise test above, which exercises every
  // illegal (from, to) pair including every terminal "from".
  for (const terminal of TERMINAL_STATES) {
    assert.deepEqual(ALLOWED_TRANSITIONS[terminal], [], `${terminal} must be terminal in the declared table`);
  }
});

test("a stale expected-from state is rejected by compare-and-swap, so a resumed process cannot replay", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      const id = identity(1);
      coordinator.discover(id);
      coordinator.advance(id.occurrenceId, "joining");

      // A process resumed from a stale in-memory view still believes the
      // row says "discovered". The store must refuse rather than clobber.
      assert.throws(
        () =>
          store.transition({
            occurrenceId: id.occurrenceId,
            fromState: "discovered",
            toState: "joining",
            reason: "advance",
            terminalReason: null,
            nowMs: clock.now(),
          }),
        isOrchestrationError("state_conflict"),
      );
      assert.equal(store.getSession(id.occurrenceId)?.state, "joining");
      assert.equal(store.listTransitions(id.occurrenceId).length, 2);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("failing carries a terminal reason and can happen from any non-terminal state", () => {
  for (const from of SESSION_STATES) {
    if (TERMINAL_STATES.includes(from)) continue;
    const h = harness();
    try {
      const store = h.open();
      const coordinator = coordinatorFor(store, fakeClock());
      try {
        const id = identity(1);
        coordinator.discover(id);
        driveTo(coordinator, id.occurrenceId, from);
        const row = coordinator.fail(id.occurrenceId, "organizer_unresolved");
        assert.equal(row.state, "failed");
        assert.equal(row.terminalReason, "organizer_unresolved");
      } finally {
        store.close();
      }
    } finally {
      h.cleanup();
    }
  }
});

test("an unknown occurrence is never silently created by a transition", () => {
  const h = harness();
  try {
    const store = h.open();
    const coordinator = coordinatorFor(store, fakeClock());
    try {
      assert.throws(() => coordinator.advance(identity(99).occurrenceId, "joining"), isOrchestrationError("unknown_session"));
      assert.equal(coordinator.get(identity(99).occurrenceId), null);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("discovering the same occurrence twice is rejected rather than duplicating state", () => {
  const h = harness();
  try {
    const store = h.open();
    const coordinator = coordinatorFor(store, fakeClock());
    try {
      const id = identity(1);
      coordinator.discover(id);
      assert.throws(() => coordinator.discover(id), isOrchestrationError("duplicate_session"));
      assert.equal(coordinator.history(id.occurrenceId).length, 1);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

test("a transition and its audit record commit as one unit: a mid-transition failure leaves nothing", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      const id = identity(1);
      coordinator.discover(id);
      const before = snapshot(store, id.occurrenceId);

      // The state UPDATE is valid and would run first; the audit INSERT
      // then violates the reason CHECK. If the two were not one
      // transaction, the session row would already read "joining" with no
      // audit record for it.
      assert.throws(
        () =>
          store.transition({
            occurrenceId: id.occurrenceId,
            fromState: "discovered",
            toState: "joining",
            reason: "NOT A VALID REASON TOKEN",
            terminalReason: null,
            nowMs: clock.now() + 5,
          }),
        isOrchestrationError("constraint_violation"),
      );

      assert.deepEqual(snapshot(store, id.occurrenceId), before);
      assert.equal(store.getSession(id.occurrenceId)?.state, "discovered");
      assert.equal(store.listTransitions(id.occurrenceId).length, 1);

      // The connection is still usable afterwards: the rollback did not
      // wedge it.
      assert.equal(coordinator.advance(id.occurrenceId, "joining").state, "joining");
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("a rolled-back transition is invisible after a restart", () => {
  const h = harness();
  try {
    const id = identity(1);
    const first = h.open();
    const coordinator = coordinatorFor(first, fakeClock());
    coordinator.discover(id);
    assert.throws(
      () =>
        first.transition({
          occurrenceId: id.occurrenceId,
          fromState: "discovered",
          toState: "joining",
          reason: "INVALID",
          terminalReason: null,
          nowMs: BASE_MS + 5,
        }),
      isOrchestrationError("constraint_violation"),
    );
    first.close();

    const second = h.open();
    try {
      assert.equal(second.getSession(id.occurrenceId)?.state, "discovered");
      assert.equal(second.listTransitions(id.occurrenceId).length, 1);
    } finally {
      second.close();
    }
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Bridge leases
// ---------------------------------------------------------------------------

test("a bridge lease is unique per occurrence while it is live", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      const id = identity(1);
      coordinator.discover(id);

      const lease = coordinator.acquireBridgeLease(id.occurrenceId, {
        bridgeId: "fake-bridge-a",
        bridgeSessionId: "fake-bridge-session-1",
      });
      assert.equal(lease.expiresAtMs, clock.now() + LEASE_TTL_MS);
      assert.equal(lease.releasedAtMs, null);
      assert.deepEqual(coordinator.activeBridgeLease(id.occurrenceId), withExpiry(lease, false));

      clock.advance(LEASE_TTL_MS - 1);
      assert.throws(
        () =>
          coordinator.acquireBridgeLease(id.occurrenceId, {
            bridgeId: "fake-bridge-b",
            bridgeSessionId: "fake-bridge-session-2",
          }),
        isOrchestrationError("lease_held"),
      );
      // Not yet expired (one ms of TTL remains): still reported live.
      assert.deepEqual(coordinator.activeBridgeLease(id.occurrenceId), withExpiry(lease, false));
      assert.equal(store.listLeases(id.occurrenceId).length, 1);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("one physical bridge cannot hold leases for two occurrences, while different bridges can", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      const first = identity(1);
      const second = identity(2);
      const third = identity(3);
      coordinator.discover(first);
      coordinator.discover(second);
      coordinator.discover(third);

      coordinator.acquireBridgeLease(first.occurrenceId, {
        bridgeId: "fake-bridge-shared",
        bridgeSessionId: "bridge-session-first",
      });
      assert.throws(
        () =>
          coordinator.acquireBridgeLease(second.occurrenceId, {
            bridgeId: "fake-bridge-shared",
            bridgeSessionId: "bridge-session-second",
          }),
        isOrchestrationError("lease_held"),
      );
      assert.doesNotThrow(() =>
        coordinator.acquireBridgeLease(third.occurrenceId, {
          bridgeId: "fake-bridge-other",
          bridgeSessionId: "bridge-session-third",
        }),
      );
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("a stale lease is recoverable once its bounded timeout has passed, using an injected clock", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      const id = identity(1);
      coordinator.discover(id);
      const abandoned = coordinator.acquireBridgeLease(id.occurrenceId, {
        bridgeId: "fake-bridge-a",
        bridgeSessionId: "fake-bridge-session-1",
      });

      // Exactly at the timeout the lease is expired, not held. No sleeping.
      clock.advance(LEASE_TTL_MS);
      const recovered = coordinator.acquireBridgeLease(id.occurrenceId, {
        bridgeId: "fake-bridge-b",
        bridgeSessionId: "fake-bridge-session-2",
      });

      assert.notEqual(recovered.leaseId, abandoned.leaseId);
      assert.equal(recovered.bridgeId, "fake-bridge-b");
      assert.deepEqual(coordinator.activeBridgeLease(id.occurrenceId), withExpiry(recovered, false));

      const all = store.listLeases(id.occurrenceId);
      assert.equal(all.length, 2);
      const old = all.find((l) => l.leaseId === abandoned.leaseId)!;
      assert.equal(old.releasedAtMs, clock.now());
      assert.equal(old.releaseReason, "stale_recovered");
      assert.equal(all.filter((l) => l.releasedAtMs === null).length, 1);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("a `left` event ends the lease; resuming takes a NEW lease for a NEW bridge session", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      const id = identity(1);
      coordinator.discover(id);
      const first = coordinator.acquireBridgeLease(id.occurrenceId, {
        bridgeId: "fake-bridge-a",
        bridgeSessionId: "fake-bridge-session-1",
      });

      // bridge-session/v1 has no re-open: after `left` that bridge session
      // is over, so the lease is released rather than reused.
      clock.advance(500);
      const released = coordinator.releaseBridgeLease(id.occurrenceId, first.leaseId, "left");
      assert.equal(released.releasedAtMs, clock.now());
      assert.equal(released.releaseReason, "left");
      assert.equal(coordinator.activeBridgeLease(id.occurrenceId), null);

      // Resuming does not un-leave the old bridge session; it takes a new one.
      clock.advance(500);
      const second = coordinator.acquireBridgeLease(id.occurrenceId, {
        bridgeId: "fake-bridge-a",
        bridgeSessionId: "fake-bridge-session-2",
      });
      assert.notEqual(second.leaseId, first.leaseId);
      assert.notEqual(second.bridgeSessionId, first.bridgeSessionId);
      assert.equal(second.releasedAtMs, null);
      assert.equal(store.listLeases(id.occurrenceId).length, 2);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("a bridge_failure release is terminal for that lease exactly like `left`", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      const id = identity(1);
      coordinator.discover(id);
      const lease = coordinator.acquireBridgeLease(id.occurrenceId, {
        bridgeId: "fake-bridge-a",
        bridgeSessionId: "fake-bridge-session-1",
      });
      coordinator.releaseBridgeLease(id.occurrenceId, lease.leaseId, "bridge_failure");

      assert.equal(coordinator.activeBridgeLease(id.occurrenceId), null);
      assert.throws(() => coordinator.releaseBridgeLease(id.occurrenceId, lease.leaseId, "left"), isOrchestrationError("unknown_lease"));
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("bridge failure recovery is durable, bounded, and keeps the occurrence reusable until exhaustion", () => {
  const h = harness();
  try {
    const first = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(first, clock);
    const id = identity(73);
    coordinator.discover(id);
    coordinator.advance(id.occurrenceId, "joining");
    coordinator.advance(id.occurrenceId, "listening");
    const invalidHistory = coordinator.history(id.occurrenceId);
    assert.throws(
      () => coordinator.recordBridgeFailure(id.occurrenceId, 0, [], {
        handle: "invalid handle",
        encryptedPath: "/enc/invalid",
        sha256: "b".repeat(64),
        durationMs: 1,
        format: "ogg/opus",
        keyId: "key",
        gaps: [],
        runtimeGaps: [],
      }),
      isOrchestrationError("constraint_violation"),
    );
    assert.equal(coordinator.get(id.occurrenceId)?.state, "listening");
    assert.deepEqual(coordinator.history(id.occurrenceId), invalidHistory);
    assert.equal(coordinator.bridgeFailureRecording(id.occurrenceId, 1), null);

    const firstFailure = coordinator.recordBridgeFailure(id.occurrenceId, 0, [
      { direction: "capture", startedAt: "2026-09-02T14:00:00Z", endedAt: "2026-09-02T14:00:01Z" },
    ], {
      handle: "failed1",
      encryptedPath: "/enc/failed1",
      sha256: "a".repeat(64),
      durationMs: 1,
      format: "ogg/opus",
      keyId: "key",
      gaps: [],
      runtimeGaps: [{
        startedAtMs: 9_007_199_254_740_993n,
        endedAtMs: null,
        reason: "capture_gap",
      }],
    });
    assert.deepEqual(firstFailure, { attempt: 1, retryAllowed: false });
    first.close();

    const resumed = h.open();
    try {
      const resumedCoordinator = coordinatorFor(resumed, clock);
      assert.equal(resumedCoordinator.get(id.occurrenceId)?.state, "failed");
      assert.equal(resumedCoordinator.get(id.occurrenceId)?.terminalReason, "bridge_failure_exhausted");
      assert.deepEqual(
        resumedCoordinator.history(id.occurrenceId).at(-1),
        {
          id: resumedCoordinator.history(id.occurrenceId).at(-1)?.id,
          occurrenceId: id.occurrenceId,
          fromState: "listening",
          toState: "failed",
          reason: "fail",
          terminalReason: "bridge_failure_exhausted",
          occurredAtMs: clock.now(),
        },
      );
      assert.deepEqual(resumedCoordinator.bridgeFailureRecording(id.occurrenceId, 1), {
        occurrenceId: id.occurrenceId, attempt: 1, handle: "failed1", encryptedPath: "/enc/failed1", sha256: "a".repeat(64), durationMs: 1, format: "ogg/opus", keyId: "key", finalizedAtMs: clock.now(),
        gaps: [{ ordinal: 0, direction: "capture", startedAt: "2026-09-02T14:00:00Z", endedAt: "2026-09-02T14:00:01Z" }],
        runtimeGaps: [{ ordinal: 0, startedAtMs: 9_007_199_254_740_993n, endedAtMs: null, reason: "capture_gap" }],
      });
    } finally {
      resumed.close();
    }
  } finally {
    h.cleanup();
  }
});

test("runtime recording-gap child rows enforce foreign keys and cascade with both recording parents", () => {
  const h = harness();
  try {
    const store = h.open();
    const coordinator = coordinatorFor(store, fakeClock());
    const normal = identity(74);
    const failed = identity(75);
    coordinator.discover(normal);
    coordinator.advance(normal.occurrenceId, "joining");
    coordinator.advance(normal.occurrenceId, "listening");
    coordinator.finalizeWithRecording(normal.occurrenceId, { kind: "advance", toState: "finalizing" }, {
      handle: "normal1",
      encryptedPath: "/enc/normal1",
      sha256: "c".repeat(64),
      durationMs: 1,
      format: "ogg/opus",
      keyId: "key",
      gaps: [],
      runtimeGaps: [{ startedAtMs: 1n, endedAtMs: 2n, reason: "normal_gap" }],
    });
    coordinator.discover(failed);
    coordinator.advance(failed.occurrenceId, "joining");
    coordinator.advance(failed.occurrenceId, "listening");
    coordinator.recordBridgeFailure(failed.occurrenceId, 1, [], {
      handle: "failed2",
      encryptedPath: "/enc/failed2",
      sha256: "d".repeat(64),
      durationMs: 1,
      format: "ogg/opus",
      keyId: "key",
      gaps: [],
      runtimeGaps: [{ startedAtMs: 3n, endedAtMs: null, reason: "failed_gap" }],
    });
    store.close();

    const raw = new Database(h.dbPath);
    raw.pragma("foreign_keys = ON");
    try {
      const fkViolation = (error: unknown): boolean =>
        error instanceof Database.SqliteError && error.code === "SQLITE_CONSTRAINT_FOREIGNKEY";
      assert.throws(
        () => raw.prepare(
          `INSERT INTO recording_runtime_gaps
             (occurrence_id, ordinal, started_at_ms, ended_at_ms, reason)
           VALUES ('missing', 0, '1', NULL, 'orphan')`,
        ).run(),
        fkViolation,
      );
      assert.throws(
        () => raw.prepare(
          `INSERT INTO bridge_failure_recording_runtime_gaps
             (occurrence_id, attempt, ordinal, started_at_ms, ended_at_ms, reason)
           VALUES ('missing', 1, 0, '1', NULL, 'orphan')`,
        ).run(),
        fkViolation,
      );

      raw.prepare("DELETE FROM recordings WHERE occurrence_id = ?").run(normal.occurrenceId);
      raw.prepare(
        "DELETE FROM bridge_failure_recordings WHERE occurrence_id = ? AND attempt = 1",
      ).run(failed.occurrenceId);
      assert.equal(
        (raw.prepare("SELECT count(*) AS count FROM recording_runtime_gaps").get() as { count: number }).count,
        0,
      );
      assert.equal(
        (raw.prepare("SELECT count(*) AS count FROM bridge_failure_recording_runtime_gaps").get() as { count: number }).count,
        0,
      );
      assert.deepEqual(raw.pragma("foreign_key_check"), []);
    } finally {
      raw.close();
    }
  } finally {
    h.cleanup();
  }
});

test("leases survive a restart: an unexpired lease is still held, an expired one is still recoverable", () => {
  const h = harness();
  try {
    const id = identity(1);
    const clock = fakeClock();

    const before = h.open();
    const firstCoordinator = coordinatorFor(before, clock);
    firstCoordinator.discover(id);
    const lease = firstCoordinator.acquireBridgeLease(id.occurrenceId, {
      bridgeId: "fake-bridge-a",
      bridgeSessionId: "fake-bridge-session-1",
    });
    before.close();

    const after = h.open();
    const resumed = coordinatorFor(after, clock);
    try {
      assert.deepEqual(resumed.activeBridgeLease(id.occurrenceId), withExpiry(lease, false));
      assert.throws(
        () =>
          resumed.acquireBridgeLease(id.occurrenceId, {
            bridgeId: "fake-bridge-b",
            bridgeSessionId: "fake-bridge-session-2",
          }),
        isOrchestrationError("lease_held"),
      );

      clock.advance(LEASE_TTL_MS);
      const recovered = resumed.acquireBridgeLease(id.occurrenceId, {
        bridgeId: "fake-bridge-b",
        bridgeSessionId: "fake-bridge-session-2",
      });
      assert.notEqual(recovered.leaseId, lease.leaseId);
    } finally {
      after.close();
    }
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

test("occurrence A's entire lifecycle never reads or mutates occurrence B's rows", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      const a = identity(1);
      const b = identity(2);
      coordinator.discover(a);
      coordinator.discover(b);

      // B is parked mid-flight with a live lease, so it has rows in all
      // three tables that a leaky implementation could plausibly disturb.
      coordinator.advance(b.occurrenceId, "joining");
      const bLease = coordinator.acquireBridgeLease(b.occurrenceId, {
        bridgeId: "fake-bridge-b",
        bridgeSessionId: "fake-bridge-session-b1",
      });
      const bBefore = snapshot(store, b.occurrenceId);
      const aBefore = snapshot(store, a.occurrenceId);

      // A now does everything it can do: the full happy path, two lease
      // generations (one released after `left`, one recovered from
      // staleness), and one transition that fails and rolls back.
      const aLease1 = coordinator.acquireBridgeLease(a.occurrenceId, {
        bridgeId: "fake-bridge-a",
        bridgeSessionId: "fake-bridge-session-a1",
      });
      coordinator.releaseBridgeLease(a.occurrenceId, aLease1.leaseId, "left");
      coordinator.acquireBridgeLease(a.occurrenceId, {
        bridgeId: "fake-bridge-a",
        bridgeSessionId: "fake-bridge-session-a2",
      });
      clock.advance(LEASE_TTL_MS);
      coordinator.acquireBridgeLease(a.occurrenceId, {
        bridgeId: "fake-bridge-a",
        bridgeSessionId: "fake-bridge-session-a3",
      });
      for (const next of HAPPY_PATH_STATES) {
        clock.advance(10);
        coordinator.advance(a.occurrenceId, next);
      }
      assert.throws(
        () =>
          store.transition({
            occurrenceId: a.occurrenceId,
            fromState: "notified",
            toState: "published",
            reason: "INVALID",
            terminalReason: null,
            nowMs: clock.now(),
          }),
        (error: unknown) => error instanceof OrchestrationError,
      );

      // A moved. B did not, row for row.
      assert.notDeepEqual(snapshot(store, a.occurrenceId), aBefore);
      assert.deepEqual(snapshot(store, b.occurrenceId), bBefore, "occurrence B's rows must be byte-identical after all of A's activity");

      // B's ROW is untouched (isolation) -- but the shared clock genuinely
      // has advanced past B's lease TTL while servicing all of A's activity,
      // and activeBridgeLease() computes isExpired live against that clock
      // rather than reading a stored value, so it correctly now reports
      // isExpired: true. No cross-occurrence sweep exists: nothing released
      // or mutated B's lease ROW -- store.listLeases(b.occurrenceId) below
      // still shows the same single, unreleased row it always did.
      assert.deepEqual(coordinator.activeBridgeLease(b.occurrenceId), withExpiry(bLease, true));
      assert.deepEqual(store.listLeases(b.occurrenceId), bBefore.leases);

      // A's lease token is meaningless against B, and vice versa.
      const aActive = coordinator.activeBridgeLease(a.occurrenceId)!;
      assert.throws(() => coordinator.releaseBridgeLease(b.occurrenceId, aActive.leaseId, "left"), isOrchestrationError("unknown_lease"));
      assert.throws(() => coordinator.releaseBridgeLease(a.occurrenceId, bLease.leaseId, "left"), isOrchestrationError("unknown_lease"));
      assert.deepEqual(snapshot(store, b.occurrenceId), bBefore);

      // And B can still be driven forward independently afterwards.
      assert.equal(coordinator.advance(b.occurrenceId, "listening").state, "listening");
      assert.equal(coordinator.get(a.occurrenceId)?.state, "notified");
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("two occurrences of the same recurring meeting never share state", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      // Same provider meeting id; different occurrence starts -- the
      // recurring-meeting case the occurrence key exists for.
      const week1 = buildMeetingIdentity({
        providerMeetingId: "fake-recurring-standup",
        meetingNo: "000000000",
        occurrenceStartedAt: "2026-09-02T09:00:00Z",
        title: "Fake Recurring Standup",
        organizer: null,
      });
      const week2 = buildMeetingIdentity({
        providerMeetingId: "fake-recurring-standup",
        meetingNo: "000000000",
        occurrenceStartedAt: "2026-09-09T09:00:00Z",
        title: "Fake Recurring Standup",
        organizer: null,
      });
      assert.notEqual(week1.occurrenceId, week2.occurrenceId);

      coordinator.discover(week1);
      coordinator.discover(week2);
      assert.notEqual(
        store.getSession(week1.occurrenceId)?.occurrenceSegment,
        store.getSession(week2.occurrenceId)?.occurrenceSegment,
      );

      const week2Before = snapshot(store, week2.occurrenceId);
      for (const next of HAPPY_PATH_STATES) {
        coordinator.advance(week1.occurrenceId, next);
      }
      coordinator.acquireBridgeLease(week1.occurrenceId, {
        bridgeId: "fake-bridge-a",
        bridgeSessionId: "fake-bridge-session-w1",
      });

      assert.equal(coordinator.get(week2.occurrenceId)?.state, "discovered");
      assert.deepEqual(snapshot(store, week2.occurrenceId), week2Before);
      assert.equal(coordinator.activeBridgeLease(week2.occurrenceId), null);

      // Both may hold their own bridge lease at the same time.
      coordinator.acquireBridgeLease(week2.occurrenceId, {
        bridgeId: "fake-bridge-b",
        bridgeSessionId: "fake-bridge-session-w2",
      });
      assert.notEqual(
        coordinator.activeBridgeLease(week1.occurrenceId)?.leaseId,
        coordinator.activeBridgeLease(week2.occurrenceId)?.leaseId,
      );
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Concurrency semaphore
// ---------------------------------------------------------------------------

const CONCURRENT_OCCURRENCES = 20;

async function runConcurrent(limit: number): Promise<{ peak: number; store: SessionStore; h: Harness }> {
  const h = harness();
  const store = h.open();
  const clock = fakeClock();
  const coordinator = coordinatorFor(store, clock, limit);

  const ids = Array.from({ length: CONCURRENT_OCCURRENCES }, (_, i) => identity(i + 1));
  for (const id of ids) coordinator.discover(id);

  const gate = deferred();
  let peak = 0;
  const tasks = ids.map((id) =>
    coordinator.withSession(id.occurrenceId, async () => {
      peak = Math.max(peak, coordinator.activeSessionCount());
      await gate.promise;
      const lease = coordinator.acquireBridgeLease(id.occurrenceId, {
        bridgeId: `fake-bridge-${id.providerMeetingId}`,
        bridgeSessionId: `fake-bridge-session-${id.providerMeetingId}`,
      });
      for (const next of HAPPY_PATH_STATES) {
        coordinator.advance(id.occurrenceId, next);
      }
      coordinator.releaseBridgeLease(id.occurrenceId, lease.leaseId, "left");
    }),
  );

  await flush();
  assert.equal(
    coordinator.activeSessionCount(),
    Math.min(limit, CONCURRENT_OCCURRENCES),
    `the semaphore must admit exactly ${limit} occurrences at once`,
  );
  gate.resolve();
  await Promise.all(tasks);

  assert.equal(coordinator.activeSessionCount(), 0);
  for (const id of ids) {
    assert.equal(coordinator.get(id.occurrenceId)?.state, "notified");
    assert.equal(coordinator.history(id.occurrenceId).length, HAPPY_PATH_STATES.length + 1);
    assert.equal(coordinator.activeBridgeLease(id.occurrenceId), null);
    assert.equal(store.listLeases(id.occurrenceId).length, 1);
  }
  assert.deepEqual(store.foreignKeyCheck(), []);

  return { peak, store, h };
}

test("20 concurrent occurrences run correctly under a semaphore of 4", async () => {
  const { peak, store, h } = await runConcurrent(4);
  try {
    assert.equal(peak, 4);
  } finally {
    store.close();
    h.cleanup();
  }
});

test("a semaphore of 1 is a valid deployment setting, not a broken one", async () => {
  const { peak, store, h } = await runConcurrent(1);
  try {
    assert.equal(peak, 1);
  } finally {
    store.close();
    h.cleanup();
  }
});

test("the semaphore is not a hard-coded maximum: 20 occurrences may run at once", async () => {
  const { peak, store, h } = await runConcurrent(CONCURRENT_OCCURRENCES);
  try {
    assert.equal(peak, CONCURRENT_OCCURRENCES);
  } finally {
    store.close();
    h.cleanup();
  }
});

test("a nonsensical concurrency limit is rejected at construction", () => {
  const h = harness();
  try {
    const store = h.open();
    try {
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        assert.throws(
          () => coordinatorFor(store, fakeClock(), bad),
          isOrchestrationError("invalid_configuration"),
          `maxConcurrentSessions=${bad} must be rejected`,
        );
      }
      assert.equal(coordinatorFor(store, fakeClock(), 1).maxConcurrentSessions, 1);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("a failing session releases its semaphore slot", async () => {
  const h = harness();
  try {
    const store = h.open();
    const coordinator = coordinatorFor(store, fakeClock(), 1);
    try {
      const id = identity(1);
      coordinator.discover(id);
      await assert.rejects(
        coordinator.withSession(id.occurrenceId, async () => {
          await Promise.resolve();
          throw new Error("synthetic bridge failure");
        }),
        /synthetic bridge failure/,
      );
      assert.equal(coordinator.activeSessionCount(), 0);

      // The slot is genuinely free again.
      await coordinator.withSession(id.occurrenceId, async () => {
        await Promise.resolve();
        coordinator.fail(id.occurrenceId, "bridge_failure");
      });
      assert.equal(coordinator.get(id.occurrenceId)?.state, "failed");
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("withSession never consumes a slot for an unknown occurrence", async () => {
  const h = harness();
  try {
    const store = h.open();
    const coordinator = coordinatorFor(store, fakeClock(), 1);
    try {
      await assert.rejects(
        coordinator.withSession(identity(404).occurrenceId, async () => {
          await Promise.resolve();
        }),
        isOrchestrationError("unknown_session"),
      );
      assert.equal(coordinator.activeSessionCount(), 0);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

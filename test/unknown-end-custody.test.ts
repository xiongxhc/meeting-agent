import assert from "node:assert/strict";
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import { deleteSeedRecordingEvidence } from "../src/adapters/filesystem-outbox.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import type {
  BackfillSeedFinalizationInput,
  DeliveryRow,
  RecordingInput,
  SessionStore,
  UnknownEndCustodyCleanupClaim,
  UnknownEndCustodyIdentity,
  UnknownEndCustodySource,
} from "../src/ports/session-store.ts";
import { createCoordinator, type TerminalOutcome } from "../src/sessions/coordinator.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const CUSTODY_MS = 14 * DAY_MS;
const STARTED_AT = "2026-09-02T14:00:00Z";
const STARTED_AT_MS = Date.parse(STARTED_AT);
/** Local-clock finalization instant. It is never a known end and never T. */
const STOPPED_AT_MS = STARTED_AT_MS + 10 * 60_000;
/** First durable unknown-end detection T. Deliberately later than every
 * finalization/failure timestamp so a fabricated T is distinguishable. */
const DETECTED_AT_MS = STOPPED_AT_MS + 3 * 60_000;
const DEADLINE_MS = DETECTED_AT_MS + CUSTODY_MS;

type Capability = { sourceSessionId: bigint; recordingHandle: string; sha256: string; keyId: string; authorization: string };

function capability(seed: number): Capability {
  const hex = seed.toString(16).padStart(2, "0");
  return { sourceSessionId: BigInt(100 + seed), recordingHandle: hex.repeat(16), sha256: hex.repeat(32), keyId: hex.repeat(8), authorization: hex.repeat(32) };
}

const FINAL = capability(0xa0);

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-unknown-end-"));
  const filename = path.join(dir, "state.db");
  const recordingsDir = path.join(dir, "recordings");
  mkdirSync(recordingsDir);
  const store = openSessionStore({ filename, nowMs: STARTED_AT_MS });
  const identity = buildMeetingIdentity({
    providerMeetingId: "meeting-unknown-end",
    meetingNo: "555000111",
    occurrenceStartedAt: STARTED_AT,
    title: "Unknown end",
    organizer: null,
  });
  let nowMs = STOPPED_AT_MS;
  const coordinator = createCoordinator({ store, clock: { now: () => nowMs }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 1 });
  coordinator.discover(identity);
  coordinator.advance(identity.occurrenceId, "joining");
  coordinator.advance(identity.occurrenceId, "listening");
  const occurrenceId = identity.occurrenceId;

  function writeSource(cap: Capability, bytes = `ciphertext-${cap.recordingHandle.slice(0, 4)}`): string {
    const recordingPath = path.join(recordingsDir, `${cap.recordingHandle}.crsr`);
    writeFileSync(recordingPath, Buffer.from(bytes));
    return recordingPath;
  }
  function recordingInput(cap: Capability, recordingPath: string, bridgeSessionId: string | null): RecordingInput {
    return {
      ...(bridgeSessionId === null ? {} : { recovery: { bridgeSessionId, capability: cap } }),
      handle: cap.recordingHandle, encryptedPath: recordingPath, sha256: cap.sha256, durationMs: 600_000,
      format: "pcm_s16le/24000/1/20ms", keyId: cap.keyId, gaps: [], runtimeGaps: [],
    };
  }
  function openGeneration(bridgeSessionId: string, cap: Capability): void {
    store.beginReconciliationGeneration(occurrenceId, bridgeSessionId, STARTED_AT_MS);
    store.setReconciliationRuntimeSession(occurrenceId, bridgeSessionId, cap.sourceSessionId);
  }
  function identityOf(cap: Capability, recordingPath: string): UnknownEndCustodyIdentity {
    return { recordingHandle: cap.recordingHandle, encryptedPath: recordingPath, sha256: cap.sha256, keyId: cap.keyId };
  }

  return {
    dir, filename, recordingsDir, store, identity, occurrenceId, coordinator, identityOf, writeSource,
    setNow(value: number) { nowMs = value; },
    /** Canonical finalization. `source` is the reconciliation terminal
     * provenance; only "bridge_observed" is an authoritative known end. */
    finalize(source: "bridge_observed" | "local_clock" = "local_clock", outcome: TerminalOutcome = { kind: "advance", toState: "finalizing" },
      seed?: BackfillSeedFinalizationInput, reason?: "ended" | "removed" | "bridge_failure") {
      const recordingPath = writeSource(FINAL);
      openGeneration("bridge-final", FINAL);
      coordinator.finalizeWithRecording(occurrenceId, outcome, recordingInput(FINAL, recordingPath, "bridge-final"),
        "bridge-final", STOPPED_AT_MS, source, seed);
      // Mirror the session's `finally`: every bridge left completes the
      // generation as bridge_observed with the bridge's reason (D027).
      if (source === "bridge_observed") {
        coordinator.completeReconciliationGeneration(occurrenceId, "bridge-final", STOPPED_AT_MS, source,
          reason ?? (outcome.kind === "fail" ? outcome.terminalReason as "removed" | "bridge_failure" | "ended" : "ended"));
      }
      const source_: UnknownEndCustodySource = { kind: "final", occurrenceId };
      return { source: source_, cap: FINAL, recordingPath, exact: identityOf(FINAL, recordingPath), bridgeSessionId: "bridge-final" };
    },
    /** One failed bridge generation. `withRecording=false` records the failure
     * without any finalized source, i.e. a live/unknown Runtime writer. */
    failAttempt(expectedAttempt: number, withRecording = true) {
      const cap = capability(0xb0 + expectedAttempt);
      const bridgeSessionId = `bridge-fail-${expectedAttempt}`;
      openGeneration(bridgeSessionId, cap);
      const recordingPath = withRecording ? writeSource(cap) : path.join(recordingsDir, `${cap.recordingHandle}.crsr`);
      const result = coordinator.recordBridgeFailure(occurrenceId, 5, [], withRecording ? recordingInput(cap, recordingPath, bridgeSessionId) : null);
      assert.equal(result.attempt, expectedAttempt);
      assert.equal(result.retryAllowed, true);
      const source: UnknownEndCustodySource = { kind: "bridge_failure", occurrenceId, attempt: expectedAttempt };
      return { source, cap, recordingPath, exact: identityOf(cap, recordingPath), bridgeSessionId, attempt: expectedAttempt };
    },
    seedInput(endedAt: string): BackfillSeedFinalizationInput {
      return {
        terminalReason: "ended", terminalSource: "bridge_observed", endedAt, identity, provider: "feishu", encryption: "aes-256-gcm",
        processingWarnings: [], provenance: { runtimeProfile: "online", sttProvider: "stt", sttModel: "stt-v1", liveStreamModel: "stream-v1",
          finalBatchModel: "final-v1", textProvider: "text", textModel: "text-v1", agentVersion: "meeting-agent/test" },
      };
    },
    raw<T>(fn: (db: Database.Database) => T): T {
      const db = new Database(filename);
      try { db.pragma("foreign_keys = ON"); return fn(db); } finally { db.close(); }
    },
    custodyRows() {
      return this.raw((db) => db.prepare(`SELECT source_kind AS kind, failure_attempt AS attempt, state,
        unknown_end_detected_at_ms AS detectedAtMs, unknown_end_deadline_ms AS deadlineMs, cleanup_failure_reason AS reason,
        deleted_at_ms AS deletedAtMs, last_observed_at_ms AS observedAtMs
        FROM unknown_end_custody ORDER BY source_kind, failure_attempt`).all() as Array<Record<string, unknown>>);
    },
    /** Every table an unknown-end assignment must never touch. */
    sideEffects() {
      return this.raw((db) => ({
        deliveries: (db.prepare("SELECT count(*) AS n FROM delivery_journal").get() as { n: number }).n,
        jobs: (db.prepare("SELECT count(*) AS n FROM backfill_jobs").get() as { n: number }).n,
        seeds: (db.prepare("SELECT count(*) AS n FROM backfill_seeds").get() as { n: number }).n,
        warnings: (db.prepare("SELECT count(*) AS n FROM backfill_warning_intents").get() as { n: number }).n,
        notifications: (db.prepare("SELECT count(*) AS n FROM notification_intents").get() as { n: number }).n,
        session: db.prepare("SELECT state, terminal_reason AS terminalReason FROM sessions WHERE occurrence_id=?").get(occurrenceId),
        knownEnds: (db.prepare("SELECT count(*) AS n FROM reconciliation_generations WHERE occurrence_id=? AND terminal_source='bridge_observed'").get(occurrenceId) as { n: number }).n,
      }));
    },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function deleteWithClaim(recordingsDir: string, claim: UnknownEndCustodyCleanupClaim, fault?: (step: string) => void): void {
  deleteSeedRecordingEvidence({ recordingsDir, recordingPath: claim.recordingPath, recordingHandle: claim.recordingHandle,
    recordingBytes: claim.recordingBytes, recordingDevice: claim.recordingDevice, recordingInode: claim.recordingInode,
    ...(fault === undefined ? {} : { fault }) });
}

function token(letter: string): string { return letter.repeat(32); }

test("migrations 026 and 027 add per-source custody and the generation terminal reason at head and never assign implicitly", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-unknown-end-migrate-"));
  const filename = path.join(dir, "state.db");
  const oldMigrations = path.join(dir, "migrations-025");
  mkdirSync(oldMigrations);
  cpSync(path.resolve("migrations"), oldMigrations, { recursive: true, filter: (source) => {
    const version = /^(\d+)_/.exec(path.basename(source));
    return version === null || Number(version[1]) <= 25;
  } });
  try {
    const old = openSessionStore({ filename, migrationsDir: oldMigrations, nowMs: 1 });
    const identity = buildMeetingIdentity({ providerMeetingId: "legacy", meetingNo: "1", occurrenceStartedAt: STARTED_AT, title: "Legacy", organizer: null });
    old.createSession({ occurrenceId: identity.occurrenceId, providerMeetingId: identity.providerMeetingId, occurrenceStartedAt: identity.occurrenceStartedAt, nowMs: 1 });
    // A pre-027 bridge_observed terminal (written by the old schema, which had
    // no reason column) keeps a NULL reason after upgrade.
    old.beginReconciliationGeneration(identity.occurrenceId, "bridge-legacy", 1);
    assert.equal(old.schemaVersion, 25);
    old.close();
    const raw025 = new Database(filename);
    try {
      raw025.prepare("UPDATE reconciliation_generations SET terminal_at_ms=2, terminal_source='bridge_observed', expires_at_ms=2+1209600000 WHERE occurrence_id=?")
        .run(identity.occurrenceId);
    } finally { raw025.close(); }
    const upgraded = openSessionStore({ filename, nowMs: 2 });
    try {
      assert.equal(upgraded.schemaVersion, 29);
      const raw027 = new Database(filename, { readonly: true });
      try {
        const columns = (raw027.pragma("table_info(reconciliation_generations)") as Array<{ name: string }>).map((column) => column.name);
        assert.ok(columns.includes("terminal_reason"));
        assert.deepEqual(raw027.prepare("SELECT terminal_source AS source, terminal_reason AS reason FROM reconciliation_generations").all(),
          [{ source: "bridge_observed", reason: null }]);
      } finally { raw027.close(); }
      // New completions carry the bridge reason exactly: required for bridge_observed, forbidden for local_clock.
      upgraded.beginReconciliationGeneration(identity.occurrenceId, "bridge-a", 3);
      upgraded.beginReconciliationGeneration(identity.occurrenceId, "bridge-b", 3);
      assert.throws(() => upgraded.completeReconciliationGeneration(identity.occurrenceId, "bridge-a", 4, "bridge_observed"), /terminal reason/i);
      assert.throws(() => upgraded.completeReconciliationGeneration(identity.occurrenceId, "bridge-a", 4, "bridge_observed", "left" as never), /terminal reason/i);
      assert.throws(() => upgraded.completeReconciliationGeneration(identity.occurrenceId, "bridge-b", 4, "local_clock", "ended"), /terminal reason/i);
      upgraded.completeReconciliationGeneration(identity.occurrenceId, "bridge-a", 4, "bridge_observed", "removed");
      upgraded.completeReconciliationGeneration(identity.occurrenceId, "bridge-b", 4, "local_clock");
      const rawReasons = new Database(filename, { readonly: true });
      try {
        assert.deepEqual(rawReasons.prepare("SELECT bridge_session_id AS bridge, terminal_source AS source, terminal_reason AS reason FROM reconciliation_generations ORDER BY bridge").all(),
          [{ bridge: "bridge-a", source: "bridge_observed", reason: "removed" }, { bridge: "bridge-b", source: "local_clock", reason: null },
            { bridge: "bridge-legacy", source: "bridge_observed", reason: null }]);
      } finally { rawReasons.close(); }
      const sql = new Map(upgraded.describeSchema().map((table) => [table.name, table.sql])).get("unknown_end_custody") ?? "";
      assert.match(sql, /STRICT/);
      assert.match(sql, /final_occurrence_id TEXT REFERENCES recordings\(occurrence_id\) ON DELETE RESTRICT/);
      assert.match(sql, /FOREIGN KEY \(failure_occurrence_id, failure_attempt\) REFERENCES bridge_failure_recordings\(occurrence_id, attempt\) ON DELETE RESTRICT/);
      assert.match(sql, /PRIMARY KEY \(occurrence_id, source_kind, failure_attempt\)/);
      assert.deepEqual(upgraded.foreignKeyCheck(), []);
      // Re-open and a cleanup clock read never manufacture custody.
      assert.equal(upgraded.claimDueUnknownEndCustodyCleanup(DEADLINE_MS + DAY_MS, token("a")), null);
      assert.equal(upgraded.getUnknownEndCustody({ kind: "final", occurrenceId: identity.occurrenceId }), null);
      // No parent, no row: the exact-source triggers refuse before any FK or CHECK could be bypassed.
      const raw = new Database(filename);
      try {
        raw.pragma("foreign_keys = ON");
        const insert = (kind: string, attempt: number, handle: string) => raw.prepare(`INSERT INTO unknown_end_custody
          (occurrence_id,source_kind,failure_attempt,final_occurrence_id,failure_occurrence_id,recording_handle,recording_path,
           recording_sha256,recording_key_id,recording_bytes,recording_device,recording_inode,unknown_end_detected_at_ms,unknown_end_deadline_ms,
           state,last_observed_at_ms)
          VALUES (?,?,?,?,?,?,?,'${"0".repeat(64)}','${"0".repeat(16)}',1,'1','1',?,?,'assigned',?)`)
          .run(identity.occurrenceId, kind, attempt, kind === "final" ? identity.occurrenceId : null, kind === "final" ? null : identity.occurrenceId,
            handle, path.join(dir, `${handle}.crsr`), DETECTED_AT_MS, DEADLINE_MS, DETECTED_AT_MS);
        assert.throws(() => insert("final", 0, FINAL.recordingHandle), /finalized canonical source/);
        assert.throws(() => insert("bridge_failure", 1, capability(0xb1).recordingHandle), /finalized failed source/);
        assert.deepEqual(raw.prepare("SELECT count(*) AS n FROM unknown_end_custody").get(), { n: 0 });
      } finally { raw.close(); }
    } finally { upgraded.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("first canonical detection T is stable through retry, two handles, reopen, clock regression/advance and a later real end", () => {
  const f = fixture();
  try {
    const final = f.finalize("local_clock");
    const stat = lstatSync(final.recordingPath, { bigint: true });
    const first = f.store.assignUnknownEndCustody(final.source, DETECTED_AT_MS, final.exact);
    assert.equal(first.outcome, "assigned");
    assert.deepEqual(first.custody, {
      source: final.source, recordingHandle: FINAL.recordingHandle, recordingPath: path.resolve(final.recordingPath),
      recordingSha256: FINAL.sha256, recordingKeyId: FINAL.keyId, recordingBytes: Number(stat.size),
      recordingDevice: stat.dev.toString(), recordingInode: stat.ino.toString(),
      detectedAtMs: DETECTED_AT_MS, deadlineMs: DEADLINE_MS, state: "assigned", cleanupFailureReason: null, deletedAtMs: null,
    });
    // Retry with a later clock, then an earlier clock from a second handle.
    assert.deepEqual(f.store.assignUnknownEndCustody(final.source, DETECTED_AT_MS + 5_000, final.exact), { outcome: "existing", custody: first.custody });
    const other = openSessionStore({ filename: f.filename });
    try {
      assert.deepEqual(other.assignUnknownEndCustody(final.source, DETECTED_AT_MS - 5_000, final.exact), { outcome: "existing", custody: first.custody });
      assert.equal(other.claimDueUnknownEndCustodyCleanup(DEADLINE_MS - 1, token("a")), null);
    } finally { other.close(); }
    f.store.close();
    const reopened = openSessionStore({ filename: f.filename });
    try {
      assert.deepEqual(reopened.getUnknownEndCustody(final.source), first.custody);
      // A later trustworthy end on a reopened generation neither extends nor clears the assignment.
      reopened.beginReconciliationGeneration(f.occurrenceId, "bridge-reopen", DETECTED_AT_MS + DAY_MS);
      reopened.completeReconciliationGeneration(f.occurrenceId, "bridge-reopen", DETECTED_AT_MS + 2 * DAY_MS, "bridge_observed", "ended");
      assert.deepEqual(reopened.assignUnknownEndCustody(final.source, DETECTED_AT_MS + 3 * DAY_MS, final.exact), { outcome: "existing", custody: first.custody });
      assert.equal(reopened.claimDueUnknownEndCustodyCleanup(DEADLINE_MS - 1, token("a")), null);
      const due = reopened.claimDueUnknownEndCustodyCleanup(DEADLINE_MS, token("a"));
      assert.equal(due?.deadlineMs, DEADLINE_MS);
      assert.equal(due?.detectedAtMs, DETECTED_AT_MS);
      assert.deepEqual(f.custodyRows(), [{ kind: "final", attempt: 0, state: "cleanup_claimed", detectedAtMs: DETECTED_AT_MS,
        deadlineMs: DEADLINE_MS, reason: null, deletedAtMs: null, observedAtMs: DEADLINE_MS }]);
      assert.deepEqual(f.sideEffects(), { deliveries: 0, jobs: 0, seeds: 0, warnings: 0, notifications: 0,
        session: { state: "finalizing", terminalReason: null }, knownEnds: 1 });
      assert.equal(reopened.getRecording(f.occurrenceId)?.finalizedAtMs, STOPPED_AT_MS);
      // The canonical parent is held by a real foreign key, not only by a trigger.
      f.raw((db) => assert.throws(() => db.prepare("DELETE FROM recordings WHERE occurrence_id=?").run(f.occurrenceId), /FOREIGN KEY/));
    } finally { reopened.close(); }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("two failed attempts receive distinct assignments and claims; canonical or sibling cleanup cannot touch the other", () => {
  const f = fixture();
  try {
    const first = f.failAttempt(1);
    const second = f.failAttempt(2);
    assert.equal(f.custodyRows().length, 0, "recording a failed generation never assigns custody");
    const t1 = DETECTED_AT_MS;
    // Ten seconds later: due inside attempt 1's live lease, so the claim order is exact.
    const t2 = DETECTED_AT_MS + 10_000;
    const a1 = f.store.assignUnknownEndCustody(first.source, t1, first.exact);
    const a2 = f.store.assignUnknownEndCustody(second.source, t2, second.exact);
    assert.equal(a1.outcome, "assigned");
    assert.equal(a2.outcome, "assigned");
    assert.notEqual(a1.custody.recordingInode, a2.custody.recordingInode);
    assert.deepEqual([a1.custody.deadlineMs, a2.custody.deadlineMs], [t1 + CUSTODY_MS, t2 + CUSTODY_MS]);
    assert.throws(() => f.store.assignUnknownEndCustody({ kind: "final", occurrenceId: f.occurrenceId }, t1, first.exact), /finalized/i);
    // Each failed parent is held by the composite foreign key.
    f.raw((db) => assert.throws(() => db.prepare("DELETE FROM bridge_failure_recordings WHERE occurrence_id=? AND attempt=2").run(f.occurrenceId), /FOREIGN KEY/));
    // Only the earliest due exact source is claimed; the sibling stays unclaimed until its own deadline.
    const claim1 = f.store.claimDueUnknownEndCustodyCleanup(t1 + CUSTODY_MS, token("a"))!;
    assert.deepEqual(claim1.source, first.source);
    assert.equal(f.store.claimDueUnknownEndCustodyCleanup(t1 + CUSTODY_MS, token("b")), null);
    const claim2 = f.store.claimDueUnknownEndCustodyCleanup(t2 + CUSTODY_MS, token("b"))!;
    assert.deepEqual(claim2.source, second.source);
    assert.notEqual(claim1.claimToken, claim2.claimToken);
    // Attempt 1's exact identity cannot delete attempt 2's file and vice versa.
    assert.throws(() => deleteWithClaim(f.recordingsDir, { ...claim1, recordingPath: second.recordingPath }), /handle/i);
    assert.throws(() => deleteWithClaim(f.recordingsDir, { ...claim2, recordingHandle: first.cap.recordingHandle }), /handle/i);
    assert.equal(existsSync(first.recordingPath), true);
    assert.equal(existsSync(second.recordingPath), true);
    // A completion citing the wrong source or token is stale and marks nothing.
    assert.throws(() => f.store.completeUnknownEndCustodyCleanup({ source: second.source, claimToken: claim1.claimToken }, t2 + CUSTODY_MS), /stale/i);
    assert.throws(() => f.store.completeUnknownEndCustodyCleanup({ source: { kind: "final", occurrenceId: f.occurrenceId }, claimToken: claim1.claimToken }, t1 + CUSTODY_MS), /stale/i);
    // Crash after detaching attempt 1 leaves its exact tombstone; attempt 2 is untouched.
    assert.throws(() => deleteWithClaim(f.recordingsDir, claim1, (step) => { if (step === "after_recording_detach") throw new Error("crash cut"); }), /crash cut/);
    assert.equal(existsSync(first.recordingPath), false);
    assert.equal(existsSync(second.recordingPath), true);
    assert.equal(readdirSync(f.recordingsDir).filter((name) => name.startsWith(".recording-delete-seed-")).length, 1);
    assert.throws(() => f.store.completeUnknownEndCustodyCleanup(claim1, claim1.claimExpiresAtMs), /stale|expired/i);
    const reopened = openSessionStore({ filename: f.filename });
    try {
      const reclaimed = reopened.claimDueUnknownEndCustodyCleanup(claim1.claimExpiresAtMs, token("c"))!;
      assert.deepEqual(reclaimed.source, first.source);
      assert.equal(reclaimed.detectedAtMs, t1);
      deleteWithClaim(f.recordingsDir, reclaimed);
      reopened.completeUnknownEndCustodyCleanup(reclaimed, claim1.claimExpiresAtMs);
    } finally { reopened.close(); }
    assert.equal(existsSync(second.recordingPath), true);
    assert.deepEqual(readdirSync(f.recordingsDir), [path.basename(second.recordingPath)]);
    assert.throws(() => f.store.completeUnknownEndCustodyCleanup({ source: second.source, claimToken: claim1.claimToken }, t2 + CUSTODY_MS), /stale/i);
    assert.deepEqual(f.custodyRows(), [
      { kind: "bridge_failure", attempt: 1, state: "deleted", detectedAtMs: t1, deadlineMs: t1 + CUSTODY_MS, reason: null, deletedAtMs: claim1.claimExpiresAtMs, observedAtMs: claim1.claimExpiresAtMs },
      { kind: "bridge_failure", attempt: 2, state: "cleanup_claimed", detectedAtMs: t2, deadlineMs: t2 + CUSTODY_MS, reason: null, deletedAtMs: null, observedAtMs: t2 + CUSTODY_MS },
    ]);
    assert.equal(f.sideEffects().deliveries, 0);
  } finally { f.close(); }
});

test("a known bridge-observed end refuses assignment while removed, failure, local-clock and finalization instants never become one", () => {
  {
    const f = fixture();
    try {
      const final = f.finalize("bridge_observed");
      assert.throws(() => f.store.assignUnknownEndCustody(final.source, DETECTED_AT_MS, final.exact), /known end/i);
      assert.equal(f.custodyRows().length, 0);
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      const final = f.finalize("bridge_observed", { kind: "advance", toState: "finalizing" }, f.seedInput(new Date(STOPPED_AT_MS).toISOString()));
      assert.equal(f.sideEffects().seeds, 1);
      assert.throws(() => f.store.assignUnknownEndCustody(final.source, DETECTED_AT_MS, final.exact), /known end|seed/i);
      assert.equal(f.custodyRows().length, 0);
    } finally { f.close(); }
  }
  {
    // The session terminates every bridge `left` as bridge_observed; a failed
    // attempt's own recording row proves its generation ended in failure.
    const f = fixture();
    try {
      const attempt = f.failAttempt(1);
      f.store.completeReconciliationGeneration(f.occurrenceId, attempt.bridgeSessionId, STOPPED_AT_MS, "bridge_observed", "bridge_failure");
      const assigned = f.store.assignUnknownEndCustody(attempt.source, DETECTED_AT_MS, attempt.exact);
      assert.deepEqual([assigned.outcome, assigned.custody.detectedAtMs], ["assigned", DETECTED_AT_MS]);
      assert.equal(f.custodyRows().length, 1);
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      const final = f.finalize("local_clock");
      f.raw((db) => db.prepare("UPDATE reconciliation_generations SET terminal_source='legacy_unknown' WHERE occurrence_id=?").run(f.occurrenceId));
      assert.throws(() => f.store.assignUnknownEndCustody(final.source, DETECTED_AT_MS, final.exact), /ambiguous/i);
      assert.equal(f.custodyRows().length, 0);
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      const final = f.finalize("local_clock", { kind: "fail", terminalReason: "removed" });
      assert.deepEqual(f.sideEffects().session, { state: "failed", terminalReason: "removed" });
      const assigned = f.store.assignUnknownEndCustody(final.source, DETECTED_AT_MS, final.exact);
      assert.equal(assigned.outcome, "assigned");
      assert.equal(assigned.custody.detectedAtMs, DETECTED_AT_MS);
      assert.notEqual(assigned.custody.detectedAtMs, STOPPED_AT_MS);
      assert.equal(f.sideEffects().knownEnds, 0);
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      const attempt = f.failAttempt(1);
      const lastFailed = f.raw((db) => (db.prepare("SELECT last_failed_at_ms AS at FROM bridge_recoveries WHERE occurrence_id=?").get(f.occurrenceId) as { at: number }).at);
      assert.equal(lastFailed, STOPPED_AT_MS);
      const assigned = f.store.assignUnknownEndCustody(attempt.source, DETECTED_AT_MS, attempt.exact);
      assert.equal(assigned.custody.detectedAtMs, DETECTED_AT_MS);
      assert.equal(assigned.custody.deadlineMs, DEADLINE_MS);
      assert.throws(() => f.store.assignUnknownEndCustody(attempt.source, -1, attempt.exact), /clock/i);
    } finally { f.close(); }
  }
});

test("only a positively observed meeting end is a known end: the persisted generation reason, not the session's advance/fail split, decides", () => {
  const cases: Array<{ name: string; outcome: TerminalOutcome; reason?: "ended" | "removed" | "bridge_failure"; seeded?: true; legacy?: true;
    refused: boolean; session: { state: string; terminalReason: string | null } }> = [
    { name: "removed while listening", outcome: { kind: "advance", toState: "finalizing" }, reason: "removed", refused: false,
      session: { state: "finalizing", terminalReason: null } },
    { name: "removed before listening", outcome: { kind: "fail", terminalReason: "removed" }, refused: false,
      session: { state: "failed", terminalReason: "removed" } },
    { name: "bridge_failure", outcome: { kind: "fail", terminalReason: "bridge_failure" }, refused: false,
      session: { state: "failed", terminalReason: "bridge_failure" } },
    { name: "ended while listening (seeded)", outcome: { kind: "advance", toState: "finalizing" }, seeded: true, refused: true,
      session: { state: "finalizing", terminalReason: null } },
    { name: "ended before listening", outcome: { kind: "fail", terminalReason: "ended" }, refused: true,
      session: { state: "failed", terminalReason: "ended" } },
    { name: "pre-027 bridge_observed row with NULL reason", outcome: { kind: "advance", toState: "finalizing" }, reason: "removed", legacy: true,
      refused: true, session: { state: "finalizing", terminalReason: null } },
  ];
  for (const scenario of cases) {
    const f = fixture();
    try {
      // Every bridge `left` is terminated as bridge_observed, whatever its reason.
      const final = f.finalize("bridge_observed", scenario.outcome, scenario.seeded ? f.seedInput(new Date(STOPPED_AT_MS).toISOString()) : undefined, scenario.reason);
      if (scenario.legacy) f.raw((db) => db.prepare("UPDATE reconciliation_generations SET terminal_reason=NULL WHERE occurrence_id=?").run(f.occurrenceId));
      assert.equal(f.sideEffects().knownEnds, 1, scenario.name);
      assert.equal(f.sideEffects().seeds, scenario.seeded ? 1 : 0, scenario.name);
      assert.deepEqual(f.sideEffects().session, scenario.session, scenario.name);
      if (scenario.refused) {
        assert.throws(() => f.store.assignUnknownEndCustody(final.source, DETECTED_AT_MS, final.exact), /known end/i, scenario.name);
        assert.equal(f.custodyRows().length, 0, scenario.name);
        continue;
      }
      const assigned = f.store.assignUnknownEndCustody(final.source, DETECTED_AT_MS, final.exact);
      assert.deepEqual([assigned.outcome, assigned.custody.detectedAtMs, assigned.custody.deadlineMs], ["assigned", DETECTED_AT_MS, DEADLINE_MS], scenario.name);
      assert.deepEqual(f.store.assignUnknownEndCustody(final.source, DETECTED_AT_MS + 5_000, final.exact), { outcome: "existing", custody: assigned.custody }, scenario.name);
      assert.equal(f.sideEffects().seeds, 0, scenario.name);
    } finally { f.close(); }
  }
});

test("a live or unknown Runtime writer, a mismatched identity, an unsafe file and a delivery-owned source refuse assignment", () => {
  const f = fixture();
  try {
    const live = f.failAttempt(1, false);
    assert.throws(() => f.store.assignUnknownEndCustody(live.source, DETECTED_AT_MS, live.exact), /finalized/i);
    assert.throws(() => f.store.assignUnknownEndCustody({ kind: "final", occurrenceId: f.occurrenceId }, DETECTED_AT_MS, live.exact), /finalized/i);
    assert.throws(() => f.store.assignUnknownEndCustody({ kind: "bridge_failure", occurrenceId: f.occurrenceId, attempt: 2 }, DETECTED_AT_MS, live.exact), /finalized/i);
    const stopped = f.failAttempt(2);
    const wrong = (patch: Partial<UnknownEndCustodyIdentity>) => assert.throws(
      () => f.store.assignUnknownEndCustody(stopped.source, DETECTED_AT_MS, { ...stopped.exact, ...patch }), /identity/i);
    wrong({ recordingHandle: capability(0xb3).recordingHandle });
    wrong({ sha256: "f".repeat(64) });
    wrong({ keyId: "f".repeat(16) });
    wrong({ encryptedPath: path.join(f.dir, `${stopped.cap.recordingHandle}.crsr`) });
    assert.throws(() => f.store.assignUnknownEndCustody({ ...stopped.source, occurrenceId: "other" } as UnknownEndCustodySource, DETECTED_AT_MS, stopped.exact), /finalized/i);
    const original = `${stopped.recordingPath}.original`;
    renameSync(stopped.recordingPath, original);
    assert.throws(() => f.store.assignUnknownEndCustody(stopped.source, DETECTED_AT_MS, stopped.exact), /inspect|regular|ENOENT/i);
    symlinkSync(original, stopped.recordingPath);
    assert.throws(() => f.store.assignUnknownEndCustody(stopped.source, DETECTED_AT_MS, stopped.exact), /regular/i);
    rmSync(stopped.recordingPath);
    renameSync(original, stopped.recordingPath);
    assert.equal(f.custodyRows().length, 0);
    // A legacy canonical row without a Runtime descriptor is not finalized evidence.
    const legacy = buildMeetingIdentity({ providerMeetingId: "legacy", meetingNo: "1", occurrenceStartedAt: STARTED_AT, title: "Legacy", organizer: null });
    f.store.createSession({ occurrenceId: legacy.occurrenceId, providerMeetingId: legacy.providerMeetingId, occurrenceStartedAt: legacy.occurrenceStartedAt, nowMs: 1 });
    f.raw((db) => db.prepare("INSERT INTO recordings (occurrence_id,handle,sha256,duration_ms,finalized_at_ms) VALUES (?,?,?,?,?)")
      .run(legacy.occurrenceId, FINAL.recordingHandle, FINAL.sha256, 1, 1));
    assert.throws(() => f.store.assignUnknownEndCustody({ kind: "final", occurrenceId: legacy.occurrenceId }, DETECTED_AT_MS,
      f.identityOf(FINAL, path.join(f.recordingsDir, `${FINAL.recordingHandle}.crsr`))), /finalized/i);
    // A delivery-owned canonical source is live custody for the outbox, not for unknown-end cleanup.
    const g = fixture();
    try {
      const final = g.finalize("local_clock");
      const row: DeliveryRow = { occurrenceId: g.occurrenceId, revision: 1, artifactHash: `sha256:${"0".repeat(64)}`, recordingPath: final.recordingPath,
        bundlePath: path.join(g.dir, "outbox", "bundle"), endedAtMs: STOPPED_AT_MS, transcriptComplete: false, retryCount: 0, nextRetryAtMs: STOPPED_AT_MS,
        retryReason: null, publishedAtMs: null, deletedAtMs: null, publicationUrl: null, vaultCommit: null, recoveryArtifact: null, stageToken: null };
      g.store.savePending(row);
      assert.throws(() => g.store.assignUnknownEndCustody(final.source, DETECTED_AT_MS, final.exact), /delivery/i);
      assert.equal(g.custodyRows().length, 0);
    } finally { g.close(); }
  } finally { f.close(); }
});

test("after durable T an injected cleanup failure or a retained alignment claim blocks deletion without moving T or the deadline", () => {
  const f = fixture();
  try {
    const final = f.finalize("local_clock");
    const assigned = f.store.assignUnknownEndCustody(final.source, DETECTED_AT_MS, final.exact).custody;
    const claim = f.store.claimDueUnknownEndCustodyCleanup(DEADLINE_MS, token("a"))!;
    assert.throws(() => f.store.failUnknownEndCustodyCleanup({ ...claim, claimToken: token("b") }, DEADLINE_MS + 1, "detach_failed"), /stale/i);
    f.store.failUnknownEndCustodyCleanup(claim, DEADLINE_MS + 1, "detach_failed");
    const blocked = { ...assigned, state: "cleanup_failed" as const, cleanupFailureReason: "detach_failed" as const };
    assert.deepEqual(f.store.getUnknownEndCustody(final.source), blocked);
    assert.equal(f.store.claimDueUnknownEndCustodyCleanup(DEADLINE_MS + DAY_MS, token("c")), null);
    assert.deepEqual(f.store.assignUnknownEndCustody(final.source, DEADLINE_MS + DAY_MS, final.exact), { outcome: "existing", custody: blocked });
    assert.throws(() => f.store.completeUnknownEndCustodyCleanup(claim, DEADLINE_MS + 2), /stale/i);
    assert.throws(() => f.store.failUnknownEndCustodyCleanup(claim, DEADLINE_MS + 2, "source_missing"), /stale/i);
    assert.equal(existsSync(final.recordingPath), true);
    const reopened = openSessionStore({ filename: f.filename });
    try { assert.deepEqual(reopened.getUnknownEndCustody(final.source), blocked); } finally { reopened.close(); }
    f.raw((db) => {
      assert.throws(() => db.prepare("UPDATE unknown_end_custody SET unknown_end_detected_at_ms=unknown_end_detected_at_ms+1, unknown_end_deadline_ms=unknown_end_deadline_ms+1").run(), /immutable/);
      assert.throws(() => db.prepare("UPDATE unknown_end_custody SET recording_inode='999'").run(), /immutable/);
      assert.throws(() => db.prepare("UPDATE unknown_end_custody SET state='assigned', cleanup_failure_reason=NULL").run(), /monotonic/);
      assert.throws(() => db.prepare("UPDATE unknown_end_custody SET last_observed_at_ms=last_observed_at_ms-1").run(), /monotonic/);
      assert.throws(() => db.prepare("DELETE FROM unknown_end_custody").run(), /never deleted/);
    });
    // A retained durable alignment claim on the exact source blocks the claim, not the assignment.
    const attempt = f.failAttempt(1);
    const custody = f.store.assignUnknownEndCustody(attempt.source, DETECTED_AT_MS, attempt.exact).custody;
    const generationId = f.raw((db) => (db.prepare("SELECT generation_id AS id FROM recording_recovery_bindings WHERE occurrence_id=? AND recording_handle=?")
      .get(f.occurrenceId, attempt.cap.recordingHandle) as { id: string }).id);
    const alignment = f.store.beginRecordingAlignment(generationId, "reader-1");
    assert.equal(alignment.kind, "claimed");
    if (alignment.kind !== "claimed") return;
    f.store.markAlignmentCleanupFailed(alignment.attempt);
    assert.equal(f.store.claimDueUnknownEndCustodyCleanup(DEADLINE_MS + DAY_MS, token("d")), null);
    assert.deepEqual(f.store.getUnknownEndCustody(attempt.source), custody);
    f.raw((db) => db.prepare("UPDATE recording_alignment_attempts SET state='abandoned', failure_reason='recovered_owner' WHERE attempt_id=?").run(alignment.attempt.attemptId));
    assert.deepEqual(f.store.claimDueUnknownEndCustodyCleanup(DEADLINE_MS + DAY_MS, token("d"))?.source, attempt.source);
    assert.equal(f.store.getUnknownEndCustody(attempt.source)?.detectedAtMs, DETECTED_AT_MS);
  } finally { f.close(); }
});

test("due sources with changed identity, links, wrong handle, missing file or a conflicting claim stay fail-closed and never mark another file deleted", () => {
  const mutations = ["size", "inode", "symlink", "hardlink", "wrong_handle", "root_move", "missing"] as const;
  for (const mutation of mutations) {
    const f = fixture();
    try {
      const final = f.finalize("local_clock");
      const bystander = f.failAttempt(1);
      f.store.assignUnknownEndCustody(final.source, DETECTED_AT_MS, final.exact);
      const bystanderCustody = f.store.assignUnknownEndCustody(bystander.source, DETECTED_AT_MS + DAY_MS, bystander.exact).custody;
      const claim = f.store.claimDueUnknownEndCustodyCleanup(DEADLINE_MS, token("a"))!;
      assert.deepEqual(claim.source, final.source);
      const original = `${final.recordingPath}.original`;
      let recordingsDir = f.recordingsDir;
      let claimInput = claim;
      if (mutation === "size") writeFileSync(final.recordingPath, Buffer.from("ciphertext-grown-longer"));
      if (mutation === "inode") { renameSync(final.recordingPath, original); writeFileSync(final.recordingPath, Buffer.from(`ciphertext-${FINAL.recordingHandle.slice(0, 4)}`)); }
      if (mutation === "symlink") { renameSync(final.recordingPath, original); symlinkSync(original, final.recordingPath); }
      if (mutation === "hardlink") { renameSync(final.recordingPath, original); linkSync(bystander.recordingPath, final.recordingPath); }
      if (mutation === "wrong_handle") claimInput = { ...claim, recordingHandle: bystander.cap.recordingHandle };
      if (mutation === "root_move") { recordingsDir = path.join(f.dir, "moved"); mkdirSync(recordingsDir); }
      if (mutation === "missing") rmSync(final.recordingPath);
      if (mutation === "missing") {
        deleteWithClaim(recordingsDir, claimInput);
      } else {
        assert.throws(() => deleteWithClaim(recordingsDir, claimInput), /identity|size|handle|root|outside|direct child|symlink/i, mutation);
        assert.equal(existsSync(final.recordingPath), true, mutation);
        if (mutation === "inode" || mutation === "symlink" || mutation === "hardlink") assert.equal(existsSync(original), true, mutation);
        f.store.failUnknownEndCustodyCleanup(claim, DEADLINE_MS + 1, mutation === "wrong_handle" ? "unsafe_source" : "identity_mismatch");
        assert.equal(f.store.getUnknownEndCustody(final.source)?.state, "cleanup_failed", mutation);
      }
      assert.equal(existsSync(bystander.recordingPath), true, mutation);
      assert.deepEqual(f.store.getUnknownEndCustody(bystander.source), bystanderCustody, mutation);
      assert.equal(f.store.getUnknownEndCustody(final.source)?.detectedAtMs, DETECTED_AT_MS, mutation);
      assert.equal(readdirSync(f.recordingsDir).some((name) => name.startsWith(".recording-delete-")), false, mutation);
    } finally { f.close(); }
  }
  const f = fixture();
  try {
    const final = f.finalize("local_clock");
    f.store.assignUnknownEndCustody(final.source, DETECTED_AT_MS, final.exact);
    const other = openSessionStore({ filename: f.filename });
    try {
      const claim = f.store.claimDueUnknownEndCustodyCleanup(DEADLINE_MS, token("a"))!;
      assert.equal(other.claimDueUnknownEndCustodyCleanup(DEADLINE_MS + 1, token("b")), null);
      assert.throws(() => other.completeUnknownEndCustodyCleanup({ ...claim, claimToken: token("b") }, DEADLINE_MS + 1), /stale/i);
      // The lease wall persists: a clock regression cannot complete an expired claim.
      assert.throws(() => f.store.completeUnknownEndCustodyCleanup(claim, claim.claimExpiresAtMs), /stale|expired/i);
      assert.throws(() => f.store.completeUnknownEndCustodyCleanup(claim, DEADLINE_MS + 1), /stale|expired/i);
      assert.deepEqual(f.custodyRows(), [{ kind: "final", attempt: 0, state: "cleanup_claimed", detectedAtMs: DETECTED_AT_MS,
        deadlineMs: DEADLINE_MS, reason: null, deletedAtMs: null, observedAtMs: claim.claimExpiresAtMs }]);
      const reclaimed = other.claimDueUnknownEndCustodyCleanup(claim.claimExpiresAtMs, token("b"))!;
      assert.equal(reclaimed.claimToken, token("b"));
      assert.throws(() => f.store.completeUnknownEndCustodyCleanup(claim, claim.claimExpiresAtMs + 1), /stale/i);
      assert.equal(existsSync(final.recordingPath), true);
      deleteWithClaim(f.recordingsDir, reclaimed);
      other.completeUnknownEndCustodyCleanup(reclaimed, claim.claimExpiresAtMs + 1);
      assert.throws(() => other.completeUnknownEndCustodyCleanup(reclaimed, claim.claimExpiresAtMs + 2), /stale/i);
      assert.throws(() => other.failUnknownEndCustodyCleanup(reclaimed, claim.claimExpiresAtMs + 2, "source_missing"), /stale/i);
      assert.deepEqual(f.store.getUnknownEndCustody(final.source), { ...f.store.getUnknownEndCustody(final.source)!,
        state: "deleted", deletedAtMs: claim.claimExpiresAtMs + 1, detectedAtMs: DETECTED_AT_MS, deadlineMs: DEADLINE_MS });
      assert.deepEqual(f.sideEffects(), { deliveries: 0, jobs: 0, seeds: 0, warnings: 0, notifications: 0,
        session: { state: "finalizing", terminalReason: null }, knownEnds: 0 });
    } finally { other.close(); }
  } finally { f.close(); }
});

// Type-level guard: the store surface is the port, not the adapter.
const _surface: Pick<SessionStore, "assignUnknownEndCustody" | "claimDueUnknownEndCustodyCleanup" | "completeUnknownEndCustodyCleanup" | "failUnknownEndCustodyCleanup" | "getUnknownEndCustody"> | null = null;
void _surface;

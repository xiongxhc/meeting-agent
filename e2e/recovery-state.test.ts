import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { deleteSeedRecordingEvidence } from "../src/adapters/filesystem-outbox.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";

// Applied real migrations/store transitions, with synthetic ciphertext and
// capability metadata. These tests do not authenticate a Runtime capability,
// generate a shipped application seed, or establish R1 integration evidence.
const ENDED = 1_788_357_600_123;
const STOP = 1_789_308_000_123;
const EXPIRY = 1_789_567_200_123;
const helperPath = path.resolve(import.meta.dirname, "recovery-state.mjs");
async function helpers() {
  assert.ok(existsSync(helperPath), "recovery-state helper is not implemented");
  return import(helperPath);
}
function fixture() {
  const root = mkdtempSync("/private/tmp/meeting-recovery-state-");
  const databasePath = path.join(root, "state.db"), recordingsDir = path.join(root, "recordings");
  mkdirSync(recordingsDir, { mode: 0o700 });
  const handle = "a".repeat(32), recordingPath = path.join(recordingsDir, `${handle}.crsr`);
  const ciphertext = Buffer.from("component-only synthetic ciphertext");
  writeFileSync(recordingPath, ciphertext, { mode: 0o600 });
  const hash = createHash("sha256").update(ciphertext).digest("hex");
  const capability = { sourceSessionId: 41n, recordingHandle: handle, sha256: hash, keyId: "c".repeat(16), authorization: "d".repeat(64) };
  const identity = buildMeetingIdentity({ providerMeetingId: "component-recovery", meetingNo: "4242", occurrenceStartedAt: "2026-09-02T13:59:00Z", title: "Component fixture", organizer: null });
  const store = openSessionStore({ filename: databasePath, nowMs: ENDED });
  const coordinator = createCoordinator({ store, clock: { now: () => ENDED }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 1 });
  coordinator.discover(identity); coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening");
  store.beginReconciliationGeneration(identity.occurrenceId, "component-bridge", ENDED - 1_000);
  store.setReconciliationRuntimeSession(identity.occurrenceId, "component-bridge", 41n);
  coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, {
    recovery: { bridgeSessionId: "component-bridge", capability }, handle, encryptedPath: recordingPath, sha256: hash,
    durationMs: 20, format: "pcm_s16le/24000/1/20ms", keyId: capability.keyId, gaps: [], runtimeGaps: [],
  }, "component-bridge", ENDED, "bridge_observed", {
    terminalReason: "ended", terminalSource: "bridge_observed", endedAt: new Date(ENDED).toISOString(), identity,
    provider: "feishu", encryption: "aes-256-gcm", processingWarnings: [], provenance: {
      runtimeProfile: "online", sttProvider: "component-stt", sttModel: "stt-model", liveStreamModel: "live-model",
      finalBatchModel: "batch-model", textProvider: "component-text", textModel: "text-model", agentVersion: "component-only",
    },
  });
  coordinator.completeReconciliationGeneration(identity.occurrenceId, "component-bridge", ENDED, "bridge_observed", "ended");
  store.close();
  return {
    root, databasePath, recordingPath, recordingsDir, handle, hash, occurrenceId: identity.occurrenceId,
    open: () => openSessionStore({ filename: databasePath, nowMs: ENDED }),
    alter(sql: string) { const db = new Database(databasePath); try { db.exec(sql); } finally { db.close(); } },
    close() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("recovery projection preserves original deadlines and safe source identity without changing SQLite or exposing private capability fields", async () => {
  const { readKnownEndRecoveryState } = await helpers(), f = fixture();
  try {
    const before = readFileSync(f.databasePath), files = readdirSync(f.root).sort();
    const value = readKnownEndRecoveryState(f);
    assert.equal(value.endedAtMs, ENDED); assert.equal(value.stopAtMs, STOP); assert.equal(value.expiresAtMs, EXPIRY);
    assert.equal(value.source.sourceSessionId, "41"); assert.equal(value.source.handle, f.handle); assert.equal(value.source.sha256, f.hash);
    assert.equal(value.source.retention, "retained"); assert.equal(value.lifecycle.owner, "seed"); assert.equal(value.stage, "seed-pending");
    assert.deepEqual(value.pending, { deliveryCount: 0, jobCount: 0 });
    assert.equal(value.r1Preconditions.runtimeCleanupMarkerCleared, true);
    assert.equal(value.r1Preconditions.initialBuildFailed, false);
    assert.ok(Object.isFrozen(value) && Object.isFrozen(value.source) && Object.isFrozen(value.lifecycle));
    const encoded = JSON.stringify(value);
    assert.ok(!encoded.includes("d".repeat(64)) && !encoded.includes("c".repeat(16)));
    assert.ok(!/authorization|key[_A-Z]?id|claimToken|processOwnerToken/i.test(encoded));
    assert.deepEqual(readFileSync(f.databasePath), before); assert.deepEqual(readdirSync(f.root).sort(), files);
  } finally { f.close(); }
});

test("only real store failure and confirmed process settlement make the initial-failure restart preconditions true", async () => {
  const { readKnownEndRecoveryState } = await helpers(), f = fixture(), store = f.open();
  try {
    const claim = store.claimBackfillSeedBuild({ nowMs: ENDED + 1, claimToken: "1".repeat(32), operationBudgetMs: 1_000 })!;
    const process = store.beginBackfillProcess({ kind: "initial", occurrenceId: f.occurrenceId, claimToken: claim.claimToken, nowMs: ENDED + 2 });
    assert.equal(readKnownEndRecoveryState(f).stage, "runtime-cleanup-blocked");
    store.settleBackfillProcess({ occurrenceId: f.occurrenceId, processOwnerToken: process.processOwnerToken, nowMs: ENDED + 3, outcome: "confirmed" });
    store.failBackfillBuild({ kind: "initial", occurrenceId: f.occurrenceId, claimToken: claim.claimToken, nowMs: ENDED + 4, retryDelayMs: 1_000, reason: "build_failed" });
    const value = readKnownEndRecoveryState(f);
    assert.equal(value.stage, "initial-build-failed"); assert.equal(value.lifecycle.initialBuildAttempts, 1);
    assert.equal(value.lifecycle.initialBuildReason, "build_failed"); assert.equal(value.r1Preconditions.initialFailureRestartReady, true);
  } finally { store.close(); f.close(); }
});

test("failed Runtime cleanup remains blocked after the original expiry and does not become a cleanup proof", async () => {
  const { readKnownEndRecoveryState } = await helpers(), f = fixture(), store = f.open();
  try {
    const claim = store.claimBackfillSeedBuild({ nowMs: ENDED + 1, claimToken: "2".repeat(32), operationBudgetMs: 1_000 })!;
    const process = store.beginBackfillProcess({ kind: "initial", occurrenceId: f.occurrenceId, claimToken: claim.claimToken, nowMs: ENDED + 2 });
    store.settleBackfillProcess({ occurrenceId: f.occurrenceId, processOwnerToken: process.processOwnerToken, nowMs: ENDED + 3, outcome: "failed" });
    assert.equal(store.claimExpiredBackfillSeedCleanup({ nowMs: EXPIRY, claimToken: "3".repeat(32) }), null);
    const value = readKnownEndRecoveryState(f);
    assert.equal(value.stage, "runtime-cleanup-blocked"); assert.equal(value.lifecycle.processCleanupState, "failed");
    assert.equal(value.r1Preconditions.runtimeCleanupMarkerCleared, false); assert.equal(value.source.retention, "retained");
  } finally { store.close(); f.close(); }
});

test("expiry projection accepts actual seed tombstones after governed source deletion and generation purge", async () => {
  const { readKnownEndRecoveryState } = await helpers(), f = fixture(), store = f.open();
  try {
    assert.equal(store.claimExpiredBackfillSeedCleanup({ nowMs: EXPIRY - 1, claimToken: "4".repeat(32) }), null);
    const claim = store.claimExpiredBackfillSeedCleanup({ nowMs: EXPIRY, claimToken: "4".repeat(32) })!;
    deleteSeedRecordingEvidence({ recordingsDir: f.recordingsDir, recordingPath: claim.recordingPath, recordingHandle: claim.recordingHandle,
      recordingBytes: claim.recordingBytes, recordingDevice: claim.recordingDevice, recordingInode: claim.recordingInode });
    store.completeBackfillSeedCleanup({ occurrenceId: f.occurrenceId, claimToken: claim.claimToken, nowMs: EXPIRY });
    store.purgeExpiredReconciliationEvidence(EXPIRY);
    const value = readKnownEndRecoveryState(f);
    assert.equal(value.stage, "seed-deleted"); assert.equal(value.source.retention, "deleted");
    assert.equal(value.lifecycle.deletedAtMs, EXPIRY); assert.equal(value.generationRetained, false);
    assert.equal(value.stopAtMs, STOP); assert.equal(value.expiresAtMs, EXPIRY);
    assert.equal(value.r1Preconditions.initialFailureRestartReady, false);
  } finally { store.close(); f.close(); }
});

test("unknown occurrence or absent database never becomes a manufactured seed or database", async () => {
  const { readKnownEndRecoveryState } = await helpers(), f = fixture();
  try {
    assert.throws(() => readKnownEndRecoveryState({ ...f, occurrenceId: "foreign" }), /known-end seed/);
    const missing = path.join(f.root, "absent.db");
    assert.throws(() => readKnownEndRecoveryState({ ...f, databasePath: missing })); assert.equal(existsSync(missing), false);
  } finally { f.close(); }
});

for (const [name, sql] of [
  ["original expiry", "DROP TRIGGER backfill_seed_immutable_update; PRAGMA ignore_check_constraints=ON; UPDATE backfill_seeds SET expires_at_ms=expires_at_ms+1"],
  ["positive terminal reason", "UPDATE reconciliation_generations SET terminal_reason='removed'"],
  ["generation recording handle", "UPDATE reconciliation_generations SET recording_handle='" + "f".repeat(32) + "'"],
  ["recording hash", "UPDATE recordings SET sha256='" + "e".repeat(64) + "'"],
  ["recovery source", "UPDATE recording_recovery_bindings SET source_session_id='42'"],
  ["lifecycle authority", "UPDATE backfill_seed_lifecycle SET owner='delivery'"],
] as const) {
  test(`recovery projection refuses tampered ${name} instead of treating it as source-backed restart evidence`, async () => {
    const { readKnownEndRecoveryState } = await helpers(), f = fixture();
    try { f.alter(sql); assert.throws(() => readKnownEndRecoveryState(f)); } finally { f.close(); }
  });
}

test("missing or replaced retained ciphertext fails before its deletion is inferred", async () => {
  const { readKnownEndRecoveryState } = await helpers(), f = fixture();
  try {
    truncateSync(f.recordingPath, 0); assert.throws(() => readKnownEndRecoveryState(f), /recording identity/);
    rmSync(f.recordingPath); assert.throws(() => readKnownEndRecoveryState(f), /retained recording/);
  } finally { f.close(); }
});

test("replacement ciphertext with identical bytes remains a different physical source", async () => {
  const { readKnownEndRecoveryState } = await helpers(), f = fixture();
  try {
    const bytes = readFileSync(f.recordingPath);
    renameSync(f.recordingPath, `${f.recordingPath}.original`);
    writeFileSync(f.recordingPath, bytes, { mode: 0o600 });
    assert.throws(() => readKnownEndRecoveryState(f), /recording identity/);
  } finally { f.close(); }
});

test("selected alignment must remain complete and bound to the exact recording source", async () => {
  const { readKnownEndRecoveryState } = await helpers(), f = fixture(), store = f.open();
  try {
    const recovery = store.getRecordingRecovery(f.occurrenceId, "component-bridge", f.handle)!;
    const claim = store.beginRecordingAlignment(recovery.generationId, "component-owner");
    assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed") throw new Error("missing component alignment claim");
    const selected = store.completeRecordingAlignment(claim.attempt, {
      type: "recording_alignment_complete", source: { sourceSessionId: 41n, recordingHandle: f.handle, sha256: f.hash },
      pageCount: 0n, coverageStatus: "unavailable_legacy", warnings: ["unavailable_legacy"], traversalSucceeded: true,
    });
    assert.deepEqual(readKnownEndRecoveryState(f).selectedAlignment,
      { attemptId: selected.attemptId, state: "complete", coverageStatus: "unavailable_legacy" });
    f.alter("UPDATE recording_alignment_attempts SET source_session_id='42'");
    assert.throws(() => readKnownEndRecoveryState(f), /selected recording attempt/);
    f.alter("UPDATE recording_alignment_attempts SET source_session_id='41',state='abandoned',coverage_status=NULL");
    assert.throws(() => readKnownEndRecoveryState(f), /selected recording attempt/);
  } finally { store.close(); f.close(); }
});

test("initial occurrence locator refuses zero or multiple seeds without choosing an arbitrary occurrence", async () => {
  const { readSeedOccurrenceId } = await helpers(), f = fixture();
  try {
    const emptyPath = path.join(f.root, "empty.db");
    openSessionStore({ filename: emptyPath, nowMs: ENDED }).close();
    assert.throws(() => readSeedOccurrenceId(emptyPath), /exactly one/);
    assert.equal(readSeedOccurrenceId(f.databasePath), f.occurrenceId);
    // Deliberately corrupt only the locator table in this migrated component
    // fixture. This cannot become admitted source/recovery evidence.
    f.alter("ALTER TABLE backfill_seeds RENAME TO component_original_seeds; CREATE TABLE backfill_seeds AS SELECT occurrence_id FROM component_original_seeds; INSERT INTO backfill_seeds VALUES('foreign')");
    assert.throws(() => readSeedOccurrenceId(f.databasePath), /exactly one/);
  } finally { f.close(); }
});

test("reader refuses WAL sidecars without checkpointing or altering a live database", async () => {
  const { readKnownEndRecoveryState } = await helpers(), f = fixture();
  try {
    writeFileSync(`${f.databasePath}-wal`, "component sentinel");
    const before = lstatSync(`${f.databasePath}-wal`).size;
    assert.throws(() => readKnownEndRecoveryState(f), /WAL snapshot/);
    assert.equal(lstatSync(`${f.databasePath}-wal`).size, before);
  } finally { f.close(); }
});

test("deadline clock advances monotonically at exact millisecond boundaries without replacing Runtime monotonic time", async () => {
  const { createRecoveryClock } = await helpers();
  const clock = createRecoveryClock(ENDED);
  assert.equal(clock.now(), ENDED); assert.equal(clock.advanceTo(STOP - 1), STOP - 1); assert.equal(clock.advanceTo(STOP), STOP);
  assert.equal(clock.advanceTo(STOP), STOP); assert.throws(() => clock.advanceTo(STOP - 1), /clock regression/);
  assert.equal(clock.now(), STOP); assert.equal(clock.advanceTo(EXPIRY), EXPIRY);
  assert.equal("monotonicNow" in clock, false);
  for (const invalid of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 8_640_000_000_000_001]) {
    assert.throws(() => createRecoveryClock(invalid), /clock instant/);
    assert.throws(() => clock.advanceTo(invalid), /clock instant/);
  }
});

test("warning projection retains actual retry and claimed/terminal state rather than guessing claim expiry", async () => {
  const { readKnownEndRecoveryState, readSeedOccurrenceId } = await helpers(), f = fixture(), store = f.open();
  try {
    assert.equal(readSeedOccurrenceId(f.databasePath), f.occurrenceId);
    store.stopDueBackfill({ nowMs: STOP });
    const claim = store.claimBackfillWarning({ nowMs: STOP, claimToken: "5".repeat(32) })!;
    assert.equal(readKnownEndRecoveryState(f).warning.claimed, true);
    assert.equal(readKnownEndRecoveryState(f).warning.claimExpiresAtMs, claim.claimExpiresAtMs);
    assert.ok(!JSON.stringify(readKnownEndRecoveryState(f)).includes(claim.claimToken));
    store.failBackfillWarning({ occurrenceId: f.occurrenceId, claimToken: claim.claimToken, nowMs: STOP, retryDelayMs: 1_000, reason: "sink_failed" });
    const value = readKnownEndRecoveryState(f);
    assert.equal(value.warning.nextAttemptAtMs, STOP + 1_000); assert.equal(value.warning.claimed, false);
    assert.equal(value.warning.terminalReason, null); assert.equal(value.warning.attemptCount, 1);
    store.claimBackfillWarning({ nowMs: EXPIRY, claimToken: "6".repeat(32) });
    assert.equal(readKnownEndRecoveryState(f).warning.terminalReason, "expired");
  } finally { store.close(); f.close(); }
});

test("accepted warning state comes from actual store settlement and excludes private claims", async () => {
  const { readKnownEndRecoveryState } = await helpers(), f = fixture(), store = f.open();
  try {
    store.stopDueBackfill({ nowMs: STOP });
    const claim = store.claimBackfillWarning({ nowMs: STOP, claimToken: "7".repeat(32) })!;
    store.acceptBackfillWarning({ occurrenceId: f.occurrenceId, claimToken: claim.claimToken, key: claim.key, nowMs: STOP + 1 });
    const before = readFileSync(f.databasePath), value = readKnownEndRecoveryState(f);
    assert.deepEqual(value.warning, { state: "accepted", attemptCount: 1, acceptedAtMs: STOP + 1,
      nextAttemptAtMs: STOP, terminalReason: null, claimed: false, claimExpiresAtMs: null });
    assert.ok(Object.isFrozen(value.warning));
    assert.ok(!JSON.stringify(value).includes(claim.claimToken));
    assert.deepEqual(readFileSync(f.databasePath), before);
  } finally { store.close(); f.close(); }
});

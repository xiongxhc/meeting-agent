import assert from "node:assert/strict";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import { openSessionStore, type OpenSessionStoreOptions } from "../src/adapters/sqlite-session-store.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import type { BackfillSeedConfig, BackfillSeedFinalizationInput, RecordingInput } from "../src/ports/session-store.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { createMeetingSession } from "../src/sessions/meeting-session.ts";
import type { ConversationRuntimePort, RuntimeEvent } from "../src/ports/conversation-runtime.ts";
import { testCapability } from "./lib/runtime-sdk.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const ENDED_AT = "2026-09-02T14:10:00.123Z";
const ENDED_AT_MS = Date.parse(ENDED_AT);

function seedConfig(): BackfillSeedConfig {
  return {
    provider: "feishu",
    encryption: "aes-256-gcm",
    processingWarnings: [{ code: "capture_gap", detail: "One bounded synthetic gap." }],
    provenance: {
      runtimeProfile: "online",
      sttProvider: "provider-stt",
      sttModel: "stt-v1",
      liveStreamModel: "stream-v1",
      finalBatchModel: "final-v2",
      textProvider: "provider-text",
      textModel: "text-v3",
      agentVersion: "meeting-agent/test",
    },
  };
}

function seedInput(identity: ReturnType<typeof buildMeetingIdentity>, endedAt = ENDED_AT): BackfillSeedFinalizationInput {
  return { ...seedConfig(), terminalReason: "ended", terminalSource: "bridge_observed", endedAt, identity };
}

function fixture(options: Pick<OpenSessionStoreOptions, "seedIdentityCheckpoint"> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-backfill-seed-"));
  const filename = path.join(dir, "state.db");
  const recordingsDir = path.join(dir, "recordings");
  mkdirSync(recordingsDir);
  const recordingPath = path.join(recordingsDir, `${testCapability.recordingHandle}.crsr`);
  writeFileSync(recordingPath, Buffer.from("synthetic-ciphertext"));
  const store = openSessionStore({ filename, ...options });
  const identity = buildMeetingIdentity({
    providerMeetingId: "meeting-seed",
    meetingNo: "123456789",
    occurrenceStartedAt: "2026-09-02T14:00:00Z",
    title: "Seeded meeting",
    organizer: { feishuUserId: "ou_organizer", displayName: "Organizer", source: "reservation" },
  });
  let nowMs = ENDED_AT_MS;
  const coordinator = createCoordinator({ store, clock: { now: () => nowMs }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 1 });
  coordinator.discover(identity);
  coordinator.advance(identity.occurrenceId, "joining");
  coordinator.advance(identity.occurrenceId, "listening");
  store.beginReconciliationGeneration(identity.occurrenceId, "bridge-seed", ENDED_AT_MS - 1_000);
  store.setReconciliationRuntimeSession(identity.occurrenceId, "bridge-seed", testCapability.sourceSessionId);
  const recording: RecordingInput = {
    recovery: { bridgeSessionId: "bridge-seed", capability: testCapability },
    handle: testCapability.recordingHandle,
    encryptedPath: recordingPath,
    sha256: testCapability.sha256,
    durationMs: 600_123,
    format: "pcm_s16le/24000/1/20ms",
    keyId: testCapability.keyId,
    gaps: [{ direction: "capture", startedAt: "2026-09-02T14:04:00Z", endedAt: "2026-09-02T14:04:01Z" }],
    runtimeGaps: [{ startedAtMs: 240n, endedAtMs: 480n, reason: "runtime_gap" }],
  };
  return {
    dir, filename, recordingPath, store, identity, coordinator, recording,
    setNow(value: number) { nowMs = value; },
    finalize(input = seedInput(identity), source: "bridge_observed" | "local_clock" = "bridge_observed", terminalAtMs = ENDED_AT_MS) {
      return coordinator.finalizeWithRecording(
        identity.occurrenceId,
        { kind: "advance", toState: "finalizing" },
        recording,
        "bridge-seed",
        terminalAtMs,
        source,
        input,
      );
    },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function addSeededOccurrence(f: ReturnType<typeof fixture>, ordinal: number, endedAtMs: number) {
  const hex = ordinal.toString(16);
  const identity = buildMeetingIdentity({
    providerMeetingId: `meeting-seed-${ordinal}`,
    meetingNo: `12345678${ordinal}`,
    occurrenceStartedAt: new Date(Math.floor((endedAtMs - 10 * 60_000) / 1_000) * 1_000).toISOString().replace(".000Z", "Z"),
    title: `Seeded meeting ${ordinal}`,
    organizer: null,
  });
  const ciphertext = Buffer.from(`synthetic-ciphertext-${ordinal}`);
  const capability = {
    sourceSessionId: BigInt(100 + ordinal),
    recordingHandle: hex.repeat(32),
    sha256: hex.repeat(64),
    keyId: hex.repeat(16),
    authorization: hex.repeat(64),
  };
  const recordingPath = path.join(path.dirname(f.recordingPath), `${capability.recordingHandle}.crsr`);
  writeFileSync(recordingPath, ciphertext);
  const coordinator = createCoordinator({ store: f.store, clock: { now: () => endedAtMs },
    bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 1 });
  coordinator.discover(identity);
  coordinator.advance(identity.occurrenceId, "joining");
  coordinator.advance(identity.occurrenceId, "listening");
  const bridgeSessionId = `bridge-seed-${ordinal}`;
  f.store.beginReconciliationGeneration(identity.occurrenceId, bridgeSessionId, endedAtMs - 1_000);
  f.store.setReconciliationRuntimeSession(identity.occurrenceId, bridgeSessionId, capability.sourceSessionId);
  coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, {
    recovery: { bridgeSessionId, capability }, handle: capability.recordingHandle, encryptedPath: recordingPath,
    sha256: capability.sha256, durationMs: 1_000, format: "pcm_s16le/24000/1/20ms", keyId: capability.keyId,
    gaps: [], runtimeGaps: [],
  }, bridgeSessionId, endedAtMs, "bridge_observed", seedInput(identity, new Date(endedAtMs).toISOString()));
  return f.store.getBackfillSeed(identity.occurrenceId)!;
}

test("migrations 023 through 025 add bounded seed work state without inventing legacy inputs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-backfill-migrate-"));
  const filename = path.join(dir, "state.db");
  const oldMigrations = path.join(dir, "migrations-022");
  mkdirSync(oldMigrations);
  cpSync(path.resolve("migrations"), oldMigrations, {
    recursive: true,
    filter: (source) => path.basename(source) === "migrations" || !/^(?:023|024|025|026|027|028|029|030|031)_/.test(path.basename(source)),
  });
  try {
    const oldStore = openSessionStore({ filename, migrationsDir: oldMigrations, nowMs: 1 });
    const identity = buildMeetingIdentity({ providerMeetingId: "legacy", meetingNo: "1", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Legacy", organizer: null });
    oldStore.createSession({ occurrenceId: identity.occurrenceId, providerMeetingId: identity.providerMeetingId, occurrenceStartedAt: identity.occurrenceStartedAt, nowMs: 1 });
    assert.equal(oldStore.schemaVersion, 22);
    oldStore.close();

    const upgraded = openSessionStore({ filename, nowMs: 2 });
    try {
      assert.equal(upgraded.schemaVersion, 31);
      assert.equal(upgraded.getBackfillSeed(identity.occurrenceId), null);
      const schema = new Map(upgraded.describeSchema().map((table) => [table.name, table]));
      assert.match(schema.get("backfill_seeds")?.sql ?? "", /STRICT/);
      assert.match(schema.get("backfill_seed_lifecycle")?.sql ?? "", /STRICT/);
      assert.match(schema.get("backfill_jobs")?.sql ?? "", /STRICT/);
      assert.match(schema.get("backfill_warning_intents")?.sql ?? "", /STRICT/);
      const raw = new Database(filename, { readonly: true });
      try { assert.deepEqual(raw.prepare("SELECT count(*) AS count FROM backfill_jobs").get(), { count: 0 }); }
      finally { raw.close(); }
      assert.deepEqual(upgraded.foreignKeyCheck(), []);
    } finally { upgraded.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SQL rejects an unparseable seed end while preserving canonical UTC second and millisecond spellings", () => {
  const f = fixture();
  try {
    const finalizeParent = (ordinal: number, endedAt: string) => {
      const digit = String(ordinal);
      const identity = buildMeetingIdentity({ providerMeetingId: `sql-date-${digit}`, meetingNo: `900${digit}`,
        occurrenceStartedAt: `2026-09-02T14:00:0${digit}Z`, title: `SQL date ${digit}`, organizer: null });
      const capability = { sourceSessionId: BigInt(41 + ordinal), recordingHandle: digit.repeat(32),
        sha256: digit.repeat(64), keyId: digit.repeat(16), authorization: digit.repeat(64) };
      const encryptedPath = path.join(f.dir, `${capability.recordingHandle}.crsr`);
      writeFileSync(encryptedPath, Buffer.from(`sql-date-${digit}`));
      f.coordinator.discover(identity);
      f.coordinator.advance(identity.occurrenceId, "joining");
      f.coordinator.advance(identity.occurrenceId, "listening");
      const bridgeSessionId = `bridge-sql-${digit}`;
      f.store.beginReconciliationGeneration(identity.occurrenceId, bridgeSessionId, Date.parse(endedAt) - 1_000);
      f.store.setReconciliationRuntimeSession(identity.occurrenceId, bridgeSessionId, capability.sourceSessionId);
      f.coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, {
        recovery: { bridgeSessionId, capability }, handle: capability.recordingHandle, encryptedPath,
        sha256: capability.sha256, durationMs: 10, format: "pcm_s16le/24000/1/20ms", keyId: capability.keyId,
        gaps: [], runtimeGaps: [],
      }, bridgeSessionId, Date.parse(endedAt), "bridge_observed");
      return { identity, endedAt, endedAtMs: Date.parse(endedAt), encryptedPath };
    };
    const malformed = finalizeParent(1, "2026-09-02T14:11:00Z");
    const wholeSecond = finalizeParent(2, "2026-09-02T14:12:00Z");
    const milliseconds = finalizeParent(3, "2026-09-02T14:13:00.456Z");
    const raw = new Database(f.filename);
    try {
      raw.pragma("foreign_keys = ON");
      const insert = raw.prepare(`INSERT INTO backfill_seeds (
        occurrence_id,provider,provider_meeting_id,meeting_no,occurrence_started_at,title,
        organizer_person_id,organizer_display_name,organizer_source,ended_at,ended_at_ms,stop_at_ms,expires_at_ms,
        bridge_session_id,generation_id,source_session_id,capability_recording_handle,capability_sha256,capability_key_id,capability_authorization,
        recording_path,recording_format,recording_encryption,recording_bytes,recording_device,recording_inode,recording_duration_ms,
        recording_sha256,recording_key_id,bridge_gaps_json,runtime_gaps_json,processing_warnings_json,runtime_profile,
        stt_provider,stt_model,live_stream_model,final_batch_model,text_provider,text_model,agent_version
      ) SELECT
        @occurrenceId,'feishu',@providerMeetingId,@meetingNo,@occurrenceStartedAt,@title,
        NULL,NULL,NULL,@endedAt,@endedAtMs,@stopAtMs,@expiresAtMs,
        recovery.bridge_session_id,recovery.generation_id,recovery.source_session_id,recovery.recording_handle,recovery.sha256,recovery.key_id,recovery.authorization,
        recording.encrypted_path,recording.format,'aes-256-gcm',@recordingBytes,@recordingDevice,@recordingInode,recording.duration_ms,
        recording.sha256,recording.key_id,'[]','[]','[]','online',
        'provider-stt','stt-v1','stream-v1','final-v2','provider-text','text-v3','meeting-agent/test'
      FROM recording_recovery_bindings AS recovery
      JOIN recordings AS recording ON recording.occurrence_id=recovery.occurrence_id
      WHERE recovery.occurrence_id=@occurrenceId`);
      const insertSeed = (target: ReturnType<typeof finalizeParent>, endedAt = target.endedAt) => {
        const stat = lstatSync(target.encryptedPath, { bigint: true });
        const endedAtMs = target.endedAtMs;
        return insert.run({ occurrenceId: target.identity.occurrenceId,
          providerMeetingId: target.identity.providerMeetingId, meetingNo: target.identity.meetingNo,
          occurrenceStartedAt: target.identity.occurrenceStartedAt, title: target.identity.title,
          endedAt, endedAtMs, stopAtMs: endedAtMs + 11 * DAY_MS, expiresAtMs: endedAtMs + 14 * DAY_MS,
          recordingBytes: Number(stat.size), recordingDevice: stat.dev.toString(), recordingInode: stat.ino.toString() });
      };
      assert.throws(() => insertSeed(malformed, "xxxxxxxxxxxxxxxxxxxx"), /constraint/i);
      assert.equal(insertSeed(wholeSecond).changes, 1);
      assert.equal(insertSeed(milliseconds).changes, 1);
      assert.equal(f.store.getBackfillSeed(wholeSecond.identity.occurrenceId)?.endedAt, wholeSecond.endedAt);
      assert.equal(f.store.getBackfillSeed(milliseconds.identity.occurrenceId)?.endedAt, milliseconds.endedAt);
      assert.deepEqual(f.store.foreignKeyCheck(), []);
    } finally { raw.close(); }
  } finally { f.close(); }
});

test("qualifying finalization atomically persists one exact immutable seed and seed-owned lifecycle across reopen", () => {
  const f = fixture();
  try {
    f.finalize();
    const stat = lstatSync(f.recordingPath, { bigint: true });
    const expected = {
      occurrenceId: f.identity.occurrenceId,
      provider: "feishu",
      providerMeetingId: "meeting-seed",
      meetingNo: "123456789",
      occurrenceStartedAt: "2026-09-02T14:00:00Z",
      title: "Seeded meeting",
      organizer: { feishuUserId: "ou_organizer", displayName: "Organizer", source: "reservation" as const },
      endedAt: ENDED_AT,
      endedAtMs: ENDED_AT_MS,
      expiresAtMs: ENDED_AT_MS + 14 * DAY_MS,
      stopAtMs: ENDED_AT_MS + 11 * DAY_MS,
      bridgeSessionId: "bridge-seed",
      generationId: "6d656574696e672d7365656440323032362d30392d30325431343a30303a30305a:6272696467652d73656564",
      capability: testCapability,
      recordingPath: path.resolve(f.recordingPath),
      // D032 §3: the seed carries the published audio-format token; the
      // recording row keeps the Runtime's own slashed spelling.
      recordingFormat: "pcm_s16le-24000-1-20ms",
      recordingEncryption: "aes-256-gcm",
      recordingBytes: Buffer.byteLength("synthetic-ciphertext"),
      recordingDevice: stat.dev.toString(),
      recordingInode: stat.ino.toString(),
      recordingDurationMs: 600_123,
      recordingSha256: testCapability.sha256,
      recordingKeyId: testCapability.keyId,
      bridgeGaps: [{ direction: "capture", startedAt: "2026-09-02T14:04:00Z", endedAt: "2026-09-02T14:04:01Z" }],
      runtimeGaps: [{ startedAtMs: 240n, endedAtMs: 480n, reason: "runtime_gap" }],
      processingWarnings: [{ code: "capture_gap", detail: "One bounded synthetic gap." }],
      provenance: seedInput(f.identity).provenance,
    };
    assert.deepEqual(f.store.getBackfillSeed(f.identity.occurrenceId), expected);
    assert.throws(() => f.finalize(), /legal transition|terminal state/);
    assert.deepEqual(f.store.getBackfillSeed(f.identity.occurrenceId), expected);
    const raw = new Database(f.filename);
    try {
      assert.deepEqual(raw.prepare("SELECT owner,state,stop_at_ms AS stopAtMs,expires_at_ms AS expiresAtMs,initial_build_attempts AS attempts FROM backfill_seed_lifecycle").get(), {
        owner: "seed", state: "pending", stopAtMs: expected.stopAtMs, expiresAtMs: expected.expiresAtMs, attempts: 0,
      });
      assert.deepEqual(raw.prepare("SELECT count(*) AS count FROM delivery_journal").get(), { count: 0 });
      assert.throws(() => raw.prepare("UPDATE backfill_seeds SET title='changed' WHERE occurrence_id=?").run(f.identity.occurrenceId), /immutable/);
      assert.throws(() => raw.prepare("DELETE FROM backfill_seeds WHERE occurrence_id=?").run(f.identity.occurrenceId), /immutable/);
      assert.throws(() => raw.prepare("UPDATE backfill_seed_lifecycle SET stop_at_ms=stop_at_ms+1 WHERE occurrence_id=?").run(f.identity.occurrenceId), /immutable|binding/);
      assert.throws(() => raw.prepare(`UPDATE backfill_seed_lifecycle
        SET process_owner_token=?,process_cleanup_state='failed' WHERE occurrence_id=?`)
        .run("a".repeat(32), f.identity.occurrenceId), /process ownership fence/);
    } finally { raw.close(); }
    f.store.close();
    const reopened = openSessionStore({ filename: f.filename });
    try { assert.deepEqual(reopened.getBackfillSeed(f.identity.occurrenceId), expected); }
    finally { reopened.close(); }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("invalid end provenance, ciphertext size and symlink identity roll back finalization", () => {
  const cases: Array<{ name: string; arrange(f: ReturnType<typeof fixture>): void; input(f: ReturnType<typeof fixture>): BackfillSeedFinalizationInput; source?: "bridge_observed" | "local_clock"; terminalAtMs?: number }> = [
    { name: "removed", arrange() {}, input: (f) => ({ ...seedInput(f.identity), terminalReason: "removed" } as unknown as BackfillSeedFinalizationInput) },
    { name: "local clock", arrange() {}, input: (f) => seedInput(f.identity), source: "local_clock" },
    { name: "mismatched instant", arrange() {}, input: (f) => seedInput(f.identity), terminalAtMs: ENDED_AT_MS + 1 },
    { name: "empty ciphertext", arrange: (f) => truncateSync(f.recordingPath, 0), input: (f) => seedInput(f.identity) },
    { name: "oversized ciphertext", arrange: (f) => truncateSync(f.recordingPath, 8 * 1024 ** 3 + 1), input: (f) => seedInput(f.identity) },
    { name: "symlink ciphertext", arrange: (f) => { const target = `${f.recordingPath}.target`; renameSync(f.recordingPath, target); symlinkSync(target, f.recordingPath); }, input: (f) => seedInput(f.identity) },
  ];
  for (const scenario of cases) {
    const f = fixture();
    try {
      scenario.arrange(f);
      assert.throws(() => f.finalize(scenario.input(f), scenario.source, scenario.terminalAtMs), scenario.name);
      assert.equal(f.coordinator.get(f.identity.occurrenceId)?.state, "listening", scenario.name);
      assert.equal(f.store.getRecording(f.identity.occurrenceId), null, scenario.name);
      assert.equal(f.store.getBackfillSeed(f.identity.occurrenceId), null, scenario.name);
    } finally { f.close(); }
  }
});

test("a duplicated ended seed cannot override the actual failed terminal transition", () => {
  const f = fixture();
  try {
    assert.throws(() => f.coordinator.finalizeWithRecording(
      f.identity.occurrenceId,
      { kind: "fail", terminalReason: "removed" },
      f.recording,
      "bridge-seed",
      ENDED_AT_MS,
      "bridge_observed",
      seedInput(f.identity),
    ), /ended|terminal|transition/);
    assert.equal(f.coordinator.get(f.identity.occurrenceId)?.state, "listening");
    assert.equal(f.store.getRecording(f.identity.occurrenceId), null);
    assert.equal(f.store.getBackfillSeed(f.identity.occurrenceId), null);
  } finally { f.close(); }
});

test("ciphertext inode or size changes at the pre-commit fence roll back the whole transaction", () => {
  for (const mutation of ["replace", "grow"] as const) {
    let checkpointCalls = 0;
    const f = fixture({ seedIdentityCheckpoint(recordingPath) {
      checkpointCalls += 1;
      if (mutation === "replace") {
        renameSync(recordingPath, `${recordingPath}.old`);
        writeFileSync(recordingPath, Buffer.from("synthetic-ciphertext"));
      } else {
        writeFileSync(recordingPath, Buffer.from("synthetic-ciphertext-grown"));
      }
    } });
    try {
      assert.throws(() => f.finalize(), /identity|size|changed/);
      assert.equal(checkpointCalls, 1);
      assert.equal(f.coordinator.get(f.identity.occurrenceId)?.state, "listening");
      assert.equal(f.store.getRecording(f.identity.occurrenceId), null);
      assert.equal(f.store.getBackfillSeed(f.identity.occurrenceId), null);
      const raw = new Database(f.filename, { readonly: true });
      try { assert.deepEqual(raw.prepare("SELECT count(*) AS count FROM backfill_seed_lifecycle").get(), { count: 0 }); }
      finally { raw.close(); }
    } finally { f.close(); }
  }
});

test("two stores grant one bounded initial-build owner, then reclaim only at derived stale expiry", () => {
  const f = fixture();
  try {
    f.finalize();
    const other = openSessionStore({ filename: f.filename });
    let otherClosed = false;
    try {
      const first = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1, claimToken: "a".repeat(32), operationBudgetMs: 1_000 });
      assert.equal(first?.claimExpiresAtMs, ENDED_AT_MS + 61_001);
      assert.equal(first?.attempt, 1);
      assert.equal(first?.seed.occurrenceId, f.identity.occurrenceId);
      assert.equal(other.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 2, claimToken: "b".repeat(32), operationBudgetMs: 1_000 }), null);
      const reclaimed = other.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 61_001, claimToken: "b".repeat(32), operationBudgetMs: 900_000 });
      assert.equal(reclaimed?.claimExpiresAtMs, ENDED_AT_MS + 1_021_001);
      assert.equal(reclaimed?.attempt, 2);
      assert.equal(f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 61_002, claimToken: "c".repeat(32), operationBudgetMs: 1_000 }), null);
      assert.throws(() => f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1, claimToken: "A".repeat(32), operationBudgetMs: 1_000 }), /token/);
      assert.throws(() => f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1, claimToken: "d".repeat(32), operationBudgetMs: 999 }), /budget/);
      assert.equal(other.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 11 * DAY_MS, claimToken: "e".repeat(32), operationBudgetMs: 1_000 }), null);
      other.close();
      otherClosed = true;
      const reopened = openSessionStore({ filename: f.filename });
      try {
        assert.equal(reopened.claimBackfillSeedBuild({
          nowMs: ENDED_AT_MS + 1_021_001,
          claimToken: "f".repeat(32),
          operationBudgetMs: 1_000,
        }), null, "a clock rollback after observed stop cannot reopen the immutable build window");
        const raw = new Database(f.filename, { readonly: true });
        try {
          assert.deepEqual(raw.prepare("SELECT state,build_claim_token AS claim FROM backfill_seed_lifecycle").get(), {
            state: "stopped", claim: null,
          });
        } finally { raw.close(); }
      } finally { reopened.close(); }
    } finally { if (!otherClosed) other.close(); }
  } finally { f.close(); }
});

test("claim-time stop persists per occurrence without starving another eligible seed behind a future retry", () => {
  const f = fixture();
  try {
    f.finalize();
    const laterA = addSeededOccurrence(f, 2, ENDED_AT_MS + DAY_MS);
    const laterB = addSeededOccurrence(f, 3, ENDED_AT_MS + DAY_MS);
    const nowMs = f.store.getBackfillSeed(f.identity.occurrenceId)!.stopAtMs;
    assert.equal(f.store.claimBackfillSeedBuild({ nowMs, claimToken: "a".repeat(32), operationBudgetMs: 1_000 }), null);
    const future = f.store.claimBackfillSeedBuild({ nowMs, claimToken: "b".repeat(32), operationBudgetMs: 1_000 })!;
    assert.ok([laterA.occurrenceId, laterB.occurrenceId].includes(future.seed.occurrenceId));
    assert.deepEqual(f.store.failBackfillBuild({ kind: "initial", occurrenceId: future.seed.occurrenceId,
      claimToken: future.claimToken, nowMs: nowMs + 1, retryDelayMs: 1_000,
      reason: "runtime_failed" }), { kind: "rescheduled" });
    const other = openSessionStore({ filename: f.filename });
    try {
      const eligible = other.claimBackfillSeedBuild({ nowMs: nowMs + 1,
        claimToken: "c".repeat(32), operationBudgetMs: 1_000 })!;
      assert.ok(eligible);
      assert.notEqual(eligible.seed.occurrenceId, future.seed.occurrenceId);
      assert.ok([laterA.occurrenceId, laterB.occurrenceId].includes(eligible.seed.occurrenceId));
      const raw = new Database(f.filename, { readonly: true });
      try {
        assert.deepEqual(raw.prepare("SELECT state,last_observed_at_ms AS observed FROM backfill_seed_lifecycle WHERE occurrence_id=?")
          .get(f.identity.occurrenceId), { state: "stopped", observed: nowMs });
      } finally { raw.close(); }
    } finally { other.close(); }
  } finally { f.close(); }
});

test("meeting session seeds only exact bridge-observed ended with supplied provenance and preserves the observed string", async () => {
  for (const scenario of [
    { reason: "ended" as const, supplied: true, joined: true, expected: ENDED_AT },
    { reason: "removed" as const, supplied: true, joined: true, expected: null },
    { reason: "ended" as const, supplied: false, joined: true, expected: null },
    { reason: "ended" as const, supplied: true, joined: false, expected: null },
  ]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-backfill-session-"));
    const filename = path.join(dir, "state.db");
    const recordingPath = path.join(dir, `${testCapability.recordingHandle}.crsr`);
    writeFileSync(recordingPath, Buffer.from("session-ciphertext"));
    const store = openSessionStore({ filename });
    const identity = buildMeetingIdentity({ providerMeetingId: `session-${scenario.reason}-${scenario.supplied}`, meetingNo: "998877665",
      occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Session seed", organizer: null });
    const coordinator = createCoordinator({ store, clock: { now: () => ENDED_AT_MS }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 1 });
    coordinator.discover(identity);
    let bridgeListener: ((raw: unknown) => void) | undefined;
    let sequence = 0;
    const bridge = {
      async send() {},
      subscribe(listener: (raw: unknown) => void) { bridgeListener = listener; return () => { bridgeListener = undefined; }; },
      emit(type: "joined" | "left", reason?: "ended" | "removed") {
        sequence += 1;
        bridgeListener?.({ schema: "bridge-session/v2", sessionId: "bridge-seed", sequence, observedAt: ENDED_AT, type,
          ...(type === "joined" ? { meetingOccurrenceId: identity.occurrenceId } : { reason }),
          observationTiming: null, observationTimingReason: "timing_unavailable" });
      },
    };
    const runtimeListeners = new Set<(event: RuntimeEvent) => void>();
    let runtimeClosed = false;
    const runtime: ConversationRuntimePort = {
      currentSessionId: testCapability.sourceSessionId,
      async startVoiceSession() {
        return { timingContract: "capture-clock/v1", bridgeSessionId: "bridge-seed", sessionId: testCapability.sourceSessionId,
          mediaLease: { mediaProtocolVersion: 2, sessionId: testCapability.sourceSessionId, connectEndpoint: "tcp://127.0.0.1:9001",
            credential: "synthetic", expiresAtMs: BigInt(ENDED_AT_MS + 60_000), reconnectWindowMs: 10_000n,
            captureFormat: "pcm_s16le/24000/1/20ms", timingContract: "capture-clock/v1" } };
      },
      async seedConversationContext() {}, async authorizeVoiceResponse() { return 1n; }, async skipVoiceResponse() {},
      async processText() { return { output: null, warnings: [] }; },
      async finalizeRecording() { return { recoveryCapability: testCapability, recordingHandle: testCapability.recordingHandle,
        encryptedPath: recordingPath, sha256: testCapability.sha256, durationMs: 10n,
        format: "pcm_s16le/24000/1/20ms", keyId: testCapability.keyId, gaps: [] }; },
      async *readRecordingAlignment() {},
      async reconcileRecording() { return { segments: [], warnings: [] }; },
      subscribe(listener) { runtimeListeners.add(listener); return () => { runtimeListeners.delete(listener); }; },
      async close() { runtimeClosed = true; },
    };
    const session = createMeetingSession({ identity, bridge, runtime, coordinator, clock: { now: () => ENDED_AT_MS },
      agentIdentity: { aliases: ["Meetbot"] }, bridgeId: "mac", bridgeSessionId: "bridge-seed", disclosureText: "Disclosure",
      timedEvidence: { store }, ...(scenario.supplied ? { backfillSeedConfig: {
        ...seedConfig(),
        // Deliberately hostile excess fields prove configuration cannot
        // manufacture finalization authority; the session overwrites them
        // with its actual identity and validated bridge event.
        identity: buildMeetingIdentity({ providerMeetingId: "wrong", meetingNo: "wrong", occurrenceStartedAt: "2026-09-02T13:00:00Z", title: "Wrong", organizer: null }),
        terminalReason: "removed", terminalSource: "local_clock", endedAt: "2026-09-02T13:00:00Z",
    } as unknown as BackfillSeedConfig } : {}) });
    try {
      await session.join();
      if (scenario.joined) { bridge.emit("joined"); await session.settled(); }
      bridge.emit("left", scenario.reason); await session.settled();
      assert.equal(store.getBackfillSeed(identity.occurrenceId)?.endedAt ?? null, scenario.expected);
      if (!scenario.joined) {
        assert.equal(coordinator.get(identity.occurrenceId)?.state, "failed");
        assert.deepEqual(store.getRecording(identity.occurrenceId), {
          occurrenceId: identity.occurrenceId, handle: testCapability.recordingHandle, encryptedPath: recordingPath,
          sha256: testCapability.sha256, durationMs: 10, format: "pcm_s16le/24000/1/20ms", keyId: testCapability.keyId,
          finalizedAtMs: ENDED_AT_MS, gaps: [], runtimeGaps: [],
          // A media-v2 lease makes no drain claim (D029 §1).
          captureDrain: null, captureIntegrity: "unavailable",
        });
        assert.equal(session.state().finalizationError, null);
        assert.deepEqual(session.state().routingErrors, []);
        assert.equal(bridgeListener, undefined);
        assert.equal(runtimeListeners.size, 0);
        assert.equal(runtimeClosed, true);
        const raw = new Database(filename, { readonly: true });
        try { assert.deepEqual(raw.prepare("SELECT count(*) AS count FROM backfill_seed_lifecycle").get(), { count: 0 }); }
        finally { raw.close(); }
      }
    } finally { await session.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

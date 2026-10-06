import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createFilesystemOperatorWarningSink } from "../src/adapters/filesystem-operator-warning.ts";
import { createBackfillWarningWorker } from "../src/delivery/backfill-worker.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
// @ts-expect-error Component-only JavaScript fixture has no public declarations.
import { createWarningComponentSeed as fixture } from "./fixtures/warning-component-seed.mjs";

// Actual migrated SQL/store/worker/sink, explicitly synthetic component seed.
// These tests cannot prove application admission, SDK authentication or R1/R3.
const helperPath = path.resolve(import.meta.dirname, "warning-store-fault.mjs");
async function helpers() {
  assert.ok(existsSync(helperPath), "warning acceptance SQL fault helper is not implemented");
  return import(helperPath);
}
type Component = ReturnType<typeof fixture>;
function binding(f: Component) {
  return { root: f.root, databasePath: f.databasePath, occurrenceId: f.occurrenceId,
    stopAtMs: f.stopAtMs, expiresAtMs: f.expiresAtMs };
}
function raw(f: Component, occurrenceId = f.occurrenceId) {
  const db = new Database(f.databasePath, { readonly: true, fileMustExist: true });
  try { return db.prepare(`SELECT w.state,w.accepted_at_ms AS acceptedAtMs,w.claim_token AS claimToken,
    w.claim_expires_at_ms AS claimExpiresAtMs,w.attempt_count AS attempts,w.next_attempt_at_ms AS nextAttemptAtMs,
    w.stop_at_ms AS stopAtMs,w.expires_at_ms AS expiresAtMs,l.last_observed_at_ms AS observedAtMs
    FROM backfill_warning_intents w JOIN backfill_seed_lifecycle l USING(occurrence_id) WHERE w.occurrence_id=?`)
    .get(occurrenceId) as { state: string; acceptedAtMs: number | null; claimToken: string | null;
      claimExpiresAtMs: number | null; attempts: number; nextAttemptAtMs: number;
      stopAtMs: number; expiresAtMs: number; observedAtMs: number }; }
  finally { db.close(); }
}
function file(f: Component) {
  const directory = path.join(f.outboxDir, "operator-warnings"), names = readdirSync(directory);
  assert.equal(names.length, 1);
  const filename = path.join(directory, names[0]!), stat = lstatSync(filename, { bigint: true });
  const bytes = readFileSync(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === BigInt(process.getuid!()));
  assert.equal(stat.mode & 0o777n, 0o600n);
  assert.equal(lstatSync(directory).mode & 0o777, 0o700);
  return { name: names[0], bytes, sha256: createHash("sha256").update(bytes).digest("hex"),
    device: stat.dev.toString(), inode: stat.ino.toString() };
}
function sibling(f: Component, store: ReturnType<Component["open"]>) {
  const identity = buildMeetingIdentity({ providerMeetingId: "component-z'other", meetingNo: "4343",
    occurrenceStartedAt: "2026-09-02T13:59:00Z", title: "Other synthetic component", organizer: null });
  const handle = "b".repeat(32), encryptedPath = path.join(f.recordingsDir, `${handle}.crsr`);
  writeFileSync(encryptedPath, readFileSync(f.recordingPath), { mode: 0o600 });
  const capability = { sourceSessionId: 42n, recordingHandle: handle, sha256: f.hash,
    keyId: "e".repeat(16), authorization: "f".repeat(64) };
  const coordinator = createCoordinator({ store, clock: { now: () => f.endedAtMs }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 1 });
  coordinator.discover(identity); coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening");
  store.beginReconciliationGeneration(identity.occurrenceId, "component-other", f.endedAtMs - 1_000);
  store.setReconciliationRuntimeSession(identity.occurrenceId, "component-other", 42n);
  coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, {
    recovery: { bridgeSessionId: "component-other", capability }, handle, encryptedPath, sha256: f.hash,
    durationMs: 20, format: "pcm_s16le/24000/1/20ms", keyId: capability.keyId, gaps: [], runtimeGaps: [],
  }, "component-other", f.endedAtMs, "bridge_observed", {
    terminalReason: "ended", terminalSource: "bridge_observed", endedAt: new Date(f.endedAtMs).toISOString(), identity,
    provider: "feishu", encryption: "aes-256-gcm", processingWarnings: [], provenance: {
      runtimeProfile: "online", sttProvider: "component-stt", sttModel: "stt-model", liveStreamModel: "live-model",
      finalBatchModel: "batch-model", textProvider: "component-text", textModel: "text-model", agentVersion: "component-only",
    },
  });
  coordinator.completeReconciliationGeneration(identity.occurrenceId, "component-other", f.endedAtMs, "bridge_observed", "ended");
  assert.equal(store.stopDueBackfill({ nowMs: f.stopAtMs })?.occurrenceId, identity.occurrenceId);
  return identity.occurrenceId;
}

test("real acceptance transaction abort rolls back state, claim and its preceding wall observation", async () => {
  const { installWarningStoreFault } = await helpers(), f = fixture(), store = f.open();
  try {
    const claim = store.claimBackfillWarning({ nowMs: f.stopAtMs, claimToken: "1".repeat(32) }); assert.ok(claim);
    const sink = createFilesystemOperatorWarningSink({ outboxDir: f.outboxDir });
    const receipt = await sink.accept({ key: claim.key, payload: claim.payload });
    const before = raw(f), acceptedFile = file(f), ciphertext = readFileSync(f.recordingPath);
    const fault = installWarningStoreFault(binding(f));
    assert.match(fault.templateSha256, /^[a-f0-9]{64}$/);
    assert.throws(() => installWarningStoreFault(binding(f)), /conflicting warning fault trigger/);
    assert.throws(() => store.acceptBackfillWarning({ occurrenceId: f.occurrenceId, claimToken: claim.claimToken,
      key: receipt.key, nowMs: f.stopAtMs + 123 }), { code: "SQLITE_CONSTRAINT_TRIGGER", message: "e2e_warning_accept_abort" });
    assert.deepEqual(raw(f), before, "the complete immediate transaction, including clock observation, must roll back");
    assert.deepEqual(file(f), acceptedFile); assert.deepEqual(readFileSync(f.recordingPath), ciphertext);
    const db = new Database(f.databasePath);
    try {
      db.exec("CREATE TRIGGER unrelated_component_trigger AFTER UPDATE ON backfill_warning_intents BEGIN SELECT 2; END");
      fault.clear();
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='unrelated_component_trigger'").get());
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(fault.triggerName), undefined);
    } finally { db.close(); }
    store.acceptBackfillWarning({ occurrenceId: f.occurrenceId, claimToken: claim.claimToken, key: receipt.key, nowMs: f.stopAtMs + 123 });
    assert.equal(raw(f).acceptedAtMs, f.stopAtMs + 123);
  } finally { store.close(); f.close(); }
});

test("real worker reschedules acceptance abort and reopened retry reuses one identical physical warning file", async () => {
  const { installWarningStoreFault } = await helpers(), f = fixture();
  let store = f.open(), now = f.stopAtMs;
  let checkpoints: string[] = [];
  const sink = () => createFilesystemOperatorWarningSink({ outboxDir: f.outboxDir,
    durabilityCheckpoint: step => { checkpoints.push(step); } });
  let worker = createBackfillWarningWorker({ store, sink: sink(), clock: { now: () => now }, random: () => 0 });
  try {
    const fault = installWarningStoreFault(binding(f));
    assert.deepEqual(await worker.pollOnce(), { kind: "rescheduled", occurrenceId: f.occurrenceId });
    assert.deepEqual(checkpoints, ["file", "directory"]);
    assert.deepEqual(raw(f), { state: "pending", acceptedAtMs: null, claimToken: null, claimExpiresAtMs: null,
      attempts: 1, nextAttemptAtMs: f.stopAtMs + 1_000, stopAtMs: f.stopAtMs, expiresAtMs: f.expiresAtMs, observedAtMs: f.stopAtMs });
    const acceptedFile = file(f), ciphertext = readFileSync(f.recordingPath), retry = raw(f).nextAttemptAtMs;
    assert.ok(retry < f.expiresAtMs);
    fault.clear(); await worker.close(); store.close();
    store = f.open(); now = retry - 1; checkpoints = [];
    worker = createBackfillWarningWorker({ store, sink: sink(), clock: { now: () => now }, random: () => 0 });
    assert.deepEqual(await worker.pollOnce(), { kind: "idle" }); assert.deepEqual(checkpoints, []);
    now = retry; assert.equal((await worker.pollOnce()).kind, "accepted");
    assert.deepEqual(checkpoints, ["directory"], "the existing-file replay must not create or write a new file");
    assert.deepEqual(file(f), acceptedFile); assert.deepEqual(readFileSync(f.recordingPath), ciphertext);
    assert.deepEqual(raw(f), { state: "accepted", acceptedAtMs: retry, claimToken: null, claimExpiresAtMs: null,
      attempts: 2, nextAttemptAtMs: retry, stopAtMs: f.stopAtMs, expiresAtMs: f.expiresAtMs, observedAtMs: retry });
    assert.deepEqual(await worker.pollOnce(), { kind: "idle" }); assert.equal(raw(f).attempts, 2);
  } finally { await worker.close(); store.close(); f.close(); }
});

test("the armed fault leaves target claiming/reschedule and a different occurrence acceptance unaffected", async () => {
  const { installWarningStoreFault } = await helpers(), f = fixture(), store = f.open();
  try {
    const otherId = sibling(f, store), fault = installWarningStoreFault(binding(f));
    const target = store.claimBackfillWarning({ nowMs: f.stopAtMs, claimToken: "2".repeat(32) }); assert.ok(target);
    assert.equal(target.occurrenceId, f.occurrenceId);
    store.failBackfillWarning({ occurrenceId: f.occurrenceId, claimToken: target.claimToken, nowMs: f.stopAtMs, retryDelayMs: 1_000, reason: "sink_failed" });
    assert.equal(raw(f).state, "pending");
    const other = store.claimBackfillWarning({ nowMs: f.stopAtMs, claimToken: "3".repeat(32) }); assert.ok(other);
    assert.equal(other.occurrenceId, otherId);
    const receipt = await createFilesystemOperatorWarningSink({ outboxDir: f.outboxDir }).accept({ key: other.key, payload: other.payload });
    store.acceptBackfillWarning({ occurrenceId: otherId, claimToken: other.claimToken, key: receipt.key, nowMs: f.stopAtMs });
    assert.equal(raw(f, otherId).state, "accepted"); assert.equal(raw(f).acceptedAtMs, null);
    fault.clear();
  } finally { store.close(); f.close(); }
});

test("a real occurrence containing a SQL quote is targeted without altering SQL structure", async () => {
  const { installWarningStoreFault } = await helpers(), f = fixture(), store = f.open();
  try {
    const otherId = sibling(f, store), main = store.claimBackfillWarning({ nowMs: f.stopAtMs, claimToken: "4".repeat(32) });
    assert.ok(main); assert.equal(main.occurrenceId, f.occurrenceId);
    store.failBackfillWarning({ occurrenceId: main.occurrenceId, claimToken: main.claimToken,
      nowMs: f.stopAtMs, retryDelayMs: 1_000, reason: "sink_failed" });
    assert.ok(otherId.includes("'"));
    const fault = installWarningStoreFault({ ...binding(f), occurrenceId: otherId });
    const claim = store.claimBackfillWarning({ nowMs: f.stopAtMs, claimToken: "5".repeat(32) });
    assert.ok(claim); assert.equal(claim.occurrenceId, otherId);
    const receipt = await createFilesystemOperatorWarningSink({ outboxDir: f.outboxDir }).accept({ key: claim.key, payload: claim.payload });
    const before = raw(f, otherId);
    assert.throws(() => store.acceptBackfillWarning({ occurrenceId: otherId, claimToken: claim.claimToken,
      key: receipt.key, nowMs: f.stopAtMs + 1 }), { code: "SQLITE_CONSTRAINT_TRIGGER", message: "e2e_warning_accept_abort" });
    assert.deepEqual(raw(f, otherId), before); fault.clear();
    store.acceptBackfillWarning({ occurrenceId: otherId, claimToken: claim.claimToken, key: receipt.key, nowMs: f.stopAtMs + 1 });
    assert.equal(raw(f, otherId).state, "accepted"); assert.equal(raw(f).state, "pending");
  } finally { store.close(); f.close(); }
});

test("installation refuses wrong private DB/seed binding and any pre-existing fault trigger", async () => {
  const { installWarningStoreFault, WARNING_STORE_FAULT_TRIGGER } = await helpers(), f = fixture();
  const rawDb = new Database(f.databasePath);
  try {
    const before = raw(f);
    for (const input of [{ ...binding(f), root: f.root + "/." },
      { ...binding(f), databasePath: path.join(f.root, "missing.db") },
      { ...binding(f), occurrenceId: "wrong'; SELECT 1; --" },
      { ...binding(f), expiresAtMs: f.expiresAtMs + 1 }]) assert.throws(() => installWarningStoreFault(input));
    assert.equal(existsSync(path.join(f.root, "missing.db")), false);
    chmodSync(f.root, 0o755); assert.throws(() => installWarningStoreFault(binding(f))); chmodSync(f.root, 0o700);
    const link = path.join(f.root, "alias.db"); symlinkSync(f.databasePath, link);
    assert.throws(() => installWarningStoreFault({ ...binding(f), databasePath: link })); unlinkSync(link);
    rawDb.exec(`CREATE TRIGGER ${WARNING_STORE_FAULT_TRIGGER} AFTER UPDATE ON backfill_warning_intents BEGIN SELECT 1; END`);
    const old = rawDb.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(WARNING_STORE_FAULT_TRIGGER);
    assert.throws(() => installWarningStoreFault(binding(f)), /conflicting warning fault trigger/);
    assert.deepEqual(rawDb.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(WARNING_STORE_FAULT_TRIGGER), old);
    assert.deepEqual(raw(f), before);
  } finally { rawDb.close(); f.close(); }
});

test("clear refuses a replaced DB or modified trigger and never deletes another trigger", async () => {
  const { installWarningStoreFault, WARNING_STORE_FAULT_TRIGGER } = await helpers(), f = fixture();
  try {
    const fault = installWarningStoreFault(binding(f)), original = f.databasePath + ".original";
    renameSync(f.databasePath, original);
    const replacement = new Database(f.databasePath); replacement.exec("CREATE TABLE harmless (value TEXT)"); replacement.close();
    assert.throws(() => fault.clear(), /warning fault database identity changed/);
    unlinkSync(f.databasePath); renameSync(original, f.databasePath);
    const db = new Database(f.databasePath);
    try {
      db.exec(`DROP TRIGGER ${WARNING_STORE_FAULT_TRIGGER}`);
      db.exec(`CREATE TRIGGER ${WARNING_STORE_FAULT_TRIGGER} AFTER UPDATE ON backfill_warning_intents BEGIN SELECT 1; END`);
      db.exec("CREATE TRIGGER unrelated_component_trigger AFTER UPDATE ON backfill_warning_intents BEGIN SELECT 2; END");
      assert.throws(() => fault.clear(), /conflicting warning fault trigger/);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN (?,?)").get(WARNING_STORE_FAULT_TRIGGER, "unrelated_component_trigger") as { n: number }).n, 2);
    } finally { db.close(); }
  } finally { f.close(); }
});

test("SQL replay clock requires exact persisted pending retry and original binding", async () => {
  const { warningSqlReplayBoundary } = await helpers();
  assert.equal(typeof warningSqlReplayBoundary, "function");
  const state = { occurrenceId: "occurrence", stopAtMs: 1100000, expiresAtMs: 1400000,
    warning: { state: "pending", claimed: false, acceptedAtMs: null, claimExpiresAtMs: null, attemptCount: 1, nextAttemptAtMs: 1101000 } };
  const plan = { occurrenceId: "occurrence", stopAtMs: 1100000, expiresAtMs: 1400000, nextAttemptAtMs: 1101000 };
  assert.equal(warningSqlReplayBoundary({ state, plan }), 1101000);
  for (const patch of [{ plan: { ...plan, occurrenceId: "foreign" } }, { plan: { ...plan, stopAtMs: 1100001 } },
    { plan: { ...plan, expiresAtMs: 1400001 } }, { plan: { ...plan, nextAttemptAtMs: undefined } },
    { plan: { ...plan, nextAttemptAtMs: 1101001 } }, { state: { ...state, warning: null } },
    { state: { ...state, warning: { ...state.warning, state: "claimed" } } },
    { state: { ...state, warning: { ...state.warning, claimed: true } } },
    { state: { ...state, warning: { ...state.warning, acceptedAtMs: 1100000 } } },
    { state: { ...state, warning: { ...state.warning, claimExpiresAtMs: 1130000 } } },
    { state: { ...state, warning: { ...state.warning, attemptCount: 2 } } },
    { state: { ...state, warning: { ...state.warning, nextAttemptAtMs: 1100000 } }, plan: { ...plan, nextAttemptAtMs: 1100000 } },
    { state: { ...state, warning: { ...state.warning, nextAttemptAtMs: 1400000 } }, plan: { ...plan, nextAttemptAtMs: 1400000 } },
  ]) assert.throws(() => warningSqlReplayBoundary({ state, plan, ...patch }));
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers";
import Database from "better-sqlite3";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";

// Component-only: real migrations, explicit synthetic ciphertext/capability/rows.
// These rows are never app generated or integration evidence.
const ENDED = 1_788_357_600_123;
async function helpers() {
  const filename = path.join(import.meta.dirname, "r2-baseline.mjs");
  assert.ok(existsSync(filename), "R2 baseline helper is not implemented");
  return import(filename);
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

const status = () => ({ codes: [], lanes: [{ lane: "backfill", intervalMs: 3_600_000, ticks: 1, inFlight: false, lastOutcome: "backfill_enqueued", failures: [] }] });
const settled = { occurrenceId: "expected", phase: "settled", finalization: "seeded", runtimeClose: "closed", runtimeCleanup: "graceful" };
test("same entry sequence cannot tick until the exact occurrence has settled real cleanup", async () => {
  const { runR2InitialBuild } = await helpers();
  const order: string[] = [];
  let rows = [{ ...settled, occurrenceId: "foreign" }, { ...settled, phase: "pending" }];
  const app = { occurrenceOutcomes: () => rows, maintenanceStatus: status,
    async maintenanceTick(lane: string) { assert.equal(lane, "backfill"); order.push("tick"); return "backfill_enqueued"; } };
  const result = await runR2InitialBuild({ getComposition: () => app, occurrenceId: "expected", budgetMs: 1,
    async waitFor(check: () => unknown) {
      assert.equal(check(), undefined); assert.deepEqual(order, []);
      rows = [{ ...settled, runtimeCleanup: "failed" }]; assert.equal(check(), undefined);
      rows = [settled]; return check();
    }, event: (name: string) => order.push(name) });
  assert.deepEqual(order, ["r2_live_cleanup_confirmed", "tick", "r2_initial_enqueued"]);
  assert.equal(result.lanes[0]!.ticks, 1);
});
test("unsettled cleanup timeout never invokes a maintenance tick", async () => {
  const { runR2InitialBuild } = await helpers(); let ticks = 0;
  await assert.rejects(runR2InitialBuild({ getComposition: () => ({ occurrenceOutcomes: () => [ { ...settled, runtimeCleanup: "failed" } ], maintenanceTick: () => ticks++ }),
    occurrenceId: "expected", budgetMs: 1, event: () => {}, waitFor: async (check: () => unknown) => { assert.equal(check(), undefined); throw new Error("timeout"); } }), /timeout/);
  assert.equal(ticks, 0);
});
for (const mutation of ["outcome", "code", "ticks", "inFlight", "failure"]) {
  test(`initial sequence refuses ${mutation} instead of manufacturing success`, async () => {
    const { runR2InitialBuild } = await helpers(); const observed = status();
    if (mutation === "code") (observed.codes as string[]).push("backfill:failure");
    if (mutation === "ticks") observed.lanes[0]!.ticks = 2;
    if (mutation === "inFlight") observed.lanes[0]!.inFlight = true;
    if (mutation === "failure") (observed.lanes[0]!.failures as string[]).push("failed");
    await assert.rejects(runR2InitialBuild({ getComposition: () => ({ occurrenceOutcomes: () => [settled], maintenanceStatus: () => observed,
      maintenanceTick: async () => mutation === "outcome" ? "backfill_rescheduled" : "backfill_enqueued" }),
      occurrenceId: "expected", budgetMs: 1, waitFor: async (check: () => unknown) => check(), event: () => {} }), /r2_initial_worker_outcome_refused/);
  });
}
test("owned peers close after partial startup failure and every close is attempted", async () => {
  const { withOwnedPeers } = await helpers(); const closed: string[] = [];
  await assert.rejects(withOwnedPeers({ first: async () => ({ close: async () => closed.push("first") }),
    second: async () => { throw new Error("startup failed"); } }, async () => assert.fail("no app before startup")), /startup failed/);
  assert.deepEqual(closed, ["first"]); closed.length = 0;
  await assert.rejects(withOwnedPeers({ first: async () => ({ close: async () => { closed.push("first"); throw new Error("private-error"); } }),
    second: async () => ({ close: async () => closed.push("second") }) }, async () => closed.push("app closed")), /owned_peer_close_unconfirmed/);
  assert.deepEqual(closed, ["app closed", "second", "first"]);
});
test("R2 plan refuses mixed direct-entry modes and preserves default capture and other cadences", async () => {
  const { assertR2Plan, r2LaneIntervals } = await helpers();
  for (const conflict of [{ interactive: true }, { initialR1: true }, { d2Cut: "durable" }]) assert.throws(() => assertR2Plan({ r2Baseline: true, ...conflict }), /R2 baseline cannot combine modes/);
  assertR2Plan({ r2Baseline: true, interactive: false, d2Cut: null });
  assert.deepEqual(r2LaneIntervals({ backfill: 30_000, warning: 5000, custody: 5000 }), { backfill: 3_600_000, warning: 5000, custody: 5000 });
});
function deliveredFixture() {
  const f = fixture(), store = f.open();
  try {
    const recovery = store.getRecordingRecovery(f.occurrenceId, "component-bridge", f.handle)!;
    const attempt = store.beginRecordingAlignment(recovery.generationId, "component-owner");
    assert.equal(attempt.kind, "claimed");
    if (attempt.kind !== "claimed") throw new Error("component claim missing");
    store.completeRecordingAlignment(attempt.attempt, { type: "recording_alignment_complete",
      source: { sourceSessionId: 41n, recordingHandle: f.handle, sha256: f.hash }, pageCount: 0n,
      coverageStatus: "unavailable_legacy", warnings: ["unavailable_legacy"], traversalSucceeded: true });
  } finally { store.close(); }
  const db = new Database(f.databasePath);
  try {
    db.prepare("UPDATE backfill_seed_lifecycle SET owner='delivery',initial_build_attempts=1 WHERE occurrence_id=?").run(f.occurrenceId);
    db.prepare(`INSERT INTO delivery_journal(occurrence_id,revision,artifact_hash,recording_path,bundle_path,ended_at_ms,
      transcript_complete,retry_count,next_retry_at_ms,published_at_ms,publication_url,vault_commit,recording_handle)
      VALUES(?,1,?,?,?, ?,0,0,?,?,?, ?,?)`).run(f.occurrenceId, `sha256:${"e".repeat(64)}`, f.recordingPath,
      path.join(f.root, "outbox"), ENDED, ENDED, ENDED + 1, "https://fixture.invalid/commit", "f".repeat(40), f.handle);
    db.prepare("INSERT INTO backfill_jobs(occurrence_id,state,next_attempt_at_ms,stop_at_ms) VALUES(?,'due',?,?)").run(f.occurrenceId, ENDED, ENDED + 11 * 86_400_000);
  } finally { db.close(); }
  return f;
}
type BaselineState = Awaited<ReturnType<(Awaited<ReturnType<typeof helpers>>)["readR2BaselineState"]>>;
function observations(state: BaselineState) {
  return { state, artifact: { occurrenceId: state.occurrenceId, revision: 1, hash: `sha256:${"e".repeat(64)}`,
    actualHash: `sha256:${"e".repeat(64)}`, files: ["READY"], meeting: { ended_at: new Date(ENDED).toISOString(), transcript_complete: false } },
    receipt: { valid: true, status: "present", receipts: ["actual-receipt"], checks: [{ schema: "teammem-meeting-receipt/v1", markdownUrl: "https://fixture.invalid/commit",
      vaultCommit: "f".repeat(40), commitExists: true, commitIsAncestorOfRef: true, noteBytes: 42,
      occurrenceMatchesArtifact: true, revisionMatchesArtifact: true, artifactHashMatches: true, noteNamesOccurrence: true,
      noteWithholdsAudioPath: true, urlNamesCommit: true }] }, publishExit: 0,
    providerCalls: [{ route: "final", outcome: "unavailable" }, { route: "synthesis", outcome: "ok" }],
    unusedVoice: { calls: [], appended: 0, ready: false }, maintenance: status(),
    sourceMeasurement: { sha256: state.source.sha256, bytes: state.source.bytes, device: state.source.device, inode: state.source.inode,
      imported: [1, 2].map(() => ({ sha256: state.source.sha256, bytes: state.source.bytes, device: "observed-device", inode: "observed-inode", nlink: 2,
        directoryDevice: "observed-device", directoryInode: "observed-directory" })) } };
}
test("real synthetic SQLite projection is readonly, retains incomplete delivery authority and excludes capability bytes", async () => {
  const { readR2BaselineState, r2BaselineOracles, r2BaselineMetadata } = await helpers(), f = deliveredFixture();
  try {
    const before = readFileSync(f.databasePath), files = readdirSync(f.root).sort();
    const state = readR2BaselineState(f);
    assert.equal(state.counts.seeds, 1); assert.equal(state.delivery.revision, 1); assert.equal(state.job.state, "due");
    assert.ok(r2BaselineOracles(observations(state)).every((row: { status: string }) => row.status === "pass"));
    const input = observations(state);
    const safe = JSON.stringify(r2BaselineMetadata({ ...input, authorization: "secret", key: "secret", token: "secret", prompt: "secret", audio: "secret",
      state: { ...state, counts: { ...state.counts, authorization: "secret" }, source: { ...state.source, token: "secret" } },
      providerCalls: input.providerCalls.map(row => ({ ...row, audio: "secret", authorization: "secret" })) }));
    assert.ok(!safe.includes("secret") && !safe.includes("d".repeat(64)) && !safe.includes("c".repeat(16)));
    assert.ok(!safe.includes(f.recordingPath));
    assert.deepEqual(readFileSync(f.databasePath), before); assert.deepEqual(readdirSync(f.root).sort(), files);
  } finally { f.close(); }
});
for (const [name, sql] of [
  ["extra delivery", "INSERT INTO delivery_journal(occurrence_id,revision,artifact_hash,recording_path,bundle_path,ended_at_ms,transcript_complete,retry_count,next_retry_at_ms) SELECT occurrence_id,2,artifact_hash,recording_path,bundle_path,ended_at_ms,transcript_complete,0,next_retry_at_ms FROM delivery_journal"],
  ["early tombstone", `UPDATE delivery_journal SET deleted_at_ms=${ENDED + 2}`],
  ["complete bit", "UPDATE delivery_journal SET transcript_complete=1"],
  ["process ownership", `UPDATE backfill_seed_lifecycle SET process_owner_token='${"a".repeat(32)}',process_cleanup_state='active'`],
  ["tentative alignment", "DELETE FROM recording_alignment_selected"],
  ["original deadline", "DROP TRIGGER backfill_job_immutable_binding; UPDATE backfill_jobs SET stop_at_ms=stop_at_ms+1"],
  ["completed retry", `UPDATE backfill_jobs SET state='complete',target_revision=1,completion_revision=1,completion_artifact_hash='sha256:${"e".repeat(64)}'`],
] as const) test(`baseline refuses ${name}`, async () => {
  const { readR2BaselineState, r2BaselineOracles } = await helpers(), f = deliveredFixture();
  try { f.alter(sql); assert.ok(r2BaselineOracles(observations(readR2BaselineState(f))).some((row: { status: string }) => row.status === "fail")); }
  finally { f.close(); }
});
for (const mutation of ["source hash", "source inode", "import missing", "import different inode", "import different directory", "import source inode", "import extra link", "import zero bytes", "receipt absent", "receipt invalid", "receipt schema", "receipt commit", "artifact hash", "artifact occurrence", "artifact revision", "artifact ended", "final success", "synthesis failure", "voice append", "extra tick"]) test(`baseline oracle rejects ${mutation}`, async () => {
  const { readR2BaselineState, r2BaselineOracles } = await helpers(), f = deliveredFixture();
  try {
    const input = observations(readR2BaselineState(f));
    if (mutation === "source hash") input.sourceMeasurement.sha256 = "0".repeat(64);
    if (mutation === "source inode") input.sourceMeasurement.inode = "0";
    if (mutation === "import missing") input.sourceMeasurement.imported = [];
    if (mutation === "import different inode") input.sourceMeasurement.imported[1]!.inode = "different";
    if (mutation === "import different directory") input.sourceMeasurement.imported[1]!.directoryInode = "different";
    if (mutation === "import source inode") for (const row of input.sourceMeasurement.imported) { row.device = input.state.source.device; row.inode = input.state.source.inode; }
    if (mutation === "import extra link") input.sourceMeasurement.imported[0]!.nlink = 3;
    if (mutation === "import zero bytes") input.sourceMeasurement.imported[0]!.bytes = 0;
    if (mutation === "receipt absent") input.receipt.receipts = [];
    if (mutation === "receipt invalid") input.receipt.valid = false;
    if (mutation === "receipt schema") input.receipt.checks[0]!.schema = "foreign";
    if (mutation === "receipt commit") input.receipt.checks[0]!.vaultCommit = "0".repeat(40);
    if (mutation === "artifact hash") input.artifact.actualHash = "wrong";
    if (mutation === "artifact occurrence") input.artifact.occurrenceId = "foreign";
    if (mutation === "artifact revision") input.artifact.revision = 2;
    if (mutation === "artifact ended") input.artifact.meeting.ended_at = new Date(ENDED + 1).toISOString();
    if (mutation === "final success") input.providerCalls.push({ route: "final", outcome: "ok" });
    if (mutation === "synthesis failure") input.providerCalls.push({ route: "synthesis", outcome: "armed_failure" });
    if (mutation === "voice append") input.unusedVoice.appended = 1;
    if (mutation === "extra tick") input.maintenance.lanes[0]!.ticks = 2;
    assert.ok(r2BaselineOracles(input).some((row: { status: string }) => row.status === "fail"));
  } finally { f.close(); }
});
test("peer closes wait for the application work to settle and synchronous close refusal cannot skip other owners", async () => {
  const { withOwnedPeers } = await helpers();
  const order: string[] = []; let release!: () => void;
  const closed = new Promise<void>(resolve => { release = resolve; });
  const operation = withOwnedPeers({ peer: async () => ({ close: async () => order.push("peer closed") }) },
    async () => { order.push("app closing"); await closed; order.push("app closed"); });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["app closing"]); release(); await operation;
  assert.deepEqual(order, ["app closing", "app closed", "peer closed"]);
  order.length = 0;
  await assert.rejects(withOwnedPeers({ first: async () => ({ close: async () => order.push("first") }),
    second: async () => ({ close: () => { order.push("second"); throw new Error("private error"); } }) }, async () => {}), /owned_peer_close_unconfirmed/);
  assert.deepEqual(order, ["second", "first"]);
});
test("actual scoped ciphertext inventory includes custody dot entries and refuses symlinks", async () => {
  const { readR2BaselineState, measureR2Sources, r2BaselineOracles } = await helpers(), f = deliveredFixture();
  try {
    const audioStore = path.join(f.root, "imported"), directory = path.join(audioStore, "observed-occurrence", "1");
    mkdirSync(directory, { recursive: true });
    const first = path.join(directory, "consumer-chosen-name"), second = path.join(directory, ".consumer-custody-name");
    writeFileSync(first, readFileSync(f.recordingPath)); linkSync(first, second);
    const state = readR2BaselineState(f), input = observations(state);
    const measured = await measureR2Sources({ state, recordingsDir: f.recordingsDir, audioStore, privateRoot: f.root });
    assert.equal(measured.imported.length, 2); assert.ok(measured.imported.every((row: { nlink: number }) => row.nlink === 2));
    assert.ok(r2BaselineOracles({ ...input, sourceMeasurement: measured }).every((row: { status: string }) => row.status === "pass"));
    symlinkSync(first, path.join(directory, "symlink"));
    await assert.rejects(measureR2Sources({ state, recordingsDir: f.recordingsDir, audioStore, privateRoot: f.root }), /symlink/);
    await assert.rejects(measureR2Sources({ state, recordingsDir: f.recordingsDir, audioStore, privateRoot: f.recordingsDir }), /outside scoped/);
  } finally { f.close(); }
});
for (const mutation of ["missing partner", "independent copy", "outside link", "third name", "wrong bytes"]) test(`actual ciphertext inventory rejects ${mutation}`, async () => {
  const { readR2BaselineState, measureR2Sources, r2BaselineOracles } = await helpers(), f = deliveredFixture();
  try {
    const audioStore = path.join(f.root, "audio-store"), directory = path.join(audioStore, "observed", "1");
    mkdirSync(directory, { recursive: true });
    const first = path.join(directory, "observed-final"), second = path.join(directory, ".observed-custody");
    const bytes = readFileSync(f.recordingPath);
    writeFileSync(first, bytes); linkSync(first, second);
    if (mutation === "missing partner") rmSync(second);
    if (mutation === "independent copy") { rmSync(second); writeFileSync(second, bytes); }
    if (mutation === "outside link") linkSync(first, path.join(f.root, "outside-store"));
    if (mutation === "third name") linkSync(first, path.join(directory, "third"));
    if (mutation === "wrong bytes") writeFileSync(first, Buffer.alloc(bytes.length));
    const state = readR2BaselineState(f);
    const measured = await measureR2Sources({ state, recordingsDir: f.recordingsDir, audioStore, privateRoot: f.root });
    assert.ok(r2BaselineOracles({ ...observations(state), sourceMeasurement: measured }).some((row: { name: string; status: string }) => row.name === "r2_source_retained" && row.status === "fail"));
  } finally { f.close(); }
});
test("missing source, bound-source tampering and WAL refuse without repairing SQLite", async () => {
  const { readR2BaselineState } = await helpers(), f = deliveredFixture();
  try {
    writeFileSync(`${f.databasePath}-wal`, "sentinel"); assert.throws(() => readR2BaselineState(f), /WAL/); rmSync(`${f.databasePath}-wal`);
    f.alter("UPDATE recordings SET sha256='" + "0".repeat(64) + "'"); assert.throws(() => readR2BaselineState(f), /identity/);
    f.alter("UPDATE recordings SET sha256='" + f.hash + "'");
    rmSync(f.recordingPath); assert.throws(() => readR2BaselineState(f), /missing/);
  } finally { f.close(); }
});
test("direct R2 reader refuses a closed WAL-mode header without creating sidecars", async () => {
  const { readR2BaselineState } = await helpers(), root = mkdtempSync("/private/tmp/r2-wal-read-");
  try {
    const databasePath = path.join(root, "state.db"), db = new Database(databasePath);
    db.pragma("journal_mode=WAL"); db.exec("CREATE TABLE component_only(value TEXT)"); db.close();
    const before = readFileSync(databasePath), files = readdirSync(root).sort();
    assert.deepEqual(files, ["state.db"]);
    assert.throws(() => readR2BaselineState({ databasePath, occurrenceId: "component" }), /WAL/);
    assert.deepEqual(readdirSync(root).sort(), files); assert.deepEqual(readFileSync(databasePath), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("actual runner read helper refuses WAL/header/sidecars before any ordinary or capture SQL callback", async () => {
  const modulePath = path.join(import.meta.dirname, "run.mjs"), runner = await import(modulePath);
  assert.equal(typeof runner.readRunEvidence, "function", "guarded runner sequence is not implemented");
  const f = deliveredFixture();
  try {
    const before = readFileSync(f.databasePath); let reads = 0;
    const read = () => {
      reads++;
      const db = new Database(f.databasePath, { readonly: true, fileMustExist: true });
      try { return (db.prepare("SELECT COUNT(*) AS n FROM backfill_seeds").get() as { n: number }).n; } finally { db.close(); }
    };
    assert.equal(await runner.readRunEvidence({ databasePath: f.databasePath, r2Baseline: true, read }), 1);
    assert.equal(reads, 1); assert.deepEqual(readFileSync(f.databasePath), before);
    const durablePath = path.join(import.meta.dirname, "durable-oracles.mjs"), { readDurableEvidence } = await import(durablePath);
    const capture = await runner.readRunEvidence({ databasePath: f.databasePath, r2Baseline: true,
      read: () => readDurableEvidence(f.databasePath, f.occurrenceId) });
    assert.equal(capture.recordings.length, 1); assert.deepEqual(readFileSync(f.databasePath), before);
    for (const suffix of ["-wal", "-shm"]) {
      writeFileSync(f.databasePath + suffix, "unchanged sentinel");
      const files = readdirSync(f.root).sort();
      await assert.rejects(runner.readRunEvidence({ databasePath: f.databasePath, r2Baseline: true, read }), /WAL/);
      assert.equal(reads, 1); assert.deepEqual(readdirSync(f.root).sort(), files);
      assert.equal(readFileSync(f.databasePath + suffix, "utf8"), "unchanged sentinel"); rmSync(f.databasePath + suffix);
    }
    const walPath = path.join(f.root, "closed-wal.db"), wal = new Database(walPath);
    wal.pragma("journal_mode=WAL"); wal.exec("CREATE TABLE component_only(value TEXT)"); wal.close();
    const walBefore = readFileSync(walPath), files = readdirSync(f.root).sort();
    const readWal = () => {
      reads++;
      const db = new Database(walPath, { readonly: true, fileMustExist: true });
      try { return (db.prepare("SELECT COUNT(*) AS n FROM component_only").get() as { n: number }).n; } finally { db.close(); }
    };
    await assert.rejects(runner.readRunEvidence({ databasePath: walPath, r2Baseline: true, read: readWal }), /WAL/);
    assert.equal(reads, 1); assert.deepEqual(readdirSync(f.root).sort(), files); assert.deepEqual(readFileSync(walPath), walBefore);
    f.alter("UPDATE schema_migrations SET version=30 WHERE version=29");
    const schemaBefore = readFileSync(f.databasePath), schemaFiles = readdirSync(f.root).sort();
    await assert.rejects(runner.readRunEvidence({ databasePath: f.databasePath, r2Baseline: true, read }), /schema/);
    assert.equal(reads, 1); assert.deepEqual(readFileSync(f.databasePath), schemaBefore); assert.deepEqual(readdirSync(f.root).sort(), schemaFiles);
  } finally { f.close(); }
});
for (const failure of ["filesystem refusal", "hash mismatch", "link mismatch"]) test(`actual final cleanup preserves R2 ciphertext after ${failure} without keep`, async () => {
  const { readR2BaselineState, measureR2Sources, r2BaselineOracles } = await helpers();
  const modulePath = path.join(import.meta.dirname, "run.mjs"), runner = await import(modulePath), f = deliveredFixture();
  try {
    const audioStore = path.join(f.root, "imported"); mkdirSync(audioStore);
    const first = path.join(audioStore, "observed"), second = path.join(audioStore, ".custody");
    const original = readFileSync(f.recordingPath); writeFileSync(first, original); linkSync(first, second);
    const state = readR2BaselineState(f), input = observations(state), results = [];
    if (failure === "filesystem refusal") {
      symlinkSync(first, path.join(audioStore, "unsafe"));
      await assert.rejects(measureR2Sources({ state, recordingsDir: f.recordingsDir, audioStore, privateRoot: f.root }), /symlink/);
      results.push({ name: "r2_baseline_read", status: "fail" });
    } else {
      if (failure === "hash mismatch") writeFileSync(first, Buffer.alloc(original.length));
      if (failure === "link mismatch") linkSync(first, path.join(f.root, "outside-store"));
      const measured = await measureR2Sources({ state, recordingsDir: f.recordingsDir, audioStore, privateRoot: f.root });
      results.push(...r2BaselineOracles({ ...input, sourceMeasurement: measured }));
      assert.ok(results.some(row => row.status === "fail"));
    }
    assert.equal(typeof runner.finishPrivateRoot, "function", "runner cleanup decision is not implemented");
    const decision = runner.finishPrivateRoot({ staged: { root: f.root }, options: { keep: false, r2Baseline: true },
      live: { processEvidence: { inventory: { failures: [] }, children: [] } }, results });
    assert.equal(decision.preserveRoot, true); assert.equal(decision.reason, "r2_evidence_nonpass");
    assert.ok(existsSync(f.root) && existsSync(first) && existsSync(second)); assert.deepEqual(readFileSync(f.recordingPath), original);
  } finally { f.close(); }
});
test("actual final cleanup keeps R2 exceptional refusals and leaves clean ordinary-mode deletion unchanged", async () => {
  const modulePath = path.join(import.meta.dirname, "run.mjs"), runner = await import(modulePath);
  assert.equal(typeof runner.finishPrivateRoot, "function");
  for (const r2Baseline of [true, false]) {
    const root = mkdtempSync("/private/tmp/r2-cleanup-decision-"); writeFileSync(path.join(root, "ciphertext"), "component-only");
    try {
      const decision = runner.finishPrivateRoot({ staged: { root }, options: { keep: false, r2Baseline }, runFailed: true,
        live: { processEvidence: { inventory: { failures: [] }, children: [] } }, results: [] });
      assert.equal(decision.preserveRoot, r2Baseline); assert.equal(existsSync(root), r2Baseline);
      assert.equal(decision.reason, r2Baseline ? "r2_run_refused" : null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

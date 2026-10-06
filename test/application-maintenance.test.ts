// Application Cut C: independent, recoverable maintenance lanes
// (src/application-maintenance.ts) composed by src/application-composition.ts.
//
// Every store is a real SQLite file in a private temp root; every peer is a
// scripted in-process peer (the backfill Runtime child through the accepted
// worker's startTransport/connectRuntime seams, the organizer sender through
// the accepted NotificationSender port). No live network, device, provider or
// key is touched. Crash = abandon the handle and reopen; never a fake state.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { RecordingAlignmentEntry, RecordingAlignmentPage } from "@conversation/runtime";

import { createFilesystemOperatorWarningSink } from "../src/adapters/filesystem-operator-warning.ts";
import { createFeishuSdkHttp } from "../src/adapters/feishu-sdk-http.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { composeApplication, RUNTIME_CHILD_ENVIRONMENT_ALLOWLIST, type ComposedApplication } from "../src/application-composition.ts";
import { createApplicationMaintenance, DEFAULT_LANE_INTERVALS_MS, MAINTENANCE_LANES, type CreateMaintenanceInput, type MaintenanceOwner, type MaintenanceSupervisor } from "../src/application-maintenance.ts";
import type { BackfillGatewayTransport } from "../src/delivery/backfill-worker.ts";
import { notificationRequestUuid, type NotificationSender } from "../src/delivery/notification-worker.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { occurrencePathSegment } from "../src/domain/occurrence-id.ts";
import type { ConversationRuntimePort, FinalizedRecordingRuntime } from "../src/ports/conversation-runtime.ts";
import type { OperatorWarningSink } from "../src/ports/operator-warning.ts";
import type { SessionStore, UnknownEndCustodySource } from "../src/ports/session-store.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { ALIGNMENT_POLICY } from "../src/sessions/recording-alignment.ts";
import { STANDALONE_SCHEMA, type StandaloneConfigV1 } from "../src/standalone-config.ts";
import { testCapability } from "./lib/runtime-sdk.ts";
import { scope } from "./lib/feishu-fixtures.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const ENDED_AT = "2026-09-02T14:10:00.123Z";
const ENDED_AT_MS = Date.parse(ENDED_AT);
const WARNING_AT_MS = ENDED_AT_MS + 11 * DAY_MS;
const EXPIRES_AT_MS = ENDED_AT_MS + 14 * DAY_MS;
const COMMIT = "a".repeat(40);
const PROVENANCE = { runtimeProfile: "online", sttProvider: "stt", sttModel: "stt-v1", liveStreamModel: "live-v1",
  finalBatchModel: "final-v1", textProvider: "text", textModel: "text-v1", agentVersion: "test" } as const;

// ---------------------------------------------------------------------------
// Fixture: private data roots, one real store, one known-ended seed
// ---------------------------------------------------------------------------

type Roots = { dir: string; recordingsDir: string; outboxDir: string; receiptsDir: string; filename: string; close(): void };

function roots(): Roots {
  const dir = realpathSync(mkdtempSync(path.join(realpathSync(tmpdir()), "meeting-maintenance-")));
  const recordingsDir = path.join(dir, "recordings"), outboxDir = path.join(dir, "outbox"), receiptsDir = path.join(dir, "receipts");
  for (const name of [recordingsDir, outboxDir, receiptsDir]) { mkdirSync(name, { mode: 0o700 }); chmodSync(name, 0o700); }
  return { dir, recordingsDir, outboxDir, receiptsDir, filename: path.join(dir, "state.db"), close: () => rmSync(dir, { recursive: true, force: true }) };
}

function raw<T>(filename: string, fn: (db: Database.Database) => T): T {
  const db = new Database(filename, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}

/** A known-ended, immutable seed with a real encrypted source file (the
 * accepted finalizeWithRecording path), optionally with a selected alignment
 * so the real builder can run. */
function seedKnownEnded(store: SessionStore, r: Roots, wall: () => number, withAlignment: boolean, suffix = "") {
  const handle = createHash("sha256").update(`handle${suffix}`).digest("hex").slice(0, 32);
  const recordingPath = path.join(r.recordingsDir, `${handle}.crsr`);
  const bytes = Buffer.from(`synthetic-encrypted-recording${suffix}`);
  writeFileSync(recordingPath, bytes);
  const capability = { ...testCapability, recordingHandle: handle, sha256: createHash("sha256").update(bytes).digest("hex") };
  const identity = buildMeetingIdentity({ providerMeetingId: `meeting${suffix}`, meetingNo: `4242${suffix.length}`, occurrenceStartedAt: "2026-09-02T14:00:00Z",
    title: `Maintenance meeting${suffix}`, organizer: { feishuUserId: "ou_owner", displayName: "Owner", source: "reservation" } });
  const coordinator = createCoordinator({ store, clock: { now: wall }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 1 });
  coordinator.discover(identity); coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening");
  const bridge = `bridge${suffix}`;
  const binding = { occurrenceId: identity.occurrenceId, bridgeSessionId: bridge, runtimeSessionId: 41n };
  store.beginReconciliationGeneration(identity.occurrenceId, bridge, ENDED_AT_MS - 1_000);
  store.setReconciliationRuntimeSession(identity.occurrenceId, bridge, 41n);
  const timed = store.beginTimedEvidence(binding, ENDED_AT_MS - 1_000);
  store.appendTimedUi(timed, { schema: "bridge-session/v2", sessionId: bridge, sequence: 1, observedAt: "2026-09-02T14:00:00Z",
    type: "participant_joined", feishuUserId: "ou_owner", displayName: "Owner", observationTiming: null, observationTimingReason: "timing_unavailable" }, ENDED_AT_MS - 999);
  store.closeTimedEvidence(timed, ENDED_AT_MS);
  coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, {
    recovery: { bridgeSessionId: bridge, capability }, handle, encryptedPath: recordingPath, sha256: capability.sha256, durationMs: 20,
    format: "pcm_s16le/24000/1/20ms", keyId: capability.keyId, gaps: [], runtimeGaps: [],
  }, bridge, ENDED_AT_MS, "bridge_observed", { terminalReason: "ended", terminalSource: "bridge_observed", endedAt: ENDED_AT, identity,
    provider: "feishu", encryption: "aes-256-gcm", processingWarnings: [], provenance: PROVENANCE });
  const seed = store.getBackfillSeed(identity.occurrenceId)!;
  assert.equal(seed.stopAtMs, WARNING_AT_MS); assert.equal(seed.expiresAtMs, EXPIRES_AT_MS);
  const source = { sourceSessionId: 41n, recordingHandle: handle, sha256: capability.sha256 };
  if (withAlignment) {
    const recovery = store.getRecordingRecovery(identity.occurrenceId, bridge, handle)!;
    const epoch = { bridgeSessionId: bridge, clockDomainId: "clock", captureEpoch: 1n };
    const frame: Extract<RecordingAlignmentEntry, { kind: "frame" }> = { kind: "frame", mediaStartSample: 0n, mediaEndSample: 480n, sampleRateHz: 24_000,
      gapOffsetMs: 0n, epoch, captureStatus: "available", reasons: [],
      provenance: { captureEpoch: 1n, sequence: 1n, outputStartSample: 0n, sampleCount: 480, sourceStartNumerator: 0n, sourceEndNumerator: 11_520_000n,
        sourceDenominator: 24_000, sourceRateHz: 24_000, quality: "nominal_frame_endpoint_interpolation",
        span: { hostStartNs: 1_000_000_000n, hostEndNs: 1_020_000_000n, roundingEnvelopeNs: 1n, captureUncertaintyNs: null } },
      wall: { quality: "local_wall_estimate", policyId: "local-wall-estimate/v1", localStartNs: BigInt(Date.parse("2026-09-02T14:00:00Z")) * 1_000_000n,
        localEndNs: BigInt(Date.parse("2026-09-02T14:00:00.020Z")) * 1_000_000n, wallEpoch: 1n, wallRun: 1n, maximumBracketNs: 1n, maximumResolutionNs: 1n,
        modelAllowanceNs: 10_000_000n, interpolationRoundingNs: 1n, captureRoundingNs: 1n, captureUncertaintyNs: null, externalUtcAccuracyNs: null, overallPhysicalAccuracyNs: null } };
    const alignment = store.beginRecordingAlignment(recovery.generationId, "fixture");
    if (alignment.kind !== "claimed") throw new Error("fixture alignment already selected");
    const page: RecordingAlignmentPage = { type: "recording_alignment_page", source, pageIndex: 0n, policy: ALIGNMENT_POLICY, entries: [{ kind: "epoch", epoch }, frame] };
    store.appendRecordingAlignment(alignment.attempt, page);
    store.completeRecordingAlignment(alignment.attempt, { type: "recording_alignment_complete", source, pageCount: 1n, coverageStatus: "available",
      warnings: ["local_wall_timestamp_estimate"], traversalSucceeded: true });
  }
  return { identity, seed, recordingPath, handle, coordinator, source };
}

/** Scripted postmeeting Runtime: the real builder/outbox runs on top of it. */
function scriptedRuntime(source: { sourceSessionId: bigint; recordingHandle: string; sha256: string }, finalFailures: number) {
  let finalCalls = 0;
  const runtime = {
    currentSessionId: 99n,
    readRecordingAlignment() { throw new Error("selected alignment must replay without a new Runtime read"); },
    async reconcileFinalizedRecording() { finalCalls += 1; if (finalCalls <= finalFailures) throw new Error("synthetic final unavailable"); return { source, segments: [], warnings: [] }; },
    async processText() { return { output: { summary: "Maintenance summary", projects: [], decisions: [], action_items: [], discussion_points: [], person_summaries: [] }, warnings: [] }; },
    async close() {},
  } as unknown as ConversationRuntimePort & FinalizedRecordingRuntime & { readonly currentSessionId: bigint };
  return { runtime, finalCalls: () => finalCalls };
}

function gracefulTransport(): BackfillGatewayTransport {
  return { cleanupOutcome: { status: "graceful" as const }, messages: { async *[Symbol.asyncIterator]() { /* scripted */ } }, async send() {}, async close() {} } as BackfillGatewayTransport;
}

type Sender = NotificationSender & { calls: Array<{ receiveId: string; text: string; uuid: string }> };
function sender(): Sender {
  const calls: Sender["calls"] = [];
  return { calls, async sendText(input) { calls.push({ receiveId: input.receiveId, text: input.text, uuid: input.uuid }); return { messageId: `om_${calls.length}` }; } };
}

const quiet: MaintenanceSupervisor = { assertOwnership() {}, occurrenceIsLive: () => false, holdsFinalizedRecording: () => false };

function maintenance(store: SessionStore, r: Roots, wall: () => number, overrides: Partial<CreateMaintenanceInput> = {}): MaintenanceOwner {
  return createApplicationMaintenance({
    store, clock: { now: wall }, dataPaths: { recordingsDir: r.recordingsDir, outboxDir: r.outboxDir, receiptsDir: r.receiptsDir },
    runtime: { launcherPath: path.join(r.dir, "launcher"), gatewayConfigPath: path.join(r.dir, "gateway.toml") }, env: { PATH: "/usr/bin:/bin" },
    supervisor: quiet, discover: async () => undefined, notificationSender: sender(),
    ...overrides,
    options: { random: () => 0, intervalsMs: { backfill: 3_600_000, warning: 3_600_000, outbox: 3_600_000, notification: 3_600_000, discovery: 3_600_000, custody: 3_600_000 },
      backfill: { operationBudgetMs: 1_000, cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 }, startTransport: async () => gracefulTransport() },
      ...overrides.options },
  });
}

function writeReceipt(r: Roots, occurrenceId: string, revision: number, artifactHash: string): void {
  const receipt = { artifact_hash: artifactHash, markdown_path: "Meetings/2026-W36/[meeting].md",
    markdown_url: `https://example.test/group/vault/-/blob/${COMMIT}/Meetings/2026-W36/%5Bmeeting%5D.md`, occurrence_id: occurrenceId, revision,
    schema: "teammem-meeting-receipt/v1", status: "published", vault_commit: COMMIT };
  writeFileSync(path.join(r.receiptsDir, `${occurrencePathSegment(occurrenceId as `${string}@${string}`)}.json`), `${JSON.stringify(receipt)}\n`);
}

function warningFiles(r: Roots): string[] {
  const directory = path.join(r.outboxDir, "operator-warnings");
  return existsSync(directory) ? readdirSync(directory).filter((name) => !name.startsWith(".")) : [];
}

function lane(owner: MaintenanceOwner, name: (typeof MAINTENANCE_LANES)[number]) {
  return owner.status().lanes.find((entry) => entry.lane === name)!;
}

async function until(check: () => boolean, budgetMs = 2_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!check()) { if (Date.now() > deadline) throw new Error("condition not met within budget"); await pause(5); }
}

// ---------------------------------------------------------------------------
// 1. Scheduler: one in-flight tick per lane, next only after settlement, cadence recorded
// ---------------------------------------------------------------------------

test("each lane admits one in-flight tick, joins concurrent callers, schedules the next only after settlement and records cadence", async () => {
  const r = roots();
  const store = openSessionStore({ filename: r.filename, nowMs: 1 });
  let release: (() => void) | undefined, concurrent = 0, maxConcurrent = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const discover = async () => { calls += 1; concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent); if (calls === 1) await gate; concurrent -= 1; };
  const owner = maintenance(store, r, () => 1, { discover, options: { intervalsMs: { discovery: 20, backfill: 3_600_000, warning: 3_600_000, outbox: 3_600_000, notification: 3_600_000, custody: 3_600_000 } } });
  try {
    assert.deepEqual(owner.status().lanes.map((entry) => entry.lane), [...MAINTENANCE_LANES]);
    assert.equal(owner.status().started, false);
    owner.start();
    assert.throws(() => owner.start(), /maintenance_already_started/);
    assert.equal(lane(owner, "outbox").ticks, 0, "no start-time burst: the first tick follows one interval");
    // The timer-driven first tick blocks on the gate; every concurrent caller joins it.
    await until(() => lane(owner, "discovery").inFlight);
    const a = owner.tick("discovery"), b = owner.tick("discovery");
    assert.equal(a, b);
    await pause(60);
    assert.equal(calls, 1, "no overlapping tick while one is in flight");
    assert.equal(lane(owner, "discovery").ticks, 1);
    release!();
    assert.equal(await a, "discovery_ticked");
    await until(() => lane(owner, "discovery").ticks >= 3, 3_000);
    const status = lane(owner, "discovery");
    assert.equal(maxConcurrent, 1);
    // Node timers may fire up to ~1 ms early against performance.now; the
    // invariant proven above is no overlap, the counter records the real gap.
    assert.ok(status.lastCadenceMs !== null && status.lastCadenceMs >= 15, `start-to-start cadence ${status.lastCadenceMs} reflects the 20 ms interval`);
    assert.ok(status.maxCadenceMs !== null && status.maxCadenceMs >= status.lastCadenceMs);
    assert.ok(status.maxScheduleDelayMs !== null && status.maxScheduleDelayMs >= 0, "timer-driven ticks record their scheduling delay");
    assert.ok(status.maxDurationMs !== null && status.maxDurationMs >= 50, "the gated tick's duration is recorded");
    assert.equal(status.lastOutcome, "discovery_ticked");
    assert.deepEqual(status.failures, []);
    assert.equal(DEFAULT_LANE_INTERVALS_MS.outbox, 5_000);
    await owner.close();
    const ticks = lane(owner, "discovery").ticks;
    await pause(80);
    assert.equal(lane(owner, "discovery").ticks, ticks, "no tick after close");
    await assert.rejects(owner.tick("discovery"), /maintenance_closed/);
    assert.equal(owner.close(), owner.close(), "repeated close returns the same promise");
    assert.throws(() => maintenance(store, r, () => 1, { options: { intervalsMs: { outbox: 0 } } }), /maintenance_interval_invalid/);
  } finally { await owner.close().catch(() => undefined); store.close(); r.close(); }
});

// ---------------------------------------------------------------------------
// 2. R1: seeded-undelivered survives crash/reopen, warns at +11d, deletes at +14d
// ---------------------------------------------------------------------------

test("R1: a seed whose first build failed survives reopen, warns once at +11d through a failing sink and deletes at +14d without an artifact", async () => {
  const r = roots();
  let wall = ENDED_AT_MS + 1, spawns = 0;
  let store = openSessionStore({ filename: r.filename, nowMs: ENDED_AT_MS });
  const seeded = seedKnownEnded(store, r, () => wall, false);
  const failingRuntime = { startTransport: async () => { spawns += 1; return gracefulTransport(); }, connectRuntime: async () => { throw new Error("synthetic Runtime connect failure"); } };
  let owner = maintenance(store, r, () => wall, { options: { backfill: { operationBudgetMs: 1_000, cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 }, ...failingRuntime } } });
  try {
    assert.equal(await owner.tick("backfill"), "backfill_rescheduled");
    assert.equal(spawns, 1);
    assert.deepEqual(store.pending(), [], "no fake incomplete artifact or delivery row");
    assert.deepEqual(raw(r.filename, (db) => db.prepare("SELECT count(*) AS count FROM backfill_jobs").get()), { count: 0 }, "no job manufactured");
    assert.equal(await owner.tick("outbox"), "outbox_reconciled");
    assert.equal(existsSync(seeded.recordingPath), true, "governed audio retained before its deadline");
    // Crash: abandon the handle and owner; reopen, retry is still bounded and durable.
    store.close();
    wall += 60_000;
    store = openSessionStore({ filename: r.filename });
    assert.ok(store.getBackfillSeed(seeded.identity.occurrenceId), "seed discoverable after reopen");
    const sinkAttempts: string[] = [];
    const realSink = createFilesystemOperatorWarningSink({ outboxDir: r.outboxDir, durabilityCheckpoint: (step) => { sinkAttempts.push(step); if (sinkAttempts.length === 1) throw new Error("synthetic fsync failure"); } });
    owner = maintenance(store, r, () => wall, { options: { warningSink: realSink, backfill: { operationBudgetMs: 1_000, cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 }, ...failingRuntime } } });
    assert.equal(await owner.tick("backfill"), "backfill_rescheduled");
    assert.equal(spawns, 2, "bounded retry through the accepted owner after reopen");
    assert.equal(await owner.tick("warning"), "warning_idle", "no warning before original endedAt+11d");
    wall = WARNING_AT_MS;
    assert.equal(await owner.tick("backfill"), "backfill_stopped", "D010: backfill stops three days before expiry");
    assert.equal(await owner.tick("warning"), "warning_rescheduled", "sink failure before durable acceptance is not an accepted warning");
    assert.deepEqual(warningFiles(r), [], "the failed staging file never became the visible warning");
    assert.deepEqual(raw(r.filename, (db) => db.prepare("SELECT state, attempt_count AS attempts FROM backfill_warning_intents").get()), { state: "pending", attempts: 1 }, "durably rescheduled, never marked accepted");
    wall += 60_000;
    assert.equal(await owner.tick("warning"), "warning_accepted");
    assert.equal(warningFiles(r).length, 1, "D011: one visible inbox file");
    assert.deepEqual(raw(r.filename, (db) => db.prepare("SELECT state FROM backfill_warning_intents").get()), { state: "accepted" });
    assert.equal(await owner.tick("warning"), "warning_idle");
    wall = EXPIRES_AT_MS - 1;
    assert.equal(await owner.tick("outbox"), "outbox_reconciled");
    assert.equal(existsSync(seeded.recordingPath), true, "exact expiry: one millisecond early is not due");
    wall = EXPIRES_AT_MS;
    assert.equal(await owner.tick("outbox"), "outbox_reconciled");
    assert.equal(existsSync(seeded.recordingPath), false, "governed deletion at original endedAt+14d despite the failed build");
    assert.deepEqual(readdirSync(r.recordingsDir), [], "no tombstone left behind");
    assert.deepEqual(raw(r.filename, (db) => db.prepare("SELECT state, deleted_at_ms AS deleted FROM backfill_seed_lifecycle").get()), { state: "deleted", deleted: EXPIRES_AT_MS });
    assert.deepEqual(store.pending(), [], "still no artifact or delivery row");
    assert.equal(warningFiles(r).length, 1);
    assert.equal(store.getBackfillSeed(seeded.identity.occurrenceId)?.expiresAtMs, EXPIRES_AT_MS, "expiry never shifted");
    await owner.close();
  } finally { store.close(); r.close(); }
});

// ---------------------------------------------------------------------------
// 3. R2: incomplete then complete higher revision through the real builder/outbox
// ---------------------------------------------------------------------------

test("R2: an incomplete revision publishes through the real builder/outbox, notification follows only a verified receipt, a complete higher receipt stops retry and cleans early", async () => {
  const r = roots();
  let wall = ENDED_AT_MS + 1;
  let store = openSessionStore({ filename: r.filename, nowMs: ENDED_AT_MS });
  const seeded = seedKnownEnded(store, r, () => wall, true);
  assert.equal(store.getSession(seeded.identity.occurrenceId)?.state, "finalizing");
  const runtime = scriptedRuntime(seeded.source, 1);
  const organizer = sender();
  let spawns = 0;
  const backfill = { operationBudgetMs: 1_000, cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 },
    startTransport: async () => { spawns += 1; return gracefulTransport(); }, connectRuntime: async () => runtime.runtime };
  let owner = maintenance(store, r, () => wall, { notificationSender: organizer, options: { backfill } });
  try {
    assert.equal(await owner.tick("backfill"), "backfill_enqueued");
    const first = store.pending().find((row) => row.revision === 1)!;
    assert.equal(first.transcriptComplete, false, "the first real delivery is honestly incomplete");
    assert.equal(await owner.tick("notification"), "notification_polled");
    assert.equal(organizer.calls.length, 0, "no notification without a verified receipt");
    // Crash before receipt: reopen, the canonical intent is still deliverable.
    store.close(); wall += 1_000;
    store = openSessionStore({ filename: r.filename });
    owner = maintenance(store, r, () => wall, { notificationSender: organizer, options: { backfill } });
    assert.equal(await owner.tick("outbox"), "outbox_reconciled");
    assert.equal(store.pending().find((row) => row.revision === 1)?.retryReason, "receipt_unavailable");
    writeReceipt(r, seeded.identity.occurrenceId, 1, first.artifactHash);
    wall += 60_000;
    assert.equal(await owner.tick("outbox"), "outbox_reconciled");
    assert.equal(store.pending().find((row) => row.revision === 1)?.publishedAtMs, wall, "the receipt is the only publication evidence");
    assert.equal(existsSync(seeded.recordingPath), true, "an incomplete receipt does not clean the ciphertext early");
    assert.equal(await owner.tick("notification"), "notification_polled");
    assert.equal(organizer.calls.length, 1);
    assert.equal(organizer.calls[0]?.uuid, notificationRequestUuid({ occurrenceId: seeded.identity.occurrenceId, revision: 1, artifactHash: first.artifactHash,
      publicationUrl: `https://example.test/group/vault/-/blob/${COMMIT}/Meetings/2026-W36/%5Bmeeting%5D.md`, vaultCommit: COMMIT }));
    assert.equal(await owner.tick("notification"), "notification_polled");
    assert.equal(organizer.calls.length, 1, "replay creates no second organizer notification");
    // The accepted retry owner builds the complete higher revision through the same builder/outbox.
    wall += 60_000;
    assert.equal(await owner.tick("backfill"), "backfill_enqueued");
    const second = store.pending().find((row) => row.revision === 2)!;
    assert.equal(second.transcriptComplete, true);
    assert.equal(spawns, 2);
    assert.equal(store.pending().find((row) => row.revision === 1)?.deletedAtMs, null, "the old incomplete revision stays until the complete receipt");
    writeReceipt(r, seeded.identity.occurrenceId, 2, second.artifactHash);
    wall += 60_000;
    assert.equal(await owner.tick("outbox"), "outbox_reconciled");
    assert.equal(existsSync(seeded.recordingPath), false, "D016: a verified complete receipt may clean local ciphertext early");
    assert.deepEqual(raw(r.filename, (db) => db.prepare("SELECT state FROM backfill_jobs").get()), { state: "complete" }, "D016: the complete receipt ends retry work");
    assert.equal(await owner.tick("backfill"), "backfill_idle", "no further build after verified completion");
    assert.equal(spawns, 2);
    assert.equal(store.getBackfillSeed(seeded.identity.occurrenceId)?.expiresAtMs, EXPIRES_AT_MS, "exact expiry never shifts");
    assert.equal(await owner.tick("notification"), "notification_polled");
    assert.equal(organizer.calls.length, 2, "the complete revision has its own verified-receipt notification");
    await owner.close();
  } finally { store.close(); r.close(); }
});

// ---------------------------------------------------------------------------
// 4. R3: warning file idempotency across at-least-once sink calls; exact expiry
// ---------------------------------------------------------------------------

test("R3: simulated lost warning commit and graceful reopen leave one visible inbox file and the expiry instant never moves", async () => {
  const r = roots();
  let wall = WARNING_AT_MS;
  let store = openSessionStore({ filename: r.filename, nowMs: ENDED_AT_MS });
  const seeded = seedKnownEnded(store, r, () => wall, false);
  const real = createFilesystemOperatorWarningSink({ outboxDir: r.outboxDir });
  let accepts = 0;
  // Simulate a lost receipt commit by throwing after durable sink acceptance;
  // the worker reschedules, then this test gracefully closes and reopens SQLite.
  const crashingAfterAccept: OperatorWarningSink = { async accept(input) { const receipt = await real.accept(input); accepts += 1; if (accepts === 1) throw new Error("crash after sink acceptance"); return receipt; } };
  let owner = maintenance(store, r, () => wall, { options: { warningSink: crashingAfterAccept } });
  try {
    assert.equal(await owner.tick("backfill"), "backfill_stopped");
    assert.equal(await owner.tick("warning"), "warning_rescheduled");
    assert.equal(warningFiles(r).length, 1, "the durable file exists before the lost DB receipt");
    store.close(); wall += 60_000;
    store = openSessionStore({ filename: r.filename });
    owner = maintenance(store, r, () => wall, { options: { warningSink: crashingAfterAccept } });
    assert.equal(await owner.tick("warning"), "warning_accepted", "same-bytes replay restores durability");
    assert.equal(accepts, 2);
    assert.equal(warningFiles(r).length, 1, "one physical visible inbox file after at-least-once calls");
    assert.equal(await owner.tick("warning"), "warning_idle");
    for (const at of [EXPIRES_AT_MS - 1, EXPIRES_AT_MS - 1]) { wall = at; assert.equal(await owner.tick("outbox"), "outbox_reconciled"); }
    assert.equal(existsSync(seeded.recordingPath), true);
    wall = EXPIRES_AT_MS;
    assert.equal(await owner.tick("outbox"), "outbox_reconciled");
    assert.equal(existsSync(seeded.recordingPath), false, "deleted exactly at original endedAt+14d");
    assert.equal(warningFiles(r).length, 1);
    await owner.close();
  } finally { store.close(); r.close(); }
});

// ---------------------------------------------------------------------------
// 5. R4: a hung backfill peer inside its bound never blocks the other lanes
// ---------------------------------------------------------------------------

test("R4: a hung backfill peer within its attempt bound blocks no other lane, sees only the allowlisted env and settles as a bounded reschedule", async () => {
  const r = roots();
  const wall = ENDED_AT_MS + 1;
  const store = openSessionStore({ filename: r.filename, nowMs: ENDED_AT_MS });
  seedKnownEnded(store, r, () => wall, false);
  const seenEnv: string[][] = [];
  let aborted = false;
  const hung = { operationBudgetMs: 1_000, cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 },
    startTransport: (input: { env?: Readonly<Record<string, string>>; startupAbortSignal?: AbortSignal }) => new Promise<BackfillGatewayTransport>((resolve) => {
      seenEnv.push(Object.keys(input.env ?? {}));
      // The hung peer only yields once the worker's bounded cancel aborts it, with its reaped cleanup outcome.
      input.startupAbortSignal?.addEventListener("abort", () => { aborted = true; resolve(gracefulTransport()); }, { once: true });
    }) };
  const owner = maintenance(store, r, () => wall, { env: { PATH: "/usr/bin:/bin", HOME: r.dir }, options: { backfill: hung } });
  try {
    const backfill = owner.tick("backfill");
    await pause(20);
    assert.equal(lane(owner, "backfill").inFlight, true);
    for (const name of ["outbox", "warning", "notification", "discovery", "custody"] as const) {
      const settled = await Promise.race([owner.tick(name), pause(500).then(() => "timed_out")]);
      assert.notEqual(settled, "timed_out", `${name} advanced while backfill hung`);
    }
    assert.equal(lane(owner, "backfill").inFlight, true, "backfill still in flight inside its bound");
    assert.equal(await backfill, "backfill_rescheduled", "the bounded attempt is cancelled and durably rescheduled");
    assert.equal(aborted, true);
    assert.ok(seenEnv[0]!.every((name) => RUNTIME_CHILD_ENVIRONMENT_ALLOWLIST.includes(name)), "the peer sees only the allowlisted environment");
    assert.deepEqual(raw(r.filename, (db) => db.prepare("SELECT initial_build_last_reason AS reason, process_cleanup_state AS cleanup FROM backfill_seed_lifecycle").get()), { reason: "runtime_failed", cleanup: null });
    await owner.close();
  } finally { store.close(); r.close(); }
});

// ---------------------------------------------------------------------------
// 6. Kill/restart during an in-flight tick: no orphan, reopen resumes
// ---------------------------------------------------------------------------

test("close during an in-flight backfill tick cancels and awaits it, leaves no orphan, and a reopened owner resumes the durable retry", async () => {
  const r = roots();
  let wall = ENDED_AT_MS + 1;
  let store = openSessionStore({ filename: r.filename, nowMs: ENDED_AT_MS });
  seedKnownEnded(store, r, () => wall, false);
  let starts = 0, aborted = 0, closes = 0;
  const hung = { operationBudgetMs: 900_000, cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 },
    startTransport: (input: { startupAbortSignal?: AbortSignal }) => new Promise<BackfillGatewayTransport>((resolve) => {
      starts += 1;
      input.startupAbortSignal?.addEventListener("abort", () => { aborted += 1; resolve({ ...gracefulTransport(), async close() { closes += 1; } } as BackfillGatewayTransport); }, { once: true });
    }) };
  let owner = maintenance(store, r, () => wall, { options: { backfill: hung } });
  try {
    const tick = owner.tick("backfill");
    await pause(20);
    const closing = owner.close();
    assert.equal(await tick, "backfill_rescheduled", "the in-flight tick settles as a cancelled bounded attempt, never orphaned");
    await closing;
    assert.deepEqual([starts, aborted, closes >= 1], [1, 1, true], "the late transport is closed by the worker, not leaked");
    assert.equal(lane(owner, "backfill").inFlight, false);
    await assert.rejects(owner.tick("backfill"), /maintenance_closed/);
    store.close();
    wall += 60_000;
    store = openSessionStore({ filename: r.filename });
    owner = maintenance(store, r, () => wall, { options: { backfill: { ...hung, startTransport: async () => { starts += 1; return gracefulTransport(); }, connectRuntime: async () => { throw new Error("still unavailable"); } } } });
    assert.equal(await owner.tick("backfill"), "backfill_rescheduled", "reopen resumes the durable retry");
    assert.equal(starts, 2);
    await owner.close();
  } finally { store.close(); r.close(); }
});

// ---------------------------------------------------------------------------
// 7. D020/D022: unconfirmed Runtime cleanup poisons the lane and blocks deletion after reopen
// ---------------------------------------------------------------------------

test("D020/D022: unconfirmed process cleanup is a visible lane and close failure, and the failed ownership marker blocks deletion after reopen", async () => {
  const r = roots();
  let wall = ENDED_AT_MS + 1;
  let store = openSessionStore({ filename: r.filename, nowMs: ENDED_AT_MS });
  const seeded = seedKnownEnded(store, r, () => wall, false);
  let spawns = 0;
  const failedCleanup = { operationBudgetMs: 1_000, cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 },
    startTransport: async () => { spawns += 1; return { ...gracefulTransport(), cleanupOutcome: { status: "failed" as const, reason: "process_not_reaped" } } as BackfillGatewayTransport; },
    connectRuntime: async () => { throw new Error("synthetic Runtime connect failure"); } };
  let owner = maintenance(store, r, () => wall, { options: { backfill: failedCleanup } });
  try {
    assert.equal(await owner.tick("backfill"), "backfill_cleanup_unconfirmed");
    assert.deepEqual(lane(owner, "backfill").failures, ["backfill_cleanup_unconfirmed"]);
    assert.ok(owner.status().codes.includes("backfill:backfill_cleanup_unconfirmed"), "never reported idle");
    assert.equal(await owner.tick("backfill"), "backfill_cleanup_unconfirmed", "the poisoned worker never spawns again");
    assert.equal(spawns, 1);
    await assert.rejects(owner.close(), /maintenance_close_failed:backfill_close_failed/);
    store.close();
    wall = EXPIRES_AT_MS + 1;
    store = openSessionStore({ filename: r.filename });
    owner = maintenance(store, r, () => wall, { options: { backfill: failedCleanup } });
    assert.equal(await owner.tick("backfill"), "backfill_idle", "the failed marker refuses a new build claim after reopen");
    assert.equal(spawns, 1, "no respawn after reopen");
    assert.equal(await owner.tick("outbox"), "outbox_reconciled");
    assert.equal(existsSync(seeded.recordingPath), true, "expiry is due but active/failed Runtime ownership visibly blocks deletion");
    assert.deepEqual(raw(r.filename, (db) => db.prepare("SELECT process_cleanup_state AS cleanup, state FROM backfill_seed_lifecycle").get()), { cleanup: "failed", state: "stopped" }, "D020: stopped with a failed cleanup marker, not an ordinary retry");
    assert.equal(store.getBackfillSeed(seeded.identity.occurrenceId)?.expiresAtMs, EXPIRES_AT_MS, "the deadline is not extended to make anything green");
    await owner.close();
  } finally { store.close(); r.close(); }
});

// ---------------------------------------------------------------------------
// 8. Unknown-end custody cleanup: exact deletion, live-entry block, identity mismatch, expired claim
// ---------------------------------------------------------------------------

const STARTED_AT = "2026-09-02T14:00:00Z";
const STARTED_AT_MS = Date.parse(STARTED_AT);
const STOPPED_AT_MS = STARTED_AT_MS + 10 * 60_000;
const DETECTED_AT_MS = STOPPED_AT_MS + 3 * 60_000;
const CUSTODY_DEADLINE_MS = DETECTED_AT_MS + 14 * DAY_MS;
const FINAL = { sourceSessionId: 160n, recordingHandle: "a0".repeat(16), sha256: "a0".repeat(32), keyId: "a0".repeat(8), authorization: "a0".repeat(32) };

function custodyFixture(r: Roots, wall: () => number) {
  const store = openSessionStore({ filename: r.filename, nowMs: STARTED_AT_MS });
  const identity = buildMeetingIdentity({ providerMeetingId: "meeting-unknown-end", meetingNo: "555000111", occurrenceStartedAt: STARTED_AT, title: "Unknown end", organizer: null });
  const coordinator = createCoordinator({ store, clock: { now: wall }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 1 });
  coordinator.discover(identity); coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening");
  const recordingPath = path.join(r.recordingsDir, `${FINAL.recordingHandle}.crsr`);
  writeFileSync(recordingPath, Buffer.from("ciphertext-a0a0"));
  store.beginReconciliationGeneration(identity.occurrenceId, "bridge-final", STARTED_AT_MS);
  store.setReconciliationRuntimeSession(identity.occurrenceId, "bridge-final", FINAL.sourceSessionId);
  coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, {
    recovery: { bridgeSessionId: "bridge-final", capability: FINAL }, handle: FINAL.recordingHandle, encryptedPath: recordingPath, sha256: FINAL.sha256,
    durationMs: 600_000, format: "pcm_s16le/24000/1/20ms", keyId: FINAL.keyId, gaps: [], runtimeGaps: [] }, "bridge-final", STOPPED_AT_MS, "local_clock");
  const source: UnknownEndCustodySource = { kind: "final", occurrenceId: identity.occurrenceId };
  const assignment = store.assignUnknownEndCustody(source, DETECTED_AT_MS, { recordingHandle: FINAL.recordingHandle, encryptedPath: recordingPath, sha256: FINAL.sha256, keyId: FINAL.keyId });
  assert.equal(assignment.outcome, "assigned");
  assert.equal(assignment.custody.deadlineMs, CUSTODY_DEADLINE_MS);
  return { store, source, recordingPath, occurrenceId: identity.occurrenceId };
}

test("custody: a due unknown-end source is deleted exactly once with the identity-only tombstone and completed under its claim", async () => {
  const r = roots();
  let wall = STOPPED_AT_MS;
  const f = custodyFixture(r, () => wall);
  const owner = maintenance(f.store, r, () => wall);
  try {
    wall = CUSTODY_DEADLINE_MS - 1;
    assert.equal(await owner.tick("custody"), "custody_idle", "not due one millisecond before T+14d");
    assert.equal(existsSync(f.recordingPath), true);
    wall = CUSTODY_DEADLINE_MS;
    assert.equal(await owner.tick("custody"), "custody_deleted");
    assert.equal(existsSync(f.recordingPath), false);
    assert.deepEqual(readdirSync(r.recordingsDir), [], "tombstone removed after the exact identity recheck");
    const custody = f.store.getUnknownEndCustody(f.source)!;
    assert.equal(custody.state, "deleted"); assert.equal(custody.deletedAtMs, CUSTODY_DEADLINE_MS); assert.equal(custody.detectedAtMs, DETECTED_AT_MS);
    assert.equal(await owner.tick("custody"), "custody_idle", "deleted exactly once");
    assert.deepEqual(owner.status().custody, [{ source: f.source, outcome: "deleted", reason: null }]);
    await owner.close();
  } finally { f.store.close(); r.close(); }
});

test("custody: a live entry for the occurrence blocks deletion as a visible reader_active failure that is never auto-retried", async () => {
  const r = roots();
  let wall = STOPPED_AT_MS;
  const f = custodyFixture(r, () => wall);
  const supervisor: MaintenanceSupervisor = { ...quiet, occurrenceIsLive: (occurrenceId) => occurrenceId === f.occurrenceId };
  const owner = maintenance(f.store, r, () => wall, { supervisor });
  try {
    wall = CUSTODY_DEADLINE_MS;
    assert.equal(await owner.tick("custody"), "custody_cleanup_failed:reader_active");
    assert.equal(existsSync(f.recordingPath), true, "bytes retained");
    const custody = f.store.getUnknownEndCustody(f.source)!;
    assert.equal(custody.state, "cleanup_failed"); assert.equal(custody.cleanupFailureReason, "reader_active"); assert.equal(custody.deadlineMs, CUSTODY_DEADLINE_MS);
    wall += DAY_MS;
    assert.equal(await owner.tick("custody"), "custody_idle", "custody M2: cleanup_failed is terminal for automation");
    assert.equal(existsSync(f.recordingPath), true);
    assert.deepEqual(owner.status().custody, [{ source: f.source, outcome: "failed", reason: "reader_active" }]);
    await owner.close();
  } finally { f.store.close(); r.close(); }
});

test("custody: a source whose filesystem identity changed is recorded as identity_mismatch and never deleted", async () => {
  const r = roots();
  let wall = STOPPED_AT_MS;
  const f = custodyFixture(r, () => wall);
  const owner = maintenance(f.store, r, () => wall);
  try {
    rmSync(f.recordingPath); writeFileSync(f.recordingPath, Buffer.from("replaced-with-other-bytes"));
    wall = CUSTODY_DEADLINE_MS;
    assert.equal(await owner.tick("custody"), "custody_cleanup_failed:identity_mismatch");
    assert.equal(existsSync(f.recordingPath), true, "a replaced file is never deleted");
    assert.equal(f.store.getUnknownEndCustody(f.source)?.cleanupFailureReason, "identity_mismatch");
    await owner.close();
  } finally { f.store.close(); r.close(); }
});

test("custody M1: a claim that expires before settlement is a visible code, and the next claim records the missing source instead of silence", async () => {
  const r = roots();
  let wall = STOPPED_AT_MS, jumpAfterClaim = false;
  const f = custodyFixture(r, () => wall);
  // The lane reads the clock for the tick start, the claim, then the settlement; the wall jumps past the 30 s lease before settlement.
  let reads = 0;
  const clock = () => { if (!jumpAfterClaim) return wall; reads += 1; return reads <= 2 ? wall : wall + 31_000; };
  const owner = maintenance(f.store, r, clock);
  try {
    wall = CUSTODY_DEADLINE_MS; jumpAfterClaim = true;
    assert.equal(await owner.tick("custody"), "custody_claim_expired");
    assert.deepEqual(owner.status().custody, [{ source: f.source, outcome: "claim_expired", reason: null }]);
    assert.equal(existsSync(f.recordingPath), false, "the deletion itself happened under the live claim");
    assert.equal(f.store.getUnknownEndCustody(f.source)?.state, "cleanup_claimed", "the row keeps its expired lease; nothing is invented");
    jumpAfterClaim = false; wall += 60_000;
    assert.equal(await owner.tick("custody"), "custody_cleanup_failed:source_missing", "the later claimant re-detects and records, never silently completes");
    assert.equal(f.store.getUnknownEndCustody(f.source)?.state, "cleanup_failed");
    await owner.close();
  } finally { f.store.close(); r.close(); }
});

// ---------------------------------------------------------------------------
// 9. Composition: lanes start before Feishu readiness, close in the accepted order
// ---------------------------------------------------------------------------

function compositionFixture() {
  const dir = realpathSync(mkdtempSync(path.join(realpathSync(tmpdir()), "meeting-maintenance-composition-")));
  const stateRoot = path.join(dir, "state");
  mkdirSync(stateRoot, { mode: 0o700 }); chmodSync(stateRoot, 0o700);
  for (const name of ["recordings", "outbox", "receipts", "vault"]) { mkdirSync(path.join(dir, name), { mode: 0o700 }); chmodSync(path.join(dir, name), 0o700); }
  writeFileSync(path.join(dir, "app-secret"), "synthetic-app-secret\n", { mode: 0o600 });
  writeFileSync(path.join(dir, "bridge-static.json"), JSON.stringify({ schema: "feishu-bridge-config/v1", audio: { captureDisplayId: 1, outputDeviceUid: "synthetic" } }), { mode: 0o600 });
  const config: StandaloneConfigV1 = {
    schema: STANDALONE_SCHEMA, stateRoot,
    feishu: { region: "feishu", tenantKey: scope.tenantKey, appId: scope.appId, appSecretFile: path.join(dir, "app-secret") },
    agentIdentity: { aliases: ["Meetbot"] },
    dataPaths: { recordingsDir: path.join(dir, "recordings"), outboxDir: path.join(dir, "outbox"), receiptsDir: path.join(dir, "receipts"), teamVaultDir: path.join(dir, "vault") },
    runtime: { launcherPath: path.join(dir, "runtime-launcher"), gatewayConfigPath: path.join(dir, "gateway.toml"), protocolVersion: 4 },
    bridgeSlots: [{ physicalClientId: "mac-1", bridgeId: "bridge-1", executable: "/usr/bin/true", staticConfigPath: path.join(dir, "bridge-static.json"), argv: [], cooperativeGraceMs: 1000 }],
  };
  let asserted = 0;
  return { dir, config, owner: { assertCurrentOwnership() { asserted += 1; }, close() {}, asserted: () => asserted },
    slot: { physicalClientId: "mac-1", bridgeId: "bridge-1", async launch() { throw new Error("no live occurrence in this test"); } },
    close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("composition: maintenance lanes start before Feishu ingress readiness, expose static counters, and close in the accepted order with repeated close and post-close fences", async () => {
  const f = compositionFixture();
  const log: string[] = [];
  const organizer = sender();
  let app: ComposedApplication | undefined;
  try {
    app = await composeApplication(f.config, f.owner, { inviteIngress: false, bridgeSlots: [f.slot], log: (code) => log.push(code),
      metadata: { async resolve() { return { status: "blocked", reason: "reference_missing", retryable: false }; } },
      maintenance: { notificationSender: organizer, random: () => 0, intervalsMs: { outbox: 10, notification: 10, discovery: 10, warning: 3_600_000, custody: 3_600_000, backfill: 3_600_000 } } });
    assert.equal(app.maintenanceStatus().started, false, "construction schedules nothing");
    await app.start();
    assert.equal(app.maintenanceStatus().started, true);
    assert.ok(log.indexOf("maintenance_started") < log.indexOf("composition_started"), "lanes start before ingress readiness is awaited");
    await until(() => app!.maintenanceStatus().lanes.every((entry) => ["outbox", "notification", "discovery"].includes(entry.lane) ? entry.ticks >= 3 : entry.ticks === 0));
    assert.equal(await app.maintenanceTick("notification"), "notification_polled");
    assert.equal(await app.maintenanceTick("custody"), "custody_idle");
    assert.equal(await app.maintenanceTick("backfill"), "backfill_idle", "no seed: the accepted owner spawns nothing");
    const discovery = app.maintenanceStatus().lanes.find((entry) => entry.lane === "discovery")!;
    assert.ok(discovery.lastCadenceMs !== null && discovery.maxScheduleDelayMs !== null, "actual cadence and maximum delay are recorded");
    assert.deepEqual(app.maintenanceStatus().codes, []);
    assert.equal(f.owner.asserted() >= 2, true);
    const closing = app.close();
    assert.equal(app.close(), closing, "repeated close returns the same promise");
    await closing;
    const order = ["shutdown_fenced", "maintenance_fenced", "maintenance_closed", "shutdown_owned_work_settled", "shutdown_application_closed", "shutdown_runtime_owners_closed", "shutdown_transports_closed", "shutdown_store_closed"];
    assert.deepEqual(log.filter((code) => order.includes(code)), order, "ticks are fenced and awaited before the application, transports and store close");
    const ticksAtClose = app.maintenanceStatus().lanes.map((entry) => entry.ticks);
    await pause(60);
    assert.deepEqual(app.maintenanceStatus().lanes.map((entry) => entry.ticks), ticksAtClose, "no lane callback on the closed store");
    await assert.rejects(app.maintenanceTick("outbox"), /maintenance_closed/);
    assert.equal(app.maintenanceStatus().closing, true);
  } finally { await app?.close().catch(() => undefined); f.close(); }
});

test("composition: a maintenance close failure is surfaced in the aggregate static code list, never as idle; the shipped organizer sender is composed from the Feishu scope and claims nothing without a verified receipt", async () => {
  const f = compositionFixture();
  const log: string[] = [];
  const wall = ENDED_AT_MS + 1;
  const seedStore = openSessionStore({ filename: path.join(f.config.stateRoot, "orchestration.db"), nowMs: ENDED_AT_MS });
  const r: Roots = { dir: f.dir, recordingsDir: f.config.dataPaths.recordingsDir, outboxDir: f.config.dataPaths.outboxDir, receiptsDir: f.config.dataPaths.receiptsDir, filename: "", close() {} };
  seedKnownEnded(seedStore, r, () => wall, false);
  seedStore.close();
  let feishuRequests = 0;
  const http = createFeishuSdkHttp({ request: async () => { feishuRequests += 1; throw new Error("must_not_call"); } });
  let app: ComposedApplication | undefined;
  try {
    app = await composeApplication(f.config, f.owner, { inviteIngress: false, bridgeSlots: [f.slot], clock: { now: () => wall },
      metadata: { async resolve() { return { status: "blocked", reason: "reference_missing", retryable: false }; } },
      feishu: { http },
      log: (code) => log.push(code),
      maintenance: { random: () => 0, intervalsMs: { outbox: 3_600_000, notification: 3_600_000, discovery: 3_600_000, warning: 3_600_000, custody: 3_600_000, backfill: 3_600_000 },
        backfill: { operationBudgetMs: 1_000, cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 },
          startTransport: async () => ({ ...gracefulTransport(), cleanupOutcome: { status: "failed" as const, reason: "process_not_reaped" } } as BackfillGatewayTransport),
          connectRuntime: async () => { throw new Error("synthetic Runtime connect failure"); } } } });
    await app.start();
    assert.ok(!log.includes("notification_sender_unavailable"), "production composes the exact Feishu adapter that owns the tenant-token credential");
    assert.equal(await app.maintenanceTick("notification"), "notification_polled", "the lane always has a sender");
    assert.ok(!app.maintenanceStatus().codes.some((code) => code.startsWith("notification:")));
    assert.equal(feishuRequests, 0, "no receipt is verified, so the composed sender is never reached");
    assert.equal(await app.maintenanceTick("backfill"), "backfill_cleanup_unconfirmed");
    await assert.rejects(app.close(), /composition_close_failed:backfill_close_failed/);
  } finally { await app?.close().catch(() => undefined); await http.close().catch(() => undefined); f.close(); }
});

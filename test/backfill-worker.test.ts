import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { StdioGatewayTransport, type RecordingAlignmentEntry, type RecordingAlignmentPage } from "@conversation/runtime";

import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { createBackfillWarningWorker, createBackfillWorker } from "../src/delivery/backfill-worker.ts";
import type { BackfillGatewayTransport } from "../src/delivery/backfill-worker.ts";
import { createOutboxWorker, type OutboxWorker } from "../src/delivery/outbox-worker.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import type { PostmeetingRuntime } from "../src/adapters/conversation-runtime-client.ts";
import type { AlignmentAttempt, BackfillSeed, SessionStore } from "../src/ports/session-store.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { ALIGNMENT_POLICY } from "../src/sessions/recording-alignment.ts";
import { testCapability } from "./lib/runtime-sdk.ts";

const absoluteGateway = path.resolve("test/fixtures/runtime-gateway");
const absoluteConfig = path.resolve("test/fixtures/runtime-config.json");
const store = {} as SessionStore;
const outbox = {} as OutboxWorker;

const seed: BackfillSeed = {
  occurrenceId: "synthetic@2026-09-02T14:00:00Z", provider: "feishu", providerMeetingId: "synthetic",
  meetingNo: "000000000", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Synthetic", organizer: null,
  endedAt: "2026-09-02T14:10:00Z", endedAtMs: 1_000, stopAtMs: 1_000_000, expiresAtMs: 2_000_000,
  bridgeSessionId: "bridge", generationId: "generation", capability: testCapability,
  recordingPath: "/private/recordings/recording.enc", recordingFormat: "pcm_s16le/24000/1/20ms",
  recordingEncryption: "aes-256-gcm", recordingBytes: 1, recordingDevice: "1", recordingInode: "2",
  recordingDurationMs: 1, recordingSha256: testCapability.sha256, recordingKeyId: testCapability.keyId,
  bridgeGaps: [], runtimeGaps: [], processingWarnings: [], provenance: { runtimeProfile: "online",
    sttProvider: "stt", sttModel: "stt-v1", liveStreamModel: "live-v1", finalBatchModel: "final-v1",
    textProvider: "text", textModel: "text-v1", agentVersion: "test" },
};

function options(overrides: Partial<Parameters<typeof createBackfillWorker>[0]> = {}): Parameters<typeof createBackfillWorker>[0] {
  return {
    store, outbox, gatewayPath: absoluteGateway, configPath: absoluteConfig,
    env: { PATH: "/usr/bin:/bin" }, clock: { now: () => 1, monotonicNow: () => 1 }, random: () => 0, readKnownProjects: () => [],
    ...overrides,
  };
}

test("backfill worker rejects unsafe paths and incompatible total/cleanup budgets before polling", () => {
  assert.throws(() => createBackfillWorker(options({ gatewayPath: "relative-gateway" })), /absolute gateway/i);
  assert.throws(() => createBackfillWorker(options({ configPath: "relative-config" })), /absolute config/i);
  assert.throws(() => createBackfillWorker(options({ operationBudgetMs: 999,
    cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 } })), /operation budget/i);
  assert.throws(() => createBackfillWorker(options({ operationBudgetMs: 1_000,
    cleanupTimeouts: { eofGraceMs: 500, termGraceMs: 250, killGraceMs: 250 } })), /cleanup reserve|operation budget/i);
  assert.throws(() => createBackfillWorker(options({ cleanupTimeouts: {
    eofGraceMs: 30_001, termGraceMs: 1, killGraceMs: 1 } })), /cleanup timeout/i);
  assert.throws(() => createBackfillWorker(options({ cleanupTimeouts: {
    eofGraceMs: 30_000, termGraceMs: 30_000, killGraceMs: 1 } })), /cleanup timeout/i);
});

test("a frozen original window with no positive work interval reschedules without process admission", async () => {
  let began = 0, spawned = 0, failed = 0;
  const boundedSeed = { ...seed, stopAtMs: 1_003, expiresAtMs: 2_000 };
  const fakeStore = { stopDueBackfill: () => null,
    claimBackfillSeedBuild: () => ({ seed: boundedSeed, claimToken: "a".repeat(32), claimExpiresAtMs: 62_000,
      attempt: 1, targetRevision: 1, observedAtMs: 1_000 }),
    claimBackfillJob: () => null,
    beginBackfillProcess: () => { began++; return { processOwnerToken: "a".repeat(32) }; },
    failBackfillBuild: () => { failed++; return { kind: "rescheduled" }; },
  } as unknown as SessionStore;
  const worker = createBackfillWorker(options({ store: fakeStore, operationBudgetMs: 1_000,
    cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 },
    clock: { now: () => 1_000, monotonicNow: () => 1 },
    startTransport: async () => { spawned++; throw new Error("must not spawn"); } }));
  assert.deepEqual(await worker.pollOnce(),
    { kind: "rescheduled", occurrenceId: seed.occurrenceId, reason: "build_failed" });
  assert.equal(began, 0);
  assert.equal(spawned, 0);
  assert.equal(failed, 1);
});

test("missing process cleanup proof persists failed ownership and poisons the worker against respawn", async () => {
  let claims = 0;
  const settlements: Array<{ outcome: string; token: string }> = [];
  const fakeStore = {
    stopDueBackfill: () => null,
    claimBackfillSeedBuild: () => {
      claims++;
      return { seed, claimToken: "a".repeat(32), claimExpiresAtMs: 62_000, attempt: 1,
        targetRevision: 1, observedAtMs: 1_000 };
    },
    claimBackfillJob: () => null,
    beginBackfillProcess: () => ({ processOwnerToken: "a".repeat(32) }),
    settleBackfillProcess: (input: { readonly outcome: string; readonly processOwnerToken: string }) => {
      settlements.push({ outcome: input.outcome, token: input.processOwnerToken });
      return { outcome: input.outcome };
    },
  } as unknown as SessionStore;
  const worker = createBackfillWorker(options({ store: fakeStore, operationBudgetMs: 1_000,
    cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 },
    startTransport: async () => { throw new Error("synthetic spawn failure"); } }));

  let first: unknown;
  try { await worker.pollOnce(); } catch (error) { first = error; }
  assert.ok(first instanceof AggregateError);
  assert.match(first.message, /cleanup was not confirmed/);
  assert.deepEqual(settlements, [{ outcome: "failed", token: "a".repeat(32) }]);
  await assert.rejects(worker.pollOnce(), (error) => error === first);
  assert.equal(claims, 1);
});

test("confirmed transport cleanup settles before a maximum bounded Runtime retry is scheduled", async () => {
  const order: string[] = [];
  let claimed = false, now = 1_000, beginAt = 0, retryDelayMs = 0;
  const fakeStore = {
    stopDueBackfill: () => null,
    claimBackfillSeedBuild: () => {
      if (claimed) return null;
      claimed = true;
      now = 1_001;
      return { seed, claimToken: "a".repeat(32), claimExpiresAtMs: 62_000, attempt: 1,
        targetRevision: 1, observedAtMs: 1_000 };
    },
    claimBackfillJob: () => null,
    beginBackfillProcess: (input: { readonly nowMs: number }) => {
      beginAt = input.nowMs; order.push("begin"); return { processOwnerToken: "a".repeat(32) };
    },
    settleBackfillProcess: (input: { readonly outcome: string }) => {
      order.push(`settle:${input.outcome}`); return { outcome: input.outcome };
    },
    failBackfillBuild: (input: { readonly reason: string; readonly retryDelayMs: number }) => {
      retryDelayMs = input.retryDelayMs;
      order.push(`fail:${input.reason}`); return { kind: "rescheduled" };
    },
  } as unknown as SessionStore;
  const transport = {
    cleanupOutcome: { status: "graceful" as const },
    messages: { async *[Symbol.asyncIterator]() { /* no messages */ } },
    async send() {},
    async close() { order.push("transport:close"); },
  } as BackfillGatewayTransport;
  const worker = createBackfillWorker(options({ store: fakeStore, operationBudgetMs: 1_000,
    cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 },
    clock: { now: () => now, monotonicNow: () => 1 },
    random: () => 1,
    startTransport: async () => transport,
    connectRuntime: async () => { throw new Error("synthetic Runtime connect failure"); } }));

  assert.deepEqual(await worker.pollOnce(), { kind: "rescheduled", occurrenceId: seed.occurrenceId, reason: "runtime_failed" });
  assert.equal(beginAt, 1_001);
  assert.equal(retryDelayMs, 60_000);
  assert.deepEqual(order, ["begin", "transport:close", "settle:confirmed", "fail:runtime_failed"]);
  assert.deepEqual(await worker.pollOnce(), { kind: "idle" });
  await worker.close();
});

test("failed process cleanup after replaying a selected alignment poisons the instance before a second spawn", async () => {
  let claims = 0, transports = 0, selected = 0, recoveryReads = 0;
  const recoveryOrder: string[] = [];
  let pending: AlignmentAttempt | null = { storeIdentity: "store", generationId: seed.generationId, attemptId: "pending",
    ownerId: "prior-owner", token: "prior-token" };
  const selectedAlignment = { generationId: seed.generationId, attemptId: "selected", source: {
    sourceSessionId: seed.capability.sourceSessionId, recordingHandle: seed.capability.recordingHandle,
    sha256: seed.capability.sha256 }, timingContract: "capture-clock/v1" as const,
    policyId: "local-wall-estimate/v1" as const, coverageStatus: "available" as const,
    pageCount: 0, entryCount: 0, storedBytes: 0, warnings: [] };
  const fakeStore = {
    stopDueBackfill: () => null,
    claimBackfillSeedBuild: () => {
      claims++;
      return { seed, claimToken: "a".repeat(32), claimExpiresAtMs: 62_000, attempt: 1,
        targetRevision: 1, observedAtMs: 1_000 };
    },
    claimBackfillJob: () => null,
    beginBackfillProcess: () => ({ processOwnerToken: "a".repeat(32) }),
    settleBackfillProcess: (input: { readonly outcome: string }) => ({ outcome: input.outcome }),
    getRecordingRecovery: () => {
      if (++recoveryReads > 2) throw new Error("synthetic closed-evidence failure after selected replay");
      return { generationId: seed.generationId, occurrenceId: seed.occurrenceId, bridgeSessionId: seed.bridgeSessionId,
        capability: seed.capability, recordingKind: "final" as const, failureAttempt: null };
    },
    getPendingAlignment: () => pending,
    abandonRecordingAlignment: () => { recoveryOrder.push("abandon"); pending = null; },
    getReclaimableAlignment: () => null,
    beginRecordingAlignment: () => { recoveryOrder.push("selected"); selected++; return { kind: "selected" as const, selected: selectedAlignment }; },
  } as unknown as SessionStore;
  const transport = { cleanupOutcome: { status: "failed" as const, reason: "process_not_reaped" as const },
    messages: { async *[Symbol.asyncIterator]() { /* injected adapter does not consume transport */ } },
    async send() {}, async close() {} } as BackfillGatewayTransport;
  const runtime = { currentSessionId: 99n, runtimeProfile: "online", readRecordingAlignment() { throw new Error("selected alignment must not be read"); },
    async close() {} } as unknown as PostmeetingRuntime & { readonly currentSessionId: bigint };
  const worker = createBackfillWorker(options({ store: fakeStore, operationBudgetMs: 1_000,
    cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 },
    startTransport: async () => { transports++; return transport; }, connectRuntime: async () => runtime,
    proveExclusiveOwnership: async () => { recoveryOrder.push("proof"); } }));

  let first: unknown;
  try { await worker.pollOnce(); } catch (error) { first = error; }
  assert.ok(first instanceof AggregateError);
  assert.equal(selected, 1);
  assert.deepEqual(recoveryOrder, ["proof", "abandon", "selected"]);
  await assert.rejects(worker.pollOnce(), (error) => error === first);
  assert.equal(transports, 1);
  assert.equal(claims, 1);
});

test("unresolved alignment without trusted ownership proof stays blocked without a new Runtime read", async () => {
  let alignmentReads = 0, failures = 0;
  const fakeStore = {
    stopDueBackfill: () => null,
    claimBackfillSeedBuild: () => ({ seed, claimToken: "a".repeat(32), claimExpiresAtMs: 62_000,
      attempt: 1, targetRevision: 1, observedAtMs: 1_000 }),
    claimBackfillJob: () => null,
    beginBackfillProcess: () => ({ processOwnerToken: "a".repeat(32) }),
    settleBackfillProcess: (input: { readonly outcome: string }) => ({ outcome: input.outcome }),
    getRecordingRecovery: () => ({ generationId: seed.generationId, occurrenceId: seed.occurrenceId,
      bridgeSessionId: seed.bridgeSessionId, capability: seed.capability,
      recordingKind: "final" as const, failureAttempt: null }),
    getReclaimableAlignment: () => null,
    beginRecordingAlignment: () => { throw new Error("alignment is owned or has unreclaimed pages"); },
    failBackfillBuild: (input: { readonly reason: string }) => {
      failures++; assert.equal(input.reason, "alignment_failed"); return { kind: "rescheduled" as const };
    },
  } as unknown as SessionStore;
  const transport = { cleanupOutcome: { status: "graceful" as const },
    messages: { async *[Symbol.asyncIterator]() { /* injected adapter does not consume transport */ } },
    async send() {}, async close() {} } as BackfillGatewayTransport;
  const runtime = { currentSessionId: 99n, runtimeProfile: "online",
    readRecordingAlignment() { alignmentReads++; throw new Error("must not read without ownership"); },
    async close() {} } as unknown as PostmeetingRuntime & { readonly currentSessionId: bigint };
  const worker = createBackfillWorker(options({ store: fakeStore, operationBudgetMs: 1_000,
    cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 },
    startTransport: async () => transport, connectRuntime: async () => runtime }));

  assert.deepEqual(await worker.pollOnce(),
    { kind: "rescheduled", occurrenceId: seed.occurrenceId, reason: "alignment_failed" });
  assert.equal(alignmentReads, 0);
  assert.equal(failures, 1);
  await worker.close();
});

test("actual no-ready child is actively reaped while the original startup promise settles", { timeout: 5_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-backfill-no-ready-"));
  const wrapper = path.join(dir, "gateway.sh"), pidFile = path.join(dir, "child.pid");
  writeFileSync(wrapper, `#!/bin/sh
echo $$ > ${JSON.stringify(pidFile)}
exec /bin/sleep 60
`, { mode: 0o700 });
  chmodSync(wrapper, 0o700);
  let claims = 0, confirmedSettlements = 0, failures = 0;
  let actualTransport: StdioGatewayTransport | undefined;
  const fakeStore = {
    stopDueBackfill: () => null,
    claimBackfillSeedBuild: () => {
      claims++;
      if (claims > 1) return null;
      return { seed, claimToken: "a".repeat(32), claimExpiresAtMs: 62_000, attempt: 1,
        targetRevision: 1, observedAtMs: 1_000 };
    },
    claimBackfillJob: () => null,
    beginBackfillProcess: () => ({ processOwnerToken: "a".repeat(32) }),
    settleBackfillProcess: (input: { readonly outcome: string }) => {
      if (input.outcome === "confirmed") confirmedSettlements++;
      return { outcome: input.outcome };
    },
    failBackfillBuild: () => { failures++; return { kind: "rescheduled" }; },
  } as unknown as SessionStore;
  const worker = createBackfillWorker(options({ store: fakeStore, gatewayPath: wrapper, configPath: pidFile,
    env: { PATH: "/opt/homebrew/opt/node@24/bin:/usr/bin:/bin" }, operationBudgetMs: 2_000,
    cleanupTimeouts: { eofGraceMs: 100, termGraceMs: 100, killGraceMs: 100 },
    startTransport: async (input) => {
      assert.equal(input.gatewayPath, wrapper);
      actualTransport = await StdioGatewayTransport.start(input);
      return actualTransport;
    } }));

  try {
    const originalStartupAttempt = worker.pollOnce();
    assert.deepEqual(await originalStartupAttempt,
      { kind: "rescheduled", occurrenceId: seed.occurrenceId, reason: "runtime_failed" });
    assert.ok(actualTransport);
    assert.ok(actualTransport.cleanupOutcome?.status === "graceful" || actualTransport.cleanupOutcome?.status === "forced");
    assert.deepEqual(await worker.pollOnce(), { kind: "idle" });
    assert.equal(claims, 2);
    assert.equal(confirmedSettlements, 1);
    assert.equal(failures, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("close during a blocked Runtime connect actively closes ownership and awaits the original operation", async () => {
  let connectStarted!: () => void, rejectConnect!: (error: Error) => void;
  const enteredConnect = new Promise<void>((resolve) => { connectStarted = resolve; });
  const blockedConnect = new Promise<never>((_resolve, reject) => { rejectConnect = reject; });
  let cleanupOutcome: BackfillGatewayTransport["cleanupOutcome"], closes = 0, settlements = 0, failures = 0;
  const transport = { get cleanupOutcome() { return cleanupOutcome; },
    messages: { async *[Symbol.asyncIterator]() { /* injected adapter does not consume transport */ } }, async send() {},
    async close() { closes++; cleanupOutcome = { status: "graceful" }; rejectConnect(new Error("owned transport closed")); },
  } as BackfillGatewayTransport;
  const fakeStore = {
    stopDueBackfill: () => null,
    claimBackfillSeedBuild: () => ({ seed, claimToken: "a".repeat(32), claimExpiresAtMs: 62_000,
      attempt: 1, targetRevision: 1, observedAtMs: 1_000 }),
    claimBackfillJob: () => null,
    beginBackfillProcess: () => ({ processOwnerToken: "a".repeat(32) }),
    settleBackfillProcess: () => { settlements++; return { outcome: "confirmed" }; },
    failBackfillBuild: () => { failures++; return { kind: "rescheduled" }; },
  } as unknown as SessionStore;
  const worker = createBackfillWorker(options({ store: fakeStore, operationBudgetMs: 1_000,
    cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 }, startTransport: async () => transport,
    connectRuntime: () => { connectStarted(); return blockedConnect; } }));

  const original = worker.pollOnce();
  await enteredConnect;
  const closing = worker.close();
  assert.deepEqual(await original, { kind: "rescheduled", occurrenceId: seed.occurrenceId, reason: "runtime_failed" });
  await closing;
  assert.ok(closes >= 1);
  assert.equal(settlements, 1);
  assert.equal(failures, 1);
  await assert.rejects(worker.pollOnce(), /closed/);
});

test("warning worker commits only an exact durable receipt and reschedules sink failure", async () => {
  const payload = { schema: "meeting-operator-warning/v1" as const, occurrenceId: seed.occurrenceId,
    stopAt: "2026-09-13T14:10:00.000Z", expiresAt: "2026-09-16T14:10:00.000Z", reason: "backfill_stopped" as const };
  const claims = [
    { occurrenceId: seed.occurrenceId, claimToken: "a".repeat(32), claimExpiresAtMs: 31_000,
      attempt: 1, payload, key: "warning-key" },
    { occurrenceId: seed.occurrenceId, claimToken: "b".repeat(32), claimExpiresAtMs: 32_000,
      attempt: 2, payload, key: "warning-key" },
  ];
  const accepted: string[] = [], failed: Array<{ token: string; delay: number }> = [];
  const warningStore = {
    claimBackfillWarning: () => claims.shift() ?? null,
    acceptBackfillWarning: (input: { readonly claimToken: string }) => { accepted.push(input.claimToken); },
    failBackfillWarning: (input: { readonly claimToken: string; readonly retryDelayMs: number }) => {
      failed.push({ token: input.claimToken, delay: input.retryDelayMs });
    },
  };
  let calls = 0;
  const worker = createBackfillWarningWorker({ store: warningStore, clock: { now: () => 1_000 }, random: () => 1,
    sink: { async accept(input) {
      calls++;
      if (calls === 2) throw new Error("synthetic sink failure");
      return { key: input.key };
    } } });

  assert.deepEqual(await worker.pollOnce(), { kind: "accepted", occurrenceId: seed.occurrenceId, key: "warning-key" });
  assert.deepEqual(await worker.pollOnce(), { kind: "rescheduled", occurrenceId: seed.occurrenceId });
  assert.deepEqual(accepted, ["a".repeat(32)]);
  assert.deepEqual(failed, [{ token: "b".repeat(32), delay: 60_000 }]);
  assert.deepEqual(await worker.pollOnce(), { kind: "idle" });
  await worker.close();
});

test("warning worker close awaits its one in-flight durable sink operation", async () => {
  const payload = { schema: "meeting-operator-warning/v1" as const, occurrenceId: seed.occurrenceId,
    stopAt: "2026-09-13T14:10:00.000Z", expiresAt: "2026-09-16T14:10:00.000Z", reason: "backfill_stopped" as const };
  let release!: () => void, accepted = 0, closed = false;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const worker = createBackfillWarningWorker({
    store: { claimBackfillWarning: () => ({ occurrenceId: seed.occurrenceId, claimToken: "a".repeat(32),
        claimExpiresAtMs: 31_000, attempt: 1, payload, key: "warning-key" }),
      acceptBackfillWarning: () => { accepted++; }, failBackfillWarning: () => assert.fail("sink succeeds") },
    sink: { async accept(input) { await pending; return { key: input.key }; } },
    clock: { now: () => 1_000 }, random: () => 0,
  });
  const poll = worker.pollOnce();
  const close = worker.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  assert.equal((await poll).kind, "accepted");
  await close;
  assert.equal(accepted, 1);
});

test("real SQLite worker hands off an incomplete initial artifact then a complete reserved retry", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-backfill-worker-"));
  const recordingsDir = path.join(dir, "recordings"), outboxDir = path.join(dir, "outbox"), receiptsDir = path.join(dir, "receipts");
  mkdirSync(recordingsDir); mkdirSync(outboxDir); mkdirSync(receiptsDir);
  const recordingPath = path.join(recordingsDir, `${testCapability.recordingHandle}.crsr`);
  const bytes = Buffer.from("synthetic-encrypted-recording");
  writeFileSync(recordingPath, bytes);
  const capability = { ...testCapability, sha256: createHash("sha256").update(bytes).digest("hex") };
  const endedAt = "2026-09-02T14:10:00.123Z", endedAtMs = Date.parse(endedAt);
  let wall = endedAtMs + 1, transports = 0, finalCalls = 0;
  const store = openSessionStore({ filename: path.join(dir, "state.db"), nowMs: endedAtMs });
  const identity = buildMeetingIdentity({ providerMeetingId: "worker-meeting", meetingNo: "424242",
    occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Worker meeting",
    organizer: { feishuUserId: "owner", displayName: "Owner", source: "reservation" } });
  const coordinator = createCoordinator({ store, clock: { now: () => wall }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 1 });
  coordinator.discover(identity); coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening");
  const binding = { occurrenceId: identity.occurrenceId, bridgeSessionId: "bridge", runtimeSessionId: 41n };
  store.beginReconciliationGeneration(identity.occurrenceId, "bridge", endedAtMs - 1_000);
  store.setReconciliationRuntimeSession(identity.occurrenceId, "bridge", 41n);
  const timed = store.beginTimedEvidence(binding, endedAtMs - 1_000);
  store.appendTimedUi(timed, { schema: "bridge-session/v2", sessionId: "bridge", sequence: 1, observedAt: "2026-09-02T14:00:00Z",
    type: "participant_joined", feishuUserId: "owner", displayName: "Owner", observationTiming: null,
    observationTimingReason: "timing_unavailable" }, endedAtMs - 999);
  store.closeTimedEvidence(timed, endedAtMs);
  coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, {
    recovery: { bridgeSessionId: "bridge", capability }, handle: capability.recordingHandle, encryptedPath: recordingPath,
    sha256: capability.sha256, durationMs: 20, format: "pcm_s16le/24000/1/20ms", keyId: capability.keyId,
    gaps: [], runtimeGaps: [],
  }, "bridge", endedAtMs, "bridge_observed", { terminalReason: "ended", terminalSource: "bridge_observed", endedAt,
    identity, provider: "feishu", encryption: "aes-256-gcm", processingWarnings: [], provenance: {
      runtimeProfile: "online", sttProvider: "stt", sttModel: "stt-v1", liveStreamModel: "live-v1",
      finalBatchModel: "final-v1", textProvider: "text", textModel: "text-v1", agentVersion: "test" } });
  const recovery = store.getRecordingRecovery(identity.occurrenceId, "bridge", capability.recordingHandle)!;
  const source = { sourceSessionId: 41n, recordingHandle: capability.recordingHandle, sha256: capability.sha256 };
  const epoch = { bridgeSessionId: "bridge", clockDomainId: "clock", captureEpoch: 1n };
  const frame: Extract<RecordingAlignmentEntry, { kind: "frame" }> = { kind: "frame", mediaStartSample: 0n,
    mediaEndSample: 480n, sampleRateHz: 24_000, gapOffsetMs: 0n, epoch, captureStatus: "available", reasons: [],
    provenance: { captureEpoch: 1n, sequence: 1n, outputStartSample: 0n, sampleCount: 480,
      sourceStartNumerator: 0n, sourceEndNumerator: 11_520_000n, sourceDenominator: 24_000, sourceRateHz: 24_000,
      quality: "nominal_frame_endpoint_interpolation", span: { hostStartNs: 1_000_000_000n,
        hostEndNs: 1_020_000_000n, roundingEnvelopeNs: 1n, captureUncertaintyNs: null } },
    wall: { quality: "local_wall_estimate", policyId: "local-wall-estimate/v1",
      localStartNs: BigInt(Date.parse("2026-09-02T14:00:00Z")) * 1_000_000n,
      localEndNs: BigInt(Date.parse("2026-09-02T14:00:00.020Z")) * 1_000_000n,
      wallEpoch: 1n, wallRun: 1n, maximumBracketNs: 1n, maximumResolutionNs: 1n, modelAllowanceNs: 10_000_000n,
      interpolationRoundingNs: 1n, captureRoundingNs: 1n, captureUncertaintyNs: null,
      externalUtcAccuracyNs: null, overallPhysicalAccuracyNs: null } };
  const alignment = store.beginRecordingAlignment(recovery.generationId, "fixture");
  assert.equal(alignment.kind, "claimed");
  if (alignment.kind !== "claimed") throw new Error("fixture alignment already selected");
  const page: RecordingAlignmentPage = { type: "recording_alignment_page", source, pageIndex: 0n,
    policy: ALIGNMENT_POLICY, entries: [{ kind: "epoch", epoch }, frame] };
  store.appendRecordingAlignment(alignment.attempt, page);
  store.completeRecordingAlignment(alignment.attempt, { type: "recording_alignment_complete", source, pageCount: 1n,
    coverageStatus: "available", warnings: ["local_wall_timestamp_estimate"], traversalSucceeded: true });

  const outbox = createOutboxWorker({ recordingsDir, outboxDir, receiptsDir, journal: store, clock: { now: () => wall },
    random: () => 0, session: { state: (occurrenceId) => store.getSession(occurrenceId)?.state ?? null,
      publish: () => assert.fail("atomic store owns publication") }, reconciliationEvidence: store });
  const worker = createBackfillWorker({ store, outbox, gatewayPath: "/synthetic/gateway", configPath: "/synthetic/config.json",
    env: { PATH: "/usr/bin:/bin" }, operationBudgetMs: 1_000,
    cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 },
    clock: { now: () => wall, monotonicNow: () => 1 }, random: () => 0, readKnownProjects: () => [],
    startTransport: async () => {
      transports++;
      return { cleanupOutcome: { status: "graceful" as const },
        messages: { async *[Symbol.asyncIterator]() { /* injected adapter does not consume transport */ } },
        async send() {}, async close() {} } as BackfillGatewayTransport;
    },
    connectRuntime: async () => ({ currentSessionId: 99n, runtimeProfile: "online",
      readRecordingAlignment() { throw new Error("selected alignment must replay without a new Runtime read"); },
      async reconcileFinalizedRecording() {
        finalCalls++;
        if (finalCalls === 1) throw new Error("synthetic first final unavailable");
        return { source, segments: [], warnings: [] };
      },
      async processText() { return { output: { summary: "Worker summary", projects: [], decisions: [], action_items: [],
        discussion_points: [], person_summaries: [] }, warnings: [] }; },
      async close() {},
    } as unknown as PostmeetingRuntime & { readonly currentSessionId: bigint }),
  });

  try {
    rmSync(outboxDir, { recursive: true, force: true });
    writeFileSync(outboxDir, "synthetic blocked outbox parent");
    const initial = await worker.pollOnce();
    assert.equal(initial.kind, "enqueued");
    if (initial.kind !== "enqueued") throw new Error("initial build was not enqueued");
    assert.equal(initial.revision, 1);
    assert.equal(store.pending().find(({ revision }) => revision === 1)?.transcriptComplete, false);
    rmSync(outboxDir, { force: true });
    mkdirSync(outboxDir);
    outbox.reconcile();
    wall++;
    const retry = await worker.pollOnce();
    assert.equal(retry.kind, "enqueued");
    if (retry.kind !== "enqueued") throw new Error("retry build was not enqueued");
    assert.equal(retry.revision, 2);
    assert.equal(store.pending().find(({ revision }) => revision === 2)?.transcriptComplete, true);
    assert.equal(transports, 2);
    await worker.close();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

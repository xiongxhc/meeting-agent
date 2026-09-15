import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import type { VersionFourVoiceTranscriptFinalEvent } from "@conversation/runtime";
import type { BridgeEventMessageV2 } from "../src/contracts/bridge-session-v2.ts";
import * as live from "../src/sessions/live-provisional.ts";
import { decodeLiveEvidence, encodeLiveEvidence } from "../src/sessions/live-evidence-codec.ts";

export function liveFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-live-timed-")), filename = path.join(dir, "state.db");
  const store = openSessionStore({ filename });
  const identity = buildMeetingIdentity({ providerMeetingId: "synthetic", meetingNo: "000000000", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Synthetic", organizer: null });
  const coordinator = createCoordinator({ store, clock: { now: () => 1000 }, bridgeLeaseTtlMs: 30000, maxConcurrentSessions: 1 });
  coordinator.discover(identity);
  store.beginReconciliationGeneration(identity.occurrenceId, "bridge-one", 1000);
  store.setReconciliationRuntimeSession(identity.occurrenceId, "bridge-one", 42n);
  const binding = { occurrenceId: identity.occurrenceId, bridgeSessionId: "bridge-one", runtimeSessionId: 42n };
  return { dir, filename, store, identity, binding, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

export function timedFinal(segmentId = "9"): VersionFourVoiceTranscriptFinalEvent {
  return { type: "voice_transcript_final", sessionId: 42n, segmentId, turnId: null, text: "Agent, note the decision",
    capture: { kind: "source_sample_range/v1", clockDomainId: "domain", captureEpoch: 1n, firstFrameSequence: 7n, lastFrameSequence: 8n,
      sourceStartSample: 9007199254740993n, sourceEndSample: 9007199254741017n, sampleRateHz: 24000 },
    liveCoverage: { kind: "whole_touched_frame_nominal_host_envelope/v1", hostStartNs: 1_000_000_000n, hostEndNs: 2_000_000_000n,
      firstFrameHostEndNs: 1_500_000_000n, mappingQuality: "nominal_frame_endpoint_interpolation", captureUncertaintyNs: null, knownRoundingAllowanceNs: 1n } };
}
export function snapshot(sequence = 1): BridgeEventMessageV2 {
  return { schema: "bridge-session/v2", sessionId: "bridge-one", sequence, observedAt: "2026-09-02T14:00:00Z", type: "ui_snapshot",
    snapshotSequence: sequence, observationTiming: { clockDomainId: "domain", hostBeforeNs: "9007199254740993", hostAfterNs: "9007199254740994" },
    state: "ui_exact", feishuUserId: "person", reason: null, barrierBefore: null };
}

test("SQLite retains parsed timed wording/source and exact v2 brackets before one-shot result, across reopen", () => {
  const f = liveFixture();
  try {
    const owner = f.store.beginTimedEvidence(f.binding, 1000);
    assert.equal(f.store.appendTimedFinal(owner, timedFinal(), 1001), "inserted");
    assert.equal(f.store.appendTimedUi(owner, snapshot(), 1001), "inserted");
    const other = openSessionStore({ filename: f.filename });
    try {
      assert.deepEqual(other.readTimedFinal(f.binding, "", 1002)?.event, timedFinal());
      assert.equal(other.readTimedFinal(f.binding, "", 1002)?.result, null);
      assert.deepEqual(other.readTimedUi(f.binding, 0, 1002), [snapshot()]);
      assert.throws(() => other.beginTimedEvidence(f.binding, 1002), /owned|exists/);
      assert.equal(f.store.resolveTimedFinal(owner, "9", { kind: "anonymous", reason: "coverage_missing" }, 1003), true);
      assert.equal(other.resolveTimedFinal(owner, "9", { kind: "provisional_ui_observed", feishuUserId: "person" }, 1004), false);
      assert.deepEqual(other.readTimedFinal(f.binding, "", 1005)?.result, { kind: "anonymous", reason: "coverage_missing" });
    } finally { other.close(); }
  } finally { f.close(); }
});

test("timed durable caps latch separate loss facts without discarding admissible timing-missing wording", () => {
  const f = liveFixture();
  try {
    const owner = f.store.beginTimedEvidence(f.binding, 1000);
    assert.equal(f.store.appendTimedFinal(owner, { type: "voice_transcript_final", sessionId: 42n, segmentId: "1", turnId: null,
      text: "still retained", captureUnavailableReason: "capture_timing_missing" }, 1000), "inserted");
    assert.equal(f.store.appendTimedFinal(owner, { ...timedFinal("2"), text: "x".repeat(16385) }, 1000), "overflow");
    assert.equal(f.store.getTimedEvidenceStatus(f.binding, 1000)?.wordingLossReason, "text_limit_exceeded");
    assert.equal(f.store.getTimedEvidenceStatus(f.binding, 1000)?.uiLossReason, null);
    assert.equal(f.store.readTimedFinal(f.binding, "", 1000)?.event.text, "still retained");
  } finally { f.close(); }
});

test("expired timed payload is unreadable while bounded physical purge resumes without a large cascade", () => {
  const f = liveFixture(), raw = new Database(f.filename);
  try {
    const owner = f.store.beginTimedEvidence(f.binding, 1000);
    for (let i = 1; i <= 17; i++) f.store.appendTimedUi(owner, snapshot(i), 1000);
    f.store.appendTimedFinal(owner, timedFinal(), 1000);
    f.store.completeReconciliationGeneration(f.binding.occurrenceId, f.binding.bridgeSessionId, 2000, "local_clock");
    const expiry = 2000 + 14 * 24 * 60 * 60 * 1000;
    assert.equal(f.store.readTimedUi(f.binding, 0, expiry - 1).length, 8);
    assert.deepEqual(f.store.readTimedUi(f.binding, 0, expiry), []);
    assert.equal(f.store.readTimedFinal(f.binding, "", expiry), null);
    assert.equal(f.store.purgeExpiredReconciliationEvidence(expiry), 0);
    assert.deepEqual(raw.prepare("SELECT count(*) AS n FROM timed_ui_evidence").get(), { n: 9 });
    assert.equal(f.store.purgeExpiredTimedEvidenceBatch(expiry).removedRows, 8);
    assert.equal(f.store.purgeExpiredReconciliationEvidence(expiry), 1);
    assert.deepEqual(raw.prepare("SELECT count(*) AS n FROM timed_ui_evidence").get(), { n: 0 });
  } finally { raw.close(); f.close(); }
});

test("provisional attribution needs whole-envelope periodic coverage, attendance and a fresh observed activation", async () => {
  const f = liveFixture();
  const results: unknown[] = [];
  try {
    const owner = new live.LiveProvisionalCorrelator({ store: f.store, binding: f.binding, nowMs: () => 1000, onResult: (event) => results.push(event) });
    owner.observe({ schema: "bridge-session/v2", sessionId: "bridge-one", sequence: 1, observedAt: "2026-09-02T14:00:00Z",
      type: "participant_joined", feishuUserId: "person", displayName: "Person",
      observationTiming: { clockDomainId: "domain", hostBeforeNs: "0", hostAfterNs: "1" }, observationTimingReason: null });
    owner.observe({ ...snapshot(2), state: "unknown", feishuUserId: null, reason: "no_highlight", observationTiming: { clockDomainId: "domain", hostBeforeNs: "2", hostAfterNs: "3" } });
    owner.observe({ ...snapshot(3), observationTiming: { clockDomainId: "domain", hostBeforeNs: "900000000", hostAfterNs: "950000000" } });
    owner.finalize(timedFinal());
    assert.equal(results.length, 0);
    owner.observe({ ...snapshot(4), observationTiming: { clockDomainId: "domain", hostBeforeNs: "2000000000", hostAfterNs: "2000000001" } });
    assert.deepEqual(results, [{ segmentId: "9", result: { kind: "provisional_ui_observed", feishuUserId: "person" } }]);
    await owner.close();
  } finally { f.close(); }
});

class CatchupClock implements live.LiveCatchupClock {
  time = 0;
  readonly tasks = new Map<() => void, number>();
  now() { return this.time; }
  schedule(callback: () => void, delay: number) { this.tasks.set(callback, this.time + delay); return () => { this.tasks.delete(callback); }; }
  advance(ms: number) { this.time += ms; for (const [task, at] of [...this.tasks]) if (at <= this.time) { this.tasks.delete(task); task(); } }
}
function joined(sequence = 1): BridgeEventMessageV2 {
  return { schema: "bridge-session/v2", sessionId: "bridge-one", sequence, observedAt: "2026-09-02T14:00:00Z", type: "participant_joined",
    feishuUserId: "person", displayName: "Person", observationTiming: { clockDomainId: "domain", hostBeforeNs: "0", hostAfterNs: "1" }, observationTimingReason: null };
}
function snap(sequence: number, before: bigint, state: "ui_exact" | "unknown" | "unreadable" = "ui_exact"): Extract<BridgeEventMessageV2, { type: "ui_snapshot" }> {
  return { ...snapshot(sequence), type: "ui_snapshot", snapshotSequence: sequence, state, feishuUserId: state === "ui_exact" ? "person" : null,
    reason: state === "ui_exact" ? null : state === "unknown" ? "no_highlight" : "snapshot_unreadable", barrierBefore: null,
    observationTiming: { clockDomainId: "domain", hostBeforeNs: before.toString(), hostAfterNs: (before + 1n).toString() } };
}
function inDomain(event: BridgeEventMessageV2, clockDomainId: string): BridgeEventMessageV2 {
  if (!("observationTiming" in event) || event.observationTiming === null) throw new Error("test requires timing");
  return { ...event, observationTiming: { ...event.observationTiming, clockDomainId } };
}

test("A to B retires A, releases old coverage, and lets only the new domain restart its epoch", async () => {
  const f = liveFixture(), clock = new CatchupClock(), results: live.ProvisionalResolution[] = [];
  const owner = new live.LiveProvisionalCorrelator({ store: f.store, binding: f.binding, nowMs: () => 1000, catchupClock: clock, onResult: (r) => results.push(r) });
  try {
    owner.observe(joined()); owner.observe(snap(2, 10n, "unknown")); owner.observe(snap(3, 900_000_000n));
    owner.finalize({ ...timedFinal("1"), capture: { ...timedFinal().capture!, captureEpoch: 9n } });
    owner.observe(inDomain(joined(4), "B"));
    assert.deepEqual(results[0]?.result, { kind: "anonymous", reason: "generation_changed" });
    owner.observe(inDomain({ ...snap(5, 10n, "unknown"), snapshotSequence: 4 }, "B")); owner.observe(inDomain({ ...snap(6, 900_000_000n), snapshotSequence: 5 }, "B"));
    owner.finalize({ ...timedFinal("2"), capture: { ...timedFinal().capture!, clockDomainId: "B" } });
    owner.observe(inDomain({ ...snap(7, 2_000_000_000n), snapshotSequence: 6 }, "B"));
    assert.deepEqual(results[1]?.result, { kind: "provisional_ui_observed", feishuUserId: "person" });
    owner.observe(joined(8)); owner.observe(snap(9, 10n, "unknown")); owner.observe(snap(10, 900_000_000n));
    owner.finalize(timedFinal("3")); owner.observe(snap(11, 2_000_000_000n)); clock.advance(2000);
    assert.equal(results[2]?.result.kind, "anonymous");
    assert.equal(f.store.getTimedEvidenceStatus(f.binding, 1000)?.uiLossReason, "ui_invalid");
  } finally { await owner.close(); f.close(); }
});

test("retired domain IDs share the 4096 observation budget instead of retaining unbounded history", async () => {
  const f = liveFixture(), clock = new CatchupClock(), results: live.ProvisionalResolution[] = [];
  const owner = new live.LiveProvisionalCorrelator({ store: f.store, binding: f.binding, nowMs: () => 1000, catchupClock: clock, onResult: (r) => results.push(r) });
  try {
    for (let i = 1; i <= 4096; i++) owner.observe(inDomain(joined(i), `domain-${i}`));
    owner.finalize({ ...timedFinal(), capture: { ...timedFinal().capture!, clockDomainId: "domain-4096" } });
    owner.observe(inDomain(snap(4097, 10n, "unknown"), "domain-4096"));
    assert.deepEqual(results[0]?.result, { kind: "anonymous", reason: "observation_limit" });
    owner.observe(inDomain(joined(4098), "last-domain"));
    owner.finalize({ ...timedFinal("10"), capture: { ...timedFinal().capture!, clockDomainId: "last-domain" } });
    assert.deepEqual(results[1]?.result, { kind: "anonymous", reason: "observation_limit" });
  } finally { await owner.close(); f.close(); }
});

test("the native stream-start snapshot barrier does not erase already observed same-domain attendance", async () => {
  const f = liveFixture(), results: live.ProvisionalResolution[] = [];
  const owner = new live.LiveProvisionalCorrelator({ store: f.store, binding: f.binding, nowMs: () => 1000, onResult: (r) => results.push(r) });
  try {
    owner.observe(joined());
    owner.observe({ ...snap(2, 10n, "unknown"), barrierBefore: "stream_start" });
    owner.observe(snap(3, 900_000_000n)); owner.finalize(timedFinal()); owner.observe(snap(4, 2_000_000_000n));
    assert.equal(results[0]?.result.kind, "provisional_ui_observed");
  } finally { await owner.close(); f.close(); }
});

test("fixed catchup deadline is not refreshed by duplicate finals and pending overflow is one-shot", async () => {
  const f = liveFixture(), clock = new CatchupClock(), results: live.ProvisionalResolution[] = [];
  const owner = new live.LiveProvisionalCorrelator({ store: f.store, binding: f.binding, nowMs: () => 1000, catchupClock: clock, onResult: (r) => results.push(r) });
  try {
    for (let i = 1; i <= 33; i++) owner.finalize(timedFinal(String(i)));
    assert.deepEqual(results, [{ segmentId: "33", result: { kind: "anonymous", reason: "pending_limit" } }]);
    assert.equal(clock.tasks.size, 32);
    clock.advance(1999); owner.finalize(timedFinal("1")); assert.equal(results.length, 1);
    clock.advance(1); assert.equal(results.length, 33); assert.equal(clock.tasks.size, 0);
    assert.equal(results.find((r) => r.segmentId === "1")?.result.kind, "anonymous");
    owner.finalize(timedFinal("1")); assert.equal(results.length, 33);
  } finally { await owner.close(); f.close(); }
});

for (const variant of ["startup", "old_activation", "unknown_break", "unreadable_break", "gap", "missing_attendance", "partial_start"] as const) {
  test(`provisional ${variant} cannot name by holding or stretching a snapshot`, async () => {
    const f = liveFixture(), clock = new CatchupClock(), results: live.ProvisionalResolution[] = [];
    const owner = new live.LiveProvisionalCorrelator({ store: f.store, binding: f.binding, nowMs: () => 1000, catchupClock: clock, onResult: (r) => results.push(r) });
    try {
      let sequence = 1;
      if (variant !== "missing_attendance") owner.observe(joined(sequence++));
      if (variant !== "startup") owner.observe(snap(sequence++, 10n, "unknown"));
      owner.observe(snap(sequence++, variant === "partial_start" ? 1_000_000_000n : 900_000_000n));
      const event = timedFinal();
      if (variant === "old_activation") event.liveCoverage = { ...event.liveCoverage!, firstFrameHostEndNs: 4_000_000_000n, hostEndNs: 4_000_000_000n };
      owner.finalize(event);
      if (variant === "unknown_break" || variant === "unreadable_break") owner.observe(snap(sequence++, 1_500_000_000n, variant === "unknown_break" ? "unknown" : "unreadable"));
      owner.observe(snap(sequence++, variant === "gap" || variant === "old_activation" ? 4_000_000_000n : 2_000_000_000n));
      clock.advance(2000);
      assert.equal(results.length, 1); assert.equal(results[0]?.result.kind, "anonymous");
    } finally { await owner.close(); f.close(); }
  });
}

test("reopen cannot take an active owner; actual prior child reap precedes fenced anonymous recovery", async () => {
  const f = liveFixture();
  const child = fork(new URL("./fixtures/live-evidence-owner-crash.ts", import.meta.url), [f.filename, f.binding.occurrenceId], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    await once(child, "message");
    assert.throws(() => f.store.beginTimedEvidence(f.binding, 1000), /owner.*exists/);
    let release!: () => void;
    const proof = new Promise<void>((resolve) => { release = resolve; });
    const recovery = live.recoverPendingLiveEvidence({ store: f.store, binding: f.binding, nowMs: () => 1000, exclusivePriorOwnerClosed: () => proof });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.store.readTimedFinal(f.binding, "", 1000)?.result, null);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    release(); await recovery;
    const reopened = openSessionStore({ filename: f.filename });
    try {
      assert.equal(reopened.readTimedFinal(f.binding, "", 1000)?.event.text, "prior process wording");
      assert.deepEqual(reopened.readTimedFinal(f.binding, "", 1000)?.result, { kind: "anonymous", reason: "owner_restarted" });
      assert.equal(reopened.getTimedEvidenceStatus(f.binding, 1000)?.state, "closed");
    } finally { reopened.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    f.close();
  }
});

test("reading a persisted recovery descriptor is not live-write authority on another handle", () => {
  const f = liveFixture(), other = openSessionStore({ filename: f.filename });
  try {
    const owner = f.store.beginTimedEvidence(f.binding, 1000);
    f.store.appendTimedFinal(owner, timedFinal(), 1000);
    const descriptor = other.getTimedRecoveryOwner(f.binding, 1000); assert.ok(descriptor);
    assert.throws(() => other.resolveTimedFinal(descriptor, "9", { kind: "provisional_ui_observed", feishuUserId: "impostor" }, 1000), /authority/);
    assert.equal(f.store.readTimedFinal(f.binding, "", 1000)?.result, null);
  } finally { other.close(); f.close(); }
});

test("invalid envelope retains valid source locator and wording instead of discarding both", () => {
  const event = timedFinal(); event.liveCoverage = { ...event.liveCoverage!, hostEndNs: 0n };
  const decoded = decodeLiveEvidence(encodeLiveEvidence(event), event.text);
  assert.deepEqual(decoded.capture, event.capture);
  assert.equal(decoded.liveCoverage, undefined); assert.equal(decoded.captureUnavailableReason, "capture_timing_inconsistent");
  assert.equal(decoded.text, event.text);
});

test("a timer write failure remains owned through close instead of escaping or losing its pending row", async () => {
  const f = liveFixture(), raw = new Database(f.filename), clock = new CatchupClock();
  const owner = new live.LiveProvisionalCorrelator({ store: f.store, binding: f.binding, nowMs: () => 1000, catchupClock: clock });
  try {
    owner.finalize(timedFinal());
    raw.exec("CREATE TRIGGER reject_result BEFORE UPDATE ON timed_live_evidence BEGIN SELECT RAISE(ABORT, 'injected result failure'); END");
    assert.doesNotThrow(() => clock.advance(2000));
    assert.equal(f.store.readTimedFinal(f.binding, "", 1000)?.result, null);
    raw.exec("DROP TRIGGER reject_result");
    await assert.rejects(owner.close(), /injected result failure/);
    assert.deepEqual(f.store.readTimedFinal(f.binding, "", 1000)?.result, { kind: "anonymous", reason: "owner_closed" });
  } finally { raw.close(); await owner.close().catch(() => {}); f.close(); }
});

test("a failed UI insert closes pending coverage immediately and retains cleanup failure ownership", async () => {
  const f = liveFixture(), raw = new Database(f.filename), clock = new CatchupClock(), results: live.ProvisionalResolution[] = [];
  const owner = new live.LiveProvisionalCorrelator({ store: f.store, binding: f.binding, nowMs: () => 1000, catchupClock: clock, onResult: (r) => results.push(r) });
  try {
    owner.observe(joined()); owner.observe(snap(2, 10n, "unknown")); owner.observe(snap(3, 900_000_000n)); owner.finalize(timedFinal());
    raw.exec("CREATE TRIGGER reject_observation BEFORE INSERT ON timed_ui_evidence BEGIN SELECT RAISE(ABORT, 'injected observation failure'); END");
    assert.throws(() => owner.observe(snap(4, 2_000_000_000n)), /injected observation failure/);
    assert.equal(results.length, 1); assert.equal(results[0]?.result.kind, "anonymous"); assert.equal(clock.tasks.size, 0);
    raw.exec("DROP TRIGGER reject_observation");
    await assert.rejects(owner.close(), /injected observation failure/);
    assert.equal(f.store.getTimedEvidenceStatus(f.binding, 1000)?.uiLossReason, "ui_invalid");
  } finally { raw.close(); await owner.close().catch(() => {}); f.close(); }
});

test("live row cap and trigger failure leave committed counters truthful", () => {
  const f = liveFixture(), raw = new Database(f.filename);
  try {
    const owner = f.store.beginTimedEvidence(f.binding, 1000);
    raw.exec("CREATE TRIGGER reject_final BEFORE INSERT ON timed_live_evidence BEGIN SELECT RAISE(ABORT, 'injected final failure'); END");
    assert.throws(() => f.store.appendTimedFinal(owner, timedFinal(), 1000), /injected/);
    assert.equal(f.store.getTimedEvidenceStatus(f.binding, 1000)?.liveRows, 0);
    raw.exec("DROP TRIGGER reject_final");
    for (let i = 1; i <= 256; i++) assert.equal(f.store.appendTimedFinal(owner, timedFinal(String(i)), 1000), "inserted");
    assert.equal(f.store.appendTimedFinal(owner, timedFinal("257"), 1000), "overflow");
    assert.equal(f.store.getTimedEvidenceStatus(f.binding, 1000)?.liveRows, 256);
    assert.equal(f.store.getTimedEvidenceStatus(f.binding, 1000)?.wordingLossReason, "live_limit_exceeded");
    assert.equal(f.store.getTimedEvidenceStatus(f.binding, 1000)?.uiLossReason, null);
  } finally { raw.close(); f.close(); }
});

test("clock expiry between pending wording and UI resolution forbids a post-expiry name", async () => {
  const f = liveFixture(), clock = new CatchupClock(); let now = 1000;
  const results: live.ProvisionalResolution[] = [];
  const owner = new live.LiveProvisionalCorrelator({ store: f.store, binding: f.binding, nowMs: () => now, catchupClock: clock, onResult: (r) => results.push(r) });
  try {
    owner.finalize(timedFinal());
    f.store.completeReconciliationGeneration(f.binding.occurrenceId, f.binding.bridgeSessionId, 2000, "local_clock");
    now = 2000 + 14 * 24 * 60 * 60 * 1000;
    clock.advance(2000);
    assert.deepEqual(results, [{ segmentId: "9", result: { kind: "anonymous", reason: "evidence_expired" } }]);
    assert.equal(f.store.readTimedFinal(f.binding, "", now), null);
  } finally { await owner.close(); f.close(); }
});

for (const invalid of ["malformed", "backward", "sequence_gap"] as const) {
  test(`${invalid} UI records close pending coverage and latch a durable loss fact`, async () => {
    const f = liveFixture(), results: live.ProvisionalResolution[] = [];
    const owner = new live.LiveProvisionalCorrelator({ store: f.store, binding: f.binding, nowMs: () => 1000, onResult: (r) => results.push(r) });
    try {
      owner.observe(joined()); owner.observe(snap(2, 10n, "unknown")); owner.observe(snap(3, 900_000_000n)); owner.finalize(timedFinal());
      if (invalid === "malformed") assert.throws(() => owner.observe({ ...snap(4, 1_000_000_000n), smuggled: true }));
      else owner.observe(snap(invalid === "sequence_gap" ? 5 : 4, invalid === "backward" ? 800_000_000n : 1_000_000_000n));
      assert.equal(results.length, 1); assert.equal(results[0]?.result.kind, "anonymous");
      assert.equal(f.store.getTimedEvidenceStatus(f.binding, 1000)?.uiLossReason, invalid === "sequence_gap" ? "ui_sequence_gap" : "ui_invalid");
    } finally { await owner.close(); f.close(); }
  });
}

test("expiry during trusted recovery proof settles pending anonymous without exposing expired text", async () => {
  const f = liveFixture(), raw = new Database(f.filename); let now = 1000;
  try {
    const owner = f.store.beginTimedEvidence(f.binding, now); f.store.appendTimedFinal(owner, timedFinal(), now);
    f.store.completeReconciliationGeneration(f.binding.occurrenceId, f.binding.bridgeSessionId, 2000, "local_clock");
    await live.recoverPendingLiveEvidence({ store: f.store, binding: f.binding, nowMs: () => now,
      exclusivePriorOwnerClosed: async () => { now = 2000 + 14 * 24 * 60 * 60 * 1000; } });
    assert.equal(f.store.readTimedFinal(f.binding, "", now), null);
    assert.deepEqual(raw.prepare("SELECT result FROM timed_live_evidence").get(), { result: '{"kind":"anonymous","reason":"evidence_expired"}' });
    assert.deepEqual(raw.prepare("SELECT state FROM timed_evidence_owners").get(), { state: "closed" });
    assert.throws(() => f.store.resolveTimedFinal(owner, "9", { kind: "anonymous", reason: "owner_closed" }, now), /stale|closed/);
  } finally { raw.close(); f.close(); }
});

test("4097th in-memory observation resolves pending anonymously without growing the retained coverage history", async () => {
  const f = liveFixture(), clock = new CatchupClock(), results: live.ProvisionalResolution[] = [];
  const owner = new live.LiveProvisionalCorrelator({ store: f.store, binding: f.binding, nowMs: () => 1000, catchupClock: clock, onResult: (r) => results.push(r) });
  try {
    owner.finalize(timedFinal());
    for (let i = 1; i <= 4096; i++) owner.observe(snap(i, BigInt(i * 1000)));
    assert.equal(results.length, 0);
    owner.observe(snap(4097, 4097000n));
    assert.deepEqual(results, [{ segmentId: "9", result: { kind: "anonymous", reason: "observation_limit" } }]);
    assert.equal(clock.tasks.size, 0); assert.equal(f.store.getTimedEvidenceStatus(f.binding, 1000)?.uiRows, 4097);
  } finally { await owner.close(); f.close(); }
});

for (const delta of [0n, 1n]) {
  test(`first touched frame END freshness boundary ${delta}ns beyond2s`, async () => {
    const f = liveFixture(), clock = new CatchupClock(), results: live.ProvisionalResolution[] = [];
    const owner = new live.LiveProvisionalCorrelator({ store: f.store, binding: f.binding, nowMs: () => 1000, catchupClock: clock, onResult: (r) => results.push(r) });
    try {
      owner.observe(joined()); owner.observe(snap(2, 900_000_000n, "unknown")); owner.observe(snap(3, 950_000_000n));
      const event = timedFinal(); event.liveCoverage = { ...event.liveCoverage!, firstFrameHostEndNs: 2_900_000_000n + delta, hostEndNs: 3_000_000_000n };
      owner.finalize(event); owner.observe(snap(4, 1_800_000_000n)); owner.observe(snap(5, 3_000_000_000n));
      assert.deepEqual(results[0]?.result, delta === 0n ? { kind: "provisional_ui_observed", feishuUserId: "person" } : { kind: "anonymous", reason: "activation_not_fresh" });
    } finally { await owner.close(); f.close(); }
  });
}

test("private codec rejects corrupt schema/tags/bindings without a partial decoded result", () => {
  const encoded = encodeLiveEvidence(timedFinal());
  for (const payload of [encoded.replace('"schema":1', '"schema":2'), encoded.replace('"u64"', '"u128"'), encoded.replace('"42"', '"042"'),
    encoded.replace('"segmentId":"9"', '"segmentId":"0"'), encoded.replace('"captureEpoch":', '"unexpected":'), "{", " ".repeat(4097)]) {
    assert.throws(() => decodeLiveEvidence(payload, "wording"));
  }
});

for (const priorState of ["unknown", "different_id"] as const) {
  test(`activation uses earliest prior ${priorState} bracket edge, not its end or a later same-ID poll`, async () => {
    const f = liveFixture(), results: live.ProvisionalResolution[] = [];
    const owner = new live.LiveProvisionalCorrelator({ store: f.store, binding: f.binding, nowMs: () => 1000, onResult: (r) => results.push(r) });
    try {
      owner.observe(joined());
      owner.observe({ ...snap(2, 899_999_999n, priorState === "unknown" ? "unknown" : "ui_exact"),
        ...(priorState === "different_id" ? { feishuUserId: "other" } : {}),
        observationTiming: { clockDomainId: "domain", hostBeforeNs: "899999999", hostAfterNs: "900000001" } });
      owner.observe(snap(3, 950_000_000n));
      const final = timedFinal(); final.liveCoverage = { ...final.liveCoverage!, firstFrameHostEndNs: 2_900_000_000n, hostEndNs: 3_000_000_000n };
      owner.finalize(final); owner.observe(snap(4, 1_800_000_000n)); owner.observe(snap(5, 3_000_000_000n));
      assert.deepEqual(results, [{ segmentId: "9", result: { kind: "anonymous", reason: "activation_not_fresh" } }]);
    } finally { await owner.close(); f.close(); }
  });
}

test("cancelled yielding expiry drain leaves unreadable resumable payload and current generations intact", async () => {
  const f = liveFixture(), abort = new AbortController();
  try {
    const owner = f.store.beginTimedEvidence(f.binding, 1000);
    for (let i = 1; i <= 25; i++) f.store.appendTimedUi(owner, snapshot(i), 1000);
    f.store.completeReconciliationGeneration(f.binding.occurrenceId, f.binding.bridgeSessionId, 2000, "local_clock");
    f.store.beginReconciliationGeneration(f.binding.occurrenceId, "current", 3000); f.store.setReconciliationRuntimeSession(f.binding.occurrenceId, "current", 43n);
    const current = { ...f.binding, bridgeSessionId: "current", runtimeSessionId: 43n }; f.store.beginTimedEvidence(current, 3000);
    const expiry = 2000 + 14 * 24 * 60 * 60 * 1000;
    const draining = live.drainExpiredTimedEvidence(f.store, expiry, abort.signal); abort.abort(); await assert.rejects(draining);
    assert.deepEqual(f.store.readTimedUi(f.binding, 0, expiry), []);
    const reopened = openSessionStore({ filename: f.filename });
    try { await live.drainExpiredTimedEvidence(reopened, expiry); assert.ok(reopened.getTimedEvidenceStatus(current, expiry)); }
    finally { reopened.close(); }
    assert.equal(f.store.purgeExpiredTimedEvidenceBatch(expiry).pending, false);
  } finally { f.close(); }
});

test("actual 65536-row UI admission ceiling latches loss and preserves exact counters across failed inserts", () => {
  const f = liveFixture(), raw = new Database(f.filename);
  try {
    const owner = f.store.beginTimedEvidence(f.binding, 1000);
    const insert = raw.prepare("INSERT INTO timed_ui_evidence(generation_id, sequence, payload) VALUES (?, ?, ?)");
    let bytes = 0;
    raw.transaction(() => { for (let i = 1; i <= 65535; i++) { const payload = JSON.stringify(snapshot(i)); bytes += Buffer.byteLength(payload); insert.run(owner.generationId, i, payload); } })();
    raw.exec("CREATE TRIGGER reject_ui BEFORE INSERT ON timed_ui_evidence BEGIN SELECT RAISE(ABORT, 'injected UI failure'); END");
    assert.throws(() => f.store.appendTimedUi(owner, snapshot(65536), 1000), /injected UI failure/);
    assert.equal(f.store.getTimedEvidenceStatus(f.binding, 1000)?.uiBytes, bytes);
    raw.exec("DROP TRIGGER reject_ui");
    assert.equal(f.store.appendTimedUi(owner, snapshot(65536), 1000), "inserted"); bytes += Buffer.byteLength(JSON.stringify(snapshot(65536)));
    assert.equal(f.store.appendTimedUi(owner, snapshot(65537), 1000), "overflow");
    assert.deepEqual(f.store.getTimedEvidenceStatus(f.binding, 1000), { state: "active", uiRows: 65536, uiBytes: bytes, liveRows: 0,
      uiLossReason: "ui_limit_exceeded", wordingLossReason: null }); // No owner token/authority in this public projection.
    assert.throws(() => raw.prepare("UPDATE timed_evidence_owners SET ui_bytes = 268435457 WHERE generation_id = ?").run(owner.generationId), /CHECK/);
    assert.equal(f.store.getTimedEvidenceStatus(f.binding, 1000)?.uiBytes, bytes);
    assert.equal(f.store.readTimedUi(f.binding, 65535, 1000).length, 1);
  } finally { raw.close(); f.close(); }
});

test("purge transaction failure rolls back rows and counters; one bounded retry leaves the expired remainder", () => {
  const f = liveFixture(), raw = new Database(f.filename);
  try {
    const owner = f.store.beginTimedEvidence(f.binding, 1000);
    for (let i = 1; i <= 10; i++) f.store.appendTimedUi(owner, snapshot(i), 1000);
    f.store.appendTimedFinal(owner, timedFinal(), 1000);
    f.store.completeReconciliationGeneration(f.binding.occurrenceId, f.binding.bridgeSessionId, 2000, "local_clock");
    const expiry = 2000 + 14 * 24 * 60 * 60 * 1000;
    const before = raw.prepare("SELECT ui_rows, ui_bytes, live_rows FROM timed_evidence_owners").get();
    raw.exec("CREATE TRIGGER reject_purge BEFORE DELETE ON timed_live_evidence BEGIN SELECT RAISE(ABORT, 'injected purge failure'); END");
    assert.throws(() => f.store.purgeExpiredTimedEvidenceBatch(expiry), /injected purge/);
    assert.deepEqual(raw.prepare("SELECT ui_rows, ui_bytes, live_rows FROM timed_evidence_owners").get(), before);
    raw.exec("DROP TRIGGER reject_purge");
    assert.deepEqual(f.store.purgeExpiredTimedEvidenceBatch(expiry), { removedRows: 9, removedGenerations: 0, pending: true });
    assert.deepEqual(raw.prepare("SELECT ui_rows, live_rows FROM timed_evidence_owners").get(), { ui_rows: 2, live_rows: 0 });
  } finally { raw.close(); f.close(); }
});

test("failed exclusive-owner proof and old generations cannot overwrite selected results or new live bindings", async () => {
  const f = liveFixture();
  try {
    const old = f.store.beginTimedEvidence(f.binding, 1000); f.store.appendTimedFinal(old, timedFinal(), 1000);
    const descriptor = f.store.getTimedRecoveryOwner(f.binding, 1000);
    await assert.rejects(live.recoverPendingLiveEvidence({ store: f.store, binding: f.binding, nowMs: () => 1000,
      exclusivePriorOwnerClosed: async () => { throw new Error("prior owner not reaped"); } }), /not reaped/);
    assert.deepEqual(f.store.getTimedRecoveryOwner(f.binding, 1000), descriptor);
    assert.throws(() => f.store.appendTimedFinal(old, { ...timedFinal(), sessionId: 43n }, 1000), /source/);
    assert.throws(() => f.store.appendTimedUi(old, { ...snapshot(), sessionId: "other" }, 1000), /UI evidence/);
    f.store.resolveTimedFinal(old, "9", { kind: "anonymous", reason: "owner_closed" }, 1000); f.store.closeTimedEvidence(old, 1000);
    f.store.completeReconciliationGeneration(f.binding.occurrenceId, f.binding.bridgeSessionId, 2000, "local_clock");
    f.store.beginReconciliationGeneration(f.binding.occurrenceId, "new", 3000); f.store.setReconciliationRuntimeSession(f.binding.occurrenceId, "new", 43n);
    const nextBinding = { ...f.binding, bridgeSessionId: "new", runtimeSessionId: 43n }, next = f.store.beginTimedEvidence(nextBinding, 3000);
    f.store.appendTimedFinal(next, { ...timedFinal(), sessionId: 43n }, 3000);
    assert.throws(() => f.store.resolveTimedFinal(old, "9", { kind: "provisional_ui_observed", feishuUserId: "person" }, 3000), /authority|closed/);
    await live.recoverPendingLiveEvidence({ store: f.store, binding: f.binding, nowMs: () => 3000, exclusivePriorOwnerClosed: async () => { throw new Error("closed owner needs no new proof"); } });
    assert.deepEqual(f.store.readTimedFinal(f.binding, "", 3000)?.result, { kind: "anonymous", reason: "owner_closed" });
    assert.equal(f.store.readTimedFinal(nextBinding, "", 3000)?.result, null);
  } finally { f.close(); }
});

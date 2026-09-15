import assert from "node:assert/strict";
import { chmodSync, copyFileSync, linkSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fork } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { finalizedWire, runtimeTestClient, testCapability } from "./lib/runtime-sdk.ts";
import type { RecordingInput } from "../src/ports/session-store.ts";
import { ALIGNMENT_POLICY, RecordingAlignmentOwner } from "../src/sessions/recording-alignment.ts";
import type { AlignmentRecoveryPermit } from "../src/ports/recording-alignment-authority.ts";
import { mintAlignmentRecoveryPermit } from "../src/ports/recording-alignment-authority.ts";
import type { RecordingAlignmentPage, RecordingAlignmentComplete } from "@conversation/runtime";

function recoveryFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-recovery-atomic-")), filename = path.join(dir, "state.db");
  const store = openSessionStore({ filename });
  const identity = buildMeetingIdentity({ providerMeetingId: "synthetic", meetingNo: "000000000", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Synthetic", organizer: null });
  const coordinator = createCoordinator({ store, clock: { now: () => 1000 }, bridgeLeaseTtlMs: 30000, maxConcurrentSessions: 1 });
  coordinator.discover(identity); coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening");
  store.beginReconciliationGeneration(identity.occurrenceId, "bridge-one", 1000);
  store.setReconciliationRuntimeSession(identity.occurrenceId, "bridge-one", 41n);
  const recording: RecordingInput = { handle: testCapability.recordingHandle, encryptedPath: "/synthetic/encrypted.crsr", sha256: testCapability.sha256,
    keyId: testCapability.keyId, format: "pcm_s16le/24000/1/20ms", durationMs: 10, gaps: [], runtimeGaps: [],
    recovery: { bridgeSessionId: "bridge-one", capability: { ...testCapability } } };
  return { dir, filename, store, identity, coordinator, recording, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function within<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("owned alignment test deadline")), 5000);
  })]); } finally { clearTimeout(timer); }
}

function alignmentFixture() {
  const f = recoveryFixture();
  f.coordinator.finalizeWithRecording(f.identity.occurrenceId, { kind: "advance", toState: "finalizing" }, f.recording, "bridge-one");
  const recovery = f.store.getRecordingRecovery(f.identity.occurrenceId, "bridge-one", testCapability.recordingHandle);
  assert.ok(recovery);
  const source = { sourceSessionId: 41n, recordingHandle: testCapability.recordingHandle, sha256: testCapability.sha256 };
  const page: RecordingAlignmentPage = { type: "recording_alignment_page", source, pageIndex: 0n, policy: ALIGNMENT_POLICY,
    entries: [{ kind: "epoch", epoch: { bridgeSessionId: "bridge-one", clockDomainId: "clock-one", captureEpoch: 1n } }] };
  const complete: RecordingAlignmentComplete = { type: "recording_alignment_complete", source, pageCount: 1n,
    coverageStatus: "available", warnings: [], traversalSucceeded: true };
  return { ...f, recovery, page, complete };
}

function wireSource() { return { source_session_id: "41", recording_handle: testCapability.recordingHandle, sha256: testCapability.sha256 }; }
function wirePage(requestId: string) { return { type: "recording_alignment_page", protocol_version: 4, request_id: requestId,
  page: { source: wireSource(), page_index: "0", policy: { id: "local-wall-estimate/v1", cadence_target_ns: "1000000000",
    maximum_bracket_ns: "5000000", maximum_pair_gap_ns: "2000000000", maximum_residual_ns: "10000000" },
  entries: [{ kind: "epoch", epoch: { bridge_session_id: "bridge-one", clock_domain_id: "clock-one", capture_epoch: "1" } }] } }; }
function wireComplete(requestId: string, pageCount = "1") { return { type: "recording_alignment_complete", protocol_version: 4, request_id: requestId,
  completion: { source: wireSource(), page_count: pageCount, coverage_status: "available", warnings: [], traversal_succeeded: true } }; }

test("actual SDK grants page credit only after SQLite commit and selects its validated traversal terminal", async () => {
  const f = alignmentFixture(), other = new Database(f.filename), { client, transport } = await runtimeTestClient(4);
  const owner = new RecordingAlignmentOwner({ store: f.store, runtime: client });
  let credits = 0;
  transport.onSend = (command) => {
    if (command.type === "read_recording_alignment") {
      assert.equal(command.capability.sourceSessionId, 41n); assert.equal(client.currentSessionId, 42n);
      transport.push({ type: "command_accepted", protocol_version: 4, request_id: command.requestId });
      transport.push(wirePage(command.requestId));
    }
    if (command.type === "recording_alignment_credit") {
      assert.deepEqual(other.prepare("SELECT page_count FROM recording_alignment_attempts").get(), { page_count: 1 });
      assert.equal(f.store.getSelectedAlignment(f.recovery.generationId), null);
      credits++; transport.push(wireComplete(command.requestId));
    }
  };
  try {
    const selected = await owner.stage(f.recovery);
    assert.equal(credits, 1); assert.equal(selected.pageCount, 1);
    assert.deepEqual(f.store.readSelectedAlignmentPage(selected, -1), f.page);
  } finally { await owner.close(); await client.close(); other.close(); f.close(); }
});

test("actual SDK cancellation retains durable ownership until real terminal cleanup and rejects reopen takeover", async () => {
  const f = alignmentFixture(), other = openSessionStore({ filename: f.filename }), { client, transport } = await runtimeTestClient(4);
  const owner = new RecordingAlignmentOwner({ store: f.store, runtime: client });
  let cancellationId = "", closeDone = false;
  transport.onSend = (command) => {
    if (command.type === "read_recording_alignment") transport.push({ type: "command_accepted", protocol_version: 4, request_id: command.requestId });
    if (command.type === "cancel_recording_alignment") cancellationId = command.requestId;
  };
  try {
    const work = owner.stage(f.recovery);
    const rejected = assert.rejects(work, /cancelled/);
    await nextTurn();
    const closing = owner.close().then(() => { closeDone = true; });
    await nextTurn(); assert.ok(cancellationId); assert.equal(closeDone, false);
    assert.throws(() => other.beginRecordingAlignment(f.recovery.generationId, "other-owner"), /owned|unreclaimed/);
    const pending = other.getPendingAlignment(f.recovery.generationId); assert.ok(pending);
    assert.throws(() => other.abandonRecordingAlignment(pending, {} as AlignmentRecoveryPermit), /authority/);
    assert.throws(() => other.reclaimRecordingAlignment(pending), /cleanup/);
    transport.push(wireComplete(cancellationId, "0"));
    await closing; await rejected;
    assert.equal(other.getPendingAlignment(f.recovery.generationId), null);
    assert.equal(other.getSelectedAlignment(f.recovery.generationId), null);
  } finally { await client.close(); other.close(); f.close(); }
});

test("shared alignment owner rejects concurrent readers and waits trusted exact-owner recovery proof", async () => {
  const f = alignmentFixture();
  let release!: () => void;
  const proof = new Promise<void>((resolve) => { release = resolve; });
  const owner = new RecordingAlignmentOwner({ store: f.store, runtime: { readRecordingAlignment() { throw new Error("not used"); } },
    proveExclusiveOwnership: async () => { await proof; } });
  try {
    const prior = f.store.beginRecordingAlignment(f.recovery.generationId, "prior-owned-process");
    assert.equal(prior.kind, "claimed"); if (prior.kind !== "claimed") return;
    f.store.appendRecordingAlignment(prior.attempt, f.page);
    const recovering = owner.recover(f.recovery.generationId);
    await assert.rejects(owner.stage(f.recovery), /busy/);
    assert.ok(f.store.getPendingAlignment(f.recovery.generationId));
    release(); await recovering;
    assert.equal(f.store.getPendingAlignment(f.recovery.generationId), null);
  } finally { release(); await owner.close(); f.close(); }
});

test("owner close waits a pending exclusive proof and cannot abandon after closure", async () => {
  const f = alignmentFixture();
  let release!: () => void, closed = false;
  const proof = new Promise<void>((resolve) => { release = resolve; });
  const owner = new RecordingAlignmentOwner({ store: f.store, runtime: { readRecordingAlignment() { throw new Error("unused"); } },
    proveExclusiveOwnership: async () => { await proof; } });
  try {
    f.store.beginRecordingAlignment(f.recovery.generationId, "prior-owner");
    const recovering = owner.recover(f.recovery.generationId), rejected = assert.rejects(recovering, /closed/);
    const closing = owner.close().then(() => { closed = true; });
    await nextTurn(); assert.equal(closed, false);
    release(); await closing; await rejected;
    assert.ok(f.store.getPendingAlignment(f.recovery.generationId));
  } finally { release(); await owner.close(); f.close(); }
});

test("each durable staging cap independently rejects the next page without publishing a prefix", () => {
  for (const [column, maximum] of [["page_count", 250000], ["entry_count", 2000000], ["stored_bytes", 268435456]] as const) {
    const f = alignmentFixture(), raw = new Database(f.filename);
    try {
      const result = f.store.beginRecordingAlignment(f.recovery.generationId, "owner-one");
      assert.equal(result.kind, "claimed"); if (result.kind !== "claimed") return;
      // A bounded counter fixture, not millions of allocated entries.
      raw.prepare(`UPDATE recording_alignment_attempts SET ${column}=? WHERE attempt_id=?`).run(maximum, result.attempt.attemptId);
      assert.throws(() => f.store.appendRecordingAlignment(result.attempt, { ...f.page,
        pageIndex: column === "page_count" ? BigInt(maximum) : 0n }), /limit/);
      assert.equal(f.store.getSelectedAlignment(f.recovery.generationId), null);
      assert.deepEqual(raw.prepare("SELECT count(*) AS n FROM recording_alignment_pages").get(), { n: 0 });
    } finally { raw.close(); f.close(); }
  }
});

test("selected reads reject corrupted persisted tags and cross-recording page bindings", () => {
  for (const corruption of ["tag", "binding", "oversize"] as const) {
    const f = alignmentFixture(), raw = new Database(f.filename);
    try {
      const result = f.store.beginRecordingAlignment(f.recovery.generationId, "owner-one");
      assert.equal(result.kind, "claimed"); if (result.kind !== "claimed") return;
      f.store.appendRecordingAlignment(result.attempt, f.page);
      const selected = f.store.completeRecordingAlignment(result.attempt, f.complete);
      const original = raw.prepare("SELECT payload FROM recording_alignment_pages").get() as { payload: string };
      if (corruption === "oversize") raw.pragma("ignore_check_constraints = ON");
      raw.prepare("UPDATE recording_alignment_pages SET payload=?").run(corruption === "tag"
        ? original.payload.replace('"u64"', '"unknown"') : corruption === "oversize" ? " ".repeat(32769)
          : original.payload.replace(testCapability.sha256, "e".repeat(64)));
      assert.throws(() => f.store.readSelectedAlignmentPage(selected, -1), /private alignment page|binding/);
    } finally { raw.close(); f.close(); }
  }
});

test("terminal header and selected pointer commit atomically; old selected readers never silently switch", () => {
  const f = alignmentFixture(), raw = new Database(f.filename);
  try {
    const first = f.store.beginRecordingAlignment(f.recovery.generationId, "first-owner");
    assert.equal(first.kind, "claimed"); if (first.kind !== "claimed") return;
    f.store.appendRecordingAlignment(first.attempt, f.page);
    const oldSelected = f.store.completeRecordingAlignment(first.attempt, f.complete);
    const second = f.store.beginRecordingAlignment(f.recovery.generationId, "second-owner", true);
    assert.equal(second.kind, "claimed"); if (second.kind !== "claimed") return;
    f.store.appendRecordingAlignment(second.attempt, f.page);
    raw.exec("CREATE TRIGGER fail_selection BEFORE UPDATE ON recording_alignment_selected BEGIN SELECT RAISE(ABORT,'synthetic terminal failure'); END");
    assert.throws(() => f.store.completeRecordingAlignment(second.attempt, f.complete), /synthetic terminal failure/);
    assert.deepEqual(f.store.getSelectedAlignment(f.recovery.generationId), oldSelected);
    assert.equal(f.store.getReclaimableAlignment(f.recovery.generationId), null);
    assert.deepEqual(raw.prepare("SELECT state FROM recording_alignment_attempts WHERE attempt_id=?").get(first.attempt.attemptId), { state: "complete" });
    assert.deepEqual(raw.prepare("SELECT state FROM recording_alignment_attempts WHERE attempt_id=?").get(second.attempt.attemptId), { state: "staging" });
    raw.exec("DROP TRIGGER fail_selection");
    raw.exec("CREATE TRIGGER fail_retirement BEFORE UPDATE ON recording_alignment_attempts WHEN NEW.state='abandoned' BEGIN SELECT RAISE(ABORT,'synthetic retirement failure'); END");
    assert.throws(() => f.store.completeRecordingAlignment(second.attempt, f.complete), /synthetic retirement failure/);
    assert.deepEqual(f.store.getSelectedAlignment(f.recovery.generationId), oldSelected);
    assert.equal(f.store.getReclaimableAlignment(f.recovery.generationId), null);
    raw.exec("DROP TRIGGER fail_retirement");
    const current = f.store.completeRecordingAlignment(second.attempt, f.complete);
    assert.notEqual(current.attemptId, oldSelected.attemptId);
    assert.throws(() => f.store.readSelectedAlignmentPage(oldSelected, -1), /generation changed/);
  } finally { raw.close(); f.close(); }
});

test("successful A to B to C refreshes do not require recovery of a nonexistent reader", async () => {
  const f = alignmentFixture(), { client, transport } = await runtimeTestClient(4);
  const owner = new RecordingAlignmentOwner({ store: f.store, runtime: client });
  transport.onSend = (command) => {
    if (command.type === "read_recording_alignment") {
      transport.push({ type: "command_accepted", protocol_version: 4, request_id: command.requestId });
      transport.push(wirePage(command.requestId));
    }
    if (command.type === "recording_alignment_credit") transport.push(wireComplete(command.requestId));
  };
  try {
    const a = await owner.stage(f.recovery), b = await owner.stage(f.recovery, true);
    assert.notEqual(a.attemptId, b.attemptId);
    const c = await owner.stage(f.recovery, true);
    assert.notEqual(b.attemptId, c.attemptId);
    assert.deepEqual(f.store.readSelectedAlignmentPage(c, -1), f.page);
    assert.equal(f.store.getPendingAlignment(f.recovery.generationId), null);
    assert.equal(f.store.getRecordingAlignmentFailure(f.recovery.generationId), null);
  } finally { await owner.close(); await client.close(); f.close(); }
});

test("superseded successful selection is not a pending owner after reopen", () => {
  const f = alignmentFixture(), other = openSessionStore({ filename: f.filename });
  try {
    for (const ownerId of ["a", "b"]) {
      const result = f.store.beginRecordingAlignment(f.recovery.generationId, ownerId, true);
      assert.equal(result.kind, "claimed"); if (result.kind !== "claimed") return;
      f.store.appendRecordingAlignment(result.attempt, f.page);
      f.store.completeRecordingAlignment(result.attempt, f.complete);
    }
    assert.equal(other.getPendingAlignment(f.recovery.generationId), null);
    assert.equal(other.getRecordingAlignmentFailure(f.recovery.generationId), null);
  } finally { other.close(); f.close(); }
});

test("retired payload reclaim is bounded and resumes after reopen without an exclusive-owner assertion", async () => {
  const f = alignmentFixture(), raw = new Database(f.filename);
  let reopened: ReturnType<typeof openSessionStore> | undefined;
  let owner: RecordingAlignmentOwner | undefined;
  try {
    const a = f.store.beginRecordingAlignment(f.recovery.generationId, "a");
    assert.equal(a.kind, "claimed"); if (a.kind !== "claimed") return;
    for (let i = 0; i < 68; i++) f.store.appendRecordingAlignment(a.attempt, { ...f.page, pageIndex: BigInt(i) });
    f.store.completeRecordingAlignment(a.attempt, { ...f.complete, pageCount: 68n });
    const b = f.store.beginRecordingAlignment(f.recovery.generationId, "b", true);
    assert.equal(b.kind, "claimed"); if (b.kind !== "claimed") return;
    f.store.appendRecordingAlignment(b.attempt, f.page);
    const selected = f.store.completeRecordingAlignment(b.attempt, f.complete);
    assert.deepEqual(f.store.getReclaimableAlignment(f.recovery.generationId), a.attempt);
    assert.throws(() => f.store.reclaimRecordingAlignment(b.attempt), /cleanup/);
    assert.throws(() => f.store.reclaimRecordingAlignment({ ...a.attempt, token: "0".repeat(36) }), /fence/);
    assert.equal(f.store.reclaimRecordingAlignment(a.attempt, 64), false);
    assert.deepEqual(raw.prepare("SELECT count(*) AS n FROM recording_alignment_pages WHERE attempt_id=?").get(a.attempt.attemptId), { n: 4 });
    assert.throws(() => f.store.beginRecordingAlignment(f.recovery.generationId, "c", true), /unreclaimed/);
    f.store.close(); // Actual handle close/reopen in the middle of reclaim.
    reopened = openSessionStore({ filename: f.filename });
    owner = new RecordingAlignmentOwner({ store: reopened, runtime: { readRecordingAlignment() { throw new Error("unused"); } } });
    assert.equal(reopened.getPendingAlignment(f.recovery.generationId), null);
    await owner.recover(f.recovery.generationId); // No proof callback is supplied or needed.
    assert.equal(reopened.getReclaimableAlignment(f.recovery.generationId), null);
    assert.equal(reopened.getRecordingAlignmentFailure(f.recovery.generationId), null);
    assert.deepEqual(reopened.readSelectedAlignmentPage(selected, -1), f.page);
    assert.deepEqual(raw.prepare("SELECT count(*) AS n FROM recording_alignment_pages").get(), { n: 1 });
  } finally { await owner?.close(); reopened?.close(); if (raw.open) raw.close(); f.close(); }
});

test("retired reclaim retains single-reader admission and close awaits every batch before refusing a new read", async () => {
  const f = alignmentFixture(), raw = new Database(f.filename), { client, transport } = await runtimeTestClient(4);
  const owner = new RecordingAlignmentOwner({ store: f.store, runtime: client });
  try {
    const a = f.store.beginRecordingAlignment(f.recovery.generationId, "a");
    assert.equal(a.kind, "claimed"); if (a.kind !== "claimed") return;
    for (let i = 0; i < 130; i++) f.store.appendRecordingAlignment(a.attempt, { ...f.page, pageIndex: BigInt(i) });
    f.store.completeRecordingAlignment(a.attempt, { ...f.complete, pageCount: 130n });
    const b = f.store.beginRecordingAlignment(f.recovery.generationId, "b", true);
    assert.equal(b.kind, "claimed"); if (b.kind !== "claimed") return;
    f.store.appendRecordingAlignment(b.attempt, f.page);
    const selected = f.store.completeRecordingAlignment(b.attempt, f.complete);
    const pending = owner.stage(f.recovery, true), rejected = assert.rejects(pending, /closed/);
    assert.deepEqual(raw.prepare("SELECT count(*) AS n FROM recording_alignment_pages WHERE attempt_id=?").get(a.attempt.attemptId), { n: 66 });
    const overlapping = assert.rejects(owner.stage(f.recovery, true), /busy/);
    let closed = false;
    const closing = owner.close().then(() => { closed = true; });
    assert.equal(closed, false);
    await nextTurn(); assert.equal(closed, false); // Third <=64-page batch still pending.
    await closing; await rejected; await overlapping;
    assert.equal(f.store.getReclaimableAlignment(f.recovery.generationId), null);
    assert.equal(f.store.getRecordingAlignmentFailure(f.recovery.generationId), null);
    assert.deepEqual(f.store.readSelectedAlignmentPage(selected, -1), f.page);
    assert.equal(transport.commands.some((command) => command.type === "read_recording_alignment"), false);
  } finally { await owner.close(); await client.close(); raw.close(); f.close(); }
});

test("failed retired-payload deletion preserves selection and permits a later cleanup retry without a fake owner failure", async () => {
  const f = alignmentFixture(), raw = new Database(f.filename), { client, transport } = await runtimeTestClient(4);
  const owner = new RecordingAlignmentOwner({ store: f.store, runtime: client });
  try {
    for (const ownerId of ["a", "b"]) {
      const attempt = f.store.beginRecordingAlignment(f.recovery.generationId, ownerId, true);
      assert.equal(attempt.kind, "claimed"); if (attempt.kind !== "claimed") return;
      f.store.appendRecordingAlignment(attempt.attempt, f.page);
      f.store.completeRecordingAlignment(attempt.attempt, f.complete);
    }
    const selected = f.store.getSelectedAlignment(f.recovery.generationId); assert.ok(selected);
    raw.exec("CREATE TRIGGER fail_reclaim BEFORE DELETE ON recording_alignment_pages BEGIN SELECT RAISE(ABORT,'synthetic reclaim failure'); END");
    await assert.rejects(owner.stage(f.recovery, true), /released payload cleanup incomplete/);
    assert.equal(f.store.getPendingAlignment(f.recovery.generationId), null);
    assert.ok(f.store.getReclaimableAlignment(f.recovery.generationId));
    assert.equal(f.store.getRecordingAlignmentFailure(f.recovery.generationId), null);
    assert.deepEqual(f.store.readSelectedAlignmentPage(selected, -1), f.page);
    assert.equal(transport.commands.some((command) => command.type === "read_recording_alignment"), false);
    raw.exec("DROP TRIGGER fail_reclaim");
    assert.deepEqual(await owner.stage(f.recovery), selected); // Resumes payload-only cleanup, then safely reuses B.
    assert.equal(f.store.getReclaimableAlignment(f.recovery.generationId), null);
  } finally { await owner.close(); await client.close(); raw.close(); f.close(); }
});

test("legacy terminal is unavailable without a policy anchor and partial warnings cannot become available", () => {
  for (const legacy of [true, false]) {
    const f = alignmentFixture();
    try {
      const result = f.store.beginRecordingAlignment(f.recovery.generationId, "owner-one");
      assert.equal(result.kind, "claimed"); if (result.kind !== "claimed") return;
      if (!legacy) {
        f.store.appendRecordingAlignment(result.attempt, { ...f.page, entries: [{ kind: "discontinuity", captureEpoch: 1n, reason: "missing_timing" }] });
        assert.throws(() => f.store.completeRecordingAlignment(result.attempt, f.complete), /warnings/);
        assert.throws(() => f.store.completeRecordingAlignment(result.attempt, { ...f.complete, warnings: ["missing_timing", "capture_alignment_missing"] }), /warnings/);
      }
      const selected = f.store.completeRecordingAlignment(result.attempt, { ...f.complete, pageCount: legacy ? 0n : 1n,
        coverageStatus: legacy ? "unavailable_legacy" : "partial", warnings: legacy ? ["unavailable_legacy"] : ["missing_timing", "capture_alignment_missing"] });
      assert.equal(selected.policyId, legacy ? null : "local-wall-estimate/v1");
      assert.equal(selected.coverageStatus, legacy ? "unavailable_legacy" : "partial");
    } finally { f.close(); }
  }
});

test("failed replacement preserves selected evidence and actual SDK cancellation cleans tentative pages", async () => {
  const f = alignmentFixture(), raw = new Database(f.filename), { client, transport } = await runtimeTestClient(4);
  const owner = new RecordingAlignmentOwner({ store: f.store, runtime: client });
  try {
    const prior = f.store.beginRecordingAlignment(f.recovery.generationId, "prior-owner");
    assert.equal(prior.kind, "claimed"); if (prior.kind !== "claimed") return;
    f.store.appendRecordingAlignment(prior.attempt, f.page);
    const selected = f.store.completeRecordingAlignment(prior.attempt, f.complete);
    raw.exec("CREATE TRIGGER fail_page BEFORE INSERT ON recording_alignment_pages BEGIN SELECT RAISE(ABORT,'synthetic page failure'); END");
    transport.onSend = (command) => {
      if (command.type === "read_recording_alignment") {
        transport.push({ type: "command_accepted", protocol_version: 4, request_id: command.requestId }); transport.push(wirePage(command.requestId));
      }
      if (command.type === "cancel_recording_alignment") transport.push({ type: "command_rejected", protocol_version: 4, request_id: command.requestId,
        error: { code: "invalid_state", kind: "invalid_state", stage: "audio_capture", message: "alignment cancelled" } });
    };
    await assert.rejects(owner.stage(f.recovery, true), /tentative evidence discarded/);
    assert.equal(f.store.getRecordingAlignmentFailure(f.recovery.generationId), "read_failed");
    assert.deepEqual(f.store.getSelectedAlignment(f.recovery.generationId), selected);
    assert.equal(f.store.getPendingAlignment(f.recovery.generationId), null);
    assert.equal(transport.commands.some((c) => c.type === "recording_alignment_credit"), false);
  } finally { await owner.close(); await client.close(); raw.close(); f.close(); }
});

test("actual SDK EOF leaves cleanup failure fenced rather than blessing reopen takeover", async () => {
  const f = alignmentFixture(), { client, transport } = await runtimeTestClient(4);
  const owner = new RecordingAlignmentOwner({ store: f.store, runtime: client });
  try {
    const work = owner.stage(f.recovery), rejected = assert.rejects(work, /cleanup failed/);
    await nextTurn(); await transport.close(); await rejected;
    assert.ok(f.store.getPendingAlignment(f.recovery.generationId));
    assert.throws(() => f.store.beginRecordingAlignment(f.recovery.generationId, "another-owner"), /owned|unreclaimed/);
    await assert.rejects(owner.close());
  } finally { await client.close(); f.close(); }
});

test("actual child crash requires reap for pending readers but a completed selection only leaves retired payload", { timeout: 15000 }, async () => {
  for (const phase of ["before-page", "after-page", "after-terminal"] as const) {
    const f = alignmentFixture();
    const first = f.store.beginRecordingAlignment(f.recovery.generationId, "first-owner");
    assert.equal(first.kind, "claimed"); if (first.kind !== "claimed") return;
    f.store.appendRecordingAlignment(first.attempt, f.page);
    const oldSelected = f.store.completeRecordingAlignment(first.attempt, f.complete);
    const child = fork(path.resolve(import.meta.dirname, "fixtures/alignment-owner-crash.ts"), [f.filename, f.recovery.generationId, phase],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const exited = once(child, "close"); let reaped = false;
    const owner = new RecordingAlignmentOwner({ store: f.store, runtime: { readRecordingAlignment() { throw new Error("unused"); } },
      proveExclusiveOwnership: async () => { if (!reaped || (child.exitCode === null && child.signalCode === null)) throw new Error("owned child is still active"); } });
    try {
      await within(Promise.race([once(child, "message"), exited.then(() => { throw new Error("owned child exited before checkpoint"); })]));
      if (phase !== "after-terminal") {
        await assert.rejects(owner.recover(f.recovery.generationId), /still active/);
        assert.deepEqual(f.store.getSelectedAlignment(f.recovery.generationId), oldSelected);
        assert.throws(() => f.store.beginRecordingAlignment(f.recovery.generationId, "overlapping-owner", true), /owned|unreclaimed/);
      } else {
        assert.equal(f.store.getPendingAlignment(f.recovery.generationId), null);
        await owner.recover(f.recovery.generationId); // Does not assert the still-alive process has died.
        assert.equal(f.store.getRecordingAlignmentFailure(f.recovery.generationId), null);
      }
      child.kill("SIGTERM"); await within(exited); reaped = true;
      const reopened = openSessionStore({ filename: f.filename });
      try {
        if (phase !== "after-terminal") assert.ok(reopened.getPendingAlignment(f.recovery.generationId));
        else assert.equal(reopened.getPendingAlignment(f.recovery.generationId), null);
        await owner.recover(f.recovery.generationId);
        assert.equal(reopened.getPendingAlignment(f.recovery.generationId), null);
        const selected = reopened.getSelectedAlignment(f.recovery.generationId); assert.ok(selected);
        if (phase === "after-terminal") assert.notEqual(selected.attemptId, oldSelected.attemptId);
        else assert.deepEqual(selected, oldSelected);
        assert.deepEqual(reopened.readSelectedAlignmentPage(selected, -1), f.page);
      } finally { reopened.close(); }
    } finally {
      if (!reaped) { child.kill("SIGKILL"); await within(exited); }
      await owner.close(); f.close();
    }
  }
});

test("opaque recovery permits bind exact database/generation/token and reclaim deletes at most64 pages", () => {
  const f = alignmentFixture(), other = alignmentFixture();
  try {
    const result = f.store.beginRecordingAlignment(f.recovery.generationId, "owner-one");
    assert.equal(result.kind, "claimed"); if (result.kind !== "claimed") return;
    const foreign = other.store.beginRecordingAlignment(other.recovery.generationId, "owner-one");
    assert.equal(foreign.kind, "claimed"); if (foreign.kind !== "claimed") return;
    for (let index = 0; index < 68; index++) f.store.appendRecordingAlignment(result.attempt, { ...f.page, pageIndex: BigInt(index) });
    // Internal test-only mint after this synchronous synthetic owner has no
    // iterator/native work. Ordinary callers cannot forge a WeakMap permit.
    const permit = mintAlignmentRecoveryPermit(result.attempt);
    assert.throws(() => other.store.abandonRecordingAlignment(foreign.attempt, permit), /authority/);
    assert.throws(() => f.store.abandonRecordingAlignment({ ...result.attempt, token: "0".repeat(36) }, permit), /fence/);
    f.store.abandonRecordingAlignment(result.attempt, permit);
    assert.throws(() => f.store.abandonRecordingAlignment(result.attempt, permit), /authority/);
    assert.equal(f.store.reclaimRecordingAlignment(result.attempt, 64), false);
    const raw = new Database(f.filename);
    try { assert.deepEqual(raw.prepare("SELECT count(*) AS n FROM recording_alignment_pages").get(), { n: 4 }); }
    finally { raw.close(); }
    assert.throws(() => f.store.beginRecordingAlignment(f.recovery.generationId, "next-owner"), /unreclaimed/);
    assert.equal(f.store.reclaimRecordingAlignment(result.attempt, 64), true);
    assert.equal(f.store.beginRecordingAlignment(f.recovery.generationId, "next-owner").kind, "claimed");
  } finally { other.close(); f.close(); }
});

test("failed old-generation authority cannot overwrite a newer finalized recording", () => {
  const f = recoveryFixture();
  try {
    f.store.recordBridgeFailure({ occurrenceId: f.identity.occurrenceId, nowMs: 1000, maxRetries: 1, gaps: [], recording: f.recording });
    f.store.beginReconciliationGeneration(f.identity.occurrenceId, "bridge-two", 1100);
    f.store.setReconciliationRuntimeSession(f.identity.occurrenceId, "bridge-two", 42n);
    const newer = { ...testCapability, sourceSessionId: 42n, recordingHandle: "e".repeat(32), sha256: "f".repeat(64), authorization: "a".repeat(64) };
    f.coordinator.finalizeWithRecording(f.identity.occurrenceId, { kind: "advance", toState: "finalizing" }, {
      ...f.recording, handle: newer.recordingHandle, sha256: newer.sha256, recovery: { bridgeSessionId: "bridge-two", capability: newer },
    }, "bridge-two");
    assert.throws(() => f.store.recordBridgeFailure({ occurrenceId: f.identity.occurrenceId, nowMs: 1200, maxRetries: 2, gaps: [], recording: f.recording }));
    assert.equal(f.store.getRecording(f.identity.occurrenceId)?.handle, newer.recordingHandle);
    assert.deepEqual(f.store.getRecordingRecovery(f.identity.occurrenceId, "bridge-two", newer.recordingHandle)?.capability, newer);
    assert.deepEqual(f.store.getRecordingRecovery(f.identity.occurrenceId, "bridge-one", testCapability.recordingHandle)?.capability, testCapability);
  } finally { f.close(); }
});

test("alignment pages remain invisible until exact terminal selection and keyset reads survive reopen", () => {
  const f = alignmentFixture(), other = openSessionStore({ filename: f.filename });
  try {
    const result = f.store.beginRecordingAlignment(f.recovery.generationId, "owner-one");
    assert.equal(result.kind, "claimed"); if (result.kind !== "claimed") return;
    assert.throws(() => other.beginRecordingAlignment(f.recovery.generationId, "owner-two"), /owned|unreclaimed/);
    f.store.appendRecordingAlignment(result.attempt, f.page);
    assert.equal(other.getSelectedAlignment(f.recovery.generationId), null);
    assert.throws(() => other.completeRecordingAlignment({ ...result.attempt, token: "0".repeat(36) }, f.complete), /fence/);
    assert.throws(() => other.completeRecordingAlignment(result.attempt, { ...f.complete, pageCount: 2n }), /completion/);
    assert.equal(other.getSelectedAlignment(f.recovery.generationId), null);
    const selected = f.store.completeRecordingAlignment(result.attempt, f.complete);
    assert.deepEqual(other.getSelectedAlignment(f.recovery.generationId), selected);
    assert.deepEqual(other.readSelectedAlignmentPage(selected, -1), f.page);
    assert.equal(other.readSelectedAlignmentPage(selected, 0), null);
    assert.throws(() => f.store.completeRecordingAlignment(result.attempt, f.complete), /fence/);
    assert.deepEqual(other.beginRecordingAlignment(f.recovery.generationId, "owner-two"), { kind: "selected", selected });
  } finally { other.close(); f.close(); }
});

test("alignment page source, full policy and contiguous index are checked before durable counters advance", () => {
  const f = alignmentFixture();
  try {
    const result = f.store.beginRecordingAlignment(f.recovery.generationId, "owner-one");
    assert.equal(result.kind, "claimed"); if (result.kind !== "claimed") return;
    for (const page of [{ ...f.page, source: { ...f.page.source, sourceSessionId: 42n } }, { ...f.page, pageIndex: 1n },
      ...(["cadenceTargetNs", "maximumBracketNs", "maximumPairGapNs", "maximumResidualNs"] as const)
        .map((key) => ({ ...f.page, policy: { ...f.page.policy, [key]: f.page.policy[key] + 1n } }))]) {
      assert.throws(() => f.store.appendRecordingAlignment(result.attempt, page));
    }
    f.store.appendRecordingAlignment(result.attempt, f.page);
    assert.equal(f.store.completeRecordingAlignment(result.attempt, f.complete).pageCount, 1);
  } finally { f.close(); }
});

test("capability mismatches and insert failure roll back normal, retry and exhausted recording transactions", () => {
  for (const mode of ["normal", "retry", "exhausted"] as const) for (const defect of ["source", "handle", "hash", "key", "bridge", "insert"] as const) {
    const f = recoveryFixture();
    const independent = new Database(f.filename);
    try {
      const capability = { ...testCapability,
        ...(defect === "source" ? { sourceSessionId: 42n } : {}),
        ...(defect === "handle" ? { recordingHandle: "e".repeat(32) } : {}),
        ...(defect === "hash" ? { sha256: "e".repeat(64) } : {}),
        ...(defect === "key" ? { keyId: "e".repeat(16) } : {}) };
      const recording = { ...f.recording, recovery: { bridgeSessionId: defect === "bridge" ? "other-bridge" : "bridge-one", capability } };
      if (defect === "insert") independent.exec("CREATE TRIGGER fail_capability BEFORE INSERT ON recording_recovery_bindings BEGIN SELECT RAISE(ABORT,'synthetic insert failure'); END");
      const before = f.store.listTransitions(f.identity.occurrenceId);
      assert.throws(() => mode === "normal"
        ? f.coordinator.finalizeWithRecording(f.identity.occurrenceId, { kind: "advance", toState: "finalizing" }, recording, "bridge-one")
        : f.store.recordBridgeFailure({ occurrenceId: f.identity.occurrenceId, nowMs: 1000, maxRetries: mode === "retry" ? 1 : 0, gaps: [], recording }));
      assert.deepEqual(f.store.listTransitions(f.identity.occurrenceId), before);
      assert.equal(f.store.getSession(f.identity.occurrenceId)?.state, "listening");
      assert.equal(f.store.getRecording(f.identity.occurrenceId), null);
      assert.equal(f.store.getBridgeFailureRecording(f.identity.occurrenceId, 1), null);
      assert.equal(f.store.getRecordingRecovery(f.identity.occurrenceId, "bridge-one", testCapability.recordingHandle), null);
      assert.deepEqual(independent.prepare("SELECT recording_handle FROM reconciliation_generations").get(), { recording_handle: null });
    } finally { independent.close(); f.close(); }
  }
});

test("private recovery survives SQLite reopen without entering ordinary recording or legacy alignment evidence", () => {
  const f = recoveryFixture();
  try {
    f.coordinator.finalizeWithRecording(f.identity.occurrenceId, { kind: "advance", toState: "finalizing" }, f.recording, "bridge-one");
    const reopened = openSessionStore({ filename: f.filename });
    try {
      assert.deepEqual(reopened.getRecordingRecovery(f.identity.occurrenceId, "bridge-one", testCapability.recordingHandle)?.capability, testCapability);
      assert.equal(reopened.getRecordingRecovery(f.identity.occurrenceId, "other-bridge", testCapability.recordingHandle), null);
      const evidence = reopened.getReconciliationEvidence(f.identity.occurrenceId, testCapability.recordingHandle);
      assert.ok(evidence); assert.equal(evidence.alignment, null);
      assert.equal(JSON.stringify(evidence, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value).includes(testCapability.authorization), false);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test("private recovery APIs reject shared parents, aliases, replacement and memory-only storage", () => {
  const identity = buildMeetingIdentity({ providerMeetingId: "synthetic", meetingNo: "000000000", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Synthetic", organizer: null });
  for (const mode of ["shared", "symlink", "parent-symlink", "hardlink", "replacement", "memory"] as const) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-private-recovery-"));
    const filename = path.join(dir, "state.db"), alias = path.join(dir, "alias.db");
    const parentAlias = `${dir}-alias`;
    let store = openSessionStore({ filename: mode === "memory" ? ":memory:" : filename });
    try {
      if (mode === "shared") chmodSync(dir, 0o755);
      if (mode === "symlink") { store.close(); symlinkSync(filename, alias); store = openSessionStore({ filename: alias }); }
      if (mode === "parent-symlink") { store.close(); symlinkSync(dir, parentAlias); store = openSessionStore({ filename: path.join(parentAlias, "state.db") }); }
      if (mode === "hardlink") linkSync(filename, alias);
      if (mode === "replacement") { renameSync(filename, alias); copyFileSync(alias, filename); }
      assert.throws(() => store.getRecordingRecovery(identity.occurrenceId, "bridge-one", testCapability.recordingHandle), /private persistent recording state/);
      // This new precondition does not disable ordinary legacy reads.
      assert.equal(store.getRecording(identity.occurrenceId), null);
    } finally { store.close(); if (mode === "parent-symlink") unlinkSync(parentAlias); rmSync(dir, { recursive: true, force: true }); }
  }
});

test("real SQLite commits exact SDK capability privately with normal and failed-generation recordings", async () => {
  const { client, transport } = await runtimeTestClient(4);
  const pending = client.finalizeRecording({ sessionId: 41n });
  const request = transport.commands[0]; assert.ok(request);
  transport.push({ type: "command_accepted", protocol_version: 4, request_id: request.requestId });
  transport.push({ ...finalizedWire, request_id: request.requestId });
  const finalized = await pending; await client.close();
  for (const mode of ["normal", "retry", "exhausted"] as const) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-recovery-")), filename = path.join(dir, "state.db");
    const store = openSessionStore({ filename }), other = openSessionStore({ filename });
    try {
      const identity = buildMeetingIdentity({ providerMeetingId: "synthetic", meetingNo: "000000000", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Synthetic", organizer: null });
      const coordinator = createCoordinator({ store, clock: { now: () => 1000 }, bridgeLeaseTtlMs: 30000, maxConcurrentSessions: 1 });
      coordinator.discover(identity); coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening");
      store.beginReconciliationGeneration(identity.occurrenceId, "bridge-one", 1000);
      store.setReconciliationRuntimeSession(identity.occurrenceId, "bridge-one", 41n);
      const recording = { handle: finalized.recordingHandle, encryptedPath: finalized.encryptedPath, sha256: finalized.sha256,
        keyId: finalized.keyId, format: finalized.format, durationMs: Number(finalized.durationMs), gaps: [], runtimeGaps: [],
        recovery: { bridgeSessionId: "bridge-one", capability: finalized.recoveryCapability } };
      if (mode === "normal") coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, recording, "bridge-one");
      else store.recordBridgeFailure({ occurrenceId: identity.occurrenceId, nowMs: 1000, maxRetries: mode === "retry" ? 1 : 0, gaps: [], recording });
      const raw = new Database(filename);
      try {
        const stored = raw.prepare("SELECT source_session_id,authorization,recording_kind,failure_attempt FROM recording_recovery_bindings").get();
        assert.deepEqual(stored, { source_session_id: "41", authorization: testCapability.authorization,
          recording_kind: mode === "normal" ? "final" : "bridge_failure", failure_attempt: mode === "normal" ? null : 1 });
      } finally { raw.close(); }
      const row = mode === "normal" ? other.getRecording(identity.occurrenceId) : other.getBridgeFailureRecording(identity.occurrenceId, 1);
      assert.ok(row); assert.equal(Object.hasOwn(row, "authorization"), false); assert.equal(Object.hasOwn(row, "recoveryCapability"), false);
      assert.equal(other.getSession(identity.occurrenceId)?.state, mode === "normal" ? "finalizing" : mode === "retry" ? "listening" : "failed");
    } finally { other.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

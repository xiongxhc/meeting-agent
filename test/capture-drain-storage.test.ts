import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { CaptureDrain } from "../src/contracts/bridge-session-v1.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { OrchestrationError, type RecordingInput } from "../src/ports/session-store.ts";

const CONFIRMED: CaptureDrain = {
  drain: "confirmed", reason: null,
  boundary: { captureEpoch: "3", lastFrameSequence: "70", outputEndSample: "33600", finalClockPairSequence: "18446744073709551615" },
};
const ZERO_FRAME: CaptureDrain = {
  drain: "confirmed", reason: null,
  boundary: { captureEpoch: "1", lastFrameSequence: "0", outputEndSample: "0", finalClockPairSequence: "2" },
};
const UNCONFIRMED: CaptureDrain = { drain: "unconfirmed", reason: "drain_not_attempted", boundary: null };

const RECORDING: RecordingInput = {
  handle: "a".repeat(32), encryptedPath: "/tmp/recording.enc", sha256: "b".repeat(64),
  durationMs: 1400, format: "pcm_s16le/24000/1/20ms", keyId: "c".repeat(16), gaps: [], runtimeGaps: [],
};

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "meeting-capture-drain-"));
  const filename = path.join(root, "state.db");
  const store = openSessionStore({ filename });
  const coordinator = createCoordinator({ store, clock: { now: () => 1000 }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 4 });
  let nth = 0;
  const finalize = (drain: CaptureDrain | undefined) => {
    nth += 1;
    const identity = buildMeetingIdentity({ providerMeetingId: `drain-${nth}`, meetingNo: "000000000",
      occurrenceStartedAt: "2026-09-22T14:00:00Z", title: "Synthetic", organizer: null });
    coordinator.discover(identity);
    coordinator.advance(identity.occurrenceId, "joining");
    coordinator.advance(identity.occurrenceId, "listening");
    store.beginReconciliationGeneration(identity.occurrenceId, `bridge-${nth}`, 1000);
    coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" },
      { ...RECORDING, handle: String(nth).padStart(32, "a"), ...(drain === undefined ? {} : { captureDrain: drain }) },
      `bridge-${nth}`);
    return identity.occurrenceId;
  };
  return { root, filename, store, finalize, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("migration 029 is the schema head and the recordings columns carry D029's outcome", () => {
  const f = fixture();
  try {
    assert.equal(f.store.schemaVersion, 29);
    assert.equal(f.store.appliedMigrations().at(-1)?.name, "029_alignment_page_private_bound.sql");

    const confirmed = f.finalize(CONFIRMED);
    const zeroFrame = f.finalize(ZERO_FRAME);
    const unconfirmed = f.finalize(UNCONFIRMED);
    const silent = f.finalize(undefined);

    assert.deepEqual(f.store.getRecording(confirmed)?.captureDrain, CONFIRMED);
    assert.deepEqual(f.store.getRecording(zeroFrame)?.captureDrain, ZERO_FRAME);
    assert.deepEqual(f.store.getRecording(unconfirmed)?.captureDrain, UNCONFIRMED);
    assert.equal(f.store.getRecording(silent)?.captureDrain, null);

    // D029 §2: the derived integrity surface. A session that never saw the
    // field is `unavailable`, never invented from any local fact.
    assert.equal(f.store.getRecording(confirmed)?.captureIntegrity, "confirmed");
    assert.equal(f.store.getRecording(zeroFrame)?.captureIntegrity, "confirmed");
    assert.equal(f.store.getRecording(unconfirmed)?.captureIntegrity, "unconfirmed");
    assert.equal(f.store.getRecording(silent)?.captureIntegrity, "unavailable");
  } finally { f.close(); }
});

test("the drain is written in the same transaction as the recording row", () => {
  const f = fixture();
  try {
    const occurrenceId = f.finalize(CONFIRMED);
    const db = new Database(f.filename, { readonly: true });
    try {
      const row = db.prepare(`SELECT capture_drain, capture_drain_reason, capture_drain_epoch,
        capture_drain_last_frame_sequence, capture_drain_output_end_sample, capture_drain_final_pair_sequence
        FROM recordings WHERE occurrence_id = ?`).get(occurrenceId);
      assert.deepEqual(row, {
        capture_drain: "confirmed", capture_drain_reason: null, capture_drain_epoch: "3",
        capture_drain_last_frame_sequence: "70", capture_drain_output_end_sample: "33600",
        capture_drain_final_pair_sequence: "18446744073709551615",
      });
    } finally { db.close(); }
  } finally { f.close(); }
});

test("a pre-028 recording stays unavailable rather than being reinterpreted", () => {
  const f = fixture();
  try {
    const occurrenceId = f.finalize(undefined);
    f.store.close();
    // Exactly the shape an upgraded database presents: a row written before
    // the columns existed, so every one of them is NULL.
    const db = new Database(f.filename);
    try {
      db.prepare("UPDATE recordings SET capture_drain = NULL WHERE occurrence_id = ?").run(occurrenceId);
    } finally { db.close(); }
    const reopened = openSessionStore({ filename: f.filename });
    try {
      assert.equal(reopened.schemaVersion, 29);
      assert.equal(reopened.getRecording(occurrenceId)?.captureDrain, null);
      assert.equal(reopened.getRecording(occurrenceId)?.captureIntegrity, "unavailable");
    } finally { reopened.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("the store refuses a drain whose members contradict its own outcome", () => {
  const f = fixture();
  try {
    for (const drain of [
      { drain: "confirmed", reason: null, boundary: null },
      { drain: "unconfirmed", reason: "why", boundary: CONFIRMED.boundary },
      { drain: "unconfirmed", reason: null, boundary: null },
      { drain: "confirmed", reason: "why", boundary: CONFIRMED.boundary },
      { drain: "confirmed", reason: null, boundary: { ...CONFIRMED.boundary, captureEpoch: "0" } },
      { drain: "confirmed", reason: null, boundary: { ...CONFIRMED.boundary, lastFrameSequence: "0" } },
      { drain: "drained", reason: null, boundary: CONFIRMED.boundary },
    ] as unknown as CaptureDrain[]) {
      assert.throws(() => f.finalize(drain),
        (error: unknown) => error instanceof OrchestrationError && error.code === "constraint_violation"
          && error.message.startsWith("capture drain violates D029"),
        JSON.stringify(drain));
    }
  } finally { f.close(); }
});

test("a store opened against a pre-028 migration set still finalizes, and refuses to drop a claim", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meeting-capture-drain-legacy-"));
  const legacy = path.join(root, "migrations-027");
  mkdirSync(legacy);
  cpSync(path.resolve("migrations"), legacy, { recursive: true, filter: (source) => !/^02[89]_/.test(path.basename(source)) });
  const store = openSessionStore({ filename: path.join(root, "state.db"), migrationsDir: legacy });
  try {
    assert.equal(store.schemaVersion, 27);
    const coordinator = createCoordinator({ store, clock: { now: () => 1000 }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 2 });
    const finalize = (nth: number, drain: CaptureDrain | undefined) => {
      const identity = buildMeetingIdentity({ providerMeetingId: `legacy-${nth}`, meetingNo: "000000000",
        occurrenceStartedAt: "2026-09-22T14:00:00Z", title: "Legacy", organizer: null });
      coordinator.discover(identity);
      coordinator.advance(identity.occurrenceId, "joining");
      coordinator.advance(identity.occurrenceId, "listening");
      store.beginReconciliationGeneration(identity.occurrenceId, `bridge-${nth}`, 1000);
      coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" },
        { ...RECORDING, handle: String(nth).padStart(32, "a"), ...(drain === undefined ? {} : { captureDrain: drain }) },
        `bridge-${nth}`);
      return identity.occurrenceId;
    };
    // Without a claim the legacy write is unchanged and reads back unavailable.
    const plain = finalize(1, undefined);
    assert.equal(store.getRecording(plain)?.captureDrain, null);
    assert.equal(store.getRecording(plain)?.captureIntegrity, "unavailable");
    // With one, the write is refused rather than silently losing the evidence.
    assert.throws(() => finalize(2, CONFIRMED),
      (error: unknown) => error instanceof OrchestrationError && error.message === "capture drain requires migration 028");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

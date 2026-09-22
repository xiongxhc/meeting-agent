import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import { deleteSeedRecordingEvidence } from "../src/adapters/filesystem-outbox.ts";
import { openSessionStore, type OpenSessionStoreOptions } from "../src/adapters/sqlite-session-store.ts";
import { canonicalArtifactHash, canonicalArtifactJson } from "../src/contracts/teammem-meeting-v1.ts";
import { parseSupportedTeamMemMeetingArtifact, type SupportedTeamMemMeetingArtifact } from "../src/contracts/teammem-meeting-v2.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { occurrencePathSegment } from "../src/domain/occurrence-id.ts";
import { createOutboxWorker } from "../src/delivery/outbox-worker.ts";
import type { BackfillDeliveryAuthority, BackfillSeed, DeliveryRow } from "../src/ports/session-store.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { testCapability } from "./lib/runtime-sdk.ts";

const ENDED_AT = "2026-09-02T14:10:00.123Z";
const ENDED_AT_MS = Date.parse(ENDED_AT);

function harness(options: Pick<OpenSessionStoreOptions, "deliveryIdentityCheckpoint"> & {
  readonly processingWarning?: { readonly code: string; readonly detail: string };
} = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-backfill-journal-"));
  const filename = path.join(dir, "state.db");
  const recordingsDir = path.join(dir, "recordings");
  mkdirSync(recordingsDir);
  const recordingPath = path.join(recordingsDir, `${testCapability.recordingHandle}.crsr`);
  const recordingBytes = Buffer.from("synthetic-ciphertext");
  writeFileSync(recordingPath, recordingBytes);
  const capability = { ...testCapability, sha256: createHash("sha256").update(recordingBytes).digest("hex") };
  const { processingWarning = { code: "capture_gap", detail: "One bounded synthetic gap." }, ...storeOptions } = options;
  const store = openSessionStore({ filename, nowMs: ENDED_AT_MS, ...storeOptions });
  const identity = buildMeetingIdentity({
    providerMeetingId: "meeting-journal",
    meetingNo: "424242",
    occurrenceStartedAt: "2026-09-02T14:00:00Z",
    title: "Journal handoff",
    organizer: { feishuUserId: "ou_owner", displayName: "Owner", source: "reservation" },
  });
  const coordinator = createCoordinator({ store, clock: { now: () => ENDED_AT_MS }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 1 });
  coordinator.discover(identity);
  coordinator.advance(identity.occurrenceId, "joining");
  coordinator.advance(identity.occurrenceId, "listening");
  store.beginReconciliationGeneration(identity.occurrenceId, "bridge-journal", ENDED_AT_MS - 1_000);
  store.setReconciliationRuntimeSession(identity.occurrenceId, "bridge-journal", capability.sourceSessionId);
  coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, {
    recovery: { bridgeSessionId: "bridge-journal", capability },
    handle: capability.recordingHandle,
    encryptedPath: recordingPath,
    sha256: capability.sha256,
    durationMs: 600_123,
    format: "pcm_s16le/24000/1/20ms",
    keyId: capability.keyId,
    gaps: [{ direction: "capture", startedAt: "2026-09-02T14:04:00Z", endedAt: "2026-09-02T14:04:01Z" }],
    runtimeGaps: [{ startedAtMs: 240n, endedAtMs: 480n, reason: "runtime_gap" }],
  }, "bridge-journal", ENDED_AT_MS, "bridge_observed", {
    terminalReason: "ended",
    terminalSource: "bridge_observed",
    endedAt: ENDED_AT,
    identity,
    provider: "feishu",
    encryption: "aes-256-gcm",
    processingWarnings: [processingWarning],
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
  });
  const seed = store.getBackfillSeed(identity.occurrenceId)!;
  return { dir, filename, recordingPath, store, coordinator, identity, seed,
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function artifact(seed: BackfillSeed, revision: number, transcriptComplete: boolean): SupportedTeamMemMeetingArtifact {
  return parseSupportedTeamMemMeetingArtifact({
    schema: "teammem-meeting/v1",
    occurrence_id: seed.occurrenceId,
    revision,
    provider: seed.provider,
    provider_meeting_id: seed.providerMeetingId,
    title: seed.title,
    started_at: seed.occurrenceStartedAt,
    ended_at: seed.endedAt,
    organizer: seed.organizer === null ? null : { person_id: seed.organizer.feishuUserId, display_name: seed.organizer.displayName },
    organizer_source: seed.organizer?.source ?? null,
    organizer_unresolved_reason: seed.organizer === null ? "instant_meeting" : null,
    transcript_complete: transcriptComplete,
    summary: "Bounded synthetic journal handoff.",
    participants: [{ person_id: "ou_owner", display_name: "Owner", attendance: [{ joined_at: seed.occurrenceStartedAt, left_at: seed.endedAt }] }],
    transcript: [], projects: [], decisions: [], action_items: [], discussion_points: [], person_summaries: [],
    recording_gaps: seed.bridgeGaps.map((gap) => ({ started_at: gap.startedAt, ended_at: gap.endedAt ?? seed.endedAt, reason: `bridge_${gap.direction}_gap` })),
    processing_warnings: [...seed.processingWarnings],
    provenance: {
      runtime_profile: seed.provenance.runtimeProfile,
      stt_provider: seed.provenance.sttProvider,
      stt_model: seed.provenance.sttModel,
      text_provider: seed.provenance.textProvider,
      text_model: seed.provenance.textModel,
      agent_version: seed.provenance.agentVersion,
      processed_at: "2026-09-02T14:11:00Z",
    },
    audio: {
      filename: "audio.enc",
      format: seed.recordingFormat,
      encryption: seed.recordingEncryption,
      duration_seconds: seed.recordingDurationMs / 1000,
      bytes: seed.recordingBytes,
      sha256: `sha256:${seed.recordingSha256}`,
      expires_at: new Date(seed.expiresAtMs).toISOString(),
    },
  });
}

function delivery(seed: BackfillSeed, value: SupportedTeamMemMeetingArtifact, recordingPath: string): DeliveryRow {
  const serialized = canonicalArtifactJson(value);
  return {
    occurrenceId: seed.occurrenceId,
    revision: value.revision,
    artifactHash: canonicalArtifactHash(value),
    recordingPath,
    bundlePath: path.join(path.dirname(recordingPath), "outbox", String(value.revision)),
    endedAtMs: seed.endedAtMs,
    transcriptComplete: value.transcript_complete,
    retryCount: 0,
    nextRetryAtMs: ENDED_AT_MS + 1,
    retryReason: null,
    publishedAtMs: null,
    deletedAtMs: null,
    publicationUrl: null,
    vaultCommit: null,
    recoveryArtifact: serialized,
    stageToken: "f".repeat(32),
    recordingHandle: seed.capability.recordingHandle,
  };
}

function initialAuthority(token: string, nowMs = ENDED_AT_MS + 1): BackfillDeliveryAuthority {
  return { kind: "initial", claimToken: token, nowMs };
}

test("migration 025 and initial fenced handoff atomically transfer only exact canonical revision one", () => {
  const f = harness();
  try {
    assert.equal(f.store.schemaVersion, 26);
    const claim = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1, claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    assert.equal(claim.targetRevision, 1);
    assert.equal(claim.observedAtMs, ENDED_AT_MS + 1);
    const exact = artifact(f.seed, 1, false);
    assert.throws(() => f.store.savePending(delivery(f.seed, exact, f.recordingPath)), /authority/i);
    assert.throws(() => f.store.savePending({ ...delivery(f.seed, exact, f.recordingPath), transcriptComplete: true }, initialAuthority(claim.claimToken)), /row|artifact/i);
    const changed = parseSupportedTeamMemMeetingArtifact({ ...exact, title: "Caller-forged title" });
    assert.throws(() => f.store.savePending(delivery(f.seed, changed, f.recordingPath), initialAuthority(claim.claimToken)), /seed|metadata|title/i);
    assert.throws(() => f.store.savePending(delivery(f.seed, artifact(f.seed, 2, false), f.recordingPath), initialAuthority(claim.claimToken)), /revision/i);

    const corrupt = new Database(f.filename);
    try { corrupt.prepare("UPDATE recording_recovery_bindings SET authorization=? WHERE occurrence_id=?").run("e".repeat(64), f.seed.occurrenceId); }
    finally { corrupt.close(); }
    assert.throws(() => f.store.savePending(delivery(f.seed, exact, f.recordingPath), initialAuthority(claim.claimToken)), /capability/i);
    const restore = new Database(f.filename);
    try { restore.prepare("UPDATE recording_recovery_bindings SET authorization=? WHERE occurrence_id=?").run(f.seed.capability.authorization, f.seed.occurrenceId); }
    finally { restore.close(); }

    const saved = f.store.savePending(delivery(f.seed, exact, f.recordingPath), initialAuthority(claim.claimToken));
    assert.equal(saved.kind, "inserted");
    assert.equal(saved.row.recoveryArtifact, canonicalArtifactJson(exact));
    const raw = new Database(f.filename, { readonly: true });
    try {
      assert.deepEqual(raw.prepare("SELECT owner,state,build_claim_token AS token FROM backfill_seed_lifecycle").get(), { owner: "delivery", state: "pending", token: null });
      assert.deepEqual(raw.prepare("SELECT state,attempt_count AS attempts,target_revision AS target FROM backfill_jobs").get(), { state: "due", attempts: 0, target: null });
      assert.deepEqual(raw.prepare("SELECT count(*) AS count FROM delivery_journal").get(), { count: 1 });
    } finally { raw.close(); }
  } finally { f.close(); }
});

test("initial failure scheduling uses the durable two-handle wall and stale input cannot advance it", () => {
  const f = harness();
  try {
    const claim = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 10_000,
      claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    const observer = openSessionStore({ filename: f.filename });
    try {
      const process = observer.beginBackfillProcess({ kind: "initial", occurrenceId: f.seed.occurrenceId,
        claimToken: claim.claimToken, nowMs: ENDED_AT_MS + 20_000 });
      observer.settleBackfillProcess({ occurrenceId: f.seed.occurrenceId,
        processOwnerToken: process.processOwnerToken, outcome: "confirmed", nowMs: ENDED_AT_MS + 20_001 });
    } finally { observer.close(); }
    assert.deepEqual(f.store.failBackfillBuild({ kind: "initial", occurrenceId: f.seed.occurrenceId,
      claimToken: claim.claimToken, nowMs: ENDED_AT_MS + 10_001,
      retryDelayMs: 1_000, reason: "runtime_failed" }), { kind: "rescheduled" });
    assert.equal(f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 11_001,
      claimToken: "b".repeat(32), operationBudgetMs: 1_000 }), null);
    const reopened = openSessionStore({ filename: f.filename });
    try {
      const next = reopened.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 21_001,
        claimToken: "b".repeat(32), operationBudgetMs: 1_000 })!;
      assert.equal(next.attempt, 2);
      assert.equal(next.targetRevision, 1);
      assert.equal(next.observedAtMs, ENDED_AT_MS + 21_001);
      assert.throws(() => f.store.failBackfillBuild({ kind: "initial", occurrenceId: f.seed.occurrenceId,
        claimToken: claim.claimToken, nowMs: ENDED_AT_MS + 30_000,
        retryDelayMs: 1_000, reason: "runtime_failed" }), /claim|token|stale/i);
      const raw = new Database(f.filename, { readonly: true });
      try { assert.deepEqual(raw.prepare("SELECT last_observed_at_ms AS observed FROM backfill_seed_lifecycle").get(),
        { observed: ENDED_AT_MS + 21_001 }); }
      finally { raw.close(); }
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test("expired exact build failure persists its observed wall before refusing a rollback retry", () => {
  const f = harness();
  try {
    const claim = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1,
      claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    const fail = (nowMs: number) => f.store.failBackfillBuild({ kind: "initial",
      occurrenceId: f.seed.occurrenceId, claimToken: claim.claimToken, nowMs,
      retryDelayMs: 1_000, reason: "runtime_failed" });
    assert.throws(() => fail(claim.claimExpiresAtMs), /claim|stale/i);
    assert.throws(() => fail(ENDED_AT_MS + 2), /claim|stale/i);
    const raw = new Database(f.filename, { readonly: true });
    try { assert.equal((raw.prepare("SELECT last_observed_at_ms AS observed FROM backfill_seed_lifecycle").get() as { observed: number }).observed,
      claim.claimExpiresAtMs); }
    finally { raw.close(); }
  } finally { f.close(); }
});

test("cleanup failure persists a stop for the exact expired token but never supersedes a newer owner", () => {
  for (const replaced of [false, true]) {
    const f = harness();
    try {
      const first = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1,
        claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
      const active = replaced
        ? f.store.claimBackfillSeedBuild({ nowMs: first.claimExpiresAtMs,
          claimToken: "b".repeat(32), operationBudgetMs: 1_000 })!
        : first;
      const failure = { kind: "initial" as const, occurrenceId: f.seed.occurrenceId,
        claimToken: first.claimToken, nowMs: first.claimExpiresAtMs,
        retryDelayMs: 1_000, reason: "cleanup_failed" as const };
      if (replaced) {
        assert.throws(() => f.store.failBackfillBuild(failure), /claim|token|stale/i);
        const raw = new Database(f.filename, { readonly: true });
        try { assert.deepEqual(raw.prepare("SELECT state,build_claim_token AS token FROM backfill_seed_lifecycle").get(),
          { state: "pending", token: active.claimToken }); }
        finally { raw.close(); }
      } else {
        assert.deepEqual(f.store.failBackfillBuild(failure), { kind: "stopped" });
        const reopened = openSessionStore({ filename: f.filename });
        try {
          assert.equal(reopened.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 2,
            claimToken: "c".repeat(32), operationBudgetMs: 1_000 }), null);
          const raw = new Database(f.filename, { readonly: true });
          try { assert.deepEqual(raw.prepare(`SELECT state,initial_build_last_reason AS reason,
              build_claim_token AS token FROM backfill_seed_lifecycle`).get(),
            { state: "stopped", reason: "cleanup_failed", token: null }); }
          finally { raw.close(); }
        } finally { reopened.close(); }
      }
    } finally { f.close(); }
  }
});

test("durable process ownership is single-use, blocks stale reclaim, and settles by exact token after stop", () => {
  const f = harness();
  try {
    const claim = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1,
      claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    assert.deepEqual(f.store.beginBackfillProcess({ kind: "initial", occurrenceId: f.seed.occurrenceId,
      claimToken: claim.claimToken, nowMs: ENDED_AT_MS + 2 }), { processOwnerToken: claim.claimToken });
    assert.throws(() => f.store.beginBackfillProcess({ kind: "initial", occurrenceId: f.seed.occurrenceId,
      claimToken: claim.claimToken, nowMs: ENDED_AT_MS + 3 }), /process|owner|active/i);
    const other = openSessionStore({ filename: f.filename });
    try {
      assert.equal(other.claimBackfillSeedBuild({ nowMs: claim.claimExpiresAtMs,
        claimToken: "b".repeat(32), operationBudgetMs: 1_000 }), null);
      assert.equal(other.claimExpiredBackfillSeedCleanup({ nowMs: f.seed.expiresAtMs,
        claimToken: "c".repeat(32) }), null);
      assert.deepEqual(other.settleBackfillProcess({ occurrenceId: f.seed.occurrenceId,
        processOwnerToken: claim.claimToken, outcome: "confirmed", nowMs: f.seed.expiresAtMs }),
      { outcome: "confirmed" });
      assert.throws(() => other.settleBackfillProcess({ occurrenceId: f.seed.occurrenceId,
        processOwnerToken: claim.claimToken, outcome: "confirmed", nowMs: f.seed.expiresAtMs }), /process|owner|active/i);
    } finally { other.close(); }
    const raw = new Database(f.filename, { readonly: true });
    try { assert.deepEqual(raw.prepare(`SELECT process_owner_token AS token,process_cleanup_state AS cleanup
      FROM backfill_seed_lifecycle`).get(), { token: null, cleanup: null }); }
    finally { raw.close(); }
  } finally { f.close(); }
});

test("failed process settlement is a permanent deletion and respawn blocker", () => {
  const f = harness();
  try {
    const claim = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1,
      claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    f.store.beginBackfillProcess({ kind: "initial", occurrenceId: f.seed.occurrenceId,
      claimToken: claim.claimToken, nowMs: ENDED_AT_MS + 2 });
    assert.deepEqual(f.store.settleBackfillProcess({ occurrenceId: f.seed.occurrenceId,
      processOwnerToken: claim.claimToken, outcome: "failed", nowMs: claim.claimExpiresAtMs }),
    { outcome: "failed" });
    assert.throws(() => f.store.settleBackfillProcess({ occurrenceId: f.seed.occurrenceId,
      processOwnerToken: claim.claimToken, outcome: "confirmed", nowMs: claim.claimExpiresAtMs + 1 }), /process|owner|active/i);
    assert.equal(f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 2,
      claimToken: "b".repeat(32), operationBudgetMs: 1_000 }), null);
    assert.equal(f.store.claimExpiredBackfillSeedCleanup({ nowMs: f.seed.expiresAtMs,
      claimToken: "b".repeat(32) }), null);
    const raw = new Database(f.filename);
    try {
      assert.deepEqual(raw.prepare(`SELECT state,initial_build_last_reason AS reason,
        process_owner_token AS token,process_cleanup_state AS cleanup FROM backfill_seed_lifecycle`).get(),
      { state: "stopped", reason: "cleanup_failed", token: claim.claimToken, cleanup: "failed" });
      assert.throws(() => raw.prepare(`UPDATE backfill_seed_lifecycle
        SET process_owner_token=NULL,process_cleanup_state=NULL`).run(), /process ownership fence/i);
    } finally { raw.close(); }
  } finally { f.close(); }
});

test("accepted complete receipt cannot authorize deletion until its concurrent exact process owner settles", () => {
  const f = harness();
  try {
    const initial = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1,
      claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    f.store.savePending(delivery(f.seed, artifact(f.seed, 1, false), f.recordingPath), initialAuthority(initial.claimToken));
    const completeClaim = f.store.claimBackfillJob({ nowMs: ENDED_AT_MS + 2,
      claimToken: "b".repeat(32), operationBudgetMs: 1_000 })!;
    const complete = delivery(f.seed, artifact(f.seed, completeClaim.targetRevision, true), f.recordingPath);
    f.store.savePending(complete, { kind: "retry", claimToken: completeClaim.claimToken,
      targetRevision: completeClaim.targetRevision, nowMs: ENDED_AT_MS + 2 });
    const interrupted = new Database(f.filename);
    try { interrupted.prepare("UPDATE backfill_jobs SET state='due',target_revision=NULL,next_attempt_at_ms=?")
      .run(ENDED_AT_MS + 3); }
    finally { interrupted.close(); }
    const active = f.store.claimBackfillJob({ nowMs: ENDED_AT_MS + 3,
      claimToken: "c".repeat(32), operationBudgetMs: 1_000 })!;
    f.store.beginBackfillProcess({ kind: "retry", occurrenceId: f.seed.occurrenceId,
      claimToken: active.claimToken, targetRevision: active.targetRevision, nowMs: ENDED_AT_MS + 4 });
    f.coordinator.advance(f.seed.occurrenceId, "awaiting_teammem");
    f.store.acceptPublication({ occurrenceId: complete.occurrenceId, revision: complete.revision,
      artifactHash: complete.artifactHash, publishedAtMs: ENDED_AT_MS + 5,
      publicationUrl: `https://example.test/-/blob/${"a".repeat(40)}/meeting.md`, vaultCommit: "a".repeat(40),
      notification: { terminalReason: "organizer_unresolved" } });
    assert.equal(f.store.authorizeDeliveryEvidenceCleanup({ occurrenceId: f.seed.occurrenceId,
      nowMs: ENDED_AT_MS + 6 }), false);
    assert.deepEqual(f.store.settleBackfillProcess({ occurrenceId: f.seed.occurrenceId,
      processOwnerToken: active.claimToken, outcome: "confirmed", nowMs: ENDED_AT_MS + 7 }),
    { outcome: "confirmed" });
    assert.equal(f.store.authorizeDeliveryEvidenceCleanup({ occurrenceId: f.seed.occurrenceId,
      nowMs: ENDED_AT_MS + 8 }), true);
  } finally { f.close(); }
});

test("retry failure retains its reserved revision and expired cleanup failure stops only the current token", () => {
  const f = harness();
  try {
    const initial = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1,
      claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    f.store.savePending(delivery(f.seed, artifact(f.seed, initial.targetRevision, false), f.recordingPath),
      initialAuthority(initial.claimToken));
    const first = f.store.claimBackfillJob({ nowMs: ENDED_AT_MS + 2,
      claimToken: "b".repeat(32), operationBudgetMs: 1_000 })!;
    assert.deepEqual(f.store.failBackfillBuild({ kind: "retry", occurrenceId: f.seed.occurrenceId,
      claimToken: first.claimToken, targetRevision: first.targetRevision, nowMs: ENDED_AT_MS + 3,
      retryDelayMs: 1_000, reason: "runtime_failed" }), { kind: "rescheduled" });
    assert.equal(f.store.claimBackfillJob({ nowMs: ENDED_AT_MS + 4,
      claimToken: "c".repeat(32), operationBudgetMs: 1_000 }), null);
    const reclaimed = f.store.claimBackfillJob({ nowMs: ENDED_AT_MS + 1_003,
      claimToken: "c".repeat(32), operationBudgetMs: 1_000 })!;
    assert.equal(reclaimed.targetRevision, first.targetRevision);
    assert.deepEqual(f.store.failBackfillBuild({ kind: "retry", occurrenceId: f.seed.occurrenceId,
      claimToken: reclaimed.claimToken, targetRevision: reclaimed.targetRevision,
      nowMs: reclaimed.claimExpiresAtMs, retryDelayMs: 1_000,
      reason: "cleanup_failed" }), { kind: "stopped" });
    const raw = new Database(f.filename, { readonly: true });
    try { assert.deepEqual(raw.prepare(`SELECT lifecycle.state,job.state AS jobState,job.target_revision AS target,
        job.last_reason AS reason FROM backfill_seed_lifecycle AS lifecycle JOIN backfill_jobs AS job USING(occurrence_id)`).get(),
      { state: "stopped", jobState: "stopped", target: first.targetRevision, reason: "cleanup_failed" }); }
    finally { raw.close(); }
  } finally { f.close(); }
});

test("stop atomically registers one original-deadline warning and warning acceptance is receipt fenced", () => {
  const f = harness();
  try {
    const before = f.store.claimBackfillWarning({ nowMs: f.seed.stopAtMs - 1,
      claimToken: "a".repeat(32) });
    assert.equal(before, null);
    assert.deepEqual(f.store.stopDueBackfill({ nowMs: f.seed.stopAtMs }), { occurrenceId: f.seed.occurrenceId });
    assert.equal(f.store.stopDueBackfill({ nowMs: f.seed.stopAtMs }), null);
    const warning = f.store.claimBackfillWarning({ nowMs: f.seed.stopAtMs,
      claimToken: "b".repeat(32) })!;
    assert.equal(warning.claimExpiresAtMs, f.seed.stopAtMs + 30_000);
    assert.equal(warning.payload.occurrenceId, f.seed.occurrenceId);
    assert.equal(warning.payload.stopAt, new Date(f.seed.stopAtMs).toISOString());
    assert.equal(warning.payload.expiresAt, new Date(f.seed.expiresAtMs).toISOString());
    assert.throws(() => f.store.acceptBackfillWarning({ occurrenceId: f.seed.occurrenceId,
      claimToken: warning.claimToken, key: "0".repeat(64), nowMs: f.seed.stopAtMs + 1 }), /key|receipt/i);
    f.store.acceptBackfillWarning({ occurrenceId: f.seed.occurrenceId,
      claimToken: warning.claimToken, key: warning.key, nowMs: f.seed.stopAtMs + 1 });
    f.store.acceptBackfillWarning({ occurrenceId: f.seed.occurrenceId,
      claimToken: warning.claimToken, key: warning.key, nowMs: f.seed.stopAtMs + 2 });
    assert.equal(f.store.claimBackfillWarning({ nowMs: f.seed.stopAtMs + 2,
      claimToken: "c".repeat(32) }), null);
  } finally { f.close(); }
});

test("warning retry uses the durable two-handle wall and stale claim expiry preserves one intent", () => {
  const f = harness();
  try {
    f.store.stopDueBackfill({ nowMs: f.seed.stopAtMs });
    const first = f.store.claimBackfillWarning({ nowMs: f.seed.stopAtMs,
      claimToken: "a".repeat(32) })!;
    const observer = openSessionStore({ filename: f.filename });
    try { assert.equal(observer.authorizeDeliveryEvidenceCleanup({ occurrenceId: f.seed.occurrenceId,
      nowMs: f.seed.stopAtMs + 20_000 }), false); }
    finally { observer.close(); }
    f.store.failBackfillWarning({ occurrenceId: f.seed.occurrenceId, claimToken: first.claimToken,
      nowMs: f.seed.stopAtMs + 1, retryDelayMs: 1_000, reason: "sink_failed" });
    assert.equal(f.store.claimBackfillWarning({ nowMs: f.seed.stopAtMs + 1_001,
      claimToken: "b".repeat(32) }), null);
    assert.throws(() => f.store.failBackfillWarning({ occurrenceId: f.seed.occurrenceId,
      claimToken: first.claimToken, nowMs: f.seed.stopAtMs + 2,
      retryDelayMs: 1_000, reason: "sink_failed" }), /claim|stale/i);
    const second = f.store.claimBackfillWarning({ nowMs: f.seed.stopAtMs + 21_000,
      claimToken: "b".repeat(32) })!;
    const reopened = openSessionStore({ filename: f.filename });
    try {
      const reclaimed = reopened.claimBackfillWarning({ nowMs: second.claimExpiresAtMs,
        claimToken: "c".repeat(32) })!;
      assert.equal(reclaimed.attempt, 3);
      assert.throws(() => f.store.acceptBackfillWarning({ occurrenceId: f.seed.occurrenceId,
        claimToken: second.claimToken, key: second.key, nowMs: second.claimExpiresAtMs }), /claim|stale/i);
      reopened.acceptBackfillWarning({ occurrenceId: f.seed.occurrenceId,
        claimToken: reclaimed.claimToken, key: reclaimed.key, nowMs: second.claimExpiresAtMs });
    } finally { reopened.close(); }
    const raw = new Database(f.filename, { readonly: true });
    try { assert.deepEqual(raw.prepare("SELECT state,attempt_count AS attempts FROM backfill_warning_intents").get(),
      { state: "accepted", attempts: 3 }); }
    finally { raw.close(); }
  } finally { f.close(); }
});

test("expired warning failure persists its claim wall before refusing a rollback retry", () => {
  const f = harness();
  try {
    f.store.stopDueBackfill({ nowMs: f.seed.stopAtMs });
    const claim = f.store.claimBackfillWarning({ nowMs: f.seed.stopAtMs,
      claimToken: "a".repeat(32) })!;
    const fail = (nowMs: number) => f.store.failBackfillWarning({ occurrenceId: f.seed.occurrenceId,
      claimToken: claim.claimToken, nowMs, retryDelayMs: 1_000, reason: "sink_failed" });
    assert.throws(() => fail(claim.claimExpiresAtMs), /claim|stale|expired/i);
    assert.throws(() => fail(f.seed.stopAtMs + 1), /claim|stale|expired/i);
    const raw = new Database(f.filename, { readonly: true });
    try { assert.equal((raw.prepare("SELECT last_observed_at_ms AS observed FROM backfill_seed_lifecycle").get() as { observed: number }).observed,
      claim.claimExpiresAtMs); }
    finally { raw.close(); }
  } finally { f.close(); }
});

test("warning expiry and attempt exhaustion become durable terminal classifications", () => {
  for (const reason of ["expired", "attempts_exhausted"] as const) {
    const f = harness();
    try {
      f.store.stopDueBackfill({ nowMs: f.seed.stopAtMs });
      if (reason === "attempts_exhausted") {
        const raw = new Database(f.filename);
        try { raw.prepare("UPDATE backfill_warning_intents SET attempt_count=999999 WHERE occurrence_id=?")
          .run(f.seed.occurrenceId); }
        finally { raw.close(); }
        const finalAttempt = f.store.claimBackfillWarning({ nowMs: f.seed.stopAtMs,
          claimToken: "a".repeat(32) })!;
        f.store.failBackfillWarning({ occurrenceId: f.seed.occurrenceId,
          claimToken: finalAttempt.claimToken, nowMs: f.seed.stopAtMs + 1,
          retryDelayMs: 1_000, reason: "sink_failed" });
      } else {
        assert.equal(f.store.claimBackfillWarning({ nowMs: f.seed.expiresAtMs,
          claimToken: "a".repeat(32) }), null);
      }
      assert.equal(f.store.claimBackfillWarning({ nowMs: f.seed.stopAtMs,
        claimToken: "b".repeat(32) }), null);
      const raw = new Database(f.filename, { readonly: true });
      try { assert.deepEqual(raw.prepare("SELECT state,terminal_reason AS reason FROM backfill_warning_intents").get(),
        { state: "terminal", reason }); }
      finally { raw.close(); }
    } finally { f.close(); }
  }
});

test("warning expiry rejection persists closure against a lower raw clock", () => {
  const f = harness();
  try {
    f.store.stopDueBackfill({ nowMs: f.seed.stopAtMs });
    const warning = f.store.claimBackfillWarning({ nowMs: f.seed.expiresAtMs - 1_000,
      claimToken: "a".repeat(32) })!;
    assert.throws(() => f.store.acceptBackfillWarning({ occurrenceId: f.seed.occurrenceId,
      claimToken: warning.claimToken, key: warning.key, nowMs: f.seed.expiresAtMs }), /expired|stale/i);
    assert.throws(() => f.store.acceptBackfillWarning({ occurrenceId: f.seed.occurrenceId,
      claimToken: warning.claimToken, key: warning.key, nowMs: f.seed.expiresAtMs - 1 }), /expired|stale/i);
    const raw = new Database(f.filename, { readonly: true });
    try { assert.deepEqual(raw.prepare(`SELECT warning.state,warning.terminal_reason AS reason,
        lifecycle.last_observed_at_ms AS observed FROM backfill_warning_intents AS warning
        JOIN backfill_seed_lifecycle AS lifecycle USING(occurrence_id)`).get(),
      { state: "terminal", reason: "expired", observed: f.seed.expiresAtMs }); }
    finally { raw.close(); }
  } finally { f.close(); }
});

test("seed-only cleanup is exact-expiry, fixed-lease and stale-token fenced without delivery rows", () => {
  const f = harness();
  try {
    f.store.stopDueBackfill({ nowMs: f.seed.stopAtMs });
    assert.equal(f.store.claimExpiredBackfillSeedCleanup({ nowMs: f.seed.expiresAtMs - 1,
      claimToken: "a".repeat(32) }), null);
    const claim = f.store.claimExpiredBackfillSeedCleanup({ nowMs: f.seed.expiresAtMs,
      claimToken: "a".repeat(32) })!;
    assert.equal(claim.claimExpiresAtMs, f.seed.expiresAtMs + 30_000);
    assert.equal(claim.recordingPath, f.seed.recordingPath);
    assert.equal(claim.recordingDevice, f.seed.recordingDevice);
    assert.equal(claim.recordingInode, f.seed.recordingInode);
    assert.equal(claim.recordingBytes, f.seed.recordingBytes);
    const reopened = openSessionStore({ filename: f.filename });
    try {
      const reclaimed = reopened.claimExpiredBackfillSeedCleanup({ nowMs: claim.claimExpiresAtMs,
        claimToken: "b".repeat(32) })!;
      assert.throws(() => f.store.completeBackfillSeedCleanup({ occurrenceId: f.seed.occurrenceId,
        claimToken: claim.claimToken, nowMs: claim.claimExpiresAtMs }), /claim|token|stale/i);
      reopened.completeBackfillSeedCleanup({ occurrenceId: f.seed.occurrenceId,
        claimToken: reclaimed.claimToken, nowMs: claim.claimExpiresAtMs });
    } finally { reopened.close(); }
    const raw = new Database(f.filename, { readonly: true });
    try {
      assert.deepEqual(raw.prepare("SELECT state,deleted_at_ms AS deleted FROM backfill_seed_lifecycle").get(),
        { state: "deleted", deleted: claim.claimExpiresAtMs });
      assert.deepEqual(raw.prepare("SELECT count(*) AS count FROM delivery_journal").get(), { count: 0 });
      assert.deepEqual(raw.prepare("SELECT count(*) AS count FROM backfill_jobs").get(), { count: 0 });
    } finally { raw.close(); }
  } finally { f.close(); }
});

test("expired cleanup completion persists its lease wall and cannot succeed after clock rollback", () => {
  const f = harness();
  try {
    f.store.stopDueBackfill({ nowMs: f.seed.stopAtMs });
    const claim = f.store.claimExpiredBackfillSeedCleanup({ nowMs: f.seed.expiresAtMs,
      claimToken: "a".repeat(32) })!;
    assert.throws(() => f.store.completeBackfillSeedCleanup({ occurrenceId: f.seed.occurrenceId,
      claimToken: claim.claimToken, nowMs: claim.claimExpiresAtMs }), /claim|stale/i);
    assert.throws(() => f.store.completeBackfillSeedCleanup({ occurrenceId: f.seed.occurrenceId,
      claimToken: claim.claimToken, nowMs: f.seed.expiresAtMs + 1 }), /claim|stale/i);
    const raw = new Database(f.filename, { readonly: true });
    try { assert.deepEqual(raw.prepare("SELECT state,last_observed_at_ms AS observed FROM backfill_seed_lifecycle").get(),
      { state: "cleanup_claimed", observed: claim.claimExpiresAtMs }); }
    finally { raw.close(); }
  } finally { f.close(); }
});

test("valid seeded handoff at the original stop persists closure before refusing lower-clock replay", () => {
  const f = harness();
  try {
    const claim = f.store.claimBackfillSeedBuild({ nowMs: f.seed.stopAtMs - 1,
      claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    const row = delivery(f.seed, artifact(f.seed, claim.targetRevision, false), f.recordingPath);
    assert.throws(() => f.store.savePending(row, initialAuthority(claim.claimToken, f.seed.stopAtMs)), /stop|deadline/i);
    assert.throws(() => f.store.savePending(row, initialAuthority(claim.claimToken, f.seed.stopAtMs - 2)), /stop|deadline/i);
    const raw = new Database(f.filename, { readonly: true });
    try { assert.deepEqual(raw.prepare(`SELECT lifecycle.last_observed_at_ms AS observed,
        count(delivery.occurrence_id) AS deliveries FROM backfill_seed_lifecycle AS lifecycle
        LEFT JOIN delivery_journal AS delivery USING(occurrence_id)`).get(),
      { observed: f.seed.stopAtMs, deliveries: 0 }); }
    finally { raw.close(); }
  } finally { f.close(); }
});

test("exact expired initial and retry handoff owners persist their observed wall before refusing rollback", () => {
  const initialFixture = harness();
  try {
    const claim = initialFixture.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1,
      claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    const row = delivery(initialFixture.seed, artifact(initialFixture.seed, claim.targetRevision, false), initialFixture.recordingPath);
    assert.throws(() => initialFixture.store.savePending(row,
      initialAuthority(claim.claimToken, claim.claimExpiresAtMs)), /claim|stale|expired|lease/i);
    assert.throws(() => initialFixture.store.savePending(row,
      initialAuthority(claim.claimToken, ENDED_AT_MS + 2)), /claim|stale|expired|lease/i);
    const raw = new Database(initialFixture.filename, { readonly: true });
    try { assert.deepEqual(raw.prepare("SELECT last_observed_at_ms AS observed FROM backfill_seed_lifecycle").get(),
      { observed: claim.claimExpiresAtMs }); }
    finally { raw.close(); }
  } finally { initialFixture.close(); }

  const retryFixture = harness();
  try {
    const initial = retryFixture.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1,
      claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    retryFixture.store.savePending(delivery(retryFixture.seed,
      artifact(retryFixture.seed, initial.targetRevision, false), retryFixture.recordingPath), initialAuthority(initial.claimToken));
    const claim = retryFixture.store.claimBackfillJob({ nowMs: ENDED_AT_MS + 2,
      claimToken: "b".repeat(32), operationBudgetMs: 1_000 })!;
    const row = delivery(retryFixture.seed, artifact(retryFixture.seed, claim.targetRevision, true), retryFixture.recordingPath);
    const authority = (nowMs: number): BackfillDeliveryAuthority => ({ kind: "retry", claimToken: claim.claimToken,
      targetRevision: claim.targetRevision, nowMs });
    assert.throws(() => retryFixture.store.savePending(row, authority(claim.claimExpiresAtMs)), /claim|stale|expired|lease/i);
    assert.throws(() => retryFixture.store.savePending(row, authority(ENDED_AT_MS + 3)), /claim|stale|expired|lease/i);
    const raw = new Database(retryFixture.filename, { readonly: true });
    try { assert.deepEqual(raw.prepare("SELECT last_observed_at_ms AS observed FROM backfill_seed_lifecycle").get(),
      { observed: claim.claimExpiresAtMs }); }
    finally { raw.close(); }
  } finally { retryFixture.close(); }
});

test("active process ownership blocks new initial and retry handoff until exact confirmed settlement", () => {
  const initialFixture = harness();
  try {
    const claim = initialFixture.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1,
      claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    const process = initialFixture.store.beginBackfillProcess({ kind: "initial", occurrenceId: initialFixture.seed.occurrenceId,
      claimToken: claim.claimToken, nowMs: ENDED_AT_MS + 2 });
    const row = delivery(initialFixture.seed, artifact(initialFixture.seed, claim.targetRevision, false), initialFixture.recordingPath);
    assert.throws(() => initialFixture.store.savePending(row,
      initialAuthority(claim.claimToken, ENDED_AT_MS + 3)), /process|cleanup|active|owner/i);
    initialFixture.store.settleBackfillProcess({ occurrenceId: initialFixture.seed.occurrenceId,
      processOwnerToken: process.processOwnerToken, outcome: "confirmed", nowMs: ENDED_AT_MS + 3 });
    assert.equal(initialFixture.store.savePending(row,
      initialAuthority(claim.claimToken, ENDED_AT_MS + 3)).kind, "inserted");
  } finally { initialFixture.close(); }

  const retryFixture = harness();
  try {
    const initial = retryFixture.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1,
      claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    retryFixture.store.savePending(delivery(retryFixture.seed,
      artifact(retryFixture.seed, initial.targetRevision, false), retryFixture.recordingPath), initialAuthority(initial.claimToken));
    const claim = retryFixture.store.claimBackfillJob({ nowMs: ENDED_AT_MS + 2,
      claimToken: "b".repeat(32), operationBudgetMs: 1_000 })!;
    const process = retryFixture.store.beginBackfillProcess({ kind: "retry", occurrenceId: retryFixture.seed.occurrenceId,
      claimToken: claim.claimToken, targetRevision: claim.targetRevision, nowMs: ENDED_AT_MS + 3 });
    const row = delivery(retryFixture.seed, artifact(retryFixture.seed, claim.targetRevision, true), retryFixture.recordingPath);
    const authority: BackfillDeliveryAuthority = { kind: "retry", claimToken: claim.claimToken,
      targetRevision: claim.targetRevision, nowMs: ENDED_AT_MS + 4 };
    assert.throws(() => retryFixture.store.savePending(row, authority), /process|cleanup|active|owner/i);
    retryFixture.store.settleBackfillProcess({ occurrenceId: retryFixture.seed.occurrenceId,
      processOwnerToken: process.processOwnerToken, outcome: "confirmed", nowMs: ENDED_AT_MS + 4 });
    assert.equal(retryFixture.store.savePending(row, authority).kind, "inserted");
  } finally { retryFixture.close(); }
});

test("exact expired initial and retry process-start owners persist their observed wall before refusing rollback", () => {
  const initialFixture = harness();
  try {
    const claim = initialFixture.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1,
      claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    const begin = (nowMs: number) => initialFixture.store.beginBackfillProcess({ kind: "initial",
      occurrenceId: initialFixture.seed.occurrenceId, claimToken: claim.claimToken, nowMs });
    assert.throws(() => begin(claim.claimExpiresAtMs), /claim|stale|expired|lease/i);
    assert.throws(() => begin(ENDED_AT_MS + 2), /claim|stale|expired|lease/i);
    const raw = new Database(initialFixture.filename, { readonly: true });
    try { assert.deepEqual(raw.prepare("SELECT last_observed_at_ms AS observed FROM backfill_seed_lifecycle").get(),
      { observed: claim.claimExpiresAtMs }); }
    finally { raw.close(); }
  } finally { initialFixture.close(); }

  const retryFixture = harness();
  try {
    const initial = retryFixture.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1,
      claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    retryFixture.store.savePending(delivery(retryFixture.seed,
      artifact(retryFixture.seed, initial.targetRevision, false), retryFixture.recordingPath), initialAuthority(initial.claimToken));
    const claim = retryFixture.store.claimBackfillJob({ nowMs: ENDED_AT_MS + 2,
      claimToken: "b".repeat(32), operationBudgetMs: 1_000 })!;
    const begin = (nowMs: number) => retryFixture.store.beginBackfillProcess({ kind: "retry",
      occurrenceId: retryFixture.seed.occurrenceId, claimToken: claim.claimToken,
      targetRevision: claim.targetRevision, nowMs });
    assert.throws(() => begin(claim.claimExpiresAtMs), /claim|stale|expired|lease/i);
    assert.throws(() => begin(ENDED_AT_MS + 3), /claim|stale|expired|lease/i);
    const raw = new Database(retryFixture.filename, { readonly: true });
    try { assert.deepEqual(raw.prepare("SELECT last_observed_at_ms AS observed FROM backfill_seed_lifecycle").get(),
      { observed: claim.claimExpiresAtMs }); }
    finally { raw.close(); }
  } finally { retryFixture.close(); }
});

test("stale initial and retry authority cannot advance the persisted wall", () => {
  const initialFixture = harness();
  try {
    const claim = initialFixture.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1,
      claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    const stale = "b".repeat(32), later = ENDED_AT_MS + 1_000;
    const row = delivery(initialFixture.seed, artifact(initialFixture.seed, claim.targetRevision, false), initialFixture.recordingPath);
    assert.throws(() => initialFixture.store.savePending(row, initialAuthority(stale, later)), /claim|stale/i);
    assert.throws(() => initialFixture.store.beginBackfillProcess({ kind: "initial", occurrenceId: initialFixture.seed.occurrenceId,
      claimToken: stale, nowMs: later }), /claim|stale/i);
    const raw = new Database(initialFixture.filename, { readonly: true });
    try { assert.deepEqual(raw.prepare("SELECT last_observed_at_ms AS observed FROM backfill_seed_lifecycle").get(),
      { observed: claim.observedAtMs }); }
    finally { raw.close(); }
  } finally { initialFixture.close(); }

  const retryFixture = harness();
  try {
    const initial = retryFixture.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1,
      claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    retryFixture.store.savePending(delivery(retryFixture.seed,
      artifact(retryFixture.seed, initial.targetRevision, false), retryFixture.recordingPath), initialAuthority(initial.claimToken));
    const claim = retryFixture.store.claimBackfillJob({ nowMs: ENDED_AT_MS + 2,
      claimToken: "b".repeat(32), operationBudgetMs: 1_000 })!;
    const stale = "c".repeat(32), later = ENDED_AT_MS + 1_000;
    const row = delivery(retryFixture.seed, artifact(retryFixture.seed, claim.targetRevision, true), retryFixture.recordingPath);
    assert.throws(() => retryFixture.store.savePending(row, { kind: "retry", claimToken: stale,
      targetRevision: claim.targetRevision, nowMs: later }), /claim|stale/i);
    assert.throws(() => retryFixture.store.beginBackfillProcess({ kind: "retry", occurrenceId: retryFixture.seed.occurrenceId,
      claimToken: stale, targetRevision: claim.targetRevision, nowMs: later }), /claim|stale/i);
    const raw = new Database(retryFixture.filename, { readonly: true });
    try { assert.deepEqual(raw.prepare("SELECT last_observed_at_ms AS observed FROM backfill_seed_lifecycle").get(),
      { observed: claim.observedAtMs }); }
    finally { raw.close(); }
  } finally { retryFixture.close(); }
});

test("cleanup-failed seed stays visibly blocked at expiry without granting physical deletion authority", () => {
  const f = harness();
  try {
    const claim = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1,
      claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    assert.deepEqual(f.store.failBackfillBuild({ kind: "initial", occurrenceId: f.seed.occurrenceId,
      claimToken: claim.claimToken, nowMs: ENDED_AT_MS + 2,
      retryDelayMs: 1_000, reason: "cleanup_failed" }), { kind: "stopped" });
    assert.equal(f.store.claimExpiredBackfillSeedCleanup({ nowMs: f.seed.expiresAtMs,
      claimToken: "b".repeat(32) }), null);
    assert.equal(existsSync(f.recordingPath), true);
    const raw = new Database(f.filename, { readonly: true });
    try { assert.deepEqual(raw.prepare(`SELECT state,initial_build_last_reason AS reason,
        cleanup_claim_token AS cleanupToken,deleted_at_ms AS deleted FROM backfill_seed_lifecycle`).get(),
      { state: "stopped", reason: "cleanup_failed", cleanupToken: null, deleted: null }); }
    finally { raw.close(); }
  } finally { f.close(); }
});

test("cleanup-failed retry blocks existing delivery cleanup at expiry without erasing its visible reason", () => {
  const f = harness();
  try {
    const outboxDir = path.join(path.dirname(f.recordingPath), "outbox"), receiptsDir = path.join(f.dir, "receipts");
    mkdirSync(outboxDir); mkdirSync(receiptsDir);
    const initial = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1,
      claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    const partial = delivery(f.seed, artifact(f.seed, initial.targetRevision, false), f.recordingPath);
    f.store.savePending({ ...partial, bundlePath: path.join(outboxDir,
      occurrencePathSegment(f.seed.occurrenceId as `${string}@${string}`), String(partial.revision)) }, initialAuthority(initial.claimToken));
    const retry = f.store.claimBackfillJob({ nowMs: ENDED_AT_MS + 2,
      claimToken: "b".repeat(32), operationBudgetMs: 1_000 })!;
    f.store.failBackfillBuild({ kind: "retry", occurrenceId: f.seed.occurrenceId,
      claimToken: retry.claimToken, targetRevision: retry.targetRevision, nowMs: ENDED_AT_MS + 3,
      retryDelayMs: 1_000, reason: "cleanup_failed" });
    assert.equal(f.store.authorizeDeliveryEvidenceCleanup({ occurrenceId: f.seed.occurrenceId,
      nowMs: f.seed.expiresAtMs }), false);
    const worker = createOutboxWorker({ recordingsDir: path.dirname(f.recordingPath), outboxDir, receiptsDir,
      journal: f.store, clock: { now: () => f.seed.expiresAtMs }, random: () => 0,
      session: { state: () => "failed", publish: () => undefined },
      reconciliationEvidence: { purgeExpiredReconciliationEvidence: () => 0 },
    });
    worker.reconcile();
    assert.equal(existsSync(f.recordingPath), true);
    const raw = new Database(f.filename, { readonly: true });
    try { assert.deepEqual(raw.prepare(`SELECT lifecycle.state,lifecycle.initial_build_last_reason AS lifecycleReason,
        job.state AS jobState,job.last_reason AS jobReason,delivery.deleted_at_ms AS deleted
        FROM backfill_seed_lifecycle AS lifecycle JOIN backfill_jobs AS job USING(occurrence_id)
        JOIN delivery_journal AS delivery USING(occurrence_id)`).get(),
      { state: "stopped", lifecycleReason: "cleanup_failed", jobState: "stopped",
        jobReason: "cleanup_failed", deleted: null }); }
    finally { raw.close(); }
  } finally { f.close(); }
});

test("initial complete intent without a retry job stops only while its authoritative receipt is absent", () => {
  for (const accepted of [false, true]) {
    const f = harness();
    try {
      const claim = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1,
        claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
      const complete = delivery(f.seed, artifact(f.seed, claim.targetRevision, true), f.recordingPath);
      f.store.savePending(complete, initialAuthority(claim.claimToken));
      if (accepted) {
        f.coordinator.advance(f.seed.occurrenceId, "awaiting_teammem");
        f.store.acceptPublication({ occurrenceId: complete.occurrenceId, revision: complete.revision,
          artifactHash: complete.artifactHash, publishedAtMs: ENDED_AT_MS + 2,
          publicationUrl: `https://example.test/-/blob/${"a".repeat(40)}/meeting.md`,
          vaultCommit: "a".repeat(40), notification: { terminalReason: "organizer_unresolved" } });
      }
      assert.deepEqual(f.store.stopDueBackfill({ nowMs: f.seed.stopAtMs }),
        accepted ? null : { occurrenceId: f.seed.occurrenceId });
      const raw = new Database(f.filename, { readonly: true });
      try {
        assert.deepEqual(raw.prepare(`SELECT lifecycle.state,count(job.occurrence_id) AS jobs
          FROM backfill_seed_lifecycle AS lifecycle LEFT JOIN backfill_jobs AS job USING(occurrence_id)`).get(),
        { state: accepted ? "pending" : "stopped", jobs: 0 });
      } finally { raw.close(); }
    } finally { f.close(); }
  }
});

test("the existing outbox worker alone removes an expired seed-owned recording without inventing delivery state", () => {
  const f = harness();
  try {
    const outboxDir = path.join(f.dir, "outbox"), receiptsDir = path.join(f.dir, "receipts");
    mkdirSync(outboxDir); mkdirSync(receiptsDir);
    f.store.stopDueBackfill({ nowMs: f.seed.stopAtMs });
    const worker = createOutboxWorker({
      recordingsDir: path.dirname(f.recordingPath), outboxDir, receiptsDir, journal: f.store,
      clock: { now: () => f.seed.expiresAtMs }, random: () => 0,
      session: { state: () => "failed", publish: () => undefined },
      reconciliationEvidence: { purgeExpiredReconciliationEvidence: () => 0 },
    });
    worker.reconcile();
    assert.equal(existsSync(f.recordingPath), false);
    const raw = new Database(f.filename, { readonly: true });
    try {
      assert.deepEqual(raw.prepare("SELECT state,deleted_at_ms AS deleted FROM backfill_seed_lifecycle").get(),
        { state: "deleted", deleted: f.seed.expiresAtMs });
      assert.deepEqual(raw.prepare("SELECT count(*) AS count FROM delivery_journal").get(), { count: 0 });
      assert.deepEqual(raw.prepare("SELECT count(*) AS count FROM backfill_jobs").get(), { count: 0 });
    } finally { raw.close(); }
  } finally { f.close(); }
});

test("seed cleanup crash replay uses stable physical identity and commits only after reopened removal", () => {
  const f = harness();
  try {
    f.store.stopDueBackfill({ nowMs: f.seed.stopAtMs });
    const first = f.store.claimExpiredBackfillSeedCleanup({ nowMs: f.seed.expiresAtMs,
      claimToken: "a".repeat(32) })!;
    assert.throws(() => deleteSeedRecordingEvidence({ recordingsDir: path.dirname(f.recordingPath),
      recordingPath: first.recordingPath, recordingHandle: first.recordingHandle,
      recordingBytes: first.recordingBytes, recordingDevice: first.recordingDevice,
      recordingInode: first.recordingInode, fault(step) { if (step === "after_recording_detach") throw new Error("crash cut"); } }), /crash cut/);
    assert.equal(existsSync(f.recordingPath), false);
    assert.equal(readdirSync(path.dirname(f.recordingPath)).filter((name) => name.startsWith(".recording-delete-seed-")).length, 1);
    const reopened = openSessionStore({ filename: f.filename });
    try {
      const reclaimed = reopened.claimExpiredBackfillSeedCleanup({ nowMs: first.claimExpiresAtMs,
        claimToken: "b".repeat(32) })!;
      deleteSeedRecordingEvidence({ recordingsDir: path.dirname(f.recordingPath),
        recordingPath: reclaimed.recordingPath, recordingHandle: reclaimed.recordingHandle,
        recordingBytes: reclaimed.recordingBytes, recordingDevice: reclaimed.recordingDevice,
        recordingInode: reclaimed.recordingInode });
      reopened.completeBackfillSeedCleanup({ occurrenceId: reclaimed.occurrenceId,
        claimToken: reclaimed.claimToken, nowMs: first.claimExpiresAtMs });
    } finally { reopened.close(); }
    assert.deepEqual(readdirSync(path.dirname(f.recordingPath)), []);
  } finally { f.close(); }
});

test("seed cleanup rechecks exact identity after detach and preserves a replacement file or directory", () => {
  for (const replacement of ["file", "directory"] as const) {
    const f = harness();
    try {
      let tombstone = "";
      let detachedOriginal = "";
      assert.throws(() => deleteSeedRecordingEvidence({ recordingsDir: path.dirname(f.recordingPath),
        recordingPath: f.seed.recordingPath, recordingHandle: f.seed.capability.recordingHandle,
        recordingBytes: f.seed.recordingBytes, recordingDevice: f.seed.recordingDevice,
        recordingInode: f.seed.recordingInode, fault() {
          tombstone = path.join(path.dirname(f.recordingPath), readdirSync(path.dirname(f.recordingPath))
            .find((name) => name.startsWith(".recording-delete-seed-"))!);
          detachedOriginal = `${tombstone}.owned`;
          renameSync(tombstone, detachedOriginal);
          if (replacement === "file") writeFileSync(tombstone, Buffer.from("replacement"));
          else mkdirSync(tombstone);
        } }), /identity|size|changed/i, replacement);
      assert.equal(existsSync(tombstone), true, replacement);
      assert.equal(existsSync(detachedOriginal), true, replacement);
    } finally { f.close(); }
  }
});

test("seed cleanup rejects changed size, inode, symlink and configured-root move without deleting evidence", () => {
  for (const mutation of ["size", "inode", "symlink", "root_move"] as const) {
    const f = harness();
    try {
      const original = `${f.recordingPath}.original`;
      let recordingsDir = path.dirname(f.recordingPath);
      if (mutation === "size") writeFileSync(f.recordingPath, Buffer.from("changed-ciphertext-size"));
      if (mutation === "inode" || mutation === "symlink") {
        renameSync(f.recordingPath, original);
        if (mutation === "inode") writeFileSync(f.recordingPath, Buffer.from("synthetic-ciphertext"));
        else symlinkSync(original, f.recordingPath);
      }
      if (mutation === "root_move") {
        recordingsDir = path.join(f.dir, "moved-recordings");
        mkdirSync(recordingsDir);
      }
      assert.throws(() => deleteSeedRecordingEvidence({ recordingsDir,
        recordingPath: f.seed.recordingPath, recordingHandle: f.seed.capability.recordingHandle,
        recordingBytes: f.seed.recordingBytes, recordingDevice: f.seed.recordingDevice,
        recordingInode: f.seed.recordingInode }), /identity|size|root|outside|direct child|symlink/i, mutation);
      assert.equal(existsSync(f.recordingPath), true, mutation);
      if (mutation === "inode" || mutation === "symlink") assert.equal(existsSync(original), true, mutation);
    } finally { f.close(); }
  }
});

test("outbox reconciliation reports blocked seed cleanup through the existing maintenance status", () => {
  const f = harness();
  try {
    f.store.stopDueBackfill({ nowMs: f.seed.stopAtMs });
    writeFileSync(f.recordingPath, Buffer.from("changed-ciphertext-size"));
    const outboxDir = path.join(f.dir, "outbox"), receiptsDir = path.join(f.dir, "receipts");
    mkdirSync(outboxDir); mkdirSync(receiptsDir);
    const failures: string[] = [];
    const worker = createOutboxWorker({ recordingsDir: path.dirname(f.recordingPath), outboxDir, receiptsDir,
      journal: f.store, clock: { now: () => f.seed.expiresAtMs }, random: () => 0,
      session: { state: () => "failed", publish: () => undefined },
      reconciliationEvidence: { purgeExpiredReconciliationEvidence: () => 0 },
      onMaintenanceFailure: (reason) => failures.push(reason),
    });
    assert.doesNotThrow(() => worker.reconcile());
    assert.deepEqual(failures, ["backfill_seed_cleanup_failed"]);
    assert.equal(existsSync(f.recordingPath), true);
  } finally { f.close(); }
});

test("seed warning identity compares code and detail values independent of object insertion order", () => {
  const f = harness({ processingWarning: { detail: "One bounded synthetic gap.", code: "capture_gap" } });
  try {
    const claim = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1, claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    const exact = artifact(f.seed, 1, false);
    const changedCode = parseSupportedTeamMemMeetingArtifact({ ...exact,
      processing_warnings: [{ code: "different_code", detail: "One bounded synthetic gap." }] });
    const changedDetail = parseSupportedTeamMemMeetingArtifact({ ...exact,
      processing_warnings: [{ code: "capture_gap", detail: "Changed detail." }] });
    assert.throws(() => f.store.savePending(delivery(f.seed, changedCode, f.recordingPath), initialAuthority(claim.claimToken)), /warning/i);
    assert.throws(() => f.store.savePending(delivery(f.seed, changedDetail, f.recordingPath), initialAuthority(claim.claimToken)), /warning/i);
    assert.equal(f.store.savePending(delivery(f.seed, exact, f.recordingPath), initialAuthority(claim.claimToken)).kind, "inserted");
  } finally { f.close(); }
});

test("two SQLite handles preserve a reserved retry revision across stale reclaim and fence the old token", () => {
  const f = harness();
  try {
    const initial = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1, claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    f.store.savePending(delivery(f.seed, artifact(f.seed, 1, false), f.recordingPath), initialAuthority(initial.claimToken));
    const other = openSessionStore({ filename: f.filename });
    try {
      const first = f.store.claimBackfillJob({ nowMs: ENDED_AT_MS + 2, claimToken: "b".repeat(32), operationBudgetMs: 1_000 })!;
      assert.equal(first.targetRevision, 2);
      assert.equal(first.claimExpiresAtMs, ENDED_AT_MS + 61_002);
      assert.equal(other.claimBackfillJob({ nowMs: ENDED_AT_MS + 3, claimToken: "c".repeat(32), operationBudgetMs: 1_000 }), null);
      const reclaimed = other.claimBackfillJob({ nowMs: first.claimExpiresAtMs, claimToken: "c".repeat(32), operationBudgetMs: 1_000 })!;
      assert.equal(reclaimed.targetRevision, 2);
      const complete = delivery(f.seed, artifact(f.seed, 2, true), f.recordingPath);
      assert.throws(() => f.store.savePending(complete, { kind: "retry", claimToken: first.claimToken, targetRevision: 2, nowMs: first.claimExpiresAtMs }), /claim|token|stale/i);
      assert.equal(other.savePending(complete, { kind: "retry", claimToken: reclaimed.claimToken, targetRevision: 2, nowMs: first.claimExpiresAtMs }).kind, "inserted");
    } finally { other.close(); }
  } finally { f.close(); }
});

test("canonical intent replays persisted bytes without a token but never replays a tombstone or conflicting bytes", () => {
  const f = harness();
  try {
    const claim = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1, claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    const row = delivery(f.seed, artifact(f.seed, 1, false), f.recordingPath);
    f.store.savePending(row, initialAuthority(claim.claimToken));
    const replay = f.store.savePending({ ...row, stageToken: "0".repeat(32) });
    assert.equal(replay.kind, "replay");
    assert.equal(replay.row.stageToken, "f".repeat(32));
    assert.throws(() => f.store.savePending({ ...row, recoveryArtifact: `${row.recoveryArtifact} ` }), /canonical|immutable|conflict/i);
    const raw = new Database(f.filename);
    try { raw.prepare("UPDATE delivery_journal SET deleted_at_ms=? WHERE occurrence_id=? AND revision=1").run(f.seed.endedAtMs + 1, f.seed.occurrenceId); }
    finally { raw.close(); }
    assert.throws(() => f.store.savePending(row), /deleted|cleanup|tombstone/i);
  } finally { f.close(); }
});

test("job claims require a live delivery lifecycle while replay survives only a mere build stop", () => {
  for (const lifecycle of ["stopped", "cleanup_claimed", "deleted"] as const) {
    const f = harness();
    try {
      const initial = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1, claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
      const row = delivery(f.seed, artifact(f.seed, 1, false), f.recordingPath);
      f.store.savePending(row, initialAuthority(initial.claimToken));
      const raw = new Database(f.filename);
      try {
        if (lifecycle === "cleanup_claimed") {
          raw.prepare(`UPDATE backfill_seed_lifecycle SET owner='seed',state='cleanup_claimed',
            cleanup_claim_token=?,cleanup_claim_expires_at_ms=? WHERE occurrence_id=?`)
            .run("c".repeat(32), f.seed.stopAtMs + 30_000, f.seed.occurrenceId);
        } else if (lifecycle === "deleted") {
          raw.prepare("UPDATE backfill_seed_lifecycle SET state='deleted',deleted_at_ms=? WHERE occurrence_id=?")
            .run(ENDED_AT_MS + 2, f.seed.occurrenceId);
        } else {
          raw.prepare("UPDATE backfill_seed_lifecycle SET state='stopped' WHERE occurrence_id=?").run(f.seed.occurrenceId);
        }
      } finally { raw.close(); }
      const reopened = openSessionStore({ filename: f.filename });
      try {
        assert.equal(reopened.claimBackfillJob({ nowMs: ENDED_AT_MS + 2, claimToken: "b".repeat(32), operationBudgetMs: 1_000 }), null, lifecycle);
        if (lifecycle === "stopped") assert.equal(reopened.savePending(row).kind, "replay");
        else assert.throws(() => reopened.savePending(row), /cleanup|deleted|lifecycle/i, lifecycle);
      } finally { reopened.close(); }
    } finally { f.close(); }
  }
});

test("backfill job schema rejects a completion hash with any non-hex suffix", () => {
  const f = harness();
  try {
    const initial = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1, claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    f.store.savePending(delivery(f.seed, artifact(f.seed, 1, false), f.recordingPath), initialAuthority(initial.claimToken));
    const raw = new Database(f.filename);
    try {
      const update = raw.prepare(`UPDATE backfill_jobs SET state='complete',target_revision=1,
        completion_revision=1,completion_artifact_hash=? WHERE occurrence_id=?`);
      assert.throws(() => update.run(`sha256:${"a".repeat(63)}g`, f.seed.occurrenceId), /constraint/i);
      assert.equal(update.run(`sha256:${"a".repeat(64)}`, f.seed.occurrenceId).changes, 1);
    } finally { raw.close(); }
  } finally { f.close(); }
});

test("partial publication stays valid while only a locally known complete receipt converges the job on first accept and replay", () => {
  const f = harness();
  try {
    const initial = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1, claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    const partial = delivery(f.seed, artifact(f.seed, 1, false), f.recordingPath);
    f.store.savePending(partial, initialAuthority(initial.claimToken));
    const retry = f.store.claimBackfillJob({ nowMs: ENDED_AT_MS + 2, claimToken: "b".repeat(32), operationBudgetMs: 1_000 })!;
    const complete = delivery(f.seed, artifact(f.seed, retry.targetRevision, true), f.recordingPath);
    f.store.savePending(complete, { kind: "retry", claimToken: retry.claimToken, targetRevision: retry.targetRevision, nowMs: ENDED_AT_MS + 2 });
    // Model an older interrupted implementation that rebuilt after a complete
    // intent but before its receipt. D016 requires the lower complete receipt
    // to end retry work even though a higher partial revision is now known.
    const interrupted = new Database(f.filename);
    try { interrupted.prepare("UPDATE backfill_jobs SET state='due',target_revision=NULL,next_attempt_at_ms=?").run(ENDED_AT_MS + 3); }
    finally { interrupted.close(); }
    const higherClaim = f.store.claimBackfillJob({ nowMs: ENDED_AT_MS + 3, claimToken: "c".repeat(32), operationBudgetMs: 1_000 })!;
    const higherPartial = delivery(f.seed, artifact(f.seed, higherClaim.targetRevision, false), f.recordingPath);
    f.store.savePending(higherPartial, { kind: "retry", claimToken: higherClaim.claimToken,
      targetRevision: higherClaim.targetRevision, nowMs: ENDED_AT_MS + 3 });
    f.coordinator.advance(f.seed.occurrenceId, "awaiting_teammem");

    const accept = (row: DeliveryRow) => f.store.acceptPublication({
      occurrenceId: row.occurrenceId,
      revision: row.revision,
      artifactHash: row.artifactHash,
      publishedAtMs: ENDED_AT_MS + row.revision + 10,
      publicationUrl: `https://example.test/-/blob/${"a".repeat(40)}/meeting-${row.revision}.md`,
      vaultCommit: "a".repeat(40),
      notification: { terminalReason: "organizer_unresolved" },
    });
    accept(higherPartial);
    let raw = new Database(f.filename, { readonly: true });
    try { assert.equal((raw.prepare("SELECT state FROM backfill_jobs").get() as { state: string }).state, "due"); }
    finally { raw.close(); }
    accept(complete);
    accept(complete);
    raw = new Database(f.filename, { readonly: true });
    try {
      assert.deepEqual(raw.prepare("SELECT state,completion_revision AS revision,completion_artifact_hash AS hash FROM backfill_jobs").get(), {
        state: "complete", revision: complete.revision, hash: complete.artifactHash,
      });
      assert.deepEqual(raw.prepare("SELECT count(*) AS count FROM notification_intents").get(), { count: 2 });
    } finally { raw.close(); }
    const writable = new Database(f.filename);
    try { assert.throws(() => writable.prepare("UPDATE backfill_jobs SET state='due',completion_revision=NULL,completion_artifact_hash=NULL,target_revision=NULL").run(), /monotonic/i); }
    finally { writable.close(); }
  } finally { f.close(); }
});

test("seed handoff rolls back if ciphertext size changes at the final delivery identity fence", () => {
  let checkpointCalls = 0;
  const f = harness({ deliveryIdentityCheckpoint(recordingPath) {
    checkpointCalls += 1;
    writeFileSync(recordingPath, Buffer.from("synthetic-ciphertext-grown"));
  } });
  try {
    const claim = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1, claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    assert.throws(() => f.store.savePending(delivery(f.seed, artifact(f.seed, 1, false), f.recordingPath), initialAuthority(claim.claimToken)), /identity|size|changed/i);
    assert.equal(checkpointCalls, 1);
    const raw = new Database(f.filename, { readonly: true });
    try {
      assert.deepEqual(raw.prepare("SELECT owner,state FROM backfill_seed_lifecycle").get(), { owner: "seed", state: "pending" });
      assert.deepEqual(raw.prepare("SELECT count(*) AS count FROM delivery_journal").get(), { count: 0 });
      assert.deepEqual(raw.prepare("SELECT count(*) AS count FROM backfill_jobs").get(), { count: 0 });
    } finally { raw.close(); }
  } finally { f.close(); }
});

test("stop and cleanup-claim transactions fence a late initial handoff without creating delivery or job state", () => {
  for (const state of ["stopped", "cleanup_claimed"] as const) {
    const f = harness();
    try {
      const claim = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1, claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
      const raw = new Database(f.filename);
      try {
        if (state === "stopped") {
          assert.equal(f.store.claimBackfillSeedBuild({ nowMs: f.seed.stopAtMs, claimToken: "b".repeat(32), operationBudgetMs: 1_000 }), null);
        } else {
          raw.prepare(`UPDATE backfill_seed_lifecycle
            SET state='cleanup_claimed',build_claim_token=NULL,build_claim_expires_at_ms=NULL,
                cleanup_claim_token=?,cleanup_claim_expires_at_ms=? WHERE occurrence_id=?`)
            .run("c".repeat(32), f.seed.stopAtMs + 30_000, f.seed.occurrenceId);
        }
      } finally { raw.close(); }
      assert.throws(() => f.store.savePending(delivery(f.seed, artifact(f.seed, 1, false), f.recordingPath),
        initialAuthority(claim.claimToken, state === "stopped" ? f.seed.stopAtMs : ENDED_AT_MS + 2)), /stop|deleted|lifecycle|claim/i);
      const check = new Database(f.filename, { readonly: true });
      try {
        assert.deepEqual(check.prepare("SELECT count(*) AS count FROM delivery_journal").get(), { count: 0 });
        assert.deepEqual(check.prepare("SELECT count(*) AS count FROM backfill_jobs").get(), { count: 0 });
      } finally { check.close(); }
    } finally { f.close(); }
  }
});

test("outbox crash replay materializes READY from the persisted canonical row without a new build token", () => {
  const f = harness();
  try {
    const outboxDir = path.join(f.dir, "outbox");
    const receiptsDir = path.join(f.dir, "receipts");
    mkdirSync(receiptsDir);
    const value = artifact(f.seed, 1, false);
    const serialized = canonicalArtifactJson(value);
    const hash = canonicalArtifactHash(value);
    const claim = f.store.claimBackfillSeedBuild({ nowMs: ENDED_AT_MS + 1, claimToken: "a".repeat(32), operationBudgetMs: 1_000 })!;
    const worker = createOutboxWorker({
      recordingsDir: path.dirname(f.recordingPath), outboxDir, receiptsDir, journal: f.store,
      clock: { now: () => ENDED_AT_MS + 1 }, random: () => 0,
      session: { state: () => "finalizing", publish: () => undefined },
      reconciliationEvidence: { purgeExpiredReconciliationEvidence: () => 0 },
    });
    const bundle = worker.enqueue({ artifact: value, serializedArtifact: serialized, artifactHash: hash,
      recordingPath: f.recordingPath, backfillAuthority: initialAuthority(claim.claimToken) });
    const originalToken = f.store.pending()[0]!.stageToken;
    rmSync(bundle, { recursive: true });
    assert.equal(worker.enqueue({ artifact: value, serializedArtifact: serialized, artifactHash: hash, recordingPath: f.recordingPath }), bundle);
    assert.equal(f.store.pending()[0]!.stageToken, originalToken);
    assert.equal(readFileSync(path.join(bundle, "meeting.json"), "utf8"), serialized);
  } finally { f.close(); }
});

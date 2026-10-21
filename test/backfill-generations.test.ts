// One publication from every bridge generation of a recovered meeting: one
// transcript from each generation's own recording, the real gaps between
// generations clamped to the meeting window, one audio file with a warning
// naming the others, and publication even when no generation saw the end.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { RecordingAlignmentEntry, RecordingAlignmentPage } from "@conversation/runtime";

import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import type { PostmeetingRuntime } from "../src/adapters/conversation-runtime-client.ts";
import { parseSupportedTeamMemMeetingArtifact } from "../src/contracts/teammem-meeting-v2.ts";
import { createBackfillWorker, type BackfillGatewayTransport } from "../src/delivery/backfill-worker.ts";
import { createOutboxWorker } from "../src/delivery/outbox-worker.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import type { BackfillSeedConfig, SessionStore } from "../src/ports/session-store.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { ALIGNMENT_POLICY } from "../src/sessions/recording-alignment.ts";

const seedConfig: BackfillSeedConfig = { provider: "feishu", encryption: "aes-256-gcm", processingWarnings: [], provenance: {
  runtimeProfile: "online", sttProvider: "stt", sttModel: "stt-v1", liveStreamModel: "live-v1",
  finalBatchModel: "final-v1", textProvider: "text", textModel: "text-v1", agentVersion: "test" } };

type Generation = { readonly bridgeSessionId: string; readonly runtimeSessionId: bigint; readonly handle: string; readonly path: string;
  readonly sha256: string; readonly capability: { sourceSessionId: bigint; recordingHandle: string; sha256: string; keyId: string; authorization: string };
  readonly wallStartMs: number; readonly durationMs: number };

/** Live evidence, a closed timed binding and a selected alignment for one generation. */
function recordGeneration(store: SessionStore, occurrenceId: string, recordingsDir: string, index: number, wallStartMs: number, durationMs: number, person: string): Generation {
  const bridgeSessionId = `bridge-${index}`, runtimeSessionId = BigInt(40 + index);
  const handle = String(index).repeat(32), keyId = "c".repeat(16);
  const bytes = Buffer.from(`ciphertext-${index}`), sha256 = createHash("sha256").update(bytes).digest("hex");
  const recordingPath = path.join(recordingsDir, `${handle}.crsr`);
  writeFileSync(recordingPath, bytes);
  store.beginReconciliationGeneration(occurrenceId, bridgeSessionId, wallStartMs);
  store.setReconciliationRuntimeSession(occurrenceId, bridgeSessionId, runtimeSessionId);
  const binding = { occurrenceId, bridgeSessionId, runtimeSessionId };
  const timed = store.beginTimedEvidence(binding, wallStartMs);
  store.appendTimedUi(timed, { schema: "bridge-session/v2", sessionId: bridgeSessionId, sequence: 1, observedAt: new Date(wallStartMs).toISOString(),
    type: "participant_joined", feishuUserId: person, displayName: person, observationTiming: null, observationTimingReason: "timing_unavailable" }, wallStartMs + 1);
  store.closeTimedEvidence(timed, wallStartMs + durationMs);
  return { bridgeSessionId, runtimeSessionId, handle, path: recordingPath, sha256,
    capability: { sourceSessionId: runtimeSessionId, recordingHandle: handle, sha256, keyId, authorization: "d".repeat(64) }, wallStartMs, durationMs };
}

function selectAlignment(store: SessionStore, occurrenceId: string, generation: Generation): void {
  const recovery = store.getRecordingRecovery(occurrenceId, generation.bridgeSessionId, generation.handle)!;
  const source = { sourceSessionId: generation.runtimeSessionId, recordingHandle: generation.handle, sha256: generation.sha256 };
  const epoch = { bridgeSessionId: generation.bridgeSessionId, clockDomainId: "clock", captureEpoch: 1n };
  const frame: Extract<RecordingAlignmentEntry, { kind: "frame" }> = { kind: "frame", mediaStartSample: 0n, mediaEndSample: 480n, sampleRateHz: 24_000,
    gapOffsetMs: 0n, epoch, captureStatus: "available", reasons: [],
    provenance: { captureEpoch: 1n, sequence: 1n, outputStartSample: 0n, sampleCount: 480, sourceStartNumerator: 0n, sourceEndNumerator: 11_520_000n,
      sourceDenominator: 24_000, sourceRateHz: 24_000, quality: "nominal_frame_endpoint_interpolation",
      span: { hostStartNs: 1_000_000_000n, hostEndNs: 1_020_000_000n, roundingEnvelopeNs: 1n, captureUncertaintyNs: null } },
    wall: { quality: "local_wall_estimate", policyId: "local-wall-estimate/v1", localStartNs: BigInt(generation.wallStartMs) * 1_000_000n,
      localEndNs: BigInt(generation.wallStartMs + 20) * 1_000_000n, wallEpoch: 1n, wallRun: 1n, maximumBracketNs: 1n, maximumResolutionNs: 1n,
      modelAllowanceNs: 10_000_000n, interpolationRoundingNs: 1n, captureRoundingNs: 1n, captureUncertaintyNs: null, externalUtcAccuracyNs: null,
      overallPhysicalAccuracyNs: null } };
  const alignment = store.beginRecordingAlignment(recovery.generationId, "fixture");
  if (alignment.kind !== "claimed") throw new Error("fixture alignment already selected");
  const page: RecordingAlignmentPage = { type: "recording_alignment_page", source, pageIndex: 0n, policy: ALIGNMENT_POLICY, entries: [{ kind: "epoch", epoch }, frame] };
  store.appendRecordingAlignment(alignment.attempt, page);
  store.completeRecordingAlignment(alignment.attempt, { type: "recording_alignment_complete", source, pageCount: 1n,
    coverageStatus: "available", warnings: ["local_wall_timestamp_estimate"], traversalSucceeded: true });
}

function recordingInput(generation: Generation, gaps: readonly { direction: "capture" | "playback"; startedAt: string; endedAt: string | null }[]) {
  return { recovery: { bridgeSessionId: generation.bridgeSessionId, capability: generation.capability }, handle: generation.handle,
    encryptedPath: generation.path, sha256: generation.sha256, durationMs: generation.durationMs, format: "pcm_s16le/24000/1/20ms",
    keyId: generation.capability.keyId, gaps: [...gaps], runtimeGaps: [] };
}

async function buildOnce(store: SessionStore, dirs: { recordingsDir: string; outboxDir: string; receiptsDir: string }, wall: number, silent: readonly string[] = []) {
  const outbox = createOutboxWorker({ ...dirs, journal: store, clock: { now: () => wall }, random: () => 0,
    session: { state: (occurrenceId) => store.getSession(occurrenceId)?.state ?? null, publish: () => assert.fail("atomic store owns publication") },
    reconciliationEvidence: store });
  const reconciled: string[] = [];
  const worker = createBackfillWorker({ store, outbox, gatewayPath: "/synthetic/gateway", configPath: "/synthetic/config.json",
    env: { PATH: "/usr/bin:/bin" }, operationBudgetMs: 1_000, cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 },
    clock: { now: () => wall, monotonicNow: () => 1 }, random: () => 0, readKnownProjects: () => [],
    startTransport: async () => ({ cleanupOutcome: { status: "graceful" as const },
      messages: { async *[Symbol.asyncIterator]() { /* unused */ } }, async send() {}, async close() {} }) as BackfillGatewayTransport,
    connectRuntime: async () => ({ currentSessionId: 99n, runtimeProfile: "online",
      readRecordingAlignment() { throw new Error("selected alignment must replay without a new Runtime read"); },
      async reconcileFinalizedRecording({ capability }: { capability: { recordingHandle: string; sourceSessionId: bigint; sha256: string } }) {
        reconciled.push(capability.recordingHandle);
        // Each recording's own words: generation n's handle is the digit n repeated.
        return { source: { sourceSessionId: capability.sourceSessionId, recordingHandle: capability.recordingHandle, sha256: capability.sha256 },
          segments: silent.includes(capability.recordingHandle) ? [] : [{ segmentId: "s1", startedAtMs: 0n, endedAtMs: 20n, text: `words of generation ${capability.recordingHandle[0]}`, speakerCluster: "cluster-1",
            mediaSampleRange: { startSampleInclusive: 0n, endSampleExclusive: 480n, sampleRateHz: 24_000, gapOffsetMs: 0n, quantizationPolicy: "provider_seconds_outward_samples/v1" } }],
          warnings: [] };
      },
      async processText() { return { output: { summary: "Summary", projects: [], decisions: [], action_items: [], discussion_points: [], person_summaries: [] }, warnings: [] }; },
      async close() {},
    } as unknown as PostmeetingRuntime & { readonly currentSessionId: bigint }) });
  const result = await worker.pollOnce();
  await worker.close();
  if (result.kind !== "enqueued") throw new Error(`build was not enqueued: ${JSON.stringify(result)}`);
  const bundle = result.bundlePath;
  const raw = readFileSync(path.join(bundle, "meeting.json"), "utf8");
  // Optional: keep the produced inbox so TeamMem's own bundle validator can be run on it.
  const evidence = process.env.MEETING_TEAMMEM_EVIDENCE_DIR;
  if (evidence !== undefined) cpSync(dirs.outboxDir, path.join(evidence, path.basename(path.dirname(dirs.outboxDir))), { recursive: true });
  return { artifact: parseSupportedTeamMemMeetingArtifact(JSON.parse(raw)), raw, bundle, reconciled };
}

function fixture(occurrenceStartedAt: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-backfill-generations-"));
  const dirs = { recordingsDir: path.join(dir, "recordings"), outboxDir: path.join(dir, "outbox"), receiptsDir: path.join(dir, "receipts") };
  for (const entry of Object.values(dirs)) mkdirSync(entry);
  const startMs = Date.parse(occurrenceStartedAt);
  const store = openSessionStore({ filename: path.join(dir, "state.db"), nowMs: startMs });
  const identity = buildMeetingIdentity({ providerMeetingId: "generations", meetingNo: "424242", occurrenceStartedAt, title: "Recovered meeting",
    organizer: { feishuUserId: "owner", displayName: "Owner", source: "reservation" } });
  let wall = startMs;
  const coordinator = createCoordinator({ store, clock: { now: () => wall }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 1 });
  coordinator.discover(identity); coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening");
  return { dir, dirs, store, identity, coordinator, startMs, setWall: (value: number) => { wall = value; }, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a recovered meeting publishes one transcript from every generation, the real gap between them clamped to the window, and one audio file with a warning; both validators accept it", async () => {
  const f = fixture("2026-09-02T14:00:00Z");
  try {
    const occurrenceId = f.identity.occurrenceId;
    // Generation 1 started joining before the scheduled start, captured until 14:20, then the bridge failed.
    const first = recordGeneration(f.store, occurrenceId, f.dirs.recordingsDir, 1, f.startMs + 60_000, 1_200_000, "alice");
    f.store.completeReconciliationGeneration(occurrenceId, first.bridgeSessionId, f.startMs + 1_200_000, "local_clock");
    f.setWall(f.startMs + 1_200_000);
    f.coordinator.recordBridgeFailure(occurrenceId, 2, [{ direction: "capture", startedAt: "2026-09-02T14:20:00.000Z", endedAt: null }],
      recordingInput(first, [{ direction: "capture", startedAt: "2026-09-02T14:20:00.000Z", endedAt: null }]));
    // Generation 2 connected media at 14:21, so its transition gap is 14:20 -> 14:21; the meeting ended at 14:30.
    const second = recordGeneration(f.store, occurrenceId, f.dirs.recordingsDir, 2, f.startMs + 1_260_000, 540_000, "bob");
    const endedAt = "2026-09-02T14:30:00.000Z", endedAtMs = Date.parse(endedAt);
    f.setWall(endedAtMs);
    f.coordinator.finalizeWithRecording(occurrenceId, { kind: "advance", toState: "finalizing" },
      recordingInput(second, [{ direction: "capture", startedAt: "2026-09-02T14:20:00.000Z", endedAt: "2026-09-02T14:21:00.000Z" }]),
      second.bridgeSessionId, endedAtMs, "bridge_observed",
      { ...seedConfig, terminalReason: "ended", terminalSource: "bridge_observed", endedAt, identity: f.identity });
    f.store.completeReconciliationGeneration(occurrenceId, second.bridgeSessionId, endedAtMs, "bridge_observed", "ended");
    selectAlignment(f.store, occurrenceId, first); selectAlignment(f.store, occurrenceId, second);

    const { artifact, reconciled } = await buildOnce(f.store, f.dirs, endedAtMs + 1);
    assert.deepEqual(new Set(reconciled), new Set([first.handle, second.handle]), "each generation is reconciled with its own capability");
    assert.deepEqual(artifact.transcript.map((segment) => segment.text), ["words of generation 1", "words of generation 2"]);
    assert.deepEqual(artifact.participants.map((participant) => participant.person_id).sort(), ["alice", "bob"]);
    assert.deepEqual(artifact.recording_gaps.map((gap) => [gap.started_at, gap.ended_at]), [["2026-09-02T14:20:00.000Z", "2026-09-02T14:21:00.000Z"]],
      "only the real gap between generations");
    assert.equal(artifact.audio.sha256, `sha256:${second.sha256}`);
    assert.deepEqual(artifact.processing_warnings.filter(({ code }) => code === "audio_partial_generations"),
      [{ code: "audio_partial_generations", detail: "shipped_generation=2;generations=2" }]);
    assert.equal(artifact.transcript_complete, false, "a failed generation means known capture loss");
  } finally { f.cleanup(); }
});

test("a transition gap that starts before the occurrence start is clamped to the meeting window", async () => {
  const f = fixture("2026-09-02T14:00:00Z");
  try {
    const occurrenceId = f.identity.occurrenceId;
    // The first generation joined at 13:58 and failed at 13:59 without ever capturing.
    const first = recordGeneration(f.store, occurrenceId, f.dirs.recordingsDir, 1, f.startMs - 120_000, 60_000, "alice");
    f.store.completeReconciliationGeneration(occurrenceId, first.bridgeSessionId, f.startMs - 60_000, "local_clock");
    f.coordinator.recordBridgeFailure(occurrenceId, 2, [], recordingInput(first, [{ direction: "capture", startedAt: "2026-09-02T13:58:00.000Z", endedAt: null }]));
    const second = recordGeneration(f.store, occurrenceId, f.dirs.recordingsDir, 2, f.startMs + 60_000, 600_000, "bob");
    const endedAt = "2026-09-02T14:11:00.000Z", endedAtMs = Date.parse(endedAt);
    f.setWall(endedAtMs);
    // The session clamps its transition gap at the occurrence start.
    f.coordinator.finalizeWithRecording(occurrenceId, { kind: "advance", toState: "finalizing" },
      recordingInput(second, [{ direction: "capture", startedAt: "2026-09-02T14:00:00Z", endedAt: "2026-09-02T14:01:00.000Z" }]),
      second.bridgeSessionId, endedAtMs, "bridge_observed",
      { ...seedConfig, terminalReason: "ended", terminalSource: "bridge_observed", endedAt, identity: f.identity });
    f.store.completeReconciliationGeneration(occurrenceId, second.bridgeSessionId, endedAtMs, "bridge_observed", "ended");
    selectAlignment(f.store, occurrenceId, first); selectAlignment(f.store, occurrenceId, second);
    const { artifact } = await buildOnce(f.store, f.dirs, endedAtMs + 1, [first.handle]);
    for (const gap of artifact.recording_gaps) assert.ok(Date.parse(gap.started_at) >= f.startMs, "inside the window");
    assert.deepEqual(artifact.recording_gaps.map((gap) => [gap.started_at, gap.ended_at]), [["2026-09-02T14:00:00Z", "2026-09-02T14:01:00.000Z"]]);
  } finally { f.cleanup(); }
});

test("when no generation saw the end, the stored generations are still published: the longest recording ships and the end is the end of capture", async () => {
  const f = fixture("2026-09-02T14:00:00Z");
  try {
    const occurrenceId = f.identity.occurrenceId;
    const first = recordGeneration(f.store, occurrenceId, f.dirs.recordingsDir, 1, f.startMs + 60_000, 1_200_000, "alice");
    f.store.completeReconciliationGeneration(occurrenceId, first.bridgeSessionId, f.startMs + 1_260_000, "local_clock");
    f.coordinator.recordBridgeFailure(occurrenceId, 2, [], recordingInput(first, [{ direction: "capture", startedAt: "2026-09-02T14:21:00.000Z", endedAt: null }]), true);
    const second = recordGeneration(f.store, occurrenceId, f.dirs.recordingsDir, 2, f.startMs + 1_320_000, 120_000, "bob");
    f.store.completeReconciliationGeneration(occurrenceId, second.bridgeSessionId, f.startMs + 1_440_000, "local_clock");
    const secondGaps = [{ direction: "capture" as const, startedAt: "2026-09-02T14:21:00.000Z", endedAt: "2026-09-02T14:22:00.000Z" },
      { direction: "capture" as const, startedAt: "2026-09-02T14:24:00.000Z", endedAt: null }];
    f.coordinator.recordBridgeFailure(occurrenceId, 2, secondGaps, recordingInput(second, secondGaps), true);
    assert.equal(f.store.getSession(occurrenceId)?.state, "listening");
    const published = f.store.publishStoredGenerations({ occurrenceId, nowMs: f.startMs + 1_500_000, reason: "bridge_recovery_failed",
      seed: { ...seedConfig, identity: f.identity } });
    assert.deepEqual(published, { attempt: 1, endedAt: "2026-09-02T14:24:00.000Z", generations: 2 }, "the longest generation ships");
    assert.equal(f.store.getSession(occurrenceId)?.state, "finalizing");
    selectAlignment(f.store, occurrenceId, first); selectAlignment(f.store, occurrenceId, second);
    const { artifact } = await buildOnce(f.store, f.dirs, f.startMs + 1_500_001);
    assert.equal(artifact.ended_at, "2026-09-02T14:24:00.000Z");
    assert.equal(artifact.audio.sha256, `sha256:${first.sha256}`);
    assert.deepEqual(artifact.transcript.map((segment) => segment.text), ["words of generation 1", "words of generation 2"]);
    assert.deepEqual(artifact.recording_gaps.map((gap) => [gap.started_at, gap.ended_at]), [["2026-09-02T14:21:00.000Z", "2026-09-02T14:22:00.000Z"]]);
    assert.deepEqual(artifact.processing_warnings.filter(({ code }) => code === "meeting_end_unobserved" || code === "audio_partial_generations"), [
      { code: "meeting_end_unobserved", detail: "bridge_recovery_failed" },
      { code: "audio_partial_generations", detail: "shipped_generation=1;generations=2" }]);
  } finally { f.cleanup(); }
});

test("nothing recorded means nothing to publish: the row is left for the caller to fail", () => {
  const f = fixture("2026-09-02T14:00:00Z");
  try {
    f.coordinator.recordBridgeFailure(f.identity.occurrenceId, 0, [], null, true);
    assert.equal(f.store.publishStoredGenerations({ occurrenceId: f.identity.occurrenceId, nowMs: f.startMs + 1, reason: "bridge_failure_exhausted",
      seed: { ...seedConfig, identity: f.identity } }), null);
    assert.equal(f.store.getSession(f.identity.occurrenceId)?.state, "listening");
  } finally { f.cleanup(); }
});

test("when no generation saw the end, the last generation's capture loss runs to the published end", async () => {
  const f = fixture("2026-09-02T14:00:00Z");
  try {
    const occurrenceId = f.identity.occurrenceId;
    // Generation 1 captured 14:01-14:21 and failed.
    const first = recordGeneration(f.store, occurrenceId, f.dirs.recordingsDir, 1, f.startMs + 60_000, 1_200_000, "alice");
    f.store.completeReconciliationGeneration(occurrenceId, first.bridgeSessionId, f.startMs + 1_260_000, "local_clock");
    const firstGaps = [{ direction: "capture" as const, startedAt: "2026-09-02T14:21:00.000Z", endedAt: null }];
    f.coordinator.recordBridgeFailure(occurrenceId, 1, firstGaps, recordingInput(first, firstGaps), true);
    // Generation 2 joined at 14:22, never connected media, and failed at 14:40; the retries are spent.
    const second = recordGeneration(f.store, occurrenceId, f.dirs.recordingsDir, 2, f.startMs + 1_320_000, 0, "bob");
    f.store.completeReconciliationGeneration(occurrenceId, second.bridgeSessionId, f.startMs + 2_400_000, "local_clock");
    const secondGaps = [{ direction: "capture" as const, startedAt: "2026-09-02T14:21:00.000Z", endedAt: null }];
    f.coordinator.recordBridgeFailure(occurrenceId, 1, secondGaps, recordingInput(second, secondGaps), true);
    const published = f.store.publishStoredGenerations({ occurrenceId, nowMs: f.startMs + 2_500_000, reason: "bridge_failure_exhausted",
      seed: { ...seedConfig, identity: f.identity } });
    assert.equal(published?.endedAt, "2026-09-02T14:40:00.000Z");
    selectAlignment(f.store, occurrenceId, first); selectAlignment(f.store, occurrenceId, second);
    const { artifact } = await buildOnce(f.store, f.dirs, f.startMs + 2_500_001, [second.handle]);
    assert.deepEqual(artifact.recording_gaps.map((gap) => [gap.started_at, gap.ended_at]), [["2026-09-02T14:21:00.000Z", "2026-09-02T14:40:00.000Z"]],
      "the 19 minutes after the first generation's loss are reported");
  } finally { f.cleanup(); }
});

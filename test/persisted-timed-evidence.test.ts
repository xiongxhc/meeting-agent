import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import * as reconciler from "../src/sessions/speaker-reconciler.ts";
import { ALIGNMENT_POLICY } from "../src/sessions/recording-alignment.ts";
import { runtimeTestClient, testCapability } from "./lib/runtime-sdk.ts";
import type { RecordingAlignmentEntry, RecordingAlignmentPage } from "@conversation/runtime";
import type { BridgeEventMessageV2 } from "../src/contracts/bridge-session-v2.ts";
import type { TimedEvidenceStatus, RecordingInput } from "../src/ports/session-store.ts";
import * as builder from "../src/delivery/artifact-builder.ts";
import { canonicalArtifactHash, parseTeamMemMeetingArtifact } from "../src/contracts/teammem-meeting-v1.ts";
import * as publicApi from "../src/application.ts";
import { createOwnedTimedSampleEvidence } from "../src/domain/attribution-evidence.ts";

function fixture(options: { active?: boolean; uiLoss?: NonNullable<TimedEvidenceStatus["uiLossReason"]>; gaps?: RecordingInput["gaps"]; failed?: boolean;
  frames?: number; admins?: number } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-final-timed-")), filename = path.join(dir, "state.db");
  const store = openSessionStore({ filename });
  const identity = buildMeetingIdentity({ providerMeetingId: "synthetic", meetingNo: "000000000", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Synthetic", organizer: null });
  const coordinator = createCoordinator({ store, clock: { now: () => 1000 }, bridgeLeaseTtlMs: 30000, maxConcurrentSessions: 1 });
  coordinator.discover(identity); coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening");
  const binding = { occurrenceId: identity.occurrenceId, bridgeSessionId: "bridge", runtimeSessionId: 41n };
  store.beginReconciliationGeneration(binding.occurrenceId, binding.bridgeSessionId, 1000);
  store.setReconciliationRuntimeSession(binding.occurrenceId, binding.bridgeSessionId, 41n);
  const owner = store.beginTimedEvidence(binding, 1000);
  const epoch = { bridgeSessionId: "bridge", clockDomainId: "domain", captureEpoch: 1n };
  const frame: Extract<RecordingAlignmentEntry, { kind: "frame" }> = { kind: "frame", mediaStartSample: 0n, mediaEndSample: 480n,
    sampleRateHz: 24000, gapOffsetMs: 0n, epoch, captureStatus: "available", reasons: [],
    provenance: { captureEpoch: 1n, sequence: 1n, outputStartSample: 0n, sampleCount: 480, sourceStartNumerator: 0n,
      sourceEndNumerator: 11520000n, sourceDenominator: 24000, sourceRateHz: 24000, quality: "nominal_frame_endpoint_interpolation",
      span: { hostStartNs: 1000000000n, hostEndNs: 1020000000n, roundingEnvelopeNs: 1n, captureUncertaintyNs: null } },
    wall: { quality: "local_wall_estimate", policyId: "local-wall-estimate/v1", localStartNs: 1788357600000000000n,
      localEndNs: 1788357600020000000n, wallEpoch: 1n, wallRun: 1n, maximumBracketNs: 1n, maximumResolutionNs: 1n,
      modelAllowanceNs: 10000000n, interpolationRoundingNs: 1n, captureRoundingNs: 1n, captureUncertaintyNs: null,
      externalUtcAccuracyNs: null, overallPhysicalAccuracyNs: null } };
  const common = { schema: "bridge-session/v2" as const, sessionId: "bridge", observedAt: "2026-09-02T14:00:00Z" };
  const events: BridgeEventMessageV2[] = [{ ...common, sequence: 1, type: "participant_joined", feishuUserId: "person", displayName: "Person",
    observationTiming: { clockDomainId: "domain", hostBeforeNs: "1", hostAfterNs: "2" }, observationTimingReason: null }];
  for (let i = 0; i < (options.admins ?? 0); i++) events.push({ ...common, sequence: i + 2, type: "command_result", commandId: `command-${i}`, outcome: "ok", detail: null });
  for (const [index, before] of [900000000n, 990000000n, 1020000000n].entries()) events.push({ ...common, sequence: index + 2 + (options.admins ?? 0),
    type: "ui_snapshot", snapshotSequence: index + 1, observationTiming: { clockDomainId: "domain", hostBeforeNs: before.toString(), hostAfterNs: (before + 1n).toString() },
    state: index === 0 ? "unknown" : "ui_exact", feishuUserId: index === 0 ? null : "person", reason: index === 0 ? "no_highlight" : null, barrierBefore: null });
  for (const event of events) store.appendTimedUi(owner, event, 1000);
  store.appendTimedFinal(owner, { type: "voice_transcript_final", sessionId: 41n, segmentId: "1", turnId: null, text: "original live words",
    capture: { kind: "source_sample_range/v1", clockDomainId: "domain", captureEpoch: 1n, firstFrameSequence: 1n, lastFrameSequence: 1n,
      sourceStartSample: 0n, sourceEndSample: 480n, sampleRateHz: 24000 } }, 1000);
  store.resolveTimedFinal(owner, "1", { kind: "anonymous", reason: "owner_closed" }, 1000);
  if (options.uiLoss) store.markTimedUiLoss(owner, options.uiLoss, 1000);
  if (!options.active) store.closeTimedEvidence(owner, 1000);
  const recording: RecordingInput = { handle: testCapability.recordingHandle,
    encryptedPath: "/synthetic/audio.enc", sha256: testCapability.sha256, keyId: testCapability.keyId, format: "pcm_s16le/24000/1/20ms", durationMs: 20,
    gaps: options.gaps ?? [], runtimeGaps: [], recovery: { bridgeSessionId: "bridge", capability: testCapability } };
  if (options.failed) store.recordBridgeFailure({ occurrenceId: identity.occurrenceId, nowMs: 1000, maxRetries: 2, gaps: recording.gaps, recording });
  else coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, recording, "bridge");
  const recovery = store.getRecordingRecovery(identity.occurrenceId, "bridge", testCapability.recordingHandle)!;
  const source = { sourceSessionId: 41n, recordingHandle: testCapability.recordingHandle, sha256: testCapability.sha256 };
  const page: RecordingAlignmentPage = { type: "recording_alignment_page", source, pageIndex: 0n, policy: ALIGNMENT_POLICY,
    entries: [{ kind: "epoch", epoch }, frame] };
  const attempt = store.beginRecordingAlignment(recovery.generationId, "fixture-owner"); assert.equal(attempt.kind, "claimed");
  if (attempt.kind !== "claimed") throw new Error("fixture ownership");
  const frames = options.frames ?? 1;
  let pageCount = 0;
  for (let offset = 0; offset < frames; offset += 8) {
    const entries: RecordingAlignmentEntry[] = offset === 0 ? [{ kind: "epoch", epoch }] : [];
    for (let i = offset; i < Math.min(offset + 8, frames); i++) entries.push({ ...frame,
      mediaStartSample: BigInt(i * 480), mediaEndSample: BigInt((i + 1) * 480),
      provenance: { ...frame.provenance!, sequence: BigInt(i + 1), outputStartSample: BigInt(i * 480), sourceStartNumerator: BigInt(i * 11520000),
        sourceEndNumerator: BigInt((i + 1) * 11520000), span: { ...frame.provenance!.span!, hostStartNs: 1000000000n + BigInt(i * 20000000), hostEndNs: 1020000000n + BigInt(i * 20000000) } },
      wall: { ...frame.wall!, localStartNs: frame.wall!.localStartNs + BigInt(i * 20000000), localEndNs: frame.wall!.localEndNs + BigInt(i * 20000000) } });
    store.appendRecordingAlignment(attempt.attempt, { ...page, pageIndex: BigInt(pageCount++), entries });
  }
  const selected = store.completeRecordingAlignment(attempt.attempt, { type: "recording_alignment_complete", source, pageCount: BigInt(pageCount),
    coverageStatus: "available", warnings: ["local_wall_timestamp_estimate"], traversalSucceeded: true });
  return { dir, filename, store, identity, binding, owner, recovery, selected, source, frame, page,
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("reopened final reader binds actual SDK historical capability and selected timed evidence without copying provisional names", async () => {
  const f = fixture(), other = openSessionStore({ filename: f.filename }), { client, transport } = await runtimeTestClient(4, 99n);
  transport.onSend = (command) => {
    if (command.type !== "reconcile_finalized_recording") return;
    assert.equal(command.capability.sourceSessionId, 41n); assert.equal(client.currentSessionId, 99n);
    transport.push({ type: "command_accepted", protocol_version: 4, request_id: command.requestId });
    transport.push({ type: "recording_reconciled", protocol_version: 4, request_id: command.requestId,
      reconciliation: { segments: [{ segment_id: "batch", started_at_ms: "0", ended_at_ms: "20", text: "final authoritative", speaker_cluster: "cluster-1",
        media_sample_range: { start_sample_inclusive: "0", end_sample_exclusive: "480", sample_rate_hz: 24000, gap_offset_ms: "0", quantization_policy: "provider_seconds_outward_samples/v1" } }], warnings: [] } });
  };
  try {
    assert.equal(typeof reconciler.reconcilePersistedTimedSpeakers, "function");
    const result = await reconciler.reconcilePersistedTimedSpeakers({ occurrenceId: f.identity.occurrenceId, bridgeSessionId: "bridge",
      recordingHandle: testCapability.recordingHandle, store: other, runtime: client, nowMs: () => 1001 });
    assert.equal(result.kind, "timed_recording_transcript/v1");
    assert.equal(result.provenance.alignmentAttemptId, f.selected.attemptId);
    assert.deepEqual(result.source, f.source);
    assert.deepEqual(result.segments.map(({ text }) => text), ["final authoritative"]);
    assert.deepEqual(result.segments[0]?.speaker, { kind: "named", feishuUserId: "person" });
    assert.equal(result.transcriptComplete, true);
    assert.equal(other.readTimedFinal(f.binding, "", 1001)?.event.text, "original live words");
    assert.equal(JSON.stringify(result, (_key, v: unknown) => typeof v === "bigint" ? v.toString() : v).includes(testCapability.authorization), false);
  } finally { await client.close(); other.close(); f.close(); }
});

test("unavailable final processing preserves mapped live wording and a bounded static failure, never secret exception text", async () => {
  const f = fixture();
  try {
    const result = await reconciler.reconcilePersistedTimedSpeakers({ occurrenceId: f.identity.occurrenceId, bridgeSessionId: "bridge",
      recordingHandle: testCapability.recordingHandle, store: f.store, nowMs: () => 1001,
      runtime: { async reconcileFinalizedRecording() { throw new Error(testCapability.authorization); } } });
    assert.deepEqual(result.segments.map(({ text }) => text), ["original live words"]);
    assert.ok(result.segments[0]?.wall);
    assert.equal(result.transcriptComplete, false);
    assert.ok(result.warnings.some(({ code, detail }) => code === "timed_final_processing_incomplete" && detail === "final_reconciliation_unavailable"));
    assert.equal(JSON.stringify(result, (_key, v: unknown) => typeof v === "bigint" ? v.toString() : v).includes(testCapability.authorization), false);
  } finally { f.close(); }
});

test("persisted UI-only loss survives reopen without erasing wording or affecting another generation", async () => {
  const lost = fixture({ uiLoss: "ui_sequence_gap" }), good = fixture();
  try {
    for (const [f, expected] of [[lost, "anonymous"], [good, "named"]] as const) {
      const reopened = openSessionStore({ filename: f.filename });
      try {
        const result = await reconciler.reconcilePersistedTimedSpeakers({ occurrenceId: f.identity.occurrenceId, bridgeSessionId: "bridge",
          recordingHandle: testCapability.recordingHandle, store: reopened, nowMs: () => 1001,
          runtime: { async reconcileFinalizedRecording() { return { source: f.source, segments: [{ segmentId: "batch", text: "final words",
            startedAtMs: 0n, endedAtMs: 20n, speakerCluster: "cluster-1", mediaSampleRange: { startSampleInclusive: 0n, endSampleExclusive: 480n,
              sampleRateHz: 24000, gapOffsetMs: 0n, quantizationPolicy: "provider_seconds_outward_samples/v1" } }], warnings: [] }; } } });
        assert.equal(result.segments[0]?.speaker.kind, expected); assert.equal(result.transcriptComplete, true);
      } finally { reopened.close(); }
    }
  } finally { lost.close(); good.close(); }
});

test("final reader refuses active ownership, expiry and selected replacement even after successful RPC", async () => {
  for (const mode of ["active", "expired", "expires_during", "replace", "wrong_source", "cancel"] as const) {
    const f = fixture({ active: mode === "active" });
    const descriptor = f.store.getTimedEvidenceBinding(f.recovery.generationId, 1000);
    assert.equal(descriptor.kind, "timed"); if (descriptor.kind !== "timed") throw new Error("fixture descriptor");
    let now = mode === "expired" ? descriptor.expiresAtMs! : 1001, called = 0;
    const abort = new AbortController(); if (mode === "cancel") abort.abort();
    try {
      await assert.rejects(reconciler.reconcilePersistedTimedSpeakers({ occurrenceId: f.identity.occurrenceId, bridgeSessionId: "bridge",
        recordingHandle: testCapability.recordingHandle, store: f.store, nowMs: () => now, signal: abort.signal,
        runtime: { async reconcileFinalizedRecording() {
          called++;
          if (mode === "expires_during") now = descriptor.expiresAtMs!;
          if (mode === "replace") {
            const next = f.store.beginRecordingAlignment(f.recovery.generationId, "replacement", true);
            assert.equal(next.kind, "claimed"); if (next.kind !== "claimed") throw new Error("fixture claim");
            f.store.appendRecordingAlignment(next.attempt, f.page);
            f.store.completeRecordingAlignment(next.attempt, { type: "recording_alignment_complete", source: f.source, pageCount: 1n,
              coverageStatus: "available", warnings: ["local_wall_timestamp_estimate"], traversalSucceeded: true });
          }
          return { source: { ...f.source, ...(mode === "wrong_source" ? { sha256: "e".repeat(64) } : {}) }, segments: [], warnings: [] };
        } } }), /unavailable|expired|quiescent|changed|cancelled/);
      assert.equal(called, ["active", "expired", "cancel"].includes(mode) ? 0 : 1);
      assert.equal(f.store.readTimedFinal(f.binding, "", 1001)?.event.text, "original live words");
    } finally { f.close(); }
  }
});

test("timed builder uses admitted wall endpoints and historical hash independently of current text control", async () => {
  const f = fixture();
  let calls = 0;
  try {
    const transcript = await reconciler.reconcilePersistedTimedSpeakers({ occurrenceId: f.identity.occurrenceId, bridgeSessionId: "bridge",
      recordingHandle: testCapability.recordingHandle, store: f.store, nowMs: () => 1001,
      runtime: { async reconcileFinalizedRecording() { throw new Error("synthetic unavailable"); } } });
    const input = { identity: f.identity, provider: "feishu", revision: 1, endedAt: "2026-09-02T14:10:00Z",
      attendance: [{ feishuUserId: "person", displayName: "Person", joinedAt: "2026-09-02T14:00:00Z", leftAt: "2026-09-02T14:10:00Z" }],
      transcript, selectedAlignment: f.selected, sessionId: 99n, meetingEnded: true, recordingGaps: [], processingWarnings: [],
      runtime: { async processText(request: { sessionId: bigint; input: string }) {
        calls++; assert.equal(request.sessionId, 99n); assert.match(request.input, /original live words/);
        return { output: { summary: "Synthetic summary", projects: [], decisions: [], action_items: [], discussion_points: [], person_summaries: [] }, warnings: [] };
      } },
      provenance: { runtimeProfile: "online" as const, sttProvider: "synthetic", sttModel: "synthetic", textProvider: "synthetic", textModel: "synthetic",
        agentVersion: "test", processedAt: "2026-09-02T14:11:00Z", finalBatchModel: "synthetic-final", liveStreamModel: "synthetic-live" },
      audio: { format: "pcm_s16le", encryption: "aes-256-gcm", durationSeconds: 0.02, bytes: 1000, sha256: `sha256:${testCapability.sha256}`, expiresAt: "2026-09-16T14:10:00Z" } };
    assert.equal(typeof builder.buildTimedTeamMemMeetingArtifact, "function");
    const built = await builder.buildTimedTeamMemMeetingArtifact(input);
    assert.equal(built.artifact.transcript[0]?.started_at, "2026-09-02T14:00:00.000000Z");
    assert.equal(built.artifact.transcript[0]?.ended_at, "2026-09-02T14:00:00.020000Z");
    assert.equal(built.artifact.transcript[0]?.speaker.kind, "person");
    assert.equal(built.artifact.transcript_complete, false);
    assert.equal(built.artifact_hash, canonicalArtifactHash(parseTeamMemMeetingArtifact(JSON.parse(built.serialized))));
    assert.equal(built.artifact.processing_warnings.filter(({ code }) => code === "local_wall_timestamp_estimate").length, 1);
    for (const changed of [
      { ...input, audio: { ...input.audio, sha256: `sha256:${"e".repeat(64)}` } },
      { ...input, transcript: { ...transcript, source: { ...transcript.source, sourceSessionId: 99n } } },
      { ...input, selectedAlignment: { ...f.selected, attemptId: "different" } },
      { ...input, transcript: { ...transcript, segments: transcript.segments.map((s) => ({ ...s, sampleEvidence: { ...s.sampleEvidence! } })) } },
      { ...input, transcript: { ...transcript, segments: transcript.segments.map((s) => ({ ...s, wall: null })) } },
      { ...input, meetingEnded: false },
    ]) await assert.rejects(builder.buildTimedTeamMemMeetingArtifact(changed), /timed|ended|wall|evidence/);
    for (const segments of [
      [...transcript.segments, { ...transcript.segments[0]!, segmentId: "overlapping" }],
      transcript.segments.map((s) => ({ ...s, wall: { ...s.wall!, startedAt: "not-a-time" } })),
      transcript.segments.map((s) => ({ ...s, wall: { ...s.wall!, endedAt: "2026-09-02T13:59:59.999999Z" } })),
    ]) {
      await assert.rejects(builder.buildTimedTeamMemMeetingArtifact({ ...input, transcript: { ...transcript, segments } }));
      assert.equal(calls, 1, "known unrepresentable timing must refuse before paid synthesis");
    }
    assert.equal(calls, 1, "invalid evidence refuses before processText");
  } finally { f.close(); }
});

test("v2 timed builder retains overlapping observations and sends exact interval provenance to synthesis", async () => {
  const f = fixture();
  try {
    const transcript = await reconciler.reconcilePersistedTimedSpeakers({ occurrenceId: f.identity.occurrenceId, bridgeSessionId: "bridge",
      recordingHandle: testCapability.recordingHandle, store: f.store, nowMs: () => 1001,
      runtime: { async reconcileFinalizedRecording() { throw new Error("synthetic unavailable"); } } });
    const live = { ...transcript.segments[0]!, segmentId: "obs-live", text: "Live wording retained.", speaker: { kind: "anonymous" as const, label: "live-1" } };
    const final = { ...live, segmentId: "obs-final", text: "Final wording retained.", wording: "reconciled" as const,
      range: { ...live.range!, startSampleInclusive: 24n, endSampleExclusive: 456n },
      wall: { ...live.wall!, startedAt: "2026-09-02T14:00:00.001000Z", endedAt: "2026-09-02T14:00:00.019000Z" },
      sampleEvidence: createOwnedTimedSampleEvidence({ sampleRateHz: 24000, possibleSamples: 432n, candidateLower: [], observedUpper: [],
        ambiguousUpper: 0n, unobservedUpper: 432n, freshCandidates: [] }), speaker: { kind: "anonymous" as const, label: "final-1" } };
    const reversed = [final, live];
    let request: { sessionId: bigint; input: string; instructions?: string } | undefined, calls = 0;
    const input = { identity: f.identity, provider: "feishu", revision: 2, endedAt: "2026-09-02T14:10:00Z",
      attendance: [{ feishuUserId: "person", displayName: "Person", joinedAt: "2026-09-02T14:00:00Z", leftAt: "2026-09-02T14:10:00Z" }],
      transcript: { ...transcript, segments: reversed }, selectedAlignment: f.selected, sessionId: 99n, meetingEnded: true,
      recordingGaps: [], processingWarnings: [], runtime: { async processText(value: typeof request) { calls++; request = value;
        return { output: { summary: "Both observations retained.", projects: [], decisions: [{ text: "Retain both.", evidence_segment_ids: ["obs-live", "obs-final"] }],
          action_items: [], discussion_points: [], person_summaries: [] }, warnings: [] }; } },
      provenance: { runtimeProfile: "online" as const, sttProvider: "synthetic", sttModel: "synthetic", textProvider: "synthetic", textModel: "synthetic",
        agentVersion: "test", processedAt: "2026-09-02T14:11:00Z", finalBatchModel: "synthetic-final", liveStreamModel: "synthetic-live" },
      audio: { format: "pcm_s16le", encryption: "aes-256-gcm", durationSeconds: 0.02, bytes: 1000, sha256: `sha256:${testCapability.sha256}`, expiresAt: "2026-09-16T14:10:00Z" } };

    const built = await builder.buildTimedTeamMemMeetingArtifactV2(input);
    assert.equal(built.artifact.schema, "teammem-meeting/v2");
    assert.deepEqual(built.artifact.transcript.map(({ segment_id, text, started_at, ended_at, provenance }) => ({ segment_id, text, started_at, ended_at, provenance })), [
      { segment_id: "obs-live", text: "Live wording retained.", started_at: "2026-09-02T14:00:00.000000Z", ended_at: "2026-09-02T14:00:00.020000Z", provenance: { stage: "live_stream", model: "synthetic-live" } },
      { segment_id: "obs-final", text: "Final wording retained.", started_at: "2026-09-02T14:00:00.001000Z", ended_at: "2026-09-02T14:00:00.019000Z", provenance: { stage: "final_batch", model: "synthetic-final" } },
    ]);
    assert.deepEqual(reversed.map(({ segmentId }) => segmentId), ["obs-final", "obs-live"], "builder sorts a copy, not private evidence");
    assert.match(request?.instructions ?? "", /overlapping live\/final entries are observations.*same speech.*not proof of repeated events/i);
    assert.match(request?.instructions ?? "", /Do not infer identities, owners, or dates\. Under projects, list each project[^.]*known_projects/);
    assert.deepEqual(JSON.parse(request?.input ?? ""), { known_projects: [], transcript: built.artifact.transcript.map(({ segment_id, text, speaker, started_at, ended_at, provenance }) =>
      ({ segment_id, text, speaker, started_at, ended_at, provenance })) });
    assert.deepEqual(built.artifact.decisions[0]?.evidence_segment_ids, ["obs-live", "obs-final"]);
    await assert.rejects(builder.buildTimedTeamMemMeetingArtifactV2({ ...input, transcript: { ...transcript, segments: [{ ...live, sampleEvidence: { ...live.sampleEvidence! } }] } }), /evidence/);
    await assert.rejects(builder.buildTimedTeamMemMeetingArtifactV2({ ...input, selectedAlignment: { ...f.selected, attemptId: "wrong" } }), /provenance/);
    await assert.rejects(builder.buildTimedTeamMemMeetingArtifactV2({ ...input, meetingEnded: false }), /ended/);
    assert.equal(calls, 1, "invalid copied evidence and authority refuse before another synthesis call");
  } finally { f.close(); }
});

test("public package exposes final timed reader and builder without private arithmetic constructors", () => {
  assert.equal(publicApi.reconcilePersistedTimedSpeakers, reconciler.reconcilePersistedTimedSpeakers);
  assert.equal(publicApi.buildTimedTeamMemMeetingArtifact, builder.buildTimedTeamMemMeetingArtifact);
  assert.equal(publicApi.buildTimedTeamMemMeetingArtifactV2, builder.buildTimedTeamMemMeetingArtifactV2);
  assert.equal("createOwnedTimedSampleEvidence" in publicApi, false);
});

test("selected alignment and durable UI stream keyset pages across reopen with actual-now checks inside each page", async () => {
  const f = fixture({ frames: 130, admins: 17 }), other = openSessionStore({ filename: f.filename });
  let alignmentReads = 0, uiReads = 0, now = 1001, expireOnUiRead = false;
  const status = other.getTimedEvidenceBinding(f.recovery.generationId, now); assert.equal(status.kind, "timed");
  if (status.kind !== "timed") throw new Error("fixture");
  const observed = { ...other,
    readSelectedAlignmentPage(selected: typeof f.selected, after: number) {
      alignmentReads++; const page = other.readSelectedAlignmentPage(selected, after); assert.ok((page?.entries.length ?? 0) <= 64); return page;
    },
    readTimedUi(binding: typeof f.binding, after: number, at: number) {
      uiReads++; const page = other.readTimedUi(binding, after, at); assert.ok(page.length <= 8);
      if (expireOnUiRead) now = status.expiresAtMs!;
      return page;
    } };
  const input = { occurrenceId: f.identity.occurrenceId, bridgeSessionId: "bridge", recordingHandle: testCapability.recordingHandle,
    store: observed, nowMs: () => now, runtime: { async reconcileFinalizedRecording() { throw new Error("synthetic unavailable"); } } };
  try {
    const result = await reconciler.reconcilePersistedTimedSpeakers(input);
    assert.equal(result.segments[0]?.speaker.kind, "named"); assert.equal(alignmentReads, 18); assert.ok(uiReads >= 3);
    expireOnUiRead = true;
    await assert.rejects(reconciler.reconcilePersistedTimedSpeakers(input), /expired/);
  } finally { other.close(); f.close(); }
});

test("typed capture gaps and failed-attempt prefixes remain incomplete after full final processing, playback does not", async () => {
  for (const mode of ["capture", "playback", "failed"] as const) {
    const f = fixture({ failed: mode === "failed", gaps: mode === "failed" ? [] : [{ direction: mode, startedAt: "2026-09-02T14:00:00Z", endedAt: null }] });
    try {
      if (mode === "failed") {
        const binding = f.store.getTimedEvidenceBinding(f.recovery.generationId, 1001);
        assert.equal(binding.kind, "timed");
        if (binding.kind === "timed") { assert.equal(binding.terminalAtMs, null); assert.equal(binding.expiresAtMs, null); }
      }
      const result = await reconciler.reconcilePersistedTimedSpeakers({ occurrenceId: f.identity.occurrenceId, bridgeSessionId: "bridge",
        recordingHandle: testCapability.recordingHandle, store: f.store, nowMs: () => 1001,
        runtime: { async reconcileFinalizedRecording() { return { source: f.source, segments: [{ segmentId: "batch", text: "final words",
          startedAtMs: 0n, endedAtMs: 20n, speakerCluster: "cluster-1", mediaSampleRange: { startSampleInclusive: 0n, endSampleExclusive: 480n,
            sampleRateHz: 24000, gapOffsetMs: 0n, quantizationPolicy: "provider_seconds_outward_samples/v1" } }], warnings: [] }; } } });
      assert.equal(result.transcriptComplete, mode === "playback", mode);
      assert.equal(result.warnings.some(({ code }) => code === "timed_capture_loss"), mode !== "playback");
    } finally { f.close(); }
  }
});

test("closed failed-prefix reading cannot substitute another failure attempt or claim an occurrence end", async () => {
  const f = fixture({ failed: true });
  let calls = 0;
  try {
    await assert.rejects(reconciler.reconcilePersistedTimedSpeakers({ occurrenceId: f.identity.occurrenceId, bridgeSessionId: "bridge",
      recordingHandle: testCapability.recordingHandle, nowMs: () => 1001,
      store: { ...f.store, getRecordingRecovery: () => ({ ...f.recovery, failureAttempt: 2 }) },
      runtime: { async reconcileFinalizedRecording() { calls++; return { source: f.source, segments: [], warnings: [] }; } } }), /metadata mismatch/);
    assert.equal(calls, 0);
    const binding = f.store.getTimedEvidenceBinding(f.recovery.generationId, 1001);
    assert.equal(binding.kind === "timed" ? binding.terminalAtMs : "missing", null);
  } finally { f.close(); }
});

test("a selected pointer changed after page fetch cannot publish even the already fetched page", async () => {
  const f = fixture(), other = openSessionStore({ filename: f.filename });
  let replaced = false;
  try {
    await assert.rejects(reconciler.reconcilePersistedTimedSpeakers({ occurrenceId: f.identity.occurrenceId, bridgeSessionId: "bridge",
      recordingHandle: testCapability.recordingHandle, nowMs: () => 1001,
      store: { ...f.store, readSelectedAlignmentPage(selected, after) {
        const page = f.store.readSelectedAlignmentPage(selected, after);
        if (!replaced) {
          replaced = true; const next = other.beginRecordingAlignment(f.recovery.generationId, "replacement", true);
          assert.equal(next.kind, "claimed"); if (next.kind !== "claimed") throw new Error("fixture");
          other.appendRecordingAlignment(next.attempt, f.page);
          other.completeRecordingAlignment(next.attempt, { type: "recording_alignment_complete", source: f.source, pageCount: 1n,
            coverageStatus: "available", warnings: ["local_wall_timestamp_estimate"], traversalSucceeded: true });
        }
        return page;
      } }, runtime: { async reconcileFinalizedRecording() { return { source: f.source, segments: [], warnings: [] }; } } }), /selected final alignment changed/);
    assert.equal(replaced, true);
  } finally { other.close(); f.close(); }
});

import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Private harness seam has no declaration.
import { parseArguments, publicationRequired } from "./run.mjs";
// @ts-expect-error Private harness seam has no declaration.
import { scriptedCaptureConfiguration } from "./stage.mjs";

const load = async () => {
  // @ts-expect-error Private harness seam has no declaration.
  try { return await import("./l4-campaign.mjs"); } catch { return {}; }
};
test("literal L4 mode propagates through real parser and capture decisions, absent mode stays default", async () => {
  const l4 = await load();
  assert.equal(typeof l4.compileL4Plan, "function", "selected L4 compiler is missing");
  for (const l4Case of ["sent-named", "unavailable-missing", "sent-drop"]) {
    const options = parseArguments(["--interactive", "--l4-case", l4Case, "--out", "/private/tmp/component-unused"]);
    assert.equal(options.l4Case, l4Case);
    assert.equal(publicationRequired(options), false);
    assert.deepEqual(scriptedCaptureConfiguration(options), { l4Case, captureFrameLimit: 3000, participants: [] });
  }
  assert.equal(publicationRequired({}), true);
  assert.deepEqual(scriptedCaptureConfiguration({}), { captureFrameLimit: 51 });
});
import { parseEventV2 } from "../src/contracts/bridge-session-v2.ts";
// @ts-expect-error Private raw owner shared with child.
import { createBridgeObservationOwner, createBridgeEventEmitter } from "./fixtures/bridge-observations.mjs";
// @ts-expect-error Private provider HTTP seam.
import { createFixtureProviderHandler } from "./fixture-provider.mjs";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";

const origin = { hostNs: "10000000000", wallMs: Date.parse("2026-10-06T12:00:00Z") };
const binding = { physicalClientId: "slot", physicalGenerationId: "a".repeat(32), occurrenceId: "occ", bridgeSessionId: "bridge" };
for (const l4Case of ["sent-named", "unavailable-missing", "sent-drop"]) {
  test(`finite ${l4Case} schedule passes actual raw admission/serializer/production codec`, async () => {
    const l4 = await load(); assert.equal(typeof l4.compileL4Plan, "function");
    const plan = l4.compileL4Plan(l4Case, origin);
    assert.equal(plan.events.length, 38);
    let host = BigInt(origin.hostNs), pending: (() => void) | null = null;
    const rows: Array<ReturnType<typeof parseEventV2>> = [];
    const emit = createBridgeEventEmitter({ sessionId: "bridge", write: (bytes: string) => rows.push(parseEventV2(JSON.parse(bytes))) });
    const owner = createBridgeObservationOwner({ plan, binding, participants: [], parseEvent: parseEventV2, emit,
      nowHostNs: () => host, timers: { setTimeout(callback: () => void) { pending = callback; return 1; }, clearTimeout() { pending = null; } } });
    owner.prepareJoin({ clockDomainId: "e2e-clock", hostBeforeNs: host.toString(), hostAfterNs: host.toString() });
    const done = owner.start(); owner.postDisclosure("disclosure-1");
    for (const row of plan.events) { host = BigInt(row.emitAtHostNs); const callback = pending as unknown as () => void; callback(); }
    await done; assert.equal(rows.length, 40);
    assert.equal(rows[0]?.type, "chat_disclosure");
    const snapshots = rows.filter(row => row.type === "ui_snapshot");
    assert.equal(snapshots.length, 32);
    assert.equal(snapshots.filter(row => row.barrierBefore === "observation_drop").length, l4Case === "sent-drop" ? 1 : 0);
    assert.equal(snapshots.at(-1)?.snapshotSequence, l4Case === "sent-drop" ? 33 : 32);
    assert.equal(rows.filter(row => row.type === "participant_left").length, 3);
  });
}
test("invalid selectors and conflicting modes refuse through actual parser before staging", () => {
  for (const flags of [["--l4-case", "sent-named"], ["--interactive", "--l4-case", "restart"],
    ["--interactive", "--l4-case", "sent-named", "--l4-case", "sent-drop"],
    ...["--only-refusals", "--package-refusals", "--r2-baseline"].map(flag => ["--interactive", "--l4-case", "sent-named", flag]),
    ["--interactive", "--l4-case", "sent-named", "--media-timing", "invalid2ns"],
    ["--interactive", "--l4-case", "sent-named", "--d2-cut", "durable"]]) {
    assert.throws(() => parseArguments([...flags, "--out", "/private/tmp/component-unused"]));
  }
});
test("submitted range uses real append observations and exact four provider messages", async () => {
  const l4 = await load(); assert.equal(typeof l4.createSubmittedFrameTracker, "function");
  const tracker = l4.createSubmittedFrameTracker(); tracker.connect("socket-1"); tracker.update("socket-1", { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24000 } } } });
  for (let i = 0; i < 60; i++) tracker.append("socket-1", Buffer.alloc(960).toString("base64"));
  const range = { connection: "socket-1", startFrame: 11, endFrame: 60 };
  const events = l4.submittedTranscriptEvents({ tracker: tracker.snapshot(), range, item: "one", previous: null, text: l4.L4_TEXT });
  assert.deepEqual(events.map((event: { type: string }) => event.type), ["input_audio_buffer.speech_started", "input_audio_buffer.speech_stopped", "input_audio_buffer.committed", "conversation.item.input_audio_transcription.completed"]);
  assert.equal(events[0].audio_start_ms, 200); assert.equal(events[1].audio_end_ms, 1200);
  for (const bad of [{ ...range, endFrame: 61 }, { ...range, startFrame: 0 }, { ...range, startFrame: 61 }, { ...range, connection: "old" }, { ...range, startFrame: 1, endFrame: 60 }])
    assert.throws(() => l4.submittedTranscriptEvents({ tracker: tracker.snapshot(), range: bad, item: "one", previous: null, text: l4.L4_TEXT }), /l4_submitted_range/);
  tracker.append("socket-1", Buffer.alloc(958).toString("base64"));
  assert.throws(() => l4.submittedTranscriptEvents({ tracker: tracker.snapshot(), range, item: "one", previous: null, text: l4.L4_TEXT }), /l4_submitted_range/);
  const reconnect = l4.createSubmittedFrameTracker(); reconnect.connect("a"); reconnect.update("a"); reconnect.connect("b"); reconnect.update("b");
  assert.equal(reconnect.snapshot().valid, false);
});
test("selected controller waits observed readiness/range/real final and watermark before end permission", async () => {
  const l4 = await load(); assert.equal(typeof l4.driveL4Capture, "function");
  const plan = l4.compileL4Plan("sent-named", origin), child = { joined: true, mediaConnected: true,
    l4: { case: "sent-named", origin, planSha256: l4.l4PlanHash(plan) }, observationPlan: { phase: "running", planned: 38, emitted: 6 } };
  const tracker = { connection: "one", appended: 70, valid: true, ready: true }, events: Array<Record<string, string>> = [];
  let sent = 0;
  const provider = { get submitted() { return { ...tracker }; }, transcript(text: string, range: { startFrame: number; endFrame: number }) {
    assert.equal(text, l4.L4_TEXT); assert.equal(range.startFrame, 71); assert.equal(range.endFrame, 120); sent++;
    events.push({ type: "voice_transcript_final", segment_id: "1", session_id: "41" }, { type: "response_skipped", segment_id: "1", session_id: "41" }); } };
  const waitFor = async (check: () => unknown, { name }: { name: string }) => {
    if (name === "l4_submitted_window") tracker.appended = 120;
    if (name === "l4_following_confirmation") child.observationPlan.emitted = 18;
    if (name === "l4_observations_complete") { child.observationPlan.phase = "completed"; child.observationPlan.emitted = 38; }
    const result = check(); assert.ok(result, name); return result;
  };
  const result = await l4.driveL4Capture({ l4Case: "sent-named", provider, child: () => child, runtimeEvents: () => events, waitFor, nowHostNs: () => BigInt(origin.hostNs) + 1400000000n, budgetMs: 100 });
  assert.equal(sent, 1); assert.equal(result.segmentId, "1"); assert.equal(result.rawRows, 38);
  for (const change of [{ joined: false }, { mediaConnected: false }, { observationPlan: { phase: "running", planned: 38, emitted: 5 } }]) {
    await assert.rejects(l4.driveL4Capture({ l4Case: "sent-named", provider, child: () => ({ ...child, ...change }), runtimeEvents: () => events,
      waitFor: async (check: () => unknown) => { if (!check()) throw new Error("prerequisite_missing"); return check(); }, nowHostNs: () => BigInt(origin.hostNs) + 1400000000n, budgetMs: 100 }));
  }
});
function answer(messages: Array<{ content: string }>, options: Record<string, unknown> = {}) {
  const { handler } = createFixtureProviderHandler(options), request = new EventEmitter();
  Object.assign(request, { url: "/api/chat" }); let output = "";
  handler(request, { setHeader() {}, write(bytes: string) { output += bytes; }, end(bytes: string) { output += bytes; } });
  request.emit("data", Buffer.from(JSON.stringify({ messages }))); request.emit("end");
  return JSON.parse(JSON.parse(output.split("\n")[0]!).message.content);
}
test("opt-in HTTP synthesis reads canonical transcript content only, never a roster or case label", () => {
  const named = [{ segment_id: "live:1", text: "Synthetic non-name wording.", speaker: { kind: "person", person_id: "ou_l4_speaker", display_name: "Speaker A", reconciled: true }, started_at: "2026-10-06T12:00:01.500000Z", ended_at: "2026-10-06T12:00:02.500000Z", provenance: { stage: "live_stream", model: "synthetic" } }];
  const prompt = [{ content: "Produce meeting synthesis" }, { content: JSON.stringify(named) }];
  assert.equal(answer(prompt).person_summaries.length, 0);
  assert.equal(answer(prompt, { l4Case: "sent-named" }).person_summaries.length, 1);
  assert.equal(answer([{ content: "meeting synthesis; participant roster ou_l4_speaker Speaker A" }, { content: "[]" }], { l4Case: "sent-named" }).person_summaries.length, 0);
  assert.equal(answer([{ content: "meeting synthesis" }, { content: JSON.stringify([{ ...named[0], speaker: { kind: "anonymous", label: "speaker_01" } }]) }], { l4Case: "sent-named" }).person_summaries.length, 0);
});
test("ordinary selected public close always settles controller and preserves close rejection", async () => {
  const l4 = await load(); const controller = new AbortController(); let closes = 0;
  await assert.rejects(l4.closeL4Composition({ getApplication: () => ({ close: async () => { closes++; throw new Error("composition_close_failed:store"); } }), controller }), /composition_close_failed/);
  assert.equal(controller.signal.aborted, true); assert.equal(closes, 1);
  const absent = new AbortController(); await l4.closeL4Composition({ getApplication: () => null, controller: absent }); assert.equal(absent.signal.aborted, true);
});

import { encodeLiveEvidence, encodeProvisionalResult, decodeLiveEvidence, decodeProvisionalResult } from "../src/sessions/live-evidence-codec.ts";
import { encodeAlignmentPage, decodeAlignmentPage, pageWarnings } from "../src/sessions/recording-alignment.ts";
import { mergeTimedRecordingEvidence } from "../src/sessions/timed-evidence-merge.ts";
import { reduceAttendance, type MeetingLifecycleEvent } from "../src/domain/participants.ts";
import { parseSupportedTeamMemMeetingArtifact } from "../src/contracts/teammem-meeting-v2.ts";
import { canonicalArtifactHash } from "../src/contracts/teammem-meeting-v1.ts";
import { buildTimedTeamMemMeetingArtifactV2 } from "../src/delivery/artifact-builder.ts";
import type { RecordingAlignmentEntry, RecordingAlignmentPage, VersionFourVoiceTranscriptFinalEvent } from "@conversation/runtime";

const codecs = { parseEventV2, decodeLiveEvidence, decodeProvisionalResult, decodeAlignmentPage, pageWarnings, mergeTimedRecordingEvidence,
  reduceAttendance, parseSupportedTeamMemMeetingArtifact, canonicalArtifactHash };
async function component(l4Case = "sent-named") {
  const l4 = await load(), plan = l4.compileL4Plan(l4Case, origin), raw: Array<ReturnType<typeof parseEventV2>> = [];
  const emit = createBridgeEventEmitter({ sessionId: "bridge", now: () => "2026-10-06T12:00:00Z", write: (bytes: string) => raw.push(parseEventV2(JSON.parse(bytes))) });
  emit({ type: "chat_disclosure", outcome: plan.disclosure }); emit({ type: "command_result", commandId: "chat", outcome: plan.disclosure === "sent" ? "ok" : "failed", detail: null });
  for (const row of plan.events) emit(row.event);
  const source = { sourceSessionId: 41n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64) }, generation = "generation-1";
  const entries: RecordingAlignmentEntry[] = Array.from({ length: 50 }, (_, i) => {
    const start = BigInt(i * 480), hostStart = BigInt(origin.hostNs) + 1500000000n + BigInt(i) * 20000000n;
    const wallStart = BigInt(origin.wallMs) * 1000000n + 1500000000n + BigInt(i) * 20000000n;
    return { kind: "frame", mediaStartSample: start, mediaEndSample: start + 480n, sampleRateHz: 24000, gapOffsetMs: 0n,
      epoch: { bridgeSessionId: "bridge", clockDomainId: "e2e-clock", captureEpoch: 1n },
      provenance: { captureEpoch: 1n, sequence: BigInt(i + 1), outputStartSample: start, sampleCount: 480, sourceStartNumerator: start * 24000n,
        sourceEndNumerator: (start + 480n) * 24000n, sourceDenominator: 24000, sourceRateHz: 24000, quality: "nominal_frame_endpoint_interpolation",
        span: { hostStartNs: hostStart, hostEndNs: hostStart + 20000000n, roundingEnvelopeNs: 1n, captureUncertaintyNs: null } },
      captureStatus: "available", reasons: ["local_wall_timestamp_estimate"], wall: { quality: "local_wall_estimate", policyId: "local-wall-estimate/v1",
        localStartNs: wallStart, localEndNs: wallStart + 20000000n, wallEpoch: 1n, wallRun: 1n, maximumBracketNs: 1n, maximumResolutionNs: 1n,
        modelAllowanceNs: 10000000n, interpolationRoundingNs: 0n, captureRoundingNs: 1n, captureUncertaintyNs: null, externalUtcAccuracyNs: null, overallPhysicalAccuracyNs: null } };
  });
  const live: VersionFourVoiceTranscriptFinalEvent = { type: "voice_transcript_final", sessionId: 41n, segmentId: "1", turnId: null, text: l4.L4_TEXT,
    capture: { kind: "source_sample_range/v1", clockDomainId: "e2e-clock", captureEpoch: 1n, firstFrameSequence: 1n, lastFrameSequence: 50n, sourceStartSample: 0n, sourceEndSample: 24000n, sampleRateHz: 24000 },
    liveCoverage: { kind: "whole_touched_frame_nominal_host_envelope/v1", hostStartNs: BigInt(origin.hostNs) + 1500000000n, hostEndNs: BigInt(origin.hostNs) + 2500000000n,
      firstFrameHostEndNs: BigInt(origin.hostNs) + 1520000000n, mappingQuality: "nominal_frame_endpoint_interpolation", captureUncertaintyNs: null, knownRoundingAllowanceNs: 1n } };
  const merged = await mergeTimedRecordingEvidence({ source, bridgeSessionId: "bridge", entries, ui: raw, live: [live], final: { unavailable: true },
    uiLossReason: l4Case === "sent-drop" ? "ui_sequence_gap" : null, wordingLossReason: null });
  const attendance = reduceAttendance(raw.flatMap<MeetingLifecycleEvent>(row => row.type === "participant_joined" ? [{ type: row.type, feishuUserId: row.feishuUserId!, displayName: row.displayName!, occurredAt: row.observedAt, sequence: row.sequence, bridgeSessionId: row.sessionId }]
    : row.type === "participant_left" ? [{ type: row.type, feishuUserId: row.feishuUserId!, occurredAt: row.observedAt, sequence: row.sequence, bridgeSessionId: row.sessionId }] : []));
  const selectedAlignment = { generationId: generation, attemptId: "attempt-1", source, timingContract: "capture-clock/v1" as const, policyId: "local-wall-estimate/v1" as const, pageCount: 2, entryCount: 50, storedBytes: 0, coverageStatus: "available" as const, warnings: ["local_wall_timestamp_estimate"] };
  const built = await buildTimedTeamMemMeetingArtifactV2({ identity: { occurrenceId: "900000001@2026-10-06T12:00:00Z", providerMeetingId: "900000001", meetingNo: "900000001", title: "Synthetic component", occurrenceStartedAt: "2026-10-06T12:00:00Z", organizer: null },
    provider: "feishu", sessionId: 42n, revision: 1, endedAt: "2026-10-06T12:00:05Z", meetingEnded: true, attendance,
    transcript: { kind: "timed_recording_transcript/v1", ...merged, provenance: { occurrenceId: "900000001@2026-10-06T12:00:00Z", bridgeSessionId: "bridge", generationId: generation, alignmentAttemptId: "attempt-1", timingContract: "capture-clock/v1", policyId: "local-wall-estimate/v1" } }, selectedAlignment,
    audio: { durationSeconds: 1, expiresAt: "2026-10-20T12:00:05Z", sha256: `sha256:${source.sha256}`, bytes: 4096, format: "pcm_s16le/24000/1", encryption: "conversation-runtime/encrypted-session-recording" },
    recordingGaps: [], processingWarnings: [], provenance: { runtimeProfile: "online", sttProvider: "synthetic", sttModel: "synthetic", liveStreamModel: "synthetic", finalBatchModel: "synthetic", textProvider: "synthetic", textModel: "synthetic", agentVersion: "synthetic", processedAt: "2026-10-06T12:00:05Z" },
    runtime: { async processText(request) { return { output: answer([{ content: request.instructions }, { content: request.input }], { l4Case }), warnings: [] }; } } });
  const page: RecordingAlignmentPage = { type: "recording_alignment_page", source, pageIndex: 0n, policy: { id: "local-wall-estimate/v1", cadenceTargetNs: 1000000000n, maximumBracketNs: 5000000n, maximumPairGapNs: 2000000000n, maximumResidualNs: 10000000n }, entries };
  const payloads = [0, 1].map(i => encodeAlignmentPage({ ...page, pageIndex: BigInt(i), entries: entries.slice(i * 25, (i + 1) * 25) }));
  const artifact = { meeting: built.artifact, hash: built.artifact_hash, occurrenceId: built.artifact.occurrence_id, revision: 1, files: ["READY", "audio.enc", "manifest.json", "meeting.json"], bundleDir: "/private/tmp/component-owned-bundle" };
  const snapshot = { occurrence: artifact.occurrenceId, owners: [{ generation_id: generation, occurrence_id: artifact.occurrenceId, bridge_session_id: "bridge", runtime_session_id: "41", state: "closed", ui_rows: raw.length, live_rows: 1, ui_loss_reason: l4Case === "sent-drop" ? "ui_sequence_gap" : null, wording_loss_reason: null }],
    ui: raw.map(row => ({ generation_id: generation, sequence: row.sequence, payload: JSON.stringify(row) })),
    live: [{ generation_id: generation, segment_id: "1", text: live.text, evidence: encodeLiveEvidence(live), result: encodeProvisionalResult({ kind: "anonymous", reason: "coverage_missing" }), occurrence_id: artifact.occurrenceId, bridge_session_id: "bridge", runtime_session_id: "41", capture_complete: 1, incomplete_reason: null, owner_state: "closed", live_rows: 1, ui_loss_reason: l4Case === "sent-drop" ? "ui_sequence_gap" : null, wording_loss_reason: null }],
    recordings: [{ occurrence_id: artifact.occurrenceId, handle: source.recordingHandle, sha256: source.sha256, key_id: "c".repeat(16), duration_ms: 1000, format: "pcm_s16le/24000/1" }], gaps: [], runtimeGaps: [],
    bindings: [{ generation_id: generation, occurrence_id: artifact.occurrenceId, bridge_session_id: "bridge", source_session_id: "41", recording_handle: source.recordingHandle, sha256: source.sha256, key_id: "c".repeat(16), recording_kind: "final" }], selected: [{ generation_id: generation, attempt_id: "attempt-1" }],
    attempts: [{ attempt_id: "attempt-1", generation_id: generation, source_session_id: "41", recording_handle: source.recordingHandle, sha256: source.sha256, key_id: "c".repeat(16), state: "complete", timing_contract: "capture-clock/v1", page_count: 2, entry_count: 50, stored_bytes: payloads.reduce((n, payload) => n + Buffer.byteLength(payload), 0), coverage_status: "available", warnings_json: '["local_wall_timestamp_estimate"]' }],
    pages: payloads.map((payload, i) => ({ attempt_id: "attempt-1", page_index: i, entry_count: 25, payload })), deliveries: [{ occurrence_id: artifact.occurrenceId, revision: 1, artifact_hash: artifact.hash, bundle_path: artifact.bundleDir, transcript_complete: 0 }] };
  return { l4Case, snapshot, artifact, drive: { case: l4Case, origin, planSha256: l4.l4PlanHash(plan), range: { connection: "one", startFrame: 1, endFrame: 50 }, segmentId: "1", runtimeSessionId: "41", rawRows: 38, bridgeSessionId: "bridge", disclosureCommandId: "chat" },
    runtimeEvents: [{ type: "voice_transcript_final", session_id: "41", segment_id: "1" }, { type: "response_skipped", session_id: "41", segment_id: "1" }], providerCalls: [], child: { playback: [], flushes: [] }, closed: true };
}
for (const l4Case of ["sent-named", "unavailable-missing", "sent-drop"]) test(`readonly oracle ${l4Case} accepts actual production merge/builder/contract component inputs`, async () => {
  const l4 = await load(); assert.equal(typeof l4.verifyL4Evidence, "function", "durable oracle missing");
  const input = await component(l4Case), result = await l4.verifyL4Evidence(input, codecs);
  assert.equal(result.case, l4Case); assert.equal(result.capture.samples, "24000"); assert.equal(result.attendance.length, 2);
  assert.equal(result.summaries.A, l4Case === "sent-named"); assert.equal(result.summaries.S, false);
  assert.equal(JSON.stringify(result).includes("synthetic budget"), false);
});
function rehash(input: Awaited<ReturnType<typeof component>>) {
  input.artifact.hash = canonicalArtifactHash(input.artifact.meeting);
  input.snapshot.deliveries[0]!.artifact_hash = input.artifact.hash;
}
const mutants: Array<[string, string, (input: Awaited<ReturnType<typeof component>>) => void, string?]> = [
  ["all runtime bindings consistently moved still fail external anchor", "l4_source_binding", input => {
    input.snapshot.owners[0]!.runtime_session_id = "99"; input.snapshot.live[0]!.runtime_session_id = "99";
    input.snapshot.bindings[0]!.source_session_id = "99"; input.snapshot.attempts[0]!.source_session_id = "99";
    const row = input.snapshot.live[0]!, evidence = decodeLiveEvidence(row.evidence, row.text);
    row.evidence = encodeLiveEvidence({ ...evidence, sessionId: 99n });
    for (const page of input.snapshot.pages) page.payload = encodeAlignmentPage({ ...decodeAlignmentPage(page.payload), source: { ...decodeAlignmentPage(page.payload).source, sourceSessionId: 99n } });
    input.snapshot.attempts[0]!.stored_bytes = input.snapshot.pages.reduce((n, page) => n + Buffer.byteLength(page.payload), 0);
  }],
  ["matched source with no intersecting recorded frames", "l4_capture_intersection", input => {
    const row = input.snapshot.live[0]!, event = decodeLiveEvidence(row.evidence, row.text);
    row.evidence = encodeLiveEvidence({ ...event, capture: { ...event.capture!, firstFrameSequence: 1001n, lastFrameSequence: 1050n, sourceStartSample: 480000n, sourceEndSample: 504000n } });
  }],
  ["missing timing cannot masquerade as missing UI identity", "l4_capture_unavailable", input => {
    const row = input.snapshot.live[0]!, event = decodeLiveEvidence(row.evidence, row.text);
    row.evidence = encodeLiveEvidence({ type: event.type, sessionId: event.sessionId, segmentId: event.segmentId, turnId: null, text: event.text, captureUnavailableReason: "capture_timing_missing" });
  }, "unavailable-missing"],
  ["declared drop without durable generation loss", "l4_selected_ui_loss", input => {
    input.snapshot.owners[0]!.ui_loss_reason = null; input.snapshot.live[0]!.ui_loss_reason = null;
  }, "sent-drop"],
  ["forged loss warning on ordinary unknown UI", "l4_artifact_ui_warning", input => {
    input.artifact.meeting.processing_warnings.push({ code: "timed_ui_evidence_loss", detail: "ui_sequence_gap" }); rehash(input);
  }, "unavailable-missing"],
  ["merged observed leave and rejoin intervals", "l4_observed_attendance", input => {
    const a = input.artifact.meeting.participants[0]!; a.attendance = [{ joined_at: a.attendance[0]!.joined_at, left_at: a.attendance[1]!.left_at }]; rehash(input);
  }],
  ["artifact hash substitution", "l4_artifact_hash_binding", input => { input.artifact.hash = "sha256:" + "d".repeat(64); }],
  ["extra actual transcript", "l4_actual_final_count", input => { input.runtimeEvents.push({ type: "voice_transcript_final", session_id: "41", segment_id: "2" }); }],
  ["unexpected speech provider output", "l4_unexpected_speech", input => { input.providerCalls.push({ route: "speech" } as never); }],
  ["live owner still active", "l4_owner_retention", input => { input.snapshot.owners[0]!.state = "active"; }],
  ["selected attempt incomplete", "l4_selected_incomplete", input => { input.snapshot.attempts[0]!.state = "collecting"; }],
  ["wrong disclosure command ID", "l4_disclosure_command", input => { input.drive.disclosureCommandId = "other"; }],
  ["closed cleanup unknown", "l4_owner_closure_unavailable", input => { input.closed = false; }],
  ["artifact falsely names silent attendee", "l4_artifact_identity", input => {
    input.artifact.meeting.transcript[0]!.speaker = { kind: "person", person_id: "ou_l4_silent", display_name: "Silent S", reconciled: true };
    input.artifact.meeting.person_summaries = [{ person_id: "ou_l4_silent", display_name: "Silent S", text: "False synthetic summary" }]; rehash(input);
  }],
];
for (const [name, code, change, l4Case] of mutants) test(`coherent oracle mutant: ${name}`, async () => {
  const l4 = await load(), input = await component(l4Case); await l4.verifyL4Evidence(input, codecs);
  change(input); await assert.rejects(l4.verifyL4Evidence(input, codecs), error => error instanceof Error && error.message === code);
});
test("actual artifact contract rejects silent S summary with valid attendance and named A", async () => {
  const input = await component();
  input.artifact.meeting.person_summaries.push({ person_id: "ou_l4_silent", display_name: "Silent S", text: "Unjustified summary" });
  assert.throws(() => parseSupportedTeamMemMeetingArtifact(input.artifact.meeting), /person_summaries require an actual participant with a named transcript segment/);
});
test("external options refuse getters and custom prototypes before accessing or serializing", async () => {
  const l4 = await load(); let calls = 0;
  assert.throws(() => l4.l4Configuration(Object.defineProperty({}, "l4Case", { get() { calls++; return "sent-named"; } })), /l4_selection_refused/);
  assert.equal(calls, 0);
  const malicious = Object.setPrototypeOf([], { toJSON() { calls++; return []; } });
  assert.throws(() => l4.l4PersonSummaries(malicious), /l4_synthesis_input_refused/); assert.equal(calls, 0);
});
// @ts-expect-error Private existing lifecycle seam.
import { runExposedComposition } from "./composition-lifecycle.mjs";
test("selected close releases actual exposed lifecycle and retains clean false on public close error", async () => {
  const l4 = await load(), controller = new AbortController(); let application: { close(): Promise<void> } | null = null;
  let resolveHandle: () => void = () => {}; const handle = new Promise<void>(resolve => { resolveHandle = resolve; });
  const run = runExposedComposition(async () => ({ async start() {}, async discover() {}, async close() { throw new Error("composition_close_failed:store"); } }), {}, {}, {},
    (app: { close(): Promise<void> }) => { application = app; resolveHandle(); }, controller);
  await handle;
  await assert.rejects(l4.closeL4Composition({ getApplication: () => application, controller }), /composition_close_failed/);
  assert.deepEqual(await run, { status: "composition_closed", clean: false });
});
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { readClosedTimedAttendance, reconcilePersistedTimedSpeakers } from "../src/sessions/speaker-reconciler.ts";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
for (const l4Case of ["sent-named", "unavailable-missing", "sent-drop"]) test(`owned synthetic SQLite ${l4Case} reaches actual closed production reconciler`, async () => {
  const l4 = await load(), input = await component(l4Case), dir = mkdtempSync(path.join(os.tmpdir(), "meeting-l4-component-")), filename = path.join(dir, "owned.db");
  const store = openSessionStore({ filename });
  try {
    const identity = buildMeetingIdentity({ providerMeetingId: "900000001", meetingNo: "900000001", occurrenceStartedAt: "2026-10-06T12:00:00Z", title: "Synthetic", organizer: null });
    const coordinator = createCoordinator({ store, clock: { now: () => 1000 }, bridgeLeaseTtlMs: 30000, maxConcurrentSessions: 1 });
    coordinator.discover(identity); coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening");
    const binding = { occurrenceId: identity.occurrenceId, bridgeSessionId: "bridge", runtimeSessionId: 41n };
    store.beginReconciliationGeneration(identity.occurrenceId, "bridge", 1000); store.setReconciliationRuntimeSession(identity.occurrenceId, "bridge", 41n);
    const owner = store.beginTimedEvidence(binding, 1000);
    for (const row of input.snapshot.ui) store.appendTimedUi(owner, parseEventV2(JSON.parse(row.payload)), 1000);
    const live = input.snapshot.live[0]!;
    store.appendTimedFinal(owner, decodeLiveEvidence(live.evidence, live.text), 1000);
    store.resolveTimedFinal(owner, "1", { kind: "anonymous", reason: "coverage_missing" }, 1000);
    if (l4Case === "sent-drop") store.markTimedUiLoss(owner, "ui_sequence_gap", 1000);
    store.closeTimedEvidence(owner, 1000);
    const source = decodeAlignmentPage(input.snapshot.pages[0]!.payload).source;
    const capability = { ...source, keyId: "c".repeat(16), authorization: "d".repeat(64) };
    coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, { handle: source.recordingHandle,
      encryptedPath: path.join(dir, "synthetic-ciphertext-locator"), sha256: source.sha256, keyId: capability.keyId, format: "pcm_s16le/24000/1", durationMs: 1000,
      gaps: [], runtimeGaps: [], recovery: { bridgeSessionId: "bridge", capability } }, "bridge");
    const recovery = store.getRecordingRecovery(identity.occurrenceId, "bridge", source.recordingHandle)!;
    const attempt = store.beginRecordingAlignment(recovery.generationId, "component");
    assert.equal(attempt.kind, "claimed"); if (attempt.kind !== "claimed") throw new Error("component claim");
    for (const page of input.snapshot.pages) store.appendRecordingAlignment(attempt.attempt, decodeAlignmentPage(page.payload));
    store.completeRecordingAlignment(attempt.attempt, { type: "recording_alignment_complete", source, pageCount: 2n, coverageStatus: "available", warnings: ["local_wall_timestamp_estimate"], traversalSucceeded: true });
    const projected = await l4.readL4Evidence(filename, identity.occurrenceId);
    assert.equal(projected.owners[0].state, "closed"); assert.equal(projected.ui.length, 40); assert.equal(projected.live.length, 1); assert.equal(projected.pages.length, 2);
    const args = { occurrenceId: identity.occurrenceId, bridgeSessionId: "bridge", recordingHandle: source.recordingHandle, store, nowMs: () => 1001 };
    const attendance = await readClosedTimedAttendance(args); assert.equal(attendance.attendance.length, 3);
    const reconciled = await reconcilePersistedTimedSpeakers({ ...args, runtime: { async reconcileFinalizedRecording() { throw new Error("synthetic unavailable"); } } });
    assert.equal(reconciled.segments[0]?.speaker.kind, l4Case === "sent-named" ? "named" : "anonymous");
    assert.equal(reconciled.segments[0]?.text, "The synthetic budget is seven.");
    assert.equal(reconciled.warnings.some(row => row.code === "timed_ui_evidence_loss"), l4Case === "sent-drop");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
for (const mode of ["stale activation", "one confirming snapshot"]) test(`shared final identity predicate rejects production merge with ${mode}`, async () => {
  const l4 = await load(), input = await component();
  const evidence = decodeLiveEvidence(input.snapshot.live[0]!.evidence, input.snapshot.live[0]!.text);
  const entries = input.snapshot.pages.flatMap(row => decodeAlignmentPage(row.payload).entries);
  let raw = input.snapshot.ui.map(row => parseEventV2(JSON.parse(row.payload)));
  if (mode === "stale activation") {
    raw = raw.map(row => {
      const ms = row.type === "participant_joined" ? (row.feishuUserId === "ou_l4_speaker" ? -1000 : -990) : row.type === "ui_snapshot" && row.state === "unknown" ? -600 : null;
      if (ms === null || !("observationTiming" in row)) return row;
      const host = BigInt(origin.hostNs) + BigInt(ms) * 1000000n;
      return { ...row, observationTiming: { clockDomainId: "e2e-clock", hostBeforeNs: (host - 1n).toString(), hostAfterNs: host.toString() } };
    });
  } else raw = raw.filter(row => row.type !== "ui_snapshot" || row.snapshotSequence <= 2).map((row, i) => ({ ...row, sequence: i + 1 }));
  const merged = await mergeTimedRecordingEvidence({ source: decodeAlignmentPage(input.snapshot.pages[0]!.payload).source,
    bridgeSessionId: "bridge", entries, ui: raw, live: [evidence], final: { unavailable: true }, uiLossReason: null, wordingLossReason: null });
  assert.equal(merged.segments[0]?.speaker.kind, "anonymous");
  assert.throws(() => l4.assertL4ReconciledIdentity(merged.segments[0], "sent-named"), /^Error: l4_reconciled_identity$/);
});
test("selected safe report omits raw wording, payloads and arbitrary diagnostics", async () => {
  const l4 = await load(); assert.equal(typeof l4.l4Report, "function");
  const report = l4.l4Report({ l4Case: "sent-named", metadata: null, checks: [{ name: "capture_recorded", status: "fail", detail: "secret arbitrary diagnostic /private/path PCM" }],
    processCleanup: { cleanupConfirmed: false }, raw: "secret", providerCalls: [{ route: "speech", text: "secret" }] });
  assert.equal(JSON.stringify(report).includes("secret"), false); assert.equal(report.checks[0].status, "fail");
  assert.equal(report.cleanupConfirmed, false); assert.equal(report.publication, "untested");
});
test("selected provider refuses an unsupported sample rate before range emission", async () => {
  const l4 = await load(), tracker = l4.createSubmittedFrameTracker(); tracker.connect("one");
  tracker.update("one", { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 16000 } } } });
  tracker.append("one", Buffer.alloc(960).toString("base64"));
  assert.throws(() => l4.submittedTranscriptEvents({ tracker: tracker.snapshot(), range: { connection: "one", startFrame: 1, endFrame: 1 }, item: "one", previous: null, text: "Synthetic" }), /l4_submitted_range/);
});
test("selected controller fails missed fixed window without transcript despite a swallowing poller", async () => {
  const l4 = await load(); let sent = 0;
  const child = { joined: false, mediaConnected: false, l4: { case: "sent-named", origin }, observationPlan: { phase: "running", planned: 38, emitted: 5 } };
  await assert.rejects(l4.driveL4Capture({ l4Case: "sent-named", provider: { submitted: { ready: false, valid: true }, transcript() { sent++; } }, child: () => child,
    runtimeEvents: () => [], nowHostNs: () => BigInt(origin.hostNs) + 2200000000n, budgetMs: 10,
    waitFor: async (check: () => unknown) => { let result; try { result = check(); } catch { result = undefined; } if (!result) throw new Error("poller_timeout"); return result; } }), /^Error: l4_fixed_window_missed$/);
  assert.equal(sent, 0);
});
test("actual entry poller cancellation settles a selected failed admission before peers close", async () => {
  // @ts-expect-error Private entry helper has no declaration.
  const entry = await import("./entry.mjs"); assert.equal(typeof entry.waitFor, "function");
  const controller = new AbortController(); let effects = 0;
  const pending = entry.waitFor(() => { effects++; return false; }, { budgetMs: 1000, name: "selected", signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /^Error: l4_drive_cancelled$/); assert.equal(effects, 0);
});
test("opt-in summary refuses a named roster shaped array without canonical segment provenance", async () => {
  const l4 = await load();
  const fake = [{ segment_id: "roster", text: "Metadata", speaker: { kind: "person", person_id: "ou_l4_speaker", display_name: "Speaker A" } }];
  assert.deepEqual(l4.l4PersonSummaries([{ content: JSON.stringify(fake) }]), []);
});

async function reportInput(l4Case = "sent-named") {
  const l4 = await load(), metadata = await l4.verifyL4Evidence(await component(l4Case), codecs);
  // Synthetic component names become the actual store's collision-free ID shape.
  metadata.generationId = Buffer.from(metadata.occurrenceId).toString("hex") + ":" + Buffer.from(metadata.bridgeSessionId).toString("hex");
  metadata.alignmentAttemptId = "12345678-1234-4234-8234-123456789abc";
  return { l4Case, metadata, checks: ["l4_selected_campaign", "artifact_bundle", "shutdown_clean", "no_key_or_plaintext_audio", "no_orphan_process", "no_closed_store_callback", "single_occurrence_identity"].map(name => ({ name, status: "pass" })), processCleanup: { cleanupConfirmed: true } };
}
for (const l4Case of ["sent-named", "unavailable-missing", "sent-drop"]) test(`safe report ${l4Case} accepts bounded production-derived metadata and required checks`, async () => {
  const l4 = await load(), input = await reportInput(l4Case);
  input.checks.push({ name: "publication_receipt", status: "skipped" });
  assert.equal(l4.l4Report(input).disposition, "observed-scripted-campaign");
});
const reportMutations: Array<[string, (input: Awaited<ReturnType<typeof reportInput>>) => void]> = [
  ["sentinel recording hash", input => { input.metadata.recordingSha256 = "/private/path diagnostic SENTINEL"; }],
  ["sentinel plan hash", input => { input.metadata.planSha256 = "secret header"; }],
  ["sentinel artifact hash", input => { input.metadata.artifactHash = "sha256:secret"; }],
  ["wrong case", input => { input.metadata.case = "sent-drop"; }],
  ["wrong metadata disposition", input => { input.metadata.disposition = "observed"; }],
  ["arbitrary runtime ID", input => { input.metadata.runtimeSessionId = "diagnostic"; }],
  ["path bridge ID", input => { input.metadata.bridgeSessionId = "/private/path"; }],
  ["unbound generation ID", input => { input.metadata.generationId = "diagnostic"; }],
  ["unbounded attempt ID", input => { input.metadata.alignmentAttemptId = "a".repeat(1000); }],
  ["invalid occurrence timestamp", input => { input.metadata.occurrenceId = "900000001@2026-99-99T12:00:00Z"; }],
  ["nonfinite revision", input => { input.metadata.artifactRevision = NaN; }],
  ["wrong raw count", input => { input.metadata.rawRows = 0; }],
  ["wrong disclosure", input => { input.metadata.disclosure = "unavailable"; }],
  ["wrong sample count", input => { input.metadata.capture.samples = "-24000"; }],
  ["wrong frame extent", input => { input.metadata.capture.lastFrame = "49"; }],
  ["wrong sample extent", input => { input.metadata.capture.sourceEndSample = "23999"; }],
  ["path frame range", input => { input.metadata.capture.firstFrame = "/private/path"; }],
  ["silent S summary", input => { input.metadata.summaries.S = true; }],
  ["missing A summary", input => { input.metadata.summaries.A = false; }],
  ["empty attendance", input => { input.metadata.attendance[0].attendance = []; }],
  ["wrong attendee identity", input => { input.metadata.attendance[1].person_id = "diagnostic"; }],
  ["invalid attendance timestamp", input => { input.metadata.attendance[0].attendance[0].joined_at = "header"; }],
  ["merged attendance intervals", input => { input.metadata.attendance[0].attendance[0].left_at = input.metadata.attendance[0].attendance[1].left_at; }],
  ["arbitrary warning", input => { input.metadata.warnings.push("secret_diagnostic"); }],
  ["unknown metadata key", input => { input.metadata.secret = "secret"; }],
];
for (const [name, mutate] of reportMutations) test(`safe report refuses ${name} before serialization`, async () => {
  const l4 = await load(), input = await reportInput(); mutate(input);
  assert.throws(() => l4.l4Report(input), /^Error: l4_report_input_refused$/);
});
test("safe report never certifies empty missing blocked skipped or failed required checks", async () => {
  const l4 = await load(), input = await reportInput();
  for (const checks of [[], input.checks.slice(1), ...["blocked", "skipped", "fail"].map(status => input.checks.map(row => row.name === "l4_selected_campaign" ? { ...row, status } : row))]) {
    assert.equal(l4.l4Report({ ...input, checks }).disposition, "prerequisite-failed-or-unknown");
  }
  for (const name of ["no_key_or_plaintext_audio", "no_orphan_process", "no_closed_store_callback", "single_occurrence_identity"]) {
    assert.equal(l4.l4Report({ ...input, checks: input.checks.filter(row => row.name !== name) }).disposition, "prerequisite-failed-or-unknown");
  }
});
test("submitted session configuration refuses nested getters before reading any property", async () => {
  const l4 = await load();
  for (const [path, key] of [[[], "type"], [["audio"], "input"], [["audio", "input"], "format"], [["audio", "input", "format"], "type"], [["audio", "input", "format"], "rate"]] as const) {
    let calls = 0; const session = { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24000 } } } };
    let row: Record<string, unknown> = session; for (const key of path) row = row[key] as Record<string, unknown>;
    Object.defineProperty(row, key, { enumerable: true, get() { calls++; return "transcription"; } });
    const tracker = l4.createSubmittedFrameTracker(); tracker.connect("one"); tracker.update("one", session);
    assert.equal(calls, 0); assert.equal(tracker.snapshot().valid, false);
  }
});
test("safe report refuses nested accessors custom arrays and inherited serialization before effects", async () => {
  const l4 = await load(); let calls = 0;
  const getter = await reportInput(); Object.defineProperty(getter.metadata.capture, "samples", { get() { calls++; return "24000"; } });
  assert.throws(() => l4.l4Report(getter), /^Error: l4_report_input_refused$/);
  const custom = await reportInput(); Object.setPrototypeOf(custom.metadata.warnings, Object.create(Array.prototype, { toJSON: { value() { calls++; return []; } } }));
  assert.throws(() => l4.l4Report(custom), /^Error: l4_report_input_refused$/);
  const sparse = await reportInput(); sparse.metadata.attendance = new Array(2);
  assert.throws(() => l4.l4Report(sparse), /^Error: l4_report_input_refused$/); assert.equal(calls, 0);
});

const actualOutputRows: Array<[string, Record<string, unknown>]> = [
  ...["accepted", "rendered", "flushed"].map(state => ["playback " + state, { type: "voice_playback", session_id: "41", generation_id: "7", state }] as [string, Record<string, unknown>]),
  ...["response_authorized", "first_text_delta", "first_synthesis_request", "first_playable_audio", "first_sidecar_accept", "playback_render_acknowledged", "barge_in_onset", "barge_in_threshold", "playback_flush_acknowledged"].map(milestone => ["timing " + milestone, { type: "voice_timing", session_id: "41", turn_id: null, milestone }] as [string, Record<string, unknown>]),
  ...["turn_started", "transcript_final", "quality_resolved", "memory_retrieved", "text_delta", "text_completed", "speech_started", "speech_completed", "timing", "turn_completed", "turn_cancelled", "turn_failed"].map(type => ["reply " + type, { type: "voice_turn_event", session_id: "41", generation_id: "7", event: { type, turn_id: "7" } }] as [string, Record<string, unknown>]),
  ["recognition timing with turn ID", { type: "voice_timing", session_id: "41", turn_id: "7", milestone: "transcript_final" }],
];
for (const [name, row] of actualOutputRows) test(`actual pinned ${name} is rejected by final output oracle`, async () => {
  const l4 = await load(), input = await component(); await l4.verifyL4Evidence(input, codecs);
  input.runtimeEvents.push(row as typeof input.runtimeEvents[number]);
  await assert.rejects(l4.verifyL4Evidence(input, codecs), /^Error: l4_unexpected_speech$/);
});
test("shared actual output predicate allows input recognition activity skip and cleanup diagnostics", async () => {
  const l4 = await load(); assert.equal(typeof l4.l4HasLiveOutput, "function");
  assert.equal(l4.l4HasLiveOutput([{ type: "voice_activity", activity: { type: "speech_started", at_ms: 0 } },
    ...["audio_received", "speech_end", "transcript_final", "cleanup"].map(milestone => ({ type: "voice_timing", turn_id: null, milestone })),
    { type: "voice_transcript_partial" }, { type: "voice_transcript_final" }, { type: "response_skipped" }]), false);
});
test("actual selected driver rejects pinned playback before any selected transcript emission", async () => {
  const l4 = await load(); let sent = 0;
  await assert.rejects(l4.driveL4Capture({ l4Case: "sent-named", provider: { submitted: { ready: true, valid: true }, transcript() { sent++; } },
    child: () => ({ joined: true, mediaConnected: true, l4: { origin }, observationPlan: { emitted: 6 } }),
    runtimeEvents: () => [{ type: "voice_playback", session_id: "41", generation_id: "7", state: "accepted" }],
    waitFor: async (check: () => unknown) => check(), nowHostNs: () => BigInt(origin.hostNs) + 1400000000n, budgetMs: 10 }), /^Error: l4_runtime_decision_refused$/);
  assert.equal(sent, 0);
});
test("safe report rejects coherent extra occurrence suffix and non-whole UTC spelling", async () => {
  const l4 = await load();
  for (const occurrence of ["1@2026-10-06T15:00:00Z@PRIVATE_SENTINEL", "1@2026-10-06T15:00:00.000Z", "1@2026-10-06T15:00:00+00:00"]) {
    const input = await reportInput(); input.metadata.occurrenceId = occurrence;
    input.metadata.generationId = Buffer.from(occurrence).toString("hex") + ":" + Buffer.from(input.metadata.bridgeSessionId).toString("hex");
    assert.throws(() => l4.l4Report(input), /^Error: l4_report_input_refused$/);
  }
});

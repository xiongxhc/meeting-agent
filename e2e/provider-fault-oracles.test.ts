import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAlignmentPage, pageWarnings, decodeAlignmentPage, ALIGNMENT_POLICY } from "../src/sessions/recording-alignment.ts";
// @ts-expect-error Test-only oracle has no public declaration.
import { providerFaultOracles, providerFaultMetadata, providerFaultPlan, PROVIDER_FAULT_CUTS, PROVIDER_FAULT_SPEAKING, FAILURE_AFTER_TERMINAL_NS } from "./provider-fault-oracles.mjs";
// @ts-expect-error Test-only oracle has no public declaration.
import { captureTailOracles } from "./durable-oracles.mjs";

// Synthetic evidence in the shapes the run keeps; predicate coverage, not integration proof.
type Entry = ReturnType<typeof decodeAlignmentPage>["entries"][number];
const FRAMES = 150, FAILURE_AT = 40;
const position = (sequence: number) => ({ captureEpoch: "1", sequence: String(sequence), outputEndSample: String(sequence * 480) });

function frames(count: number): Entry[] {
  const epoch = { bridgeSessionId: "bridge-fixture", clockDomainId: "e2e-clock", captureEpoch: 1n };
  return Array.from({ length: count }, (_, i) => {
    const start = BigInt(i * 480), host = 1_000_000_000n + BigInt(i) * 20_000_000n;
    return { kind: "frame" as const, mediaStartSample: start, mediaEndSample: start + 480n, sampleRateHz: 24000, gapOffsetMs: 0n,
      epoch, provenance: { captureEpoch: 1n, sequence: BigInt(i + 1), outputStartSample: start, sampleCount: 480,
        sourceStartNumerator: start * 24000n, sourceEndNumerator: (start + 480n) * 24000n, sourceDenominator: 24000, sourceRateHz: 24000,
        quality: "nominal_frame_endpoint_interpolation" as const, span: { hostStartNs: host, hostEndNs: host + 20_000_000n,
          roundingEnvelopeNs: 1000n, captureUncertaintyNs: null } }, captureStatus: "available" as const, wall: null,
      reasons: ["wall_alignment_missing" as const] };
  });
}

function fixture(cut = "provider-error") {
  const occurrence = "9007199254740993@2026-10-01T10:00:00Z";
  const source = { sourceSessionId: 42n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64) };
  const snapshot = {
    occurrence, live: [] as unknown[],
    recordings: [{ occurrence_id: occurrence, handle: source.recordingHandle, sha256: source.sha256, key_id: "c".repeat(16),
      duration_ms: FRAMES * 20, format: "pcm_s16le/24000/1", capture_drain: "confirmed" }],
    gaps: [] as Array<{ direction: string }>, runtimeGaps: [] as unknown[],
    bindings: [{ generation_id: "g", occurrence_id: occurrence, bridge_session_id: "bridge-fixture", source_session_id: "42",
      recording_handle: source.recordingHandle, sha256: source.sha256, key_id: "c".repeat(16), recording_kind: "final" }],
    selected: [{ generation_id: "g", attempt_id: "attempt" }],
    attempts: [{ generation_id: "g", attempt_id: "attempt", source_session_id: "42", recording_handle: source.recordingHandle,
      sha256: source.sha256, key_id: "c".repeat(16), timing_contract: "capture-clock/v1", state: "complete", page_count: 0, entry_count: 0,
      stored_bytes: 0, coverage_status: "partial", warnings_json: "[]" }],
    pages: [] as Array<{ attempt_id: string; page_index: number; entry_count: number; payload: string }>,
  };
  const setEntries = (entries: Entry[]) => {
    const chunks: Entry[][] = [];
    for (let i = 0; i < entries.length; i += 25) chunks.push(entries.slice(i, i + 25));
    snapshot.pages = chunks.map((chunk, i) => ({ attempt_id: "attempt", page_index: i, entry_count: chunk.length,
      payload: encodeAlignmentPage({ type: "recording_alignment_page", source, policy: ALIGNMENT_POLICY, pageIndex: BigInt(i), entries: chunk }) }));
    Object.assign(snapshot.attempts[0]!, { page_count: chunks.length, entry_count: entries.length,
      stored_bytes: snapshot.pages.reduce((n, p) => n + Buffer.byteLength(p.payload), 0),
      warnings_json: JSON.stringify([...new Set(snapshot.pages.flatMap(p => pageWarnings(decodeAlignmentPage(p.payload))))].sort()) });
    const last = entries.filter(e => e.kind === "frame").at(-1);
    snapshot.recordings[0]!.duration_ms = last?.kind === "frame" ? Number(last.mediaEndSample * 1000n / 24000n) : 0;
  };
  setEntries(frames(FRAMES));
  const boundary = { ...position(FRAMES), lastFrameSequence: String(FRAMES), finalClockPairSequence: "3" };
  delete (boundary as { sequence?: string }).sequence;
  const connect = cut === "provider-connect";
  const mode = PROVIDER_FAULT_CUTS[cut];
  const childState = { left: "ended", endObservation: { observationTiming: { hostBeforeNs: "900", hostAfterNs: "901" } },
    leave: { reason: "meeting_ended", monotonicNs: "950" } as { reason: string; monotonicNs: string } | null,
    commands: ["join", "connect_media", "post_disclosure", "leave"], framesSent: FRAMES, capturePosition: position(FRAMES),
    flushes: [] as Array<{ generation: string }>, withheldFlushes: [] as Array<{ generation: string }>,
    captureDrain: { drain: "confirmed", reason: null, boundary } };
  const observed = { name: "provider_fault_observed", mode, armedMonotonicNs: connect ? "10" : "100",
    armedCapture: position(connect ? 0 : 20), captureAtFailure: position(FAILURE_AT), captureAfterFailure: position(FAILURE_AT + 100),
    fault: { mode, monotonicNs: connect ? "10" : "110", appendedBefore: connect ? 0 : 30, refusedConnections: connect ? 1 : 0, appendedAfterFault: 0 },
    failureMonotonicNs: "200", failureSessionId: "42",
    speaking: null as null | { turn: string; generation: string; sessionId: string; withholdFlushAck: boolean } };
  const speaking = Object.hasOwn(PROVIDER_FAULT_SPEAKING, cut);
  const events = [observed, { name: "meeting_ended_signalled", monotonicNs: "800" }];
  const runtimeEvents: Array<Record<string, unknown>> = [{ type: "voice_session_failed", session_id: "42", monotonicNs: "200" }];
  if (speaking) {
    observed.speaking = { turn: "9", generation: "9", sessionId: "42", withholdFlushAck: PROVIDER_FAULT_SPEAKING[cut] };
    // The Runtime ends the held answer, then publishes the failure that interrupted it.
    runtimeEvents.push({ session_id: "42", generation_id: "9", event: { type: "turn_cancelled", turn_id: "9" }, monotonicNs: "190" });
    (PROVIDER_FAULT_SPEAKING[cut] ? childState.withheldFlushes : childState.flushes).push({ generation: "9" });
  }
  const row = (fields: Record<string, unknown>) => ({ observerPid: 7, ...fields });
  const lifecycle = { status: "present", rows: [
    row({ event: "voice", type: "voice_session_started", session_id: "42", monotonicNs: "50" }),
    row({ event: "voice", type: "voice_session_failed", session_id: "42", recovery: "continue_session",
      error: { code: "provider_failed", kind: "provider", stage: "speech_recognizer" }, monotonicNs: "200" }),
    row({ event: "client_command", type: "finalize_recording", request_id: "request-7", monotonicNs: "850" }),
    row({ event: "gateway_message", type: "recording_finalized", request_id: "request-7", monotonicNs: "860" }),
    row({ event: "voice", type: "voice_session_ended", session_id: "42", monotonicNs: "870" }),
    row({ event: "gateway_exit", code: 0, signal: null, monotonicNs: "990" }),
  ] as Array<Record<string, unknown>> };
  if (PROVIDER_FAULT_SPEAKING[cut] === true) {
    runtimeEvents.push({ type: "voice_session_failed", session_id: "42", monotonicNs: "201" });
    lifecycle.rows.splice(2, 0, row({ event: "voice", type: "voice_session_failed", session_id: "42", recovery: "continue_session",
      error: { code: "adapter_failure", kind: "adapter", stage: "continuous_audio_output" }, monotonicNs: "201" }));
  }
  const artifact = { meeting: { recording_gaps: [] as unknown[], processing_warnings: [] as Array<{ code: string }> } };
  const summary = { interactiveConnections: { recognition: connect ? 0 : 1 } };
  return { cut, events, runtimeEvents, lifecycle, childState, snapshot, artifact, summary, observed, setEntries };
}
const failing = (f: ReturnType<typeof fixture>) =>
  providerFaultOracles(f).filter((row: { status: string }) => row.status === "fail").map((row: { name: string }) => row.name);

for (const cut of Object.keys(PROVIDER_FAULT_CUTS)) test(`${cut}: every provider-fault oracle passes on uninterrupted recording`, () => {
  const f = fixture(cut), rows = providerFaultOracles(f);
  assert.deepEqual(rows.map((row: { name: string }) => row.name), ["provider_fault_injected", "provider_fault_distinct_event",
    "voice_session_survives_provider_fault", "no_bridge_leave_on_provider_fault", "recorded_capture_after_provider_fault",
    ...(Object.hasOwn(PROVIDER_FAULT_SPEAKING, cut) ? ["speaking_turn_ends_once_on_provider_fault"] : []), "provider_fault_not_a_recording_gap"]);
  assert.deepEqual(failing(f), [], JSON.stringify(rows));
  const metadata = providerFaultMetadata(f);
  assert.deepEqual(metadata.runtimeFailures.map((row: { error: { stage: string } }) => row.error.stage),
    PROVIDER_FAULT_SPEAKING[cut] === true ? ["speech_recognizer", "continuous_audio_output"] : ["speech_recognizer"]);
  assert.equal(metadata.artifactRecordingGaps, 0);
});

test("RED: a harness that drops recorded frames after the failure fails the post-fault and tail oracles", () => {
  const f = fixture();
  f.setEntries(frames(FRAMES).filter(e => e.kind === "frame" && e.provenance!.sequence <= BigInt(FAILURE_AT)));
  assert.deepEqual(failing(f), ["recorded_capture_after_provider_fault"]);
  assert.equal(captureTailOracles(f.snapshot, f.childState)[0].status, "fail");
  const hole = fixture();
  hole.setEntries(frames(FRAMES).filter(e => e.kind === "frame" && e.provenance!.sequence !== BigInt(FAILURE_AT + 5)));
  assert.ok(failing(hole).includes("recorded_capture_after_provider_fault"));
});

test("RED: capture that stops at the failure fails the post-fault oracle", () => {
  const f = fixture();
  f.setEntries(frames(FAILURE_AT + 10));
  Object.assign(f.childState.captureDrain.boundary, { lastFrameSequence: String(FAILURE_AT + 10), outputEndSample: String((FAILURE_AT + 10) * 480) });
  assert.deepEqual(failing(f), ["recorded_capture_after_provider_fault"]);
});

test("RED: Runtime ending the voice session on the failure fails the session oracle", () => {
  const ended = fixture();
  ended.lifecycle.rows.splice(2, 0, { observerPid: 7, event: "voice", type: "voice_session_ended", session_id: "42", monotonicNs: "210" });
  assert.ok(failing(ended).includes("voice_session_survives_provider_fault"));
  const fatal = fixture();
  fatal.lifecycle.rows[1]!.recovery = "new_session";
  assert.ok(failing(fatal).includes("provider_fault_distinct_event"));
  assert.ok(failing(fatal).includes("voice_session_survives_provider_fault"));
  const replaced = fixture();
  replaced.lifecycle.rows.push({ observerPid: 7, event: "voice", type: "voice_session_started", session_id: "43", monotonicNs: "300" });
  assert.ok(failing(replaced).includes("voice_session_survives_provider_fault"));
});

test("RED: Meeting stopping, finalizing or leaving on the failure fails its oracle", () => {
  const leave = fixture();
  leave.childState.leave = { reason: "meeting_ended", monotonicNs: "300" };
  assert.deepEqual(failing(leave), ["no_bridge_leave_on_provider_fault"]);
  const other = fixture();
  other.childState.leave = { reason: "other", monotonicNs: "950" };
  assert.deepEqual(failing(other), ["no_bridge_leave_on_provider_fault"]);
  const stop = fixture();
  stop.lifecycle.rows.splice(2, 0, { observerPid: 7, event: "client_command", type: "stop_voice_session", request_id: "request-5", monotonicNs: "300" });
  assert.ok(failing(stop).includes("voice_session_survives_provider_fault"));
});

test("the failure must be its own traced event after the fault and never a recording gap", () => {
  const absent = fixture();
  absent.lifecycle.rows.splice(1, 1); absent.runtimeEvents.length = 0;
  assert.ok(failing(absent).includes("provider_fault_distinct_event"));
  const stage = fixture();
  (stage.lifecycle.rows[1]!.error as { stage: string }).stage = "media";
  assert.ok(failing(stage).includes("provider_fault_distinct_event"));
  const early = fixture();
  early.observed.failureMonotonicNs = "90"; early.runtimeEvents[0]!.monotonicNs = "90"; early.lifecycle.rows[1]!.monotonicNs = "90";
  assert.ok(failing(early).includes("provider_fault_distinct_event"));
  const gap = fixture();
  gap.snapshot.runtimeGaps.push({ started_at_ms: "800", ended_at_ms: "900", reason: "capture_discontinuity" });
  assert.deepEqual(failing(gap), ["provider_fault_not_a_recording_gap"]);
  const artifactGap = fixture();
  artifactGap.artifact.meeting.recording_gaps.push({ started_at: "a", ended_at: "b", reason: "provider" });
  assert.deepEqual(failing(artifactGap), ["provider_fault_not_a_recording_gap"]);
});

test("injection evidence must match the selected fault", () => {
  const connected = fixture("provider-connect");
  connected.summary.interactiveConnections.recognition = 1;
  assert.deepEqual(failing(connected), ["provider_fault_injected"]);
  const wrong = fixture("provider-stall");
  wrong.observed.fault.mode = "error";
  assert.deepEqual(failing(wrong), ["provider_fault_injected"]);
  const missing = fixture();
  missing.events.splice(0, 1);
  assert.ok(failing(missing).includes("provider_fault_injected"));
});

test("RED: same frame count but broken contiguity fails the per-frame checks", () => {
  const replace = (at: number, change: (frame: Entry & { kind: "frame" }) => Entry) => {
    const f = fixture(), list = frames(FRAMES);
    list[at - 1] = change(list[at - 1] as Entry & { kind: "frame" });
    f.setEntries(list);
    return f;
  };
  const duplicate = replace(45, () => frames(FRAMES)[43]!);
  const status = replace(60, frame => ({ ...frame, captureStatus: "capture_alignment_missing" as const }));
  const jump = replace(70, frame => ({ ...frame, mediaStartSample: frame.mediaStartSample + 1n, mediaEndSample: frame.mediaEndSample + 1n }));
  const missing = replace(80, frame => ({ ...frame, reasons: [...frame.reasons, "audio_missing" as never] }));
  for (const f of [duplicate, status, jump, missing]) assert.ok(failing(f).includes("recorded_capture_after_provider_fault"), JSON.stringify(failing(f)));
});

test("speaking cuts: the held answer must end once after the failure and its flush must reach the bridge", () => {
  for (const cut of Object.keys(PROVIDER_FAULT_SPEAKING)) {
    const none = fixture(cut); none.runtimeEvents.splice(1, 1);
    assert.deepEqual(failing(none), ["speaking_turn_ends_once_on_provider_fault"]);
    const twice = fixture(cut); twice.runtimeEvents.push({ ...twice.runtimeEvents[1]!, monotonicNs: "240" });
    assert.deepEqual(failing(twice), ["speaking_turn_ends_once_on_provider_fault"]);
    const before = fixture(cut); before.runtimeEvents[1]!.monotonicNs = "105";
    assert.deepEqual(failing(before), ["speaking_turn_ends_once_on_provider_fault"]);
    const early = fixture(cut); early.observed.fault.monotonicNs = "-1000000000"; early.observed.armedMonotonicNs = "-1000000000";
    early.runtimeEvents[1]!.monotonicNs = String(200n - FAILURE_AFTER_TERMINAL_NS - 1n);
    assert.deepEqual(failing(early), ["speaking_turn_ends_once_on_provider_fault"]);
    const edge = fixture(cut); edge.observed.fault.monotonicNs = "-1000000000"; edge.observed.armedMonotonicNs = "-1000000000";
    edge.runtimeEvents[1]!.monotonicNs = String(200n - FAILURE_AFTER_TERMINAL_NS);
    assert.deepEqual(failing(edge), []);
    const late = fixture(cut); late.runtimeEvents[1]!.monotonicNs = String(200n + FAILURE_AFTER_TERMINAL_NS + 1n);
    assert.deepEqual(failing(late), ["speaking_turn_ends_once_on_provider_fault"]);
    const lateEdge = fixture(cut); lateEdge.runtimeEvents[1]!.monotonicNs = String(200n + FAILURE_AFTER_TERMINAL_NS);
    assert.deepEqual(failing(lateEdge), []);
    const noFlush = fixture(cut); noFlush.childState.flushes.length = 0; noFlush.childState.withheldFlushes.length = 0;
    assert.deepEqual(failing(noFlush), ["speaking_turn_ends_once_on_provider_fault"]);
    const notSpeaking = fixture(cut); notSpeaking.observed.speaking = null;
    assert.deepEqual(failing(notSpeaking), ["speaking_turn_ends_once_on_provider_fault"]);
  }
});

test("a playback failure is accepted only as the withheld flush, once, beside a recognition failure", () => {
  const playback = (f: ReturnType<typeof fixture>, monotonicNs: string, error = { code: "adapter_failure", kind: "adapter", stage: "continuous_audio_output" }) => {
    f.runtimeEvents.push({ type: "voice_session_failed", session_id: "42", monotonicNs });
    f.lifecycle.rows.splice(2, 0, { observerPid: 7, event: "voice", type: "voice_session_failed", session_id: "42", recovery: "continue_session", error, monotonicNs });
    return f;
  };
  for (const cut of ["provider-error", "provider-stall", "provider-error-speaking"])
    assert.deepEqual(failing(playback(fixture(cut), "202")), ["provider_fault_distinct_event"], cut);
  assert.deepEqual(failing(playback(fixture("provider-error-speaking-flush-timeout"), "202")), ["provider_fault_distinct_event"]);
  const unreported = fixture("provider-error-speaking-flush-timeout");
  unreported.lifecycle.rows.splice(2, 1); unreported.runtimeEvents.pop();
  assert.deepEqual(failing(unreported), ["provider_fault_distinct_event"]);
  const playbackOnly = fixture("provider-error-speaking-flush-timeout");
  playbackOnly.lifecycle.rows.splice(1, 1); playbackOnly.runtimeEvents.splice(0, 1); playbackOnly.observed.failureMonotonicNs = "201";
  assert.deepEqual(failing(playbackOnly), ["provider_fault_distinct_event"]);
});

test("RED: a runtime-stage invalid_state and an unended held answer fail the event and speaking oracles", () => {
  const f = fixture("provider-error-speaking-flush-timeout");
  f.lifecycle.rows[2]!.error = { code: "invalid_state", kind: "invalid_state", stage: "runtime" };
  f.runtimeEvents.splice(1, 1);
  assert.deepEqual(failing(f), ["provider_fault_distinct_event", "speaking_turn_ends_once_on_provider_fault"]);
});

test("RED: the C1 shape (Fatal on a withheld flush, new_session, capture refused) fails the session, event and capture oracles", () => {
  const f = fixture("provider-error-speaking-flush-timeout");
  f.lifecycle.rows[1]!.recovery = "new_session";
  f.lifecycle.rows.splice(2, 0, { observerPid: 7, event: "voice", type: "voice_session_ended", session_id: "42", monotonicNs: "2300" });
  f.runtimeEvents.splice(1, 1, { session_id: "42", generation_id: "9", event: { type: "turn_failed", turn_id: "9" }, monotonicNs: "2290" });
  f.setEntries(frames(FAILURE_AT + 10));
  Object.assign(f.childState.captureDrain.boundary, { lastFrameSequence: String(FAILURE_AT + 10), outputEndSample: String((FAILURE_AT + 10) * 480) });
  const failed = failing(f);
  for (const name of ["provider_fault_distinct_event", "voice_session_survives_provider_fault", "recorded_capture_after_provider_fault"])
    assert.ok(failed.includes(name), `${name}: ${JSON.stringify(failed)}`);
});

test("drive plan fields follow the cut", () => {
  assert.deepEqual(providerFaultPlan("durable"), {}); assert.deepEqual(providerFaultPlan(null), {});
  assert.deepEqual(providerFaultPlan("provider-stall"), { providerFault: "stall" });
  assert.deepEqual(providerFaultPlan("provider-error-speaking"), { providerFault: "error", providerFaultSpeaking: true, providerFaultWithholdFlushAck: false });
  assert.deepEqual(providerFaultPlan("provider-error-speaking-flush-timeout"), { providerFault: "error", providerFaultSpeaking: true, providerFaultWithholdFlushAck: true });
});

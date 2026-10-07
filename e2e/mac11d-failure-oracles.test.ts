import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecordingAlignmentPage } from "@conversation/runtime";
import { pageWarnings } from "../src/sessions/recording-alignment.ts";
// @ts-expect-error Test-only JavaScript oracle has no public declaration.
import { parseCalibrationFailureMetadata, runCalibrationFailureOracles } from "./mac11d-failure-oracles.mjs";

type Scenario = "native-primary" | "unconfirmed-cleanup-write" | "expiry-rollback";
type FixtureEpoch = { captureEpoch: bigint; bridgeSessionId: string; clockDomainId: string };
type FixtureFrame = { kind: "frame"; epoch: FixtureEpoch; captureStatus: string; sampleRateHz: number; gapOffsetMs: bigint;
  mediaStartSample: bigint; mediaEndSample: bigint; wall: object | null; reasons: string[];
  provenance: { captureEpoch: bigint; sequence: bigint; outputStartSample: bigint; sampleCount: number;
    quality: string; span: object | null } };
type FixtureEntry = FixtureFrame | { kind: "epoch"; epoch: FixtureEpoch }
  | { kind: "clock_pair"; pair: { sequence: bigint; clockDomainId: string } }
  | { kind: "discontinuity"; captureEpoch: bigint; reason: string }
  | { kind: "audio_gap"; startedAtMs: bigint; endedAtMs: bigint | null; reason: string };
type FixtureEvent = { type: string; sessionId: string; sequence: number; reason?: string;
  captureDrain?: { drain: string; reason: string; boundary: null } };
function fixture(scenario: Scenario = "native-primary") {
  const expiry = scenario === "expiry-rollback", unconfirmed = scenario === "unconfirmed-cleanup-write";
  const schema = expiry ? "mac11d-expiry/v1" : unconfirmed ? "mac11d-unconfirmed/v1" : "mac11d-native/v1";
  const drain = { drain: "unconfirmed", reason: "drain_not_attempted", boundary: null };
  const custody = { outcome: expiry ? "departure_confirmed" : "departure_unconfirmed", reason: expiry ? "departure_observed" : "cleanup_failed" };
  const result: Record<string, unknown> = { schema, type: "result", captureStarts: 1, captureStops: unconfirmed ? 2 : 1,
    outputStarts: 1, outputStops: 1, emittedBuffers: expiry ? 181 : 3, emittedSamples: expiry ? 86537 : 1097,
    cleanupConfirmed: expiry, captureDrain: drain, departureOutcome: custody.outcome, departureReason: custody.reason,
    connectionsCreated: 1, ...(expiry ? { openedConnections: 1, captureWrites: 180, clockPairWrites: 2,
      injectedWriteFailures: 1, expiredCaptureWrites: 80, rollbackApplied: true } : {
      nativeFailures: unconfirmed ? 0 : 1, delayedStops: unconfirmed ? 1 : 0,
      lateStopCompletions: unconfirmed ? 1 : 0, pendingStopCompletions: 0,
      ...(unconfirmed ? { openedConnections: 1, captureWrites: 2, clockPairWrites: 1, injectedWriteFailures: 1,
        heldReads: 1, releasedHeldReads: 1, pendingHeldReads: 0 } : {}) }) };
  const names = ["child_ready", "output_started", "capture_started", "capture_emission_complete",
    ...(expiry ? ["wall_rollback", "expiry_transport_fault"] : unconfirmed ? ["transport_write_fault"] : ["native_primary_fault"]),
    "capture_stopped", ...(unconfirmed ? ["native_stop_completion_late", "output_stopped", "capture_stopped"] : ["output_stopped"]), "control_finished"];
  const source = { sourceSessionId: 42n, recordingHandle: "opaque", sha256: "a".repeat(64) };
  const epoch = { captureEpoch: 1n, bridgeSessionId: "mac11d", clockDomainId: "synthetic-host" };
  const entries: FixtureEntry[] = [{ kind: "epoch", epoch }, { kind: "clock_pair", pair: { sequence: 1n, clockDomainId: epoch.clockDomainId } }];
  for (let index = 0; index < (expiry ? 180 : 2); index++) entries.push({ kind: "frame", epoch,
    captureStatus: "available", sampleRateHz: 24000, gapOffsetMs: 0n, mediaStartSample: BigInt(index * 480),
    mediaEndSample: BigInt((index + 1) * 480), wall: null, reasons: ["missing_clock_pair", "wall_alignment_missing"],
    provenance: { captureEpoch: 1n, sequence: BigInt(index + 1), outputStartSample: BigInt(index * 480), sampleCount: 480,
      quality: "nominal_frame_endpoint_interpolation", span: {} } });
  if (expiry) entries.push({ kind: "clock_pair", pair: { sequence: 2n, clockDomainId: epoch.clockDomainId } });
  else entries.push({ kind: "discontinuity", captureEpoch: 1n, reason: "reconnect" },
    { kind: "audio_gap", startedAtMs: 40n, endedAtMs: null, reason: "capture_discontinuity" });
  const pages = [];
  for (let offset = 0; offset < entries.length; offset += 64) pages.push({ type: "recording_alignment_page", source,
    pageIndex: BigInt(pages.length), entries: entries.slice(offset, offset + 64) });
  const events: FixtureEvent[] = [{ type: "media_connected", sessionId: "mac11d", sequence: 1 },
    { type: "media_disconnected", sessionId: "mac11d", sequence: 2, reason: expiry ? "media_transport_interrupted" : "media_cleanup_unconfirmed" },
    { type: "media_disconnected", sessionId: "mac11d", sequence: 3, captureDrain: drain }];
  return { scenario, result, drain, sessionId: 42n, bridgeSessionId: "mac11d", expiredCredentialRefused: true,
    records: [...names.map(name => ({ schema, type: "barrier", name })), result],
    events,
    shutdown: { reaped: true, failure: null, outcome: custody },
    finalized: { recordingHandle: "opaque", sha256: source.sha256, durationMs: expiry ? 3600n : 40n, format: "pcm_s16le/24000/1" },
    pages, complete: { type: "recording_alignment_complete", source, pageCount: BigInt(pages.length), traversalSucceeded: true,
      coverageStatus: "partial", warnings: ["missing_clock_pair", "wall_alignment_missing", ...(expiry ? [] : ["reconnect", "audio_missing"])] } };
}
const encode = (rows: unknown[]) => rows.map(row => JSON.stringify(row) + "\n").join("");
const scenarios: Scenario[] = ["native-primary", "unconfirmed-cleanup-write", "expiry-rollback"];
function coherentWarnings(f: ReturnType<typeof fixture>) {
  f.complete.warnings = [...new Set(f.pages.flatMap(page => pageWarnings(page as unknown as RecordingAlignmentPage)))].sort();
}

test("native and unconfirmed EOF closures bind the open gap to the authenticated 960-sample prefix", () => {
  for (const scenario of ["native-primary", "unconfirmed-cleanup-write"] as const) {
    const f = fixture(scenario);
    assert.deepEqual(f.pages[0]!.entries.slice(-2), [{ kind: "discontinuity", captureEpoch: 1n, reason: "reconnect" },
      { kind: "audio_gap", startedAtMs: 40n, endedAtMs: null, reason: "capture_discontinuity" }]);
    const proof = runCalibrationFailureOracles(f);
    assert.equal(proof.recordedSamples, "960"); assert.equal(proof.prefixComplete, false);
    assert.equal(proof.nativeCleanup, "unconfirmed"); assert.equal(proof.custody, "departure_unconfirmed");
  }
});
for (const scenario of ["native-primary", "unconfirmed-cleanup-write"] as const)
  for (const fault of ["missing_marker", "missing_gap", "duplicate_marker", "duplicate_gap", "marker_reason", "marker_epoch",
    "gap_reason", "closed_gap", "wrong_start", "reversed", "marker_before_frame", "pair_after_marker", "gap_before_frame", "after_gap", "unexpected_kind"] as const) {
    test(`${scenario} rejects ${fault} at the terminal prefix predicate`, () => {
      const f = fixture(scenario), entries = f.pages[0]!.entries;
      const marker = entries.find((entry): entry is Extract<FixtureEntry, { kind: "discontinuity" }> => entry.kind === "discontinuity")!;
      const gap = entries.find((entry): entry is Extract<FixtureEntry, { kind: "audio_gap" }> => entry.kind === "audio_gap")!;
      const lastFrame = entries.findLast(entry => entry.kind === "frame")!;
      let failure = /terminal discontinuity count/;
      if (fault === "missing_marker") entries.splice(entries.indexOf(marker), 1);
      if (fault === "missing_gap") { entries.splice(entries.indexOf(gap), 1); failure = /terminal gap count/; }
      if (fault === "duplicate_marker") entries.splice(-1, 0, structuredClone(marker));
      if (fault === "duplicate_gap") { entries.push(structuredClone(gap)); failure = /terminal gap count/; }
      if (fault === "marker_reason") { marker.reason = "pause"; failure = /terminal discontinuity reason/; }
      if (fault === "marker_epoch") { marker.captureEpoch = 2n; failure = /terminal discontinuity epoch/; }
      if (fault === "gap_reason") { gap.reason = "recording_failed"; failure = /terminal gap reason/; }
      if (fault === "closed_gap") { gap.endedAtMs = 41n; failure = /terminal gap must remain open/; }
      if (fault === "wrong_start") { gap.startedAtMs = 45n; failure = /terminal gap start disagrees with authenticated prefix/; }
      if (fault === "reversed") {
        const a = entries.indexOf(marker), b = entries.indexOf(gap); [entries[a], entries[b]] = [gap, marker]; failure = /terminal gap order/;
      }
      if (fault === "marker_before_frame" || fault === "gap_before_frame") {
        const selected = fault === "marker_before_frame" ? marker : gap;
        entries.splice(entries.indexOf(selected), 1); entries.splice(entries.indexOf(lastFrame), 0, selected);
        failure = fault === "marker_before_frame" ? /terminal discontinuity precedes authenticated prefix/ : /terminal gap order/;
      }
      if (fault === "pair_after_marker") {
        entries.splice(-1, 0, { kind: "clock_pair", pair: { sequence: 2n, clockDomainId: "synthetic-host" } });
        if (scenario === "unconfirmed-cleanup-write") f.result.clockPairWrites = 2;
        failure = /terminal discontinuity precedes authenticated prefix/;
      }
      if (fault === "after_gap") {
        entries.push({ kind: "clock_pair", pair: { sequence: 2n, clockDomainId: "synthetic-host" } });
        if (scenario === "unconfirmed-cleanup-write") f.result.clockPairWrites = 2;
        failure = /terminal gap must be final entry/;
      }
      if (fault === "unexpected_kind") { entries.push({ kind: "alignment_limit" } as never); failure = /fabricated source loss or recovery/; }
      coherentWarnings(f);
      assert.throws(() => runCalibrationFailureOracles(f), failure);
    });
  }
test("expiry keeps the original three-kind recording contract", () => {
  for (const extra of [{ kind: "discontinuity", captureEpoch: 1n, reason: "reconnect" },
    { kind: "audio_gap", startedAtMs: 3600n, endedAtMs: null, reason: "capture_discontinuity" }] as FixtureEntry[]) {
    const f = fixture("expiry-rollback"); f.pages.at(-1)!.entries.push(extra); coherentWarnings(f);
    assert.throws(() => runCalibrationFailureOracles(f), /fabricated source loss or recovery/);
  }
});
test("terminal gap follows variable authenticated prefixes while custody and drain stay unconfirmed", () => {
  for (const scenario of ["native-primary", "unconfirmed-cleanup-write"] as const) for (const count of [1, 3]) {
    const f = fixture(scenario), entries = f.pages[0]!.entries;
    const frames = entries.filter((entry): entry is FixtureFrame => entry.kind === "frame");
    if (count === 1) entries.splice(entries.indexOf(frames[1]!), 1);
    else {
      const tail = structuredClone(frames[1]!); tail.mediaStartSample = 960n; tail.mediaEndSample = 1097n;
      tail.provenance = { ...tail.provenance, sequence: 3n, outputStartSample: 960n, sampleCount: 137 };
      entries.splice(-2, 0, tail);
    }
    const samples = count === 1 ? 480n : 1097n;
    const gap = entries.find((entry): entry is Extract<FixtureEntry, { kind: "audio_gap" }> => entry.kind === "audio_gap")!;
    gap.startedAtMs = samples * 1000n / 24000n; f.finalized.durationMs = gap.startedAtMs;
    if (scenario === "unconfirmed-cleanup-write") f.result.captureWrites = count;
    const proof = runCalibrationFailureOracles(f);
    assert.equal(proof.recordedSamples, samples.toString()); assert.equal(proof.recordedFrames, count);
    assert.equal(proof.prefixComplete, count === 3); assert.equal(proof.nativeCleanup, "unconfirmed");
    assert.equal(proof.custody, "departure_unconfirmed"); assert.equal(proof.drain, "unconfirmed");
  }
});

test("failure oracles separate emitted buffers, authenticated prefix, native cleanup and departure", () => {
  for (const scenario of scenarios) {
    const proof = runCalibrationFailureOracles(fixture(scenario));
    assert.equal(proof.recordedSamples, scenario === "expiry-rollback" ? "86400" : "960");
    assert.equal(proof.prefixComplete, false);
    assert.equal(proof.nativeCleanup, scenario === "expiry-rollback" ? "confirmed" : "unconfirmed");
    assert.equal(proof.drain, "unconfirmed"); assert.equal(proof.custody, scenario === "expiry-rollback" ? "departure_confirmed" : "departure_unconfirmed");
    assert.equal(proof.scope, "component_only_failure_oracle");
  }
});
test("unconfirmed private prechecks preserve both observed capture stops and cleanup-failed custody", () => {
  const f = fixture("unconfirmed-cleanup-write");
  assert.deepEqual(f.records.slice(4, -1).map(row => row.name), ["transport_write_fault", "capture_stopped",
    "native_stop_completion_late", "output_stopped", "capture_stopped", "control_finished"]);
  assert.equal(runCalibrationFailureOracles(f).custody, "departure_unconfirmed");
});
for (const fault of ["count_one", "count_three", "one_stop", "three_stops", "other_duplicate",
  "first_before_fault", "late_before_first", "second_before_late", "output_before_late", "second_before_output", "second_after_finish"] as const) {
  test(`unconfirmed private prechecks reject ${fault} with strict scenario bounds`, () => {
    const f = fixture("unconfirmed-cleanup-write");
    let failure = /captureStops/;
    if (fault === "count_one") f.result.captureStops = 1;
    if (fault === "count_three") f.result.captureStops = 3;
    if (fault === "one_stop") { f.records.splice(8, 1); f.result.captureStops = 1; failure = /failure metadata record count/; }
    if (fault === "three_stops") { f.records.splice(8, 0, { ...f.records[8]! }); f.result.captureStops = 3; failure = /duplicate metadata barrier/; }
    if (fault === "other_duplicate") { f.records.splice(7, 0, { ...f.records[7]! }); failure = /duplicate metadata barrier/; }
    const swap = (a: number, b: number) => { [f.records[a], f.records[b]] = [f.records[b]!, f.records[a]!]; };
    if (fault === "first_before_fault") { swap(4, 5); failure = /fault cleanup order/; }
    if (fault === "late_before_first") { swap(5, 6); failure = /unconfirmed capture stop order/; }
    if (fault === "second_before_late") { swap(6, 8); failure = /unconfirmed capture stop order/; }
    if (fault === "output_before_late") { swap(6, 7); failure = /unconfirmed capture stop order/; }
    if (fault === "second_before_output") { swap(7, 8); failure = /unconfirmed capture stop order/; }
    if (fault === "second_after_finish") { swap(8, 9); failure = /unconfirmed capture stop order/; }
    assert.throws(() => runCalibrationFailureOracles(f), failure);
  });
}
test("private custody prechecks require exact scenario outcome and reason with telemetry agreement", () => {
  for (const scenario of scenarios) for (const fault of ["opposite", "wrong_reason", "telemetry"] as const) {
    const f = fixture(scenario);
    if (fault === "opposite") {
      f.shutdown.outcome.outcome = scenario === "expiry-rollback" ? "departure_unconfirmed" : "departure_confirmed";
      f.shutdown.outcome.reason = scenario === "expiry-rollback" ? "cleanup_failed" : "departure_observed";
      f.result.departureOutcome = f.shutdown.outcome.outcome; f.result.departureReason = f.shutdown.outcome.reason;
    }
    if (fault === "wrong_reason") { f.shutdown.outcome.reason = "departure_not_observed"; f.result.departureReason = f.shutdown.outcome.reason; }
    if (fault === "telemetry") f.result.departureOutcome = scenario === "expiry-rollback" ? "departure_unconfirmed" : "departure_confirmed";
    assert.throws(() => runCalibrationFailureOracles(f), fault === "telemetry" ? /departure metadata disagreement/ : /scenario custody mismatch/);
  }
});
test("only unconfirmed metadata may repeat capture_stopped", () => {
  for (const scenario of ["native-primary", "expiry-rollback"] as const) {
    const f = fixture(scenario), stop = f.records.find(row => row.name === "capture_stopped")!;
    f.records.splice(-1, 0, { ...stop });
    assert.throws(() => parseCalibrationFailureMetadata(encode(f.records), scenario), /duplicate metadata barrier/);
  }
});
test("closed scenario metadata rejects secret fields, mixed schemas and wrong fault families", () => {
  for (const scenario of scenarios) {
    const f = fixture(scenario);
    assert.deepEqual(parseCalibrationFailureMetadata(encode(f.records), scenario), f.records);
    for (const row of [{ ...f.result, endpoint: "secret" }, { ...f.result, schema: "mac11d-calibration/v1" },
      { ...f.result, metadataInvalidations: 0 }, { ...f.result, connectionsCreated: -1 },
      { ...f.result, captureDrain: { ...f.drain, acknowledged: true } }])
      assert.throws(() => parseCalibrationFailureMetadata(encode([row]), scenario));
    const wrong = { schema: f.result.schema, type: "barrier", name: scenario === "native-primary" ? "wall_rollback" : "native_primary_fault" };
    assert.throws(() => parseCalibrationFailureMetadata(encode([wrong]), scenario));
  }
  assert.throws(() => parseCalibrationFailureMetadata("", "normal"));
});
test("metadata rejects truncation, excessive size, repeated barriers and records after terminal", () => {
  const f = fixture();
  for (const text of [encode(f.records).slice(0, -1), " ".repeat(65537),
    encode([f.records[0], f.records[0]]), encode([f.result, f.records[0]]), encode([f.result, f.result]),
    encode([{ ...f.result, nativeFailures: 0.5 }]), encode([{ ...f.result, lateStopCompletions: Number.MAX_SAFE_INTEGER + 1 }])])
    assert.throws(() => parseCalibrationFailureMetadata(text, f.scenario));
  const expiry = fixture("expiry-rollback");
  assert.throws(() => parseCalibrationFailureMetadata(encode([{ ...expiry.result, rollbackApplied: "true" }]), expiry.scenario));
});
test("fault counters cannot disguise a retry, missing fault, pending work or native success", () => {
  const mutations: [Scenario, string, unknown][] = [
    ["native-primary", "nativeFailures", 0], ["native-primary", "delayedStops", 1], ["native-primary", "cleanupConfirmed", true],
    ["unconfirmed-cleanup-write", "nativeFailures", 1], ["unconfirmed-cleanup-write", "lateStopCompletions", 0],
    ["unconfirmed-cleanup-write", "pendingStopCompletions", 1], ["unconfirmed-cleanup-write", "heldReads", 0],
    ["unconfirmed-cleanup-write", "pendingHeldReads", 1], ["unconfirmed-cleanup-write", "releasedHeldReads", 0],
    ["unconfirmed-cleanup-write", "clockPairWrites", 0], ["unconfirmed-cleanup-write", "injectedWriteFailures", 0],
    ["expiry-rollback", "expiredCaptureWrites", 0], ["expiry-rollback", "rollbackApplied", false],
    ["expiry-rollback", "injectedWriteFailures", 0], ["expiry-rollback", "openedConnections", 2]];
  for (const [scenario, key, value] of mutations) {
    const f = fixture(scenario); f.result[key] = value; assert.throws(() => runCalibrationFailureOracles(f), key);
  }
  for (const scenario of scenarios) for (const key of ["connectionsCreated", "captureStarts", "captureStops", "outputStarts", "outputStops"])
    { const f = fixture(scenario); f.result[key] = scenario === "unconfirmed-cleanup-write" && key === "captureStops" ? 1 : 2;
      assert.throws(() => runCalibrationFailureOracles(f), key); }
});
test("expiry requires explicit parent stale credential refusal independently of rollback telemetry", () => {
  for (const value of [false, undefined, "true", 1]) {
    const f = fixture("expiry-rollback");
    assert.throws(() => runCalibrationFailureOracles({ ...f, expiredCredentialRefused: value }));
  }
});
test("scenario barriers prove fault before cleanup and completed late native stop before finish", () => {
  for (const scenario of scenarios) {
    const f = fixture(scenario); f.records.splice(4, 1); assert.throws(() => runCalibrationFailureOracles(f));
    const reordered = fixture(scenario); [reordered.records[3], reordered.records[4]] = [reordered.records[4]!, reordered.records[3]!];
    assert.throws(() => runCalibrationFailureOracles(reordered));
    const mismatch = fixture(scenario); mismatch.result = { ...mismatch.result, emittedSamples: 0 };
    assert.throws(() => runCalibrationFailureOracles(mismatch));
  }
  const late = fixture("unconfirmed-cleanup-write");
  [late.records[5], late.records[7]] = [late.records[7]!, late.records[5]!];
  assert.throws(() => runCalibrationFailureOracles(late));
});
test("events require actual same-session fault disconnect then typed leave without recovery", () => {
  for (const scenario of scenarios) for (const fault of ["retry", "foreign", "order", "missing", "premature", "reason"] as const) {
    const f = fixture(scenario);
    if (fault === "retry") f.events.push({ type: "reconnected", sessionId: "mac11d", sequence: 4 });
    if (fault === "foreign") f.events[1]!.sessionId = "foreign";
    if (fault === "order") f.events[1]!.sequence = 1;
    if (fault === "missing") f.events.splice(1, 1);
    if (fault === "premature") f.events[1]!.captureDrain = f.drain;
    if (fault === "reason") f.events[1]!.reason = "media_stopped";
    assert.throws(() => runCalibrationFailureOracles(f), `${scenario} ${fault}`);
  }
});
function sourceEvents(scenario: Scenario) {
  const f = fixture(scenario);
  // TimedMediaSession.supervise publishes delivery/final-pair diagnostics,
  // the lifecycle fault, then its terminal diagnosis. stop publishes drain
  // diagnosis before the one typed lifecycle stop. BridgeProcess forwards all.
  const reasons = ["capture_delivery_interrupted", "final_clock_pair_undelivered",
    scenario === "expiry-rollback" ? "media_transport_interrupted" : "media_cleanup_unconfirmed",
    scenario === "expiry-rollback" ? "reconnect_exhausted" : "media_failed", "capture_drain_unconfirmed"];
  f.events = [f.events[0]!, ...reasons.map((reason, index) => ({ type: "media_disconnected", sessionId: "mac11d", sequence: index + 2, reason })),
    { type: "media_disconnected", sessionId: "mac11d", sequence: 7,
      reason: scenario === "expiry-rollback" ? "media_stopped" : "media_cleanup_unconfirmed", captureDrain: f.drain }];
  return f;
}
test("real shipped diagnostic disconnects accompany the sole lifecycle fault and typed stop", () => {
  for (const scenario of scenarios) {
    const proof = runCalibrationFailureOracles(sourceEvents(scenario));
    assert.equal(proof.recordedSamples, scenario === "expiry-rollback" ? "86400" : "960");
    assert.equal(proof.drain, "unconfirmed");
  }
});
test("diagnostics cannot hide foreign events, duplicate or second lifecycle disconnects, or invalid causal order", () => {
  for (const scenario of scenarios) for (const fault of ["foreign", "duplicate", "second", "unknown", "early", "late", "wrong_family", "after_stop"] as const) {
    const f = sourceEvents(scenario);
    if (fault === "foreign") f.events[1]!.sessionId = "foreign";
    if (fault === "duplicate") f.events[2]!.reason = "capture_delivery_interrupted";
    if (fault === "second") f.events[4]!.reason = f.events[3]!.reason!;
    if (fault === "unknown") f.events[1]!.reason = "unknown_diagnostic";
    if (fault === "early") [f.events[3], f.events[5]] = [f.events[5]!, f.events[3]!];
    if (fault === "late") [f.events[1], f.events[4]] = [f.events[4]!, f.events[1]!];
    if (fault === "wrong_family") f.events[4]!.reason = scenario === "expiry-rollback" ? "media_failed" : "reconnect_exhausted";
    if (fault === "after_stop") f.events.push({ type: "media_disconnected", sessionId: "mac11d", sequence: 8, reason: "capture_drain_unconfirmed" });
    // Restore monotone sequence numbers after moves so causal reason ordering,
    // rather than the independent sequence check, is what catches the fault.
    f.events.forEach((event, index) => { event.sequence = index + 1; });
    assert.throws(() => runCalibrationFailureOracles(f), `${scenario} ${fault}`);
  }
});
test("authenticated coverage rejects fabricated gaps, epochs, pairs, samples and completion", () => {
  for (const fault of ["gap", "epoch", "pair", "samples", "sequence", "tail", "warnings", "duration", "source", "terminal", "reap", "drain"] as const) {
    const f = fixture(); const entries = f.pages[0]!.entries; const frame = entries[3] as FixtureFrame;
    if (fault === "gap") entries.push({ kind: "audio_gap", startedAtMs: 40n, endedAtMs: null, reason: "capture_discontinuity" });
    if (fault === "epoch") entries.push(entries[0]!);
    if (fault === "pair") entries.push({ kind: "clock_pair", pair: { sequence: 3n, clockDomainId: "synthetic-host" } });
    if (fault === "samples") frame.mediaStartSample = 481n;
    if (fault === "sequence") frame.provenance.sequence = 1n;
    if (fault === "tail") frame.provenance.sampleCount = 137;
    if (fault === "warnings") f.complete.warnings = [];
    if (fault === "duration") f.finalized.durationMs = 41n;
    if (fault === "source") f.pages[0]!.source = { ...f.pages[0]!.source, sourceSessionId: 43n };
    if (fault === "terminal") f.complete.traversalSucceeded = false;
    if (fault === "reap") f.shutdown.reaped = false;
    if (fault === "drain") f.drain.reason = "drain_deadline";
    assert.throws(() => runCalibrationFailureOracles(f), fault);
  }
  const expiry = fixture("expiry-rollback"); expiry.result.captureWrites = 179;
  assert.throws(() => runCalibrationFailureOracles(expiry));
});
test("honest complete native prefix and initial priming uncertainty remain distinct", () => {
  const f = fixture(); const entries = f.pages[0]!.entries; const first = entries[2] as FixtureFrame;
  first.captureStatus = "capture_alignment_missing"; first.provenance.quality = "unknown_priming";
  first.provenance.span = null; first.reasons = ["capture_alignment_missing", "missing_timing", "wall_alignment_missing"];
  f.complete.warnings.push("capture_alignment_missing", "missing_timing");
  assert.equal(runCalibrationFailureOracles(f).recordedSamples, "960");
  const tail = structuredClone(entries[3]) as FixtureFrame; tail.mediaStartSample = 960n; tail.mediaEndSample = 1097n;
  tail.provenance = { ...tail.provenance, sequence: 3n, outputStartSample: 960n, sampleCount: 137 };
  entries.splice(-2, 0, tail); f.finalized.durationMs = 45n;
  const gap = entries.find((entry): entry is Extract<FixtureEntry, { kind: "audio_gap" }> => entry.kind === "audio_gap")!;
  gap.startedAtMs = 45n;
  assert.equal(runCalibrationFailureOracles(f).prefixComplete, true);
  first.reasons.push("audio_missing"); assert.throws(() => runCalibrationFailureOracles(f));
});

import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Test-only JavaScript oracle has no public declaration.
import { calibrationOracle, parseCalibrationTelemetry } from "./mac11d-oracles.mjs";
// @ts-expect-error Test-only JavaScript runner has no public declaration.
import { calibrationLease } from "./mac11d-calibration.mjs";

function fixture() {
  const boundary = { captureEpoch: "1", lastFrameSequence: "3", outputEndSample: "1097", finalClockPairSequence: "2" };
  const drain = { drain: "confirmed", reason: null, boundary };
  const result = { schema: "mac11d-calibration/v1", type: "result", captureStarts: 1, captureStops: 1,
    outputStarts: 1, outputStops: 1, emittedBuffers: 3, emittedSamples: 1097, cleanupConfirmed: true,
    captureDrain: drain, departureOutcome: "departure_confirmed", departureReason: "departure_observed" };
  const source = { sourceSessionId: 42n, recordingHandle: "opaque", sha256: "a".repeat(64) };
  let start = 0n;
  const entries = [480, 480, 137].map((samples, index) => {
    const frame = { kind: "frame", captureStatus: "available", sampleRateHz: 24000, gapOffsetMs: 0n,
      mediaStartSample: start, mediaEndSample: start + BigInt(samples), reasons: [] as string[], wall: {},
      epoch: { captureEpoch: 1n, bridgeSessionId: "mac11d", clockDomainId: "synthetic-host" },
      provenance: { captureEpoch: 1n, sequence: BigInt(index + 1), outputStartSample: start, sampleCount: samples,
        quality: "nominal_frame_endpoint_interpolation", span: {} as object | null } };
    start += BigInt(samples); return frame;
  });
  return { result, drain, bridgeSessionId: "mac11d", sessionId: 42n,
    finalized: { recordingHandle: "opaque", sha256: source.sha256, durationMs: 45n, format: "pcm_s16le/24000/1" },
    shutdown: { reaped: true, failure: null, outcome: { outcome: "departure_confirmed", reason: "departure_observed" } },
    pages: [{ type: "recording_alignment_page", source, pageIndex: 0n, entries: [
      { kind: "epoch", epoch: entries[0]!.epoch }, { kind: "clock_pair", pair: { sequence: 1n, clockDomainId: "synthetic-host" } },
      ...entries, { kind: "clock_pair", pair: { sequence: 2n, clockDomainId: "synthetic-host" } }] }],
    complete: { type: "recording_alignment_complete", source, pageCount: 1n, traversalSucceeded: true,
      coverageStatus: "available", warnings: ["local_wall_timestamp_estimate"] } };
}
test("calibration requires actual recorded tail and matching typed drain separately from native emission", () => {
  assert.equal(calibrationOracle(fixture()).recordedSamples, "1097");
  const omitted = fixture(); omitted.pages[0]!.entries.splice(4, 1);
  assert.throws(() => calibrationOracle(omitted));
  const unconfirmed = fixture(); unconfirmed.result.cleanupConfirmed = false;
  assert.throws(() => calibrationOracle(unconfirmed));
  const mismatched = fixture(); mismatched.drain.boundary.outputEndSample = "1096";
  assert.throws(() => calibrationOracle(mismatched));
});
test("SDK lease identity is checked before forwarding unchanged bridge binding", () => {
  const lease = { mediaProtocolVersion: 3, bridgeSessionId: "mac11d", sessionId: 42n, expiresAtMs: 10000n, reconnectWindowMs: 1000n };
  assert.equal(calibrationLease(lease, 42n, "mac11d").bridgeSessionId, "mac11d");
  assert.throws(() => calibrationLease({ ...lease, bridgeSessionId: "foreign" }, 42n, "mac11d"));
  assert.throws(() => calibrationLease({ ...lease, sessionId: 43n }, 42n, "mac11d"));
  assert.throws(() => calibrationLease({ ...lease, mediaProtocolVersion: 2 }, 42n, "mac11d"));
});
test("recorded final pairs require the bound host domain and contiguous unique sequences", () => {
  for (const fault of ["domain", "sequence", "duplicate"]) {
    const f = fixture();
    const pair = f.pages[0]!.entries.at(-1) as { kind: string; pair: { sequence: bigint; clockDomainId: string } };
    if (fault === "domain") pair.pair.clockDomainId = "foreign";
    if (fault === "sequence") pair.pair.sequence = 3n;
    if (fault === "duplicate") f.pages[0]!.entries.push(pair);
    assert.throws(() => calibrationOracle(f));
  }
});
test("normal calibration preserves the shipped converter's honest first-frame priming uncertainty", () => {
  const f = fixture();
  const frame = f.pages[0]!.entries[2] as ReturnType<typeof fixture>["pages"][number]["entries"][number] & {
    captureStatus: string; wall: object | null; reasons: string[]; provenance: { quality: string; span: object | null } };
  frame.captureStatus = "capture_alignment_missing"; frame.wall = null;
  frame.provenance.quality = "unknown_priming"; frame.provenance.span = null;
  frame.reasons = ["missing_timing", "capture_alignment_missing", "wall_alignment_missing"];
  f.complete.coverageStatus = "partial";
  f.complete.warnings = [...frame.reasons, "local_wall_timestamp_estimate"];
  assert.equal(calibrationOracle(f).timingCoverage, "partial");
  frame.provenance.quality = "unknown_clock";
  assert.throws(() => calibrationOracle(f));
});
test("recorded nominal samples retain honest missing wall brackets without inventing timestamps", () => {
  const f = fixture();
  const frame = f.pages[0]!.entries[3] as ReturnType<typeof fixture>["pages"][number]["entries"][number] & { wall: object | null; reasons: string[] };
  frame.wall = null; frame.reasons = ["wall_alignment_missing", "missing_clock_pair"];
  f.complete.coverageStatus = "partial"; f.complete.warnings = [...frame.reasons, "local_wall_timestamp_estimate"];
  assert.equal(calibrationOracle(f).recordedSamples, "1097");
  frame.reasons.push("audio_missing");
  assert.throws(() => calibrationOracle(f));
});
test("calibration rejects foreign source, duplicate pages, partial traversal and missing final pair", () => {
  const foreign = fixture(); foreign.pages[0]!.source.sourceSessionId = 43n;
  assert.throws(() => calibrationOracle(foreign));
  const duplicate = fixture(); duplicate.pages.push(duplicate.pages[0]!);
  assert.throws(() => calibrationOracle(duplicate));
  const partial = fixture(); partial.complete.coverageStatus = "partial";
  assert.throws(() => calibrationOracle(partial));
  const missing = fixture(); missing.pages[0]!.entries.pop();
  assert.throws(() => calibrationOracle(missing));
});
test("calibration rejects frame sequence/sample discontinuity, audio loss and duration mismatch", () => {
  for (const fault of ["sequence", "samples", "loss", "duration", "custody"]) {
    const f = fixture();
    const frame = f.pages[0]!.entries[3] as ReturnType<typeof fixture>["pages"][number]["entries"][number] & { provenance: { sequence: bigint }; mediaStartSample: bigint; reasons: string[] };
    if (fault === "sequence") frame.provenance.sequence = 1n;
    if (fault === "samples") frame.mediaStartSample = 481n;
    if (fault === "loss") frame.reasons = ["audio_missing"];
    if (fault === "duration") f.finalized.durationMs = 46n;
    if (fault === "custody") f.shutdown.reaped = false;
    assert.throws(() => calibrationOracle(f), fault);
  }
});
test("telemetry accepts complete private records and rejects truncation, unknown fields and oversized input", () => {
  const result = fixture().result;
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  assert.deepEqual(parseCalibrationTelemetry(line(result)), [result]);
  assert.throws(() => parseCalibrationTelemetry(JSON.stringify(result)));
  assert.throws(() => parseCalibrationTelemetry(line({ ...result, credential: "forbidden" })));
  assert.throws(() => parseCalibrationTelemetry(" ".repeat(65537)));
  assert.deepEqual(parseCalibrationTelemetry(line({ schema: result.schema, type: "barrier", name: "capture_emission_complete" })),
    [{ schema: result.schema, type: "barrier", name: "capture_emission_complete" }]);
});

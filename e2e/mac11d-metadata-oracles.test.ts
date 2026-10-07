import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecordingAlignmentPage } from "@conversation/runtime";
import { pageWarnings } from "../src/sessions/recording-alignment.ts";
// @ts-expect-error Test-only JavaScript oracle has no public declaration.
import { metadataFailureOracle, parseMetadataTelemetry } from "./mac11d-metadata-oracles.mjs";

function fixture() {
  const drain = { drain: "unconfirmed", reason: "drain_not_attempted", boundary: null };
  const result = { schema: "mac11d-metadata/v1", type: "result", captureStarts: 1, captureStops: 1,
    outputStarts: 1, outputStops: 1, emittedBuffers: 3, emittedSamples: 1097, cleanupConfirmed: true,
    captureDrain: drain, departureOutcome: "departure_confirmed", departureReason: "departure_observed",
    connectionsCreated: 1, metadataInvalidations: 1, rejectedWallSamples: 2 };
  const source = { sourceSessionId: 42n, recordingHandle: "opaque", sha256: "a".repeat(64) };
  const epoch = { captureEpoch: 1n, bridgeSessionId: "mac11d", clockDomainId: "synthetic-host" };
  let start = 0n;
  const frames = [480, 480, 137].map((count, index) => {
    const frame = { kind: "frame", epoch, captureStatus: "available", sampleRateHz: 24000, gapOffsetMs: 0n,
      mediaStartSample: start, mediaEndSample: start + BigInt(count), wall: null,
      reasons: ["missing_clock_pair", "wall_alignment_missing"],
      provenance: { captureEpoch: 1n, sequence: BigInt(index + 1), outputStartSample: start, sampleCount: count,
        quality: "nominal_frame_endpoint_interpolation", span: {} as object | null } };
    start += BigInt(count); return frame;
  });
  return { result, drain, sessionId: 42n, bridgeSessionId: "mac11d",
    records: ["child_ready", "capture_started", "output_started", "capture_emission_complete", "metadata_clock_fault",
      "capture_stopped", "output_stopped", "control_finished"].map(name => ({ schema: result.schema, type: "barrier", name })).concat([result as never]),
    events: [{ type: "media_connected", sessionId: "mac11d", sequence: 1 },
      { type: "media_disconnected", sessionId: "mac11d", sequence: 2, reason: "media_transport_interrupted" },
      { type: "media_disconnected", sessionId: "mac11d", sequence: 3, captureDrain: drain }],
    shutdown: { reaped: true, failure: null, outcome: { outcome: "departure_confirmed", reason: "departure_observed" } },
    finalized: { recordingHandle: "opaque", sha256: source.sha256, durationMs: 45n, format: "pcm_s16le/24000/1" },
    pages: [{ type: "recording_alignment_page", source, pageIndex: 0n, entries: [
      { kind: "epoch", epoch }, { kind: "clock_pair", pair: { sequence: 1n, clockDomainId: epoch.clockDomainId } }, ...frames,
      { kind: "discontinuity", captureEpoch: 1n, reason: "reconnect" },
      { kind: "audio_gap", startedAtMs: 45n, endedAtMs: null as bigint | null, reason: "capture_discontinuity" }] }],
    complete: { type: "recording_alignment_complete", source, pageCount: 1n, traversalSucceeded: true,
      coverageStatus: "partial", warnings: ["missing_clock_pair", "wall_alignment_missing", "reconnect", "audio_missing"] } };
}
test("metadata oracle keeps native cleanup, failed drain and authenticated tail as separate facts", () => {
  const proof = metadataFailureOracle(fixture());
  assert.equal(proof.recordedSamples, "1097"); assert.equal(proof.drain, "unconfirmed");
  assert.equal(proof.scope, "component_only_metadata_oracle");
  for (const fault of ["drain", "cleanup", "restart", "tail", "rejects", "barrier"] as const) {
    const f = fixture();
    if (fault === "drain") f.drain.reason = "drain_deadline";
    if (fault === "cleanup") f.result.cleanupConfirmed = false;
    if (fault === "restart") f.result.captureStarts = 2;
    if (fault === "tail") f.pages[0]!.entries.splice(f.pages[0]!.entries.findLastIndex(entry => entry.kind === "frame"), 1);
    if (fault === "rejects") f.result.rejectedWallSamples = 1;
    if (fault === "barrier") f.records.splice(4, 1);
    assert.throws(() => metadataFailureOracle(f), fault);
  }
});
test("metadata oracle preserves terminal EOF closure and open gap without a retry", () => {
  const f = fixture();
  assert.deepEqual(f.pages[0]!.entries.slice(-2), [
    { kind: "discontinuity", captureEpoch: 1n, reason: "reconnect" },
    { kind: "audio_gap", startedAtMs: 45n, endedAtMs: null, reason: "capture_discontinuity" },
  ]);
  assert.equal(metadataFailureOracle(f).recordedSamples, "1097");
});
for (const fault of ["missing_closure", "missing_gap", "duplicate_closure", "duplicate_gap", "closure_reason",
  "closure_epoch", "gap_reason", "gap_start", "closed_gap", "reversed_tail", "closure_before_last_frame",
  "gap_before_last_frame", "unsupported_kind"] as const) {
  test(`metadata oracle rejects ${fault} at the selected terminal predicate`, () => {
    const f = fixture(), entries = f.pages[0]!.entries;
    const closure = entries.find(entry => entry.kind === "discontinuity")! as { kind: string; captureEpoch: bigint; reason: string };
    const gap = entries.find(entry => entry.kind === "audio_gap")! as { kind: string; startedAtMs: bigint; endedAtMs: bigint | null; reason: string };
    const lastFrame = entries.findLast(entry => entry.kind === "frame")!;
    let failure = /metadata terminal discontinuity count/;
    if (fault === "missing_closure") entries.splice(entries.indexOf(closure), 1);
    if (fault === "missing_gap") { entries.splice(entries.indexOf(gap), 1); failure = /metadata terminal gap count/; }
    if (fault === "duplicate_closure") entries.push(structuredClone(closure));
    if (fault === "duplicate_gap") { entries.push(structuredClone(gap)); failure = /metadata terminal gap count/; }
    if (fault === "closure_reason") { closure.reason = "pause"; failure = /metadata terminal discontinuity reason/; }
    if (fault === "closure_epoch") { closure.captureEpoch = 2n; failure = /metadata terminal discontinuity epoch/; }
    if (fault === "gap_reason") { gap.reason = "recording_failed"; failure = /metadata terminal gap reason/; }
    if (fault === "gap_start") { gap.startedAtMs = 44n; failure = /metadata terminal gap start/; }
    if (fault === "closed_gap") { gap.endedAtMs = 46n; failure = /metadata terminal gap must remain open/; }
    if (fault === "reversed_tail") {
      const a = entries.indexOf(closure), b = entries.indexOf(gap); [entries[a], entries[b]] = [gap, closure];
      failure = /metadata terminal closure order/;
    }
    if (fault === "closure_before_last_frame" || fault === "gap_before_last_frame") {
      const selected = fault === "closure_before_last_frame" ? closure : gap;
      entries.splice(entries.indexOf(selected), 1); entries.splice(entries.indexOf(lastFrame), 0, selected);
      failure = /metadata terminal closure order/;
    }
    if (fault === "unsupported_kind") { entries.push({ kind: "alignment_limit" } as never); failure = /unexpected metadata recording entry/; }
    // These thin component fixtures expose only fields the oracle reads; warnings use its genuine production helper.
    f.complete.warnings = [...new Set(f.pages.flatMap(page => pageWarnings(page as unknown as RecordingAlignmentPage)))].sort();
    assert.throws(() => metadataFailureOracle(f), failure);
  });
}
test("metadata oracle refuses recovery attempts, foreign events and premature typed finish", () => {
  for (const fault of ["retry", "foreign", "order", "finish"] as const) {
    const f = fixture();
    if (fault === "retry") f.events.push({ type: "reconnecting", sessionId: "mac11d", sequence: 4 });
    if (fault === "foreign") f.events[1]!.sessionId = "foreign";
    if (fault === "order") f.events[1]!.sequence = 1;
    if (fault === "finish") f.events[1]!.captureDrain = f.drain;
    assert.throws(() => metadataFailureOracle(f), fault);
  }
});
test("metadata oracle rejects fabricated wall timing, final pair or extra audio-loss gap", () => {
  for (const fault of ["wall", "pair", "gap", "sequence", "warnings", "duration", "source", "terminal", "reap"] as const) {
    const f = fixture();
    const frame = f.pages[0]!.entries[3] as { provenance: { sequence: bigint }; wall: object | null };
    if (fault === "wall") frame.wall = {};
    if (fault === "pair") f.pages[0]!.entries.push({ kind: "clock_pair", pair: { sequence: 2n, clockDomainId: "synthetic-host" } });
    if (fault === "gap") f.pages[0]!.entries.push({ kind: "audio_gap" } as never);
    if (fault === "sequence") frame.provenance.sequence = 1n;
    if (fault === "warnings") f.complete.warnings = [];
    if (fault === "duration") f.finalized.durationMs = 46n;
    if (fault === "source") f.pages[0]!.source = { ...f.pages[0]!.source, sourceSessionId: 43n };
    if (fault === "terminal") f.complete.traversalSucceeded = false;
    if (fault === "reap") f.shutdown.reaped = false;
    assert.throws(() => metadataFailureOracle(f), fault);
  }
});
test("metadata oracle preserves honest initial converter priming loss of timing", () => {
  const f = fixture();
  const first = f.pages[0]!.entries[2] as { captureStatus: string; reasons: string[]; provenance: { quality: string; span: object | null } };
  first.captureStatus = "capture_alignment_missing"; first.provenance.quality = "unknown_priming"; first.provenance.span = null;
  first.reasons = ["capture_alignment_missing", "missing_timing", "wall_alignment_missing"];
  f.complete.warnings.push("capture_alignment_missing", "missing_timing");
  assert.equal(metadataFailureOracle(f).recordedSamples, "1097");
  first.reasons.push("audio_missing"); assert.throws(() => metadataFailureOracle(f));
});
test("metadata telemetry is closed, bounded, ordered and cannot accept reconnect fields", () => {
  const f = fixture();
  const encode = (rows: unknown[]) => rows.map(row => JSON.stringify(row) + "\n").join("");
  assert.equal(parseMetadataTelemetry(encode(f.records)).length, 9);
  for (const text of [encode([{ ...f.result, credential: "forbidden" }]), encode([{ ...f.result, heldReads: 0 }]),
    encode([f.result, f.records[0]]), encode([f.records[4], f.records[4]]), encode(f.records).slice(0, -1), " ".repeat(65537)])
    assert.throws(() => parseMetadataTelemetry(text));
});

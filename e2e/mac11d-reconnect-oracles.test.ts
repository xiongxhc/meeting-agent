import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecordingAlignmentEntry, RecordingAlignmentPage } from "@conversation/runtime";
import type { BridgeEventMessageV2 } from "../src/contracts/bridge-session-v2.ts";
import { pageWarnings } from "../src/sessions/recording-alignment.ts";
// @ts-expect-error Private test-only JavaScript helper has no public declaration.
import { parseReconnectTelemetry, reconnectOracle } from "./mac11d-reconnect-oracles.mjs";

// These are component fixtures, never evidence of SDK/gateway/Swift acceptance.
type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type Entry = Mutable<RecordingAlignmentEntry>;
function fixture() {
  const boundary = { captureEpoch: "2", lastFrameSequence: "3", outputEndSample: "1097", finalClockPairSequence: "5" };
  const drain = { drain: "confirmed", reason: null, boundary };
  const result = { schema: "mac11d-reconnect/v1", type: "result", captureStarts: 2, captureStops: 2,
    outputStarts: 2, outputStops: 2, emittedBuffers: 6, emittedSamples: 2194, cleanupConfirmed: true,
    captureDrain: drain, departureOutcome: "departure_confirmed", departureReason: "departure_observed",
    connectionsCreated: 2, openedConnections: 2, captureWrites: 5, clockPairWrites: 4,
    injectedWriteFailures: 1, heldReads: 1, releasedHeldReads: 1, pendingHeldReads: 0 };
  const source = { sourceSessionId: 42n, recordingHandle: "b".repeat(32), sha256: "a".repeat(64) };
  const epochs = [1n, 2n].map(captureEpoch => ({ captureEpoch, bridgeSessionId: "mac11d", clockDomainId: "synthetic-host" }));
  const pair = (sequence: bigint): Entry => ({ kind: "clock_pair", pair: { sequence, clockDomainId: "synthetic-host",
    wallEpoch: 1n, hostBeforeNs: sequence * 1000000000n, hostAfterNs: sequence * 1000000000n + 1n,
    localUnixNs: 1700000000000000000n + sequence * 1000000000n, wallResolutionNs: 1n, externalUtcAccuracyNs: null } });
  let media = 0n;
  const cycle = (epochIndex: number, sizes: number[], gapOffsetMs: bigint): Entry[] => {
    let output = 0n;
    return sizes.map((sampleCount, index) => {
      const frame: Entry = { kind: "frame", captureStatus: "available", sampleRateHz: 24000, gapOffsetMs,
        mediaStartSample: media, mediaEndSample: media + BigInt(sampleCount), reasons: [],
        epoch: epochs[epochIndex]!, wall: { quality: "local_wall_estimate", policyId: "local-wall-estimate/v1",
          localStartNs: 1700000000000000000n + media, localEndNs: 1700000000000000000n + media + 1n,
          wallEpoch: 1n, wallRun: BigInt(epochIndex + 1), maximumBracketNs: 1n, maximumResolutionNs: 1n,
          modelAllowanceNs: 10000000n, interpolationRoundingNs: 0n, captureRoundingNs: 0n,
          captureUncertaintyNs: null, externalUtcAccuracyNs: null, overallPhysicalAccuracyNs: null },
        provenance: { captureEpoch: epochs[epochIndex]!.captureEpoch, sequence: BigInt(index + 1), outputStartSample: output,
          sampleCount, sourceRateHz: 24000, sourceDenominator: 24000,
          sourceStartNumerator: output * 24000n, sourceEndNumerator: (output + BigInt(sampleCount)) * 24000n,
          quality: "nominal_frame_endpoint_interpolation", span: { hostStartNs: 1000000000n + media,
            hostEndNs: 1000000000n + media + 1n, roundingEnvelopeNs: 0n, captureUncertaintyNs: null } } };
      media += BigInt(sampleCount); output += BigInt(sampleCount); return frame;
    });
  };
  const first = cycle(0, [480, 480], 0n), second = cycle(1, [480, 480, 137], 125n);
  const entries: Entry[] = [{ kind: "epoch", epoch: epochs[0]! }, pair(1n), ...first,
    { kind: "discontinuity", captureEpoch: 1n, reason: "reconnect" },
    { kind: "epoch", epoch: epochs[1]! }, { kind: "discontinuity", captureEpoch: 2n, reason: "reconnect" },
    pair(3n), { kind: "audio_gap", startedAtMs: 40n, endedAtMs: 165n, reason: "capture_discontinuity" },
    ...second, pair(5n)];
  const pages: Mutable<RecordingAlignmentPage>[] = [{ type: "recording_alignment_page", source, pageIndex: 0n,
    policy: { id: "local-wall-estimate/v1", cadenceTargetNs: 1000000000n, maximumBracketNs: 5000000n,
      maximumPairGapNs: 2000000000n, maximumResidualNs: 10000000n }, entries }];
  const payloads = [{ type: "media_connected", endpoint: "tcp://127.0.0.1:1" },
    { type: "media_disconnected", reason: "capture_delivery_interrupted" },
    { type: "media_disconnected", reason: "final_clock_pair_undelivered" },
    { type: "media_disconnected", reason: "media_transport_interrupted" },
    { type: "reconnecting", attempt: 1 }, { type: "media_connected", endpoint: "tcp://127.0.0.1:1" },
    { type: "reconnected", attempt: 1 }, { type: "media_disconnected", reason: "capture_drain_confirmed" },
    { type: "media_disconnected", reason: "media_stopped", captureDrain: structuredClone(drain) }];
  const events = payloads.map((payload, index) => ({ schema: "bridge-session/v2", sessionId: "mac11d", sequence: index + 1,
    observedAt: "2026-10-01T00:00:00Z", ...payload })) as BridgeEventMessageV2[];
  return { result, drain, events, bridgeSessionId: "mac11d", sessionId: 42n,
    finalized: { recordingHandle: source.recordingHandle, sha256: source.sha256, durationMs: 210n, format: "pcm_s16le/24000/1" },
    shutdown: { reaped: true, failure: null, outcome: { outcome: "departure_confirmed", reason: "departure_observed" } },
    pages, complete: { type: "recording_alignment_complete", source: structuredClone(source), pageCount: 1n,
      traversalSucceeded: true, coverageStatus: "partial", warnings: ["audio_missing", "local_wall_timestamp_estimate", "reconnect"] } };
}
function frame(f: ReturnType<typeof fixture>, index: number) {
  return f.pages.flatMap(page => page.entries).filter((entry): entry is Extract<Entry, { kind: "frame" }> => entry.kind === "frame")[index]!;
}
function finalPair(f: ReturnType<typeof fixture>) {
  return f.pages[0]!.entries.at(-1) as Extract<Entry, { kind: "clock_pair" }>;
}
const line = (value: unknown) => JSON.stringify(value) + "\n";

test("component-only reconnect oracle separates emitted 2194 samples from authenticated recorded 2057", () => {
  assert.equal(reconnectOracle(fixture())?.recordedSamples, "2057");
  assert.equal(reconnectOracle(fixture())?.recordedFrames, 5);
  assert.equal(reconnectOracle(fixture())?.scope, "component_only_reconnect_oracle");
});
test("component-only reconnect retains the old epoch closure and new epoch discontinuity", () => {
  const f = fixture(), entries = f.pages[0]!.entries;
  assert.deepEqual(entries.filter(entry => entry.kind === "discontinuity"), [
    { kind: "discontinuity", captureEpoch: 1n, reason: "reconnect" },
    { kind: "discontinuity", captureEpoch: 2n, reason: "reconnect" },
  ]);
  assert.equal(reconnectOracle(f)?.recordedSamples, "2057");
});
for (const fault of ["missing_old", "missing_new", "duplicate_old", "duplicate_new", "reversed",
  "old_reason", "new_reason", "old_epoch", "new_epoch", "old_before_last_frame", "old_after_epoch2",
  "new_before_epoch2", "new_after_first_frame", "gap_before_new", "gap_after_first_frame"] as const) {
  test(`component-only reconnect rejects ${fault} without masking the discontinuity predicate`, () => {
    const f = fixture(), entries = f.pages[0]!.entries;
    const discontinuities = entries.filter((entry): entry is Extract<Entry, { kind: "discontinuity" }> => entry.kind === "discontinuity");
    const old = discontinuities[0]!, next = discontinuities[1]!;
    const epoch2 = entries.filter(entry => entry.kind === "epoch")[1]!;
    const gap = entries.find(entry => entry.kind === "audio_gap")!;
    const firstLast = frame(f, 1), secondFirst = frame(f, 2);
    const moveBefore = (entry: Entry, target: Entry) => {
      entries.splice(entries.indexOf(entry), 1); entries.splice(entries.indexOf(target), 0, entry);
    };
    let failure = /recorded reconnect discontinuity count/;
    if (fault === "missing_old" || fault === "missing_new") entries.splice(entries.indexOf(fault === "missing_old" ? old : next), 1);
    if (fault === "duplicate_old" || fault === "duplicate_new") entries.splice(entries.indexOf(next), 0, structuredClone(fault === "duplicate_old" ? old : next));
    if (fault === "reversed") {
      const oldIndex = entries.indexOf(old), nextIndex = entries.indexOf(next);
      [entries[oldIndex], entries[nextIndex]] = [next, old]; failure = /reconnect discontinuity epoch/;
    }
    if (fault === "old_reason" || fault === "new_reason") {
      (fault === "old_reason" ? old : next).reason = "pause"; failure = /reconnect discontinuity reason/;
    }
    if (fault === "old_epoch" || fault === "new_epoch") {
      (fault === "old_epoch" ? old : next).captureEpoch = 3n; failure = /reconnect discontinuity epoch/;
    }
    if (fault === "old_before_last_frame") { moveBefore(old, firstLast); failure = /old reconnect closure order/; }
    if (fault === "old_after_epoch2") { moveBefore(old, next); failure = /old reconnect closure order/; }
    if (fault === "new_before_epoch2") { moveBefore(next, epoch2); failure = /reconnect discontinuity order/; }
    if (fault === "new_after_first_frame") { moveBefore(next, frame(f, 3)); failure = /reconnect discontinuity order/; }
    if (fault === "gap_before_new") { moveBefore(gap, next); failure = /closed reconnect gap order/; }
    if (fault === "gap_after_first_frame") { moveBefore(gap, frame(f, 3)); failure = /closed reconnect gap order/; }
    assert.ok(entries.includes(secondFirst));
    // Keep decoded-page warnings coherent so an earlier warning mismatch cannot mask a missing predicate.
    f.complete.warnings = [...new Set(f.pages.flatMap(pageWarnings))].sort();
    assert.throws(() => reconnectOracle(f), failure);
  });
}
test("component-only telemetry validates closed records while allowing two native cycles", () => {
  const f = fixture(), barrier = { schema: f.result.schema, type: "barrier", name: "capture_started" };
  assert.deepEqual(parseReconnectTelemetry(line(barrier) + line(barrier) + line(f.result)), [barrier, barrier, f.result]);
  for (const value of [JSON.stringify(f.result), line({ ...f.result, credential: "forbidden" }),
    line({ ...barrier, name: "invented" }), line({ ...f.result, heldReads: -1 }),
    line({ ...f.result, captureDrain: { ...f.drain, boundary: { ...f.drain.boundary, captureEpoch: "02" } } }),
    " ".repeat(65537), line({ schema: f.result.schema, type: "barrier", name: "x".repeat(4100) })])
    assert.throws(() => parseReconnectTelemetry(value));
  assert.deepEqual(parseReconnectTelemetry(line({ ...barrier, name: "transport_write_fault" })), [{ ...barrier, name: "transport_write_fault" }]);
});
test("component-only reconnect rejects unconfirmed cleanup, unreaped child and held reader residue", () => {
  for (const fault of ["cleanup", "reap", "custody", "held", "released", "writes", "native", "drain"] as const) {
    const f = fixture();
    if (fault === "cleanup") f.result.cleanupConfirmed = false;
    if (fault === "reap") f.shutdown.reaped = false;
    if (fault === "custody") f.shutdown.outcome.reason = "departure_not_observed";
    if (fault === "held") f.result.pendingHeldReads = 1;
    if (fault === "released") f.result.releasedHeldReads = 0;
    if (fault === "writes") f.result.captureWrites = 6;
    if (fault === "native") f.result.captureStarts = 3;
    if (fault === "drain") f.result.captureDrain = { ...f.drain, boundary: { ...f.drain.boundary, outputEndSample: "1096" } };
    assert.throws(() => reconnectOracle(f), fault);
  }
});
test("component-only reconnect requires real bound admissions and ordered single attempt", () => {
  for (const fault of ["missing", "extra", "order", "foreign", "sequence", "attempt", "duplicate_terminal", "no_terminal"] as const) {
    const f = fixture();
    if (fault === "missing") f.events = f.events.filter(event => event.type !== "reconnected");
    if (fault === "extra") f.events.push({ ...f.events[4]! });
    if (fault === "order") [f.events[0], f.events[4]] = [f.events[4]!, f.events[0]!];
    if (fault === "foreign") f.events[0]!.sessionId = "foreign";
    if (fault === "sequence") f.events[5]!.sequence = 1;
    if (fault === "attempt" && f.events[6]?.type === "reconnected") f.events[6].attempt = 2;
    if (fault === "duplicate_terminal") f.events.push({ ...f.events.at(-1)!, sequence: 10 });
    if (fault === "no_terminal") f.events.pop();
    assert.throws(() => reconnectOracle(f), fault);
  }
});
test("component-only source traversal rejects foreign source, duplicate pages or terminals and stale generation", () => {
  for (const fault of ["source", "terminal_source", "duplicate_page", "duplicate_terminal", "traversal", "epoch", "bridge", "frame_epoch"] as const) {
    const f = fixture();
    if (fault === "source") f.pages[0]!.source.sourceSessionId = 43n;
    if (fault === "terminal_source") f.complete.source.sha256 = "c".repeat(64);
    if (fault === "duplicate_page") f.pages.push(structuredClone(f.pages[0]!));
    if (fault === "duplicate_terminal") f.complete = [f.complete, f.complete] as unknown as typeof f.complete;
    if (fault === "traversal") f.complete.traversalSucceeded = false;
    if (fault === "epoch") f.drain.boundary.captureEpoch = "1";
    if (fault === "bridge") frame(f, 2).epoch!.bridgeSessionId = "old-generation";
    if (fault === "frame_epoch") frame(f, 2).provenance!.captureEpoch = 1n;
    assert.throws(() => reconnectOracle(f), fault);
  }
});
test("component-only recorder rejects omitted final tail, invented first-cycle tail and timeline corruption", () => {
  for (const fault of ["tail", "invented", "sequence", "global_samples", "output_samples", "duration", "gap", "gap_offset", "open_gap", "discontinuity"] as const) {
    const f = fixture();
    if (fault === "tail") frame(f, 4).provenance!.sampleCount = 136;
    if (fault === "invented") frame(f, 1).provenance!.sampleCount = 617;
    if (fault === "sequence") frame(f, 3).provenance!.sequence = 1n;
    if (fault === "global_samples") frame(f, 2).mediaStartSample = 1097n;
    if (fault === "output_samples") frame(f, 2).provenance!.outputStartSample = 960n;
    if (fault === "duration") f.finalized.durationMs = 85n;
    if (fault === "gap") f.pages[0]!.entries = f.pages[0]!.entries.filter(entry => entry.kind !== "audio_gap");
    if (fault === "gap_offset") frame(f, 3).gapOffsetMs = 124n;
    if (fault === "open_gap") for (const entry of f.pages[0]!.entries) if (entry.kind === "audio_gap") entry.endedAtMs = null;
    if (fault === "discontinuity") for (const entry of f.pages[0]!.entries) if (entry.kind === "discontinuity") entry.reason = "pause";
    assert.throws(() => reconnectOracle(f), fault);
  }
});
test("component-only clock pairs allow failed-write sequence holes but reject stale domains and wrong final boundary", () => {
  assert.equal(reconnectOracle(fixture())?.drain, "confirmed");
  for (const fault of ["domain", "duplicate", "zero", "wrong_boundary", "early_final"] as const) {
    const f = fixture();
    if (fault === "domain") finalPair(f).pair.clockDomainId = "foreign";
    if (fault === "duplicate") finalPair(f).pair.sequence = 3n;
    if (fault === "zero") finalPair(f).pair.sequence = 0n;
    if (fault === "wrong_boundary") f.drain.boundary.finalClockPairSequence = "4";
    if (fault === "early_final") f.pages[0]!.entries.splice(-2, 0, f.pages[0]!.entries.pop()!);
    assert.throws(() => reconnectOracle(f), fault);
  }
});
test("component-only timing retains honest first-frame priming for both cycles and checks decoded-page warnings", () => {
  const f = fixture();
  for (const index of [0, 2]) {
    const first = frame(f, index); first.captureStatus = "capture_alignment_missing"; first.wall = null;
    first.provenance!.quality = "unknown_priming"; first.provenance!.span = null;
    first.reasons = ["missing_timing", "capture_alignment_missing", "wall_alignment_missing"];
  }
  f.complete.warnings.push("missing_timing", "capture_alignment_missing", "wall_alignment_missing");
  assert.equal(reconnectOracle(f)?.timingCoverage, "partial");
  const wrong = structuredClone(f); frame(wrong, 3).captureStatus = "capture_alignment_missing";
  assert.throws(() => reconnectOracle(wrong));
  for (const fault of ["missing_warning", "duplicate_warning", "coverage", "unknown_quality"] as const) {
    const changed = structuredClone(f);
    if (fault === "missing_warning") changed.complete.warnings = ["local_wall_timestamp_estimate"];
    if (fault === "duplicate_warning") changed.complete.warnings.push("reconnect");
    if (fault === "coverage") changed.complete.coverageStatus = "available";
    if (fault === "unknown_quality") frame(changed, 0).provenance!.quality = "unknown_clock";
    assert.throws(() => reconnectOracle(changed), fault);
  }
});
test("component-only failed pair preserves nominal capture with honest missing wall brackets", () => {
  const f = fixture();
  for (const index of [0, 2]) {
    const first = frame(f, index); first.captureStatus = "capture_alignment_missing"; first.wall = null;
    first.provenance!.quality = "unknown_priming"; first.provenance!.span = null;
    first.reasons = ["missing_timing", "capture_alignment_missing", "wall_alignment_missing"];
  }
  // Runtime's missing-span priming barrier splits the clock-pair mapping run.
  for (const index of [1, 3, 4]) {
    const nominal = frame(f, index); nominal.wall = null;
    nominal.reasons = ["wall_alignment_missing", "missing_clock_pair"];
  }
  f.complete.warnings = ["audio_missing", "reconnect", "missing_timing", "capture_alignment_missing",
    "wall_alignment_missing", "missing_clock_pair"];
  assert.equal(reconnectOracle(f)?.recordedSamples, "2057");
  const inaccurate = structuredClone(f); frame(inaccurate, 1).reasons = ["wall_alignment_missing"];
  assert.throws(() => reconnectOracle(inaccurate));
});

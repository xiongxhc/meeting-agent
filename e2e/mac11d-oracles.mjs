// Synthetic calibration only: emission, native cleanup, custody and authenticated
// recorded coverage remain separate facts. Inputs are decoded by the shipped SDK.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

const schema = "mac11d-calibration/v1";
const barriers = new Set(["child_ready", "capture_started", "output_started", "capture_emission_complete",
  "capture_stopped", "output_stopped", "control_finished"]);
const resultKeys = ["schema", "type", "captureStarts", "captureStops", "outputStarts", "outputStops",
  "emittedBuffers", "emittedSamples", "cleanupConfirmed", "captureDrain", "departureOutcome", "departureReason"];
function exact(row, keys) {
  assert.ok(row && typeof row === "object" && !Array.isArray(row));
  assert.deepEqual(Object.keys(row).sort(), [...keys].sort());
}
function decimal(value) {
  assert.equal(typeof value, "string"); assert.match(value, /^(0|[1-9][0-9]*)$/);
  assert.ok(value.length <= 20 && BigInt(value) <= 18446744073709551615n);
  return BigInt(value);
}
export function parseCalibrationTelemetry(text) {
  assert.ok(Buffer.byteLength(text) <= 65536, "telemetry bound exceeded");
  assert.ok(text === "" || text.endsWith("\n"), "incomplete telemetry record");
  return text.split("\n").filter(Boolean).map(line => {
    assert.ok(Buffer.byteLength(line) <= 4096, "telemetry line bound exceeded");
    const row = JSON.parse(line);
    assert.equal(row.schema, schema);
    if (row.type === "barrier") {
      exact(row, ["schema", "type", "name"]); assert.ok(barriers.has(row.name));
    } else {
      exact(row, resultKeys); assert.equal(row.type, "result");
      for (const key of ["captureStarts", "captureStops", "outputStarts", "outputStops", "emittedBuffers", "emittedSamples"])
        assert.ok(Number.isSafeInteger(row[key]) && row[key] >= 0);
      assert.equal(typeof row.cleanupConfirmed, "boolean");
      assert.ok(["departure_confirmed", "departure_unconfirmed", "no_join_action"].includes(row.departureOutcome));
      assert.ok(["departure_observed", "departure_not_observed", "join_not_issued", "evidence_unavailable", "input_reap_failed", "cleanup_failed"].includes(row.departureReason));
      if (row.captureDrain !== null) {
        exact(row.captureDrain, ["drain", "reason", "boundary"]);
        if (row.captureDrain.drain === "confirmed") {
          assert.equal(row.captureDrain.reason, null);
          exact(row.captureDrain.boundary, ["captureEpoch", "lastFrameSequence", "outputEndSample", "finalClockPairSequence"]);
          Object.values(row.captureDrain.boundary).forEach(decimal);
        } else {
          assert.equal(row.captureDrain.drain, "unconfirmed"); assert.equal(row.captureDrain.boundary, null);
          assert.match(row.captureDrain.reason, /^[a-z_]{1,128}$/);
        }
      }
    }
    return row;
  });
}

export function calibrationOracle({ result, drain, shutdown, finalized, pages, complete, sessionId, bridgeSessionId }) {
  parseCalibrationTelemetry(JSON.stringify(result) + "\n");
  assert.equal(result.cleanupConfirmed, true, "native cleanup unconfirmed");
  for (const key of ["captureStarts", "captureStops", "outputStarts", "outputStops"]) assert.equal(result[key], 1);
  assert.equal(result.emittedBuffers, 3); assert.equal(result.emittedSamples, 1097);
  assert.equal(drain?.drain, "confirmed", "bridge drain unconfirmed");
  assert.deepEqual(result.captureDrain, drain, "telemetry/control drain disagreement");
  const boundary = drain.boundary;
  assert.equal(shutdown.reaped, true); assert.equal(shutdown.failure, null);
  assert.equal(shutdown.outcome?.outcome, "departure_confirmed");
  assert.equal(shutdown.outcome?.reason, "departure_observed");
  assert.equal(result.departureOutcome, shutdown.outcome.outcome);
  assert.equal(result.departureReason, shutdown.outcome.reason);
  assert.equal(finalized.format, "pcm_s16le/24000/1");
  assert.equal(complete?.type, "recording_alignment_complete"); assert.equal(complete.traversalSucceeded, true);
  assert.ok(["available", "partial"].includes(complete.coverageStatus));
  assert.equal(complete.pageCount, BigInt(pages.length)); assert.ok(pages.length > 0);
  const source = { sourceSessionId: sessionId, recordingHandle: finalized.recordingHandle, sha256: finalized.sha256 };
  assert.deepEqual(complete.source, source);
  pages.forEach((page, index) => {
    assert.equal(page.type, "recording_alignment_page"); assert.equal(page.pageIndex, BigInt(index));
    assert.deepEqual(page.source, source);
  });
  const entries = pages.flatMap(page => page.entries), frames = entries.filter(entry => entry.kind === "frame");
  const warnings = [...new Set(frames.flatMap(frame => [...frame.reasons, ...(frame.wall ? ["local_wall_timestamp_estimate"] : [])]))].sort();
  assert.deepEqual([...complete.warnings].sort(), warnings);
  assert.equal(complete.coverageStatus, warnings.some(warning => warning !== "local_wall_timestamp_estimate") ? "partial" : "available");
  assert.ok(!entries.some(entry => ["audio_gap", "discontinuity", "alignment_limit"].includes(entry.kind)), "recorded source loss");
  assert.equal(entries.filter(entry => entry.kind === "epoch").length, 1);
  const epoch = entries.find(entry => entry.kind === "epoch").epoch;
  assert.equal(epoch.captureEpoch, decimal(boundary.captureEpoch)); assert.equal(epoch.bridgeSessionId, bridgeSessionId);
  let end = 0n;
  assert.equal(frames.length, 3);
  frames.forEach((frame, index) => {
    assert.equal(frame.sampleRateHz, 24000); assert.equal(frame.gapOffsetMs, 0n);
    assert.deepEqual(frame.epoch, epoch);
    const p = frame.provenance; assert.ok(p);
    if (frame.captureStatus === "capture_alignment_missing") {
      assert.equal(index, 0); assert.equal(p.quality, "unknown_priming"); assert.equal(p.span, null); assert.equal(frame.wall, null);
      assert.deepEqual([...frame.reasons].sort(), ["capture_alignment_missing", "missing_timing", "wall_alignment_missing"]);
    } else {
      assert.equal(frame.captureStatus, "available"); assert.equal(p.quality, "nominal_frame_endpoint_interpolation");
      assert.ok(p.span);
      if (frame.wall === null) assert.deepEqual([...frame.reasons].sort(), ["missing_clock_pair", "wall_alignment_missing"]);
      else { assert.ok(frame.wall); assert.deepEqual(frame.reasons, []); }
    }
    assert.equal(p.captureEpoch, epoch.captureEpoch); assert.equal(p.sequence, BigInt(index + 1));
    assert.equal(p.outputStartSample, end); assert.equal(frame.mediaStartSample, end);
    assert.ok(Number.isSafeInteger(p.sampleCount) && p.sampleCount > 0);
    end += BigInt(p.sampleCount); assert.equal(frame.mediaEndSample, end);
  });
  assert.equal(end, 1097n, "emitted tail missing from authenticated recording");
  assert.equal(end, decimal(boundary.outputEndSample));
  assert.equal(BigInt(frames.length), decimal(boundary.lastFrameSequence));
  const pairs = entries.filter(entry => entry.kind === "clock_pair");
  assert.ok(pairs.length >= 2);
  pairs.forEach((entry, index) => {
    assert.equal(entry.pair.clockDomainId, epoch.clockDomainId, "recorded pair host domain mismatch");
    assert.equal(entry.pair.sequence, BigInt(index + 1), "recorded pair sequence discontinuity");
  });
  assert.equal(pairs.at(-1).pair.sequence, decimal(boundary.finalClockPairSequence));
  assert.ok(entries.indexOf(pairs.at(-1)) > entries.indexOf(frames.at(-1)), "final pair precedes tail");
  assert.equal(finalized.durationMs, end * 1000n / 24000n);
  return { recordedSamples: end.toString(), recordedFrames: frames.length, pages: pages.length, drain: "confirmed",
    nativeCleanup: "confirmed", custody: "departure_confirmed", timingCoverage: complete.coverageStatus,
    timingWarnings: complete.warnings, scope: "synthetic_normal_drain_calibration" };
}

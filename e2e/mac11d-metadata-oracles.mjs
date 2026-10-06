// Test-only component contract; the actual SDK runner supplies integrated proof.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { pageWarnings } from "../dist/src/sessions/recording-alignment.js";
import { parseCalibrationTelemetry } from "./mac11d-oracles.mjs";

const schema = "mac11d-metadata/v1";
const normalKeys = ["schema", "type", "captureStarts", "captureStops", "outputStarts", "outputStops",
  "emittedBuffers", "emittedSamples", "cleanupConfirmed", "captureDrain", "departureOutcome", "departureReason"];
const counters = ["connectionsCreated", "metadataInvalidations", "rejectedWallSamples"];
const barriers = ["child_ready", "capture_started", "output_started", "capture_emission_complete", "metadata_clock_fault",
  "capture_stopped", "output_stopped", "control_finished"];
export function parseMetadataTelemetry(text) {
  assert.equal(typeof text, "string"); assert.ok(Buffer.byteLength(text) <= 65536);
  assert.ok(text === "" || text.endsWith("\n"), "incomplete telemetry record");
  const seen = new Set(); let terminal = false;
  return text.split("\n").filter(Boolean).map(line => {
    assert.ok(Buffer.byteLength(line) <= 4096); assert.equal(terminal, false, "telemetry after result");
    const row = JSON.parse(line); assert.equal(row.schema, schema);
    if (row.type === "barrier") {
      assert.deepEqual(Object.keys(row).sort(), ["schema", "type", "name"].sort());
      assert.ok(barriers.includes(row.name) && !seen.has(row.name)); seen.add(row.name);
    } else {
      assert.deepEqual(Object.keys(row).sort(), [...normalKeys, ...counters].sort()); assert.equal(row.type, "result");
      const normal = Object.fromEntries(normalKeys.map(key => [key, row[key]]));
      parseCalibrationTelemetry(JSON.stringify({ ...normal, schema: "mac11d-calibration/v1" }) + "\n");
      for (const key of counters) assert.ok(Number.isSafeInteger(row[key]) && row[key] >= 0);
      terminal = true;
    }
    return row;
  });
}

export function metadataFailureOracle({ records, result, events, drain, shutdown, finalized, pages, complete, sessionId, bridgeSessionId }) {
  const decoded = parseMetadataTelemetry(records.map(row => JSON.stringify(row) + "\n").join(""));
  assert.deepEqual(decoded.at(-1), result); assert.equal(decoded.length, 9);
  const positions = Object.fromEntries(barriers.map(name => [name, decoded.findIndex(row => row.name === name)]));
  for (const name of barriers) assert.ok(positions[name] >= 0, `missing ${name}`);
  assert.equal(positions.child_ready, 0);
  for (const name of ["capture_started", "output_started"]) assert.ok(positions[name] < positions.capture_emission_complete);
  assert.ok(positions.capture_emission_complete < positions.metadata_clock_fault);
  for (const name of ["capture_stopped", "output_stopped"])
    assert.ok(positions.metadata_clock_fault < positions[name] && positions[name] < positions.control_finished);
  assert.equal(result.cleanupConfirmed, true, "native cleanup unconfirmed");
  for (const key of ["captureStarts", "captureStops", "outputStarts", "outputStops", "connectionsCreated", "metadataInvalidations"])
    assert.equal(result[key], 1, key);
  assert.ok(result.rejectedWallSamples >= 2, "periodic and final pair must both fail");
  assert.equal(result.emittedBuffers, 3); assert.equal(result.emittedSamples, 1097);
  assert.deepEqual(drain, { drain: "unconfirmed", reason: "drain_not_attempted", boundary: null });
  assert.deepEqual(result.captureDrain, drain, "telemetry/control drain disagreement");
  assert.equal(shutdown.reaped, true); assert.equal(shutdown.failure, null);
  assert.deepEqual(shutdown.outcome && { outcome: shutdown.outcome.outcome, reason: shutdown.outcome.reason },
    { outcome: "departure_confirmed", reason: "departure_observed" });
  assert.equal(result.departureOutcome, shutdown.outcome.outcome); assert.equal(result.departureReason, shutdown.outcome.reason);
  assert.ok(Array.isArray(events) && events.length > 0 && events.length <= 512);
  events.forEach((event, index) => {
    assert.equal(event.sessionId, bridgeSessionId);
    assert.ok(Number.isSafeInteger(event.sequence) && event.sequence > (events[index - 1]?.sequence ?? 0));
  });
  const connected = events.filter(row => row.type === "media_connected"); assert.equal(connected.length, 1);
  assert.ok(!events.some(row => ["reconnecting", "reconnected"].includes(row.type)), "metadata primary cannot recover");
  const terminals = events.filter(row => row.type === "media_disconnected" && row.captureDrain !== undefined);
  assert.equal(terminals.length, 1); assert.deepEqual(terminals[0].captureDrain, drain);
  assert.ok(events.slice(events.indexOf(connected[0]) + 1, events.indexOf(terminals[0]))
    .some(row => row.type === "media_disconnected" && row.captureDrain === undefined), "missing fault cleanup before leave");

  assert.equal(finalized.format, "pcm_s16le/24000/1");
  assert.equal(complete?.type, "recording_alignment_complete"); assert.equal(complete.traversalSucceeded, true);
  assert.ok(Array.isArray(pages) && pages.length > 0 && pages.length <= 32); assert.equal(complete.pageCount, BigInt(pages.length));
  const source = { sourceSessionId: sessionId, recordingHandle: finalized.recordingHandle, sha256: finalized.sha256 };
  assert.deepEqual(complete.source, source);
  pages.forEach((page, index) => {
    assert.equal(page.type, "recording_alignment_page"); assert.equal(page.pageIndex, BigInt(index)); assert.deepEqual(page.source, source);
  });
  const warnings = [...new Set(pages.flatMap(pageWarnings))].sort();
  assert.equal(new Set(complete.warnings).size, complete.warnings.length);
  assert.deepEqual([...complete.warnings].sort(), warnings); assert.equal(complete.coverageStatus, "partial");
  const entries = pages.flatMap(page => page.entries);
  assert.ok(entries.every(row => ["epoch", "clock_pair", "frame"].includes(row.kind)), "unexpected source loss or reconnect");
  const epochs = entries.filter(row => row.kind === "epoch"), pairs = entries.filter(row => row.kind === "clock_pair");
  const frames = entries.filter(row => row.kind === "frame");
  assert.equal(epochs.length, 1); assert.equal(pairs.length, 1); assert.equal(frames.length, 3);
  const epoch = epochs[0].epoch;
  assert.equal(epoch.captureEpoch, 1n); assert.equal(epoch.bridgeSessionId, bridgeSessionId);
  assert.ok(typeof epoch.clockDomainId === "string" && epoch.clockDomainId.length > 0);
  assert.equal(pairs[0].pair.clockDomainId, epoch.clockDomainId); assert.equal(pairs[0].pair.sequence, 1n);
  assert.ok(entries.indexOf(epochs[0]) < entries.indexOf(pairs[0]) && entries.indexOf(pairs[0]) < entries.indexOf(frames[0]));
  let end = 0n;
  frames.forEach((frame, index) => {
    assert.deepEqual(frame.epoch, epoch); assert.equal(frame.sampleRateHz, 24000); assert.equal(frame.gapOffsetMs, 0n);
    assert.equal(frame.wall, null, "missing final pair cannot create a wall bracket");
    const p = frame.provenance; assert.ok(p); assert.equal(p.captureEpoch, 1n); assert.equal(p.sequence, BigInt(index + 1));
    assert.equal(p.sampleCount, [480, 480, 137][index]); assert.equal(p.outputStartSample, end); assert.equal(frame.mediaStartSample, end);
    end += BigInt(p.sampleCount); assert.equal(frame.mediaEndSample, end);
    if (frame.captureStatus === "capture_alignment_missing") {
      assert.equal(index, 0); assert.equal(p.quality, "unknown_priming"); assert.equal(p.span, null);
      assert.deepEqual([...frame.reasons].sort(), ["capture_alignment_missing", "missing_timing", "wall_alignment_missing"]);
    } else {
      assert.equal(frame.captureStatus, "available"); assert.equal(p.quality, "nominal_frame_endpoint_interpolation"); assert.ok(p.span);
      assert.deepEqual([...frame.reasons].sort(), ["missing_clock_pair", "wall_alignment_missing"]);
    }
  });
  assert.equal(end, 1097n, "authenticated tail missing"); assert.equal(finalized.durationMs, 45n);
  return { recordedSamples: end.toString(), recordedFrames: frames.length, drain: "unconfirmed", nativeCleanup: "confirmed",
    custody: "departure_confirmed", timingCoverage: complete.coverageStatus, timingWarnings: complete.warnings,
    scope: "component_only_metadata_oracle" };
}

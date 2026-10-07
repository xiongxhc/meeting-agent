// Component-only evidence checks. This helper does not establish that any
// SDK/gateway/Swift integration ran; the runner owns that evidence and scope.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { pageWarnings } from "../dist/src/sessions/recording-alignment.js";
import { parseCalibrationTelemetry } from "./mac11d-oracles.mjs";

const schema = "mac11d-reconnect/v1";
const normalKeys = ["schema", "type", "captureStarts", "captureStops", "outputStarts", "outputStops",
  "emittedBuffers", "emittedSamples", "cleanupConfirmed", "captureDrain", "departureOutcome", "departureReason"];
const counters = ["connectionsCreated", "openedConnections", "captureWrites", "clockPairWrites",
  "injectedWriteFailures", "heldReads", "releasedHeldReads", "pendingHeldReads"];
const barriers = new Set(["child_ready", "capture_started", "output_started", "capture_emission_complete",
  "capture_stopped", "output_stopped", "control_finished", "transport_write_fault"]);
const repeated = new Set(["capture_started", "output_started", "capture_emission_complete", "capture_stopped", "output_stopped"]);
function exact(row, keys) {
  assert.ok(row && typeof row === "object" && !Array.isArray(row));
  assert.deepEqual(Object.keys(row).sort(), [...keys].sort());
}
export function parseReconnectTelemetry(text) {
  assert.equal(typeof text, "string");
  assert.ok(Buffer.byteLength(text) <= 65536, "telemetry bound exceeded");
  assert.ok(text === "" || text.endsWith("\n"), "incomplete telemetry record");
  const counts = new Map(); let terminal = false;
  return text.split("\n").filter(Boolean).map(line => {
    assert.ok(Buffer.byteLength(line) <= 4096, "telemetry line bound exceeded");
    assert.equal(terminal, false, "telemetry after result");
    const row = JSON.parse(line); assert.equal(row.schema, schema);
    if (row.type === "barrier") {
      exact(row, ["schema", "type", "name"]); assert.ok(barriers.has(row.name));
      const count = (counts.get(row.name) ?? 0) + 1;
      assert.ok(count <= (repeated.has(row.name) ? 2 : 1), "duplicate telemetry barrier");
      counts.set(row.name, count);
    } else {
      exact(row, [...normalKeys, ...counters]); assert.equal(row.type, "result");
      // Preserve the normal calibration's closed drain/custody contract.
      const normal = Object.fromEntries(normalKeys.map(key => [key, row[key]]));
      parseCalibrationTelemetry(JSON.stringify({ ...normal, schema: "mac11d-calibration/v1" }) + "\n");
      for (const key of counters) assert.ok(Number.isSafeInteger(row[key]) && row[key] >= 0);
      terminal = true;
    }
    return row;
  });
}

export function reconnectOracle({ result, events, drain, shutdown, finalized, pages, complete, sessionId, bridgeSessionId }) {
  parseReconnectTelemetry(JSON.stringify(result) + "\n");
  assert.equal(result.cleanupConfirmed, true, "native cleanup unconfirmed");
  for (const key of ["captureStarts", "captureStops", "outputStarts", "outputStops", "connectionsCreated", "openedConnections"])
    assert.equal(result[key], 2, key);
  assert.equal(result.emittedBuffers, 6); assert.equal(result.emittedSamples, 2194);
  assert.equal(result.captureWrites, 5); assert.ok(result.clockPairWrites >= 3);
  for (const key of ["injectedWriteFailures", "heldReads", "releasedHeldReads"]) assert.equal(result[key], 1, key);
  assert.equal(result.pendingHeldReads, 0, "held read not released");
  assert.equal(drain?.drain, "confirmed", "bridge drain unconfirmed");
  assert.deepEqual(result.captureDrain, drain, "telemetry/control drain disagreement");
  const boundary = drain.boundary;
  assert.equal(boundary.captureEpoch, "2"); assert.equal(boundary.lastFrameSequence, "3");
  assert.equal(boundary.outputEndSample, "1097");
  assert.equal(shutdown.reaped, true); assert.equal(shutdown.failure, null);
  assert.equal(shutdown.outcome?.outcome, "departure_confirmed");
  assert.equal(shutdown.outcome?.reason, "departure_observed");
  assert.equal(result.departureOutcome, shutdown.outcome.outcome);
  assert.equal(result.departureReason, shutdown.outcome.reason);

  assert.ok(Array.isArray(events) && events.length > 0 && events.length <= 512);
  events.forEach((event, index) => {
    assert.equal(event.sessionId, bridgeSessionId, "bridge event session mismatch");
    assert.ok(Number.isSafeInteger(event.sequence) && event.sequence > (events[index - 1]?.sequence ?? 0));
  });
  const connected = events.filter(event => event.type === "media_connected");
  const reconnecting = events.filter(event => event.type === "reconnecting");
  const reconnected = events.filter(event => event.type === "reconnected");
  assert.equal(connected.length, 2); assert.equal(reconnecting.length, 1); assert.equal(reconnected.length, 1);
  assert.equal(reconnecting[0].attempt, 1); assert.equal(reconnected[0].attempt, 1);
  const first = events.indexOf(connected[0]), retry = events.indexOf(reconnecting[0]), second = events.indexOf(connected[1]);
  assert.ok(first < retry && retry < second && second < events.indexOf(reconnected[0]), "reconnect admission order");
  assert.ok(events.slice(first + 1, retry).some(event => event.type === "media_disconnected"), "reconnect lacks prior disconnect");
  // Generic disconnect reasons are diagnostics, never primary error classification.
  const terminals = events.filter(event => event.type === "media_disconnected" && event.captureDrain !== undefined);
  assert.equal(terminals.length, 1, "missing or duplicate typed drain terminal");
  assert.deepEqual(terminals[0].captureDrain, drain);
  assert.ok(events.indexOf(terminals[0]) > events.indexOf(reconnected[0]));

  assert.equal(finalized.format, "pcm_s16le/24000/1");
  assert.equal(complete?.type, "recording_alignment_complete"); assert.equal(complete.traversalSucceeded, true);
  assert.ok(Array.isArray(pages) && pages.length > 0 && pages.length <= 32);
  assert.equal(complete.pageCount, BigInt(pages.length));
  const source = { sourceSessionId: sessionId, recordingHandle: finalized.recordingHandle, sha256: finalized.sha256 };
  assert.deepEqual(complete.source, source);
  pages.forEach((page, index) => {
    assert.equal(page.type, "recording_alignment_page"); assert.equal(page.pageIndex, BigInt(index));
    assert.deepEqual(page.source, source);
  });
  const warnings = [...new Set(pages.flatMap(pageWarnings))].sort();
  assert.ok(Array.isArray(complete.warnings) && new Set(complete.warnings).size === complete.warnings.length);
  assert.deepEqual([...complete.warnings].sort(), warnings, "decoded-page warning mismatch");
  assert.equal(complete.coverageStatus, warnings.some(warning => warning !== "local_wall_timestamp_estimate") ? "partial" : "available");
  const entries = pages.flatMap(page => page.entries), epochs = entries.filter(entry => entry.kind === "epoch");
  assert.equal(epochs.length, 2);
  epochs.forEach((entry, index) => {
    assert.equal(entry.epoch.captureEpoch, BigInt(index + 1)); assert.equal(entry.epoch.bridgeSessionId, bridgeSessionId);
    assert.ok(typeof entry.epoch.clockDomainId === "string" && entry.epoch.clockDomainId.length > 0);
  });
  const discontinuities = entries.filter(entry => entry.kind === "discontinuity");
  assert.equal(discontinuities.length, 2, "recorded reconnect discontinuity count");
  discontinuities.forEach((entry, index) => {
    assert.equal(entry.reason, "reconnect", "reconnect discontinuity reason");
    assert.equal(entry.captureEpoch, BigInt(index + 1), "reconnect discontinuity epoch");
  });
  assert.ok(!entries.some(entry => entry.kind === "alignment_limit"));
  const gaps = entries.filter(entry => entry.kind === "audio_gap"); assert.equal(gaps.length, 1);
  assert.equal(gaps[0].reason, "capture_discontinuity"); assert.equal(gaps[0].startedAtMs, 40n);
  assert.equal(typeof gaps[0].endedAtMs, "bigint"); assert.ok(gaps[0].endedAtMs >= 40n);
  const closedGapMs = gaps[0].endedAtMs - gaps[0].startedAtMs;

  const frames = entries.filter(entry => entry.kind === "frame"); assert.equal(frames.length, 5);
  const expectedSamples = [480, 480, 480, 480, 137];
  let end = 0n, outputEnd = 0n, activeEpoch = null, frameIndex = 0, pairSequence = 0n;
  const pairsByEpoch = [0, 0];
  for (const entry of entries) {
    if (entry.kind === "epoch") { activeEpoch = entry.epoch; outputEnd = 0n; }
    if (entry.kind === "clock_pair") {
      assert.ok(activeEpoch, "clock pair before epoch");
      assert.equal(entry.pair.clockDomainId, activeEpoch.clockDomainId, "clock pair host domain mismatch");
      assert.equal(typeof entry.pair.sequence, "bigint"); assert.ok(entry.pair.sequence > pairSequence, "clock pair sequence reversed or duplicated");
      pairSequence = entry.pair.sequence; pairsByEpoch[Number(activeEpoch.captureEpoch - 1n)] += 1;
    }
    if (entry.kind !== "frame") continue;
    const cycle = frameIndex < 2 ? 0 : 1, indexInCycle = frameIndex - (cycle ? 2 : 0), p = entry.provenance;
    assert.deepEqual(activeEpoch, epochs[cycle].epoch, "stale recorded generation");
    assert.deepEqual(entry.epoch, activeEpoch); assert.ok(p);
    assert.equal(entry.sampleRateHz, 24000); assert.equal(entry.gapOffsetMs, cycle ? closedGapMs : 0n);
    assert.equal(p.captureEpoch, activeEpoch.captureEpoch); assert.equal(p.sequence, BigInt(indexInCycle + 1));
    assert.equal(p.sampleCount, expectedSamples[frameIndex]); assert.equal(p.outputStartSample, outputEnd);
    assert.equal(entry.mediaStartSample, end); outputEnd += BigInt(p.sampleCount); end += BigInt(p.sampleCount);
    assert.equal(entry.mediaEndSample, end);
    if (entry.captureStatus === "capture_alignment_missing") {
      assert.equal(indexInCycle, 0); assert.equal(p.quality, "unknown_priming");
      assert.equal(p.span, null); assert.equal(entry.wall, null);
      assert.deepEqual([...entry.reasons].sort(), ["capture_alignment_missing", "missing_timing", "wall_alignment_missing"]);
    } else {
      assert.equal(entry.captureStatus, "available"); assert.equal(p.quality, "nominal_frame_endpoint_interpolation");
      assert.ok(p.span);
      // A failed pair or priming barrier can leave valid capture without two
      // wall pairs in its mapping run; preserve that explicit uncertainty.
      assert.deepEqual([...entry.reasons].sort(), entry.wall === null ? ["missing_clock_pair", "wall_alignment_missing"] : []);
    }
    frameIndex += 1;
  }
  assert.ok(pairsByEpoch[0] >= 1 && pairsByEpoch[1] >= 2);
  assert.ok(entries.indexOf(discontinuities[0]) > entries.indexOf(frames[1]) &&
    entries.indexOf(discontinuities[0]) < entries.indexOf(epochs[1]), "old reconnect closure order");
  assert.ok(entries.indexOf(discontinuities[1]) > entries.indexOf(epochs[1]) &&
    entries.indexOf(discontinuities[1]) < entries.indexOf(frames[2]), "reconnect discontinuity order");
  assert.ok(entries.indexOf(gaps[0]) > entries.indexOf(discontinuities[1]) &&
    entries.indexOf(gaps[0]) < entries.indexOf(frames[2]), "closed reconnect gap order");
  const pairs = entries.filter(entry => entry.kind === "clock_pair");
  assert.equal(pairs.at(-1).pair.sequence, BigInt(boundary.finalClockPairSequence));
  assert.ok(entries.indexOf(pairs.at(-1)) > entries.indexOf(frames.at(-1)), "final pair precedes tail");
  assert.equal(end, 2057n, "authenticated recording sample coverage mismatch");
  assert.equal(outputEnd, BigInt(boundary.outputEndSample));
  assert.equal(finalized.durationMs, end * 1000n / 24000n + frames.at(-1).gapOffsetMs);
  return { recordedSamples: end.toString(), recordedFrames: frames.length, pages: pages.length,
    drain: "confirmed", nativeCleanup: "confirmed", custody: "departure_confirmed",
    timingCoverage: complete.coverageStatus, timingWarnings: complete.warnings, scope: "component_only_reconnect_oracle" };
}

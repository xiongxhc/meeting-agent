// Component checks only. The runner supplies actual SDK/gateway/Swift evidence.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { pageWarnings } from "../dist/src/sessions/recording-alignment.js";
import { parseCalibrationTelemetry } from "./mac11d-oracles.mjs";

const normalKeys = ["schema", "type", "captureStarts", "captureStops", "outputStarts", "outputStops",
  "emittedBuffers", "emittedSamples", "cleanupConfirmed", "captureDrain", "departureOutcome", "departureReason"];
const nativeKeys = ["nativeFailures", "delayedStops", "lateStopCompletions", "pendingStopCompletions"];
const transportKeys = ["connectionsCreated", "openedConnections", "captureWrites", "clockPairWrites", "injectedWriteFailures"];
const commonBarriers = ["child_ready", "capture_started", "output_started", "capture_emission_complete",
  "capture_stopped", "output_stopped", "control_finished"];
const contracts = {
  "native-primary": { schema: "mac11d-native/v1", counters: ["connectionsCreated", ...nativeKeys],
    faults: ["native_primary_fault"], cleanup: false, emittedBuffers: 3, emittedSamples: 1097 },
  "unconfirmed-cleanup-write": { schema: "mac11d-unconfirmed/v1",
    counters: [...nativeKeys, ...transportKeys, "heldReads", "releasedHeldReads", "pendingHeldReads"],
    faults: ["transport_write_fault", "native_stop_completion_late"], cleanup: false, emittedBuffers: 3, emittedSamples: 1097 },
  "expiry-rollback": { schema: "mac11d-expiry/v1", counters: [...transportKeys, "expiredCaptureWrites"],
    faults: ["wall_rollback", "expiry_transport_fault"], cleanup: true, emittedBuffers: 181, emittedSamples: 86537 }
};
function contractFor(scenario) {
  assert.equal(typeof scenario, "string"); assert.ok(Object.hasOwn(contracts, scenario), "unknown failure scenario");
  return contracts[scenario];
}
function exact(row, keys) {
  assert.ok(row && typeof row === "object" && !Array.isArray(row));
  assert.deepEqual(Object.keys(row).sort(), [...keys].sort());
}
export function parseCalibrationFailureMetadata(text, scenario) {
  const contract = contractFor(scenario), expiry = scenario === "expiry-rollback";
  assert.equal(typeof text, "string"); assert.ok(Buffer.byteLength(text) <= 65536, "metadata bound exceeded");
  assert.ok(text === "" || text.endsWith("\n"), "incomplete metadata record");
  const seen = new Set(); let terminal = false;
  return text.split("\n").filter(Boolean).map(line => {
    assert.ok(Buffer.byteLength(line) <= 4096, "metadata line bound exceeded");
    assert.equal(terminal, false, "metadata after result");
    const row = JSON.parse(line); assert.equal(row?.schema, contract.schema);
    if (row.type === "barrier") {
      exact(row, ["schema", "type", "name"]);
      assert.ok([...commonBarriers, ...contract.faults].includes(row.name), "foreign fault barrier");
      assert.ok(!seen.has(row.name), "duplicate metadata barrier"); seen.add(row.name);
    } else {
      exact(row, [...normalKeys, ...contract.counters, ...(expiry ? ["rollbackApplied"] : [])]);
      assert.equal(row.type, "result");
      const normal = Object.fromEntries(normalKeys.map(key => [key, row[key]]));
      parseCalibrationTelemetry(JSON.stringify({ ...normal, schema: "mac11d-calibration/v1" }) + "\n");
      for (const key of contract.counters) assert.ok(Number.isSafeInteger(row[key]) && row[key] >= 0, key);
      if (expiry) assert.equal(typeof row.rollbackApplied, "boolean");
      terminal = true;
    }
    return row;
  });
}

export function runCalibrationFailureOracles({ scenario, records, result, events, drain, shutdown,
  finalized, pages, complete, sessionId, bridgeSessionId, expiredCredentialRefused }) {
  const contract = contractFor(scenario), expiry = scenario === "expiry-rollback", native = scenario === "native-primary";
  assert.ok(Array.isArray(records));
  const decoded = parseCalibrationFailureMetadata(records.map(row => JSON.stringify(row) + "\n").join(""), scenario);
  assert.deepEqual(decoded.at(-1), result); assert.equal(decoded.length, commonBarriers.length + contract.faults.length + 1);
  const pos = Object.fromEntries([...commonBarriers, ...contract.faults].map(name => [name, decoded.findIndex(row => row.name === name)]));
  for (const [name, index] of Object.entries(pos)) assert.ok(index >= 0, `missing ${name}`);
  assert.equal(pos.child_ready, 0);
  for (const name of ["capture_started", "output_started"]) assert.ok(pos[name] < pos.capture_emission_complete);
  const primary = native ? "native_primary_fault" : expiry ? "expiry_transport_fault" : "transport_write_fault";
  assert.ok(pos.capture_emission_complete < pos[primary], "fault precedes finite emission");
  if (expiry) assert.ok(pos.capture_emission_complete < pos.wall_rollback && pos.wall_rollback < pos[primary]);
  for (const name of ["capture_stopped", "output_stopped"]) assert.ok(pos[primary] < pos[name] && pos[name] < pos.control_finished);
  if (scenario === "unconfirmed-cleanup-write")
    assert.ok(pos.capture_stopped < pos.native_stop_completion_late && pos.native_stop_completion_late < pos.control_finished);
  for (const key of ["captureStarts", "captureStops", "outputStarts", "outputStops", "connectionsCreated"])
    assert.equal(result[key], 1, key);
  assert.equal(result.emittedBuffers, contract.emittedBuffers); assert.equal(result.emittedSamples, contract.emittedSamples);
  assert.equal(result.cleanupConfirmed, contract.cleanup, "native cleanup disagrees with primary fault");
  if (!expiry) {
    assert.equal(result.nativeFailures, native ? 1 : 0); assert.equal(result.delayedStops, native ? 0 : 1);
    assert.equal(result.lateStopCompletions, native ? 0 : 1); assert.equal(result.pendingStopCompletions, 0);
  }
  if (!native) {
    assert.equal(result.openedConnections, 1); assert.equal(result.injectedWriteFailures, 1);
    assert.ok(result.captureWrites >= 1 && result.captureWrites <= contract.emittedBuffers);
    assert.ok(result.clockPairWrites >= 1);
    if (expiry) {
      assert.equal(result.rollbackApplied, true); assert.equal(expiredCredentialRefused, true, "missing stale credential refusal");
      assert.ok(result.expiredCaptureWrites > 0 && result.expiredCaptureWrites <= result.captureWrites);
    } else {
      assert.equal(result.heldReads, 1); assert.equal(result.releasedHeldReads, 1); assert.equal(result.pendingHeldReads, 0);
    }
  }
  assert.deepEqual(drain, { drain: "unconfirmed", reason: "drain_not_attempted", boundary: null });
  assert.deepEqual(result.captureDrain, drain, "metadata/control drain disagreement");
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
  assert.ok(!events.some(row => ["reconnecting", "reconnected"].includes(row.type)), "primary failure cannot recover");
  const terminals = events.filter(row => row.type === "media_disconnected" && row.captureDrain !== undefined);
  assert.equal(terminals.length, 1); assert.deepEqual(terminals[0].captureDrain, drain);
  const connectedIndex = events.indexOf(connected[0]), terminalIndex = events.indexOf(terminals[0]);
  assert.ok(connectedIndex < terminalIndex);
  const faultReason = expiry ? "media_transport_interrupted" : "media_cleanup_unconfirmed";
  const untyped = events.filter(row => row.type === "media_disconnected" && row.captureDrain === undefined);
  const faults = untyped.filter(row => row.reason === faultReason);
  assert.equal(faults.length, 1, "missing sole actual fault disconnect");
  const faultIndex = events.indexOf(faults[0]);
  assert.ok(connectedIndex < faultIndex && faultIndex < terminalIndex);
  // The shipped session emits static diagnostics using the same event type as
  // lifecycle disconnects. They are deduplicated by reason and must not count
  // as a second lifecycle fault. Supervise emits delivery diagnoses before the
  // fault and its terminal diagnosis after; stop emits drain diagnosis last.
  const terminalDiagnosis = expiry ? "reconnect_exhausted" : "media_failed";
  const diagnosticReasons = ["capture_delivery_interrupted", "final_clock_pair_undelivered", terminalDiagnosis, "capture_drain_unconfirmed"];
  const diagnostics = untyped.filter(row => row !== faults[0]);
  assert.ok(diagnostics.length <= diagnosticReasons.length, "excessive static diagnostics");
  assert.equal(new Set(diagnostics.map(row => row.reason)).size, diagnostics.length, "duplicate static diagnostic");
  for (const diagnostic of diagnostics) {
    assert.ok(diagnosticReasons.includes(diagnostic.reason), "foreign disconnect or diagnostic");
    const index = events.indexOf(diagnostic);
    assert.ok(connectedIndex < index && index < terminalIndex, "diagnostic outside live media interval");
    if (["capture_delivery_interrupted", "final_clock_pair_undelivered"].includes(diagnostic.reason))
      assert.ok(index < faultIndex, "delivery diagnostic after lifecycle fault");
    else assert.ok(faultIndex < index, "terminal diagnostic before lifecycle fault");
  }
  const diagnosticIndex = reason => events.findIndex(row => row.type === "media_disconnected" && row.captureDrain === undefined && row.reason === reason);
  const deliveryIndex = diagnosticIndex("capture_delivery_interrupted"), finalPairIndex = diagnosticIndex("final_clock_pair_undelivered");
  if (deliveryIndex >= 0 && finalPairIndex >= 0) assert.ok(deliveryIndex < finalPairIndex, "reversed delivery diagnoses");
  const terminalDiagnosisIndex = diagnosticIndex(terminalDiagnosis), drainDiagnosisIndex = diagnosticIndex("capture_drain_unconfirmed");
  if (terminalDiagnosisIndex >= 0 && drainDiagnosisIndex >= 0)
    assert.ok(terminalDiagnosisIndex < drainDiagnosisIndex, "drain diagnosis before supervision exit");

  assert.equal(finalized.format, "pcm_s16le/24000/1");
  assert.equal(complete?.type, "recording_alignment_complete"); assert.equal(complete.traversalSucceeded, true);
  assert.ok(Array.isArray(pages) && pages.length > 0 && pages.length <= 32); assert.equal(complete.pageCount, BigInt(pages.length));
  const source = { sourceSessionId: sessionId, recordingHandle: finalized.recordingHandle, sha256: finalized.sha256 };
  assert.deepEqual(complete.source, source);
  pages.forEach((page, index) => {
    assert.equal(page.type, "recording_alignment_page"); assert.equal(page.pageIndex, BigInt(index)); assert.deepEqual(page.source, source);
    assert.ok(Array.isArray(page.entries) && page.entries.length > 0 && page.entries.length <= 64);
  });
  const warnings = [...new Set(pages.flatMap(pageWarnings))].sort();
  assert.equal(new Set(complete.warnings).size, complete.warnings.length); assert.deepEqual([...complete.warnings].sort(), warnings);
  assert.equal(complete.coverageStatus, warnings.some(warning => warning !== "local_wall_timestamp_estimate") ? "partial" : "available");
  const entries = pages.flatMap(page => page.entries);
  assert.ok(entries.every(row => ["epoch", "clock_pair", "frame"].includes(row.kind)), "fabricated source loss or recovery");
  const epochs = entries.filter(row => row.kind === "epoch"), pairs = entries.filter(row => row.kind === "clock_pair");
  const frames = entries.filter(row => row.kind === "frame");
  assert.equal(epochs.length, 1); assert.equal(entries[0], epochs[0]);
  const epoch = epochs[0].epoch; assert.equal(epoch.captureEpoch, 1n); assert.equal(epoch.bridgeSessionId, bridgeSessionId);
  assert.ok(typeof epoch.clockDomainId === "string" && epoch.clockDomainId.length > 0);
  assert.ok(pairs.length >= 1 && pairs.length <= (native ? 2 : result.clockPairWrites));
  pairs.forEach((entry, index) => {
    assert.equal(entry.pair.clockDomainId, epoch.clockDomainId); assert.equal(entry.pair.sequence, BigInt(index + 1));
  });
  assert.ok(frames.length >= 1 && frames.length <= contract.emittedBuffers);
  if (!native) assert.equal(frames.length, result.captureWrites, "completed capture writes disagree with authenticated source");
  assert.ok(entries.indexOf(pairs[0]) < entries.indexOf(frames[0]), "frame before initial clock pair");
  // A native fault can race converter/tail delivery. Authenticate the actual
  // contiguous prefix, never infer a drain ACK or full tail from emission. The
  // SDK already decoded each frame's timing values; preserve its uncertainty.
  let end = 0n;
  frames.forEach((frame, index) => {
    assert.deepEqual(frame.epoch, epoch); assert.equal(frame.sampleRateHz, 24000); assert.equal(frame.gapOffsetMs, 0n);
    const p = frame.provenance; assert.ok(p); assert.equal(p.captureEpoch, 1n); assert.equal(p.sequence, BigInt(index + 1));
    assert.equal(p.sampleCount, index === contract.emittedBuffers - 1 ? 137 : 480);
    assert.equal(p.outputStartSample, end); assert.equal(frame.mediaStartSample, end); end += BigInt(p.sampleCount);
    assert.equal(frame.mediaEndSample, end);
    if (frame.captureStatus === "capture_alignment_missing") {
      assert.equal(index, 0); assert.equal(p.quality, "unknown_priming"); assert.equal(p.span, null); assert.equal(frame.wall, null);
      assert.deepEqual([...frame.reasons].sort(), ["capture_alignment_missing", "missing_timing", "wall_alignment_missing"]);
    } else {
      assert.equal(frame.captureStatus, "available"); assert.equal(p.quality, "nominal_frame_endpoint_interpolation"); assert.ok(p.span);
      assert.deepEqual([...frame.reasons].sort(), frame.wall === null ? ["missing_clock_pair", "wall_alignment_missing"] : []);
      if (frame.wall !== null) assert.ok(pairs.length >= 2, "wall estimate without pair bracket");
    }
  });
  assert.ok(end <= BigInt(contract.emittedSamples)); assert.equal(finalized.durationMs, end * 1000n / 24000n);
  return { recordedSamples: end.toString(), recordedFrames: frames.length, emittedSamples: result.emittedSamples,
    prefixComplete: end === BigInt(result.emittedSamples), pages: pages.length, drain: "unconfirmed",
    nativeCleanup: contract.cleanup ? "confirmed" : "unconfirmed", custody: "departure_confirmed",
    timingCoverage: complete.coverageStatus, timingWarnings: complete.warnings, scope: "component_only_failure_oracle" };
}

// Actual Swift child/control/custody proof without starting any media or gateway.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { createChildBridgeSlot } from "../dist/src/adapters/child-bridge-process.js";
import { parseCalibrationArguments } from "./mac11d-calibration.mjs";
import { parseCalibrationTelemetry } from "./mac11d-oracles.mjs";
import { parseReconnectTelemetry } from "./mac11d-reconnect-oracles.mjs";
import { parseMetadataTelemetry } from "./mac11d-metadata-oracles.mjs";
import { parseCalibrationFailureMetadata } from "./mac11d-failure-oracles.mjs";

const { executable, scenario } = parseCalibrationArguments(process.argv.slice(2));
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mac11d-control-"))); chmodSync(root, 0o700);
const template = JSON.parse(readFileSync(new URL("./mac11d-swift/static-config.json", import.meta.url), "utf8"));
template.schema = "feishu-bridge-config/v1"; delete template.custody; template.evidenceRoot = root;
const config = path.join(root, "static.json"), telemetry = path.join(root, "telemetry.jsonl");
writeFileSync(config, JSON.stringify(template), { mode: 0o600 });
const binding = { physicalClientId: "mac11d-synthetic", physicalGenerationId: randomBytes(16).toString("hex"),
  occurrenceId: "mac11d-calibration@2026-10-01T00:00:00Z", bridgeSessionId: "mac11d-calibration" };
const child = await createChildBridgeSlot({ physicalClientId: binding.physicalClientId, bridgeId: binding.bridgeSessionId,
  executable, staticConfigPath: config, argv: ["--telemetry", telemetry, "--scenario", scenario, ...(scenario === "expiry-rollback" ? ["--expires-at-ms", String(Date.now() + 60000)] : [])],
  protocol: "bridge-session/v2", cooperativeGraceMs: 5000 }).launch(binding);
const events = []; let overflow = false;
const unsubscribe = child.bridge.subscribe(event => { if (events.length >= 256) overflow = true; else events.push(event); });
let shutdown, failure = null;
async function command(commandId, payload) {
  await child.bridge.send({ schema: "bridge-session/v2", sessionId: binding.bridgeSessionId, commandId, ...payload });
  const end = performance.now() + 5000;
  while (performance.now() < end && !events.some(event => event.type === "command_result" && event.commandId === commandId)) await delay(10);
  assert.equal(overflow, false);
  assert.equal(events.find(event => event.type === "command_result" && event.commandId === commandId)?.outcome, "ok");
}
try {
  await command("join", { type: "join", meetingOccurrenceId: binding.occurrenceId, meetingNo: "000000001", leaseId: "control-lease" });
  assert.ok(events.some(event => event.type === "joined"));
  await command("leave", { type: "leave", reason: "meeting_ended" });
  shutdown = await child.shutdown();
  assert.equal(shutdown.reaped, true); assert.equal(shutdown.failure, null);
  assert.equal(shutdown.outcome?.outcome, "departure_confirmed");
  const rows = (["native-primary", "unconfirmed-cleanup-write", "expiry-rollback"].includes(scenario) ? text => parseCalibrationFailureMetadata(text, scenario) : scenario === "metadata-primary" ? parseMetadataTelemetry : scenario === "normal" ? parseCalibrationTelemetry : parseReconnectTelemetry)(readFileSync(telemetry, "utf8"));
  const results = rows.filter(row => row.type === "result"); assert.equal(results.length, 1);
  const result = results[0]; assert.equal(result.captureStarts, 0); assert.equal(result.outputStarts, 0);
  assert.equal(result.captureDrain, null); assert.equal(result.departureOutcome, "departure_confirmed");
  if (scenario === "confirmed-cleanup-write") for (const key of ["connectionsCreated", "openedConnections", "injectedWriteFailures", "heldReads", "pendingHeldReads"])
    assert.equal(result[key], 0);
  if (scenario === "metadata-primary") for (const key of ["connectionsCreated", "metadataInvalidations", "rejectedWallSamples"])
    assert.equal(result[key], 0);
  if (["native-primary", "unconfirmed-cleanup-write", "expiry-rollback"].includes(scenario)) {
    for (const key of ["connectionsCreated", "nativeFailures", "delayedStops", "lateStopCompletions", "pendingStopCompletions", "openedConnections", "captureWrites", "clockPairWrites", "injectedWriteFailures", "expiredCaptureWrites"])
      if (key in result) assert.equal(result[key], 0);
    if ("rollbackApplied" in result) assert.equal(result.rollbackApplied, false);
  }
} catch { failure = "control_proof_failed"; }
finally {
  unsubscribe();
  if (!shutdown) {
    try { shutdown = await child.shutdown(); }
    catch { failure ??= "cleanup_unconfirmed"; }
  }
}
process.stdout.write(JSON.stringify({ status: failure ? "fail" : "pass", failure, scenario, root,
  scope: "actual_child_control_custody_no_media", reaped: shutdown?.reaped ?? false }) + "\n");
process.exitCode = failure ? 1 : 0;

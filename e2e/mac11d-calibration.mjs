// Synthetic Mac11d drain, reconnect and metadata-failure calibration only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RuntimeClient, StdioGatewayTransport } from "@conversation/runtime";
import { createChildBridgeSlot } from "../dist/src/adapters/child-bridge-process.js";
import { startFixtureProvider } from "./fixture-provider.mjs";
import { postmeetingGatewayToml } from "./gateway-config.mjs";
import { preflightLauncher } from "./launcher-preflight.mjs";
import { verifyPins, resolveRuntimeProfile, RUNTIME_PIN, EXPIRY_EVIDENCE_PROFILE, EXPIRY_EVIDENCE_PROVENANCE } from "./pins.mjs";
import { createExpiryEvidenceReader } from "./expiry-evidence-collector.mjs";
import { selectReleasedAdmission, validateExpiryEvidence } from "./expiry-evidence.mjs";
import { RECORDING_KEY_ENV, run, stage } from "./stage.mjs";
import { calibrationOracle, parseCalibrationTelemetry } from "./mac11d-oracles.mjs";
import { reconnectOracle, parseReconnectTelemetry } from "./mac11d-reconnect-oracles.mjs";
import { metadataFailureOracle, parseMetadataTelemetry } from "./mac11d-metadata-oracles.mjs";
import { parseCalibrationFailureMetadata, runCalibrationFailureOracles } from "./mac11d-failure-oracles.mjs";
import { expiredCredentialRefused, probeExpiredCredential } from "./expiry-auth-probe.mjs";

const scenarios = ["normal", "confirmed-cleanup-write", "metadata-primary", "native-primary", "unconfirmed-cleanup-write", "expiry-rollback"];

export function calibrationReport({ scenario, proof = null, failure = null, evidenceRoot = null, runtimeProfile = RUNTIME_PIN, expiryEvidence = null }) {
  const supported = scenarios.includes(scenario);
  try { runtimeProfile = calibrationProfile(scenario, runtimeProfile); }
  catch { failure ??= { phase: "outcome", code: "unsupported_runtime_profile" }; }
  if (!failure && !supported) failure = { phase: "outcome", code: "unsupported_scenario" };
  if (!failure && (!proof || typeof proof !== "object" || Array.isArray(proof) || Object.keys(proof).length === 0))
    failure = { phase: "outcome", code: "oracle_proof_missing" };
  const reconnect = scenario === "confirmed-cleanup-write", metadataFailure = scenario === "metadata-primary";
  const remainingFailure = ["native-primary", "unconfirmed-cleanup-write", "expiry-rollback"].includes(scenario);
  let expiryProof = null;
  const instrumented = runtimeProfile === EXPIRY_EVIDENCE_PROFILE && scenario === "expiry-rollback";
  if (!failure && instrumented && expiryEvidence !== null) {
    const result = validateExpiryEvidence(expiryEvidence);
    try { assert.deepEqual(proof, expiryEvidence.nativeProof); }
    catch { failure = { phase: "outcome", code: "oracle_proof_mismatch" }; }
    if (result.ok && !failure) expiryProof = result.proof;
    else if (!failure && result.code !== "expiry_evidence_incomplete") failure = { phase: "expiry_evidence", code: result.code };
  }
  // Legacy labels never authorize expiry acceptance; TEST consumes full raw A input.
  return { schema: "mac11d-calibration-report/v1", status: failure ? "fail" : scenario === "expiry-rollback" && !expiryProof ? "incomplete" : "pass", proof, failure,
    scope: !supported ? null : instrumented ? "instrumented_test_expiry_rollback" : remainingFailure ? `synthetic_${scenario.replaceAll("-", "_")}_failure` : metadataFailure ? "synthetic_metadata_primary_failure" : reconnect ? "synthetic_confirmed_cleanup_reconnect" : "synthetic_normal_drain_calibration", scenario,
    evidenceRoot, ...(instrumented ? { runtimeProfile: runtimeProfile.name, expiryProof } : {}) };
}
export function calibrationExitCode(report) {
  return report?.status === "pass" ? 0 : 1;
}

function calibrationProfile(scenario, value = RUNTIME_PIN) {
  const profile = resolveRuntimeProfile(value);
  assert.ok(profile === RUNTIME_PIN || profile === EXPIRY_EVIDENCE_PROFILE, "unsupported calibration profile");
  assert.ok(profile !== EXPIRY_EVIDENCE_PROFILE || scenario === "expiry-rollback", "TEST profile requires expiry-rollback");
  return profile;
}
export function parseCalibrationArguments(args) {
  assert.ok(args.length >= 2 && args.length <= 6 && args.length % 2 === 0, "invalid calibration arguments");
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    assert.ok(["--swift-child", "--scenario", "--runtime-profile"].includes(key) && !values.has(key));
    assert.ok(typeof value === "string" && value.length > 0 && !value.startsWith("--"));
    values.set(key, value);
  }
  const executable = values.get("--swift-child"), scenario = values.get("--scenario") ?? "normal";
  assert.ok(typeof executable === "string" && path.isAbsolute(executable) && executable !== "/" && !executable.includes("\0"));
  assert.ok(scenarios.includes(scenario));
  return { executable, scenario, runtimeProfile: calibrationProfile(scenario, values.get("--runtime-profile")) };
}

function expiryFailure(code) { return Object.assign(new Error(code), { code }); }
export function createExpiryOrdering() {
  let counter = 0;
  const state = {};
  return {
    markFirstTeardown() { state.firstTeardown ??= ++counter; },
    released(release) {
      if (state.firstTeardown || state.releaseObserved) throw expiryFailure("expiry_probe_ordering");
      state.releaseObserved = ++counter; state.releaseInstance = release.instance; state.releaseSequence = release.sequence;
    },
    probeStarted() { if (state.firstTeardown) throw expiryFailure("expiry_probe_ordering"); state.probeStarted = ++counter; },
    probeSettled() { state.probeSettled = ++counter; if (state.firstTeardown) throw expiryFailure("expiry_probe_ordering"); },
    snapshot: () => ({ ...state }),
  };
}
export async function observeReleasedExpiryProbe({ reader, sessionId, lease, reconnectDeadline, ordering },
  { now = () => performance.now(), sleep = delay, probe = probeExpiredCredential } = {}) {
  while (now() < reconnectDeadline) {
    if (ordering.snapshot().firstTeardown) throw expiryFailure("expiry_probe_ordering");
    const selected = selectReleasedAdmission(reader.readTail().parsed.records, { sessionId });
    if (selected.status === "released") {
      if (now() >= reconnectDeadline) break;
      ordering.released(selected.release); ordering.probeStarted();
      let result;
      try { result = await probe(lease, { reconnectDeadline }); }
      finally { ordering.probeSettled(); }
      if (now() >= reconnectDeadline || !result.connected || !result.writeCompleted || result.receivedBytes !== 0 ||
        !result.orderlyEnd || result.error !== null || result.timedOut) throw expiryFailure("expiry_probe_refused");
      return result;
    }
    const remaining = reconnectDeadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(10, remaining));
  }
  throw expiryFailure("expiry_release_deadline");
}
export function expiryNativeLifecycle(events, sessionId, bridgeSessionId) {
  assert.ok(events.every(event => event.sessionId === bridgeSessionId), "unbound native event");
  const count = predicate => events.filter(predicate).length;
  return { sessionId, connected: count(row => row.type === "media_connected"),
    faultDisconnected: count(row => row.type === "media_disconnected" && row.captureDrain === undefined && row.reason === "media_transport_interrupted"),
    terminalDisconnected: count(row => row.type === "media_disconnected" && row.captureDrain !== undefined),
    reconnecting: count(row => row.type === "reconnecting"), reconnected: count(row => row.type === "reconnected") };
}

// The component factory injects only process/clock/SDK boundaries into this same owner.
// The real path below always spawns its own fixed staged observer.
async function ownedExpiryObserver({ startupAbortSignal, markFirstTeardown }, { spawn: spawnChild, makeTransport,
  now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (startupAbortSignal?.aborted) throw expiryFailure("expiry_observer_startup_aborted");
  const child = spawnChild();
  let sdk, spawned = false, closed, failed = false, sdkClosed = false, success = false, closePromise, deadline;
  const pipes = new Set(), waiters = new Set();
  const notify = () => { for (const waiter of [...waiters]) waiter(); };
  const cleanup = () => ({ sdkTransportClosed: sdkClosed, runtimeClosed: success });
  const complete = () => spawned && closed?.code === 0 && closed?.signal === null && pipes.size === 3 && !failed;
  function close() {
    if (closePromise) return closePromise;
    markFirstTeardown(); deadline = now() + 1200;
    closePromise = new Promise((resolve, reject) => {
      let settled = false;
      const finish = ok => {
        if (settled) return; settled = true; clearTimer(timer); waiters.delete(check);
        success = ok;
        if (ok) resolve(); else reject(expiryFailure("expiry_observer_cleanup_failed"));
      };
      const check = () => {
        if (now() < deadline && sdkClosed && closed && pipes.size === 3) finish(complete());
      };
      const timer = setTimer(() => finish(false), Math.max(0, deadline - now()));
      waiters.add(check);
      // Start SDK closure immediately, concurrently with the observed lifecycle.
      try {
        const sdkClose = sdk ? sdk.close() : failedConstructionCleanup();
        Promise.resolve(sdkClose).then(() => {
          sdkClosed = now() < deadline && ["graceful", "forced"].includes(sdk?.cleanupOutcome?.status);
          if (!sdkClosed) finish(false); else check();
        }, () => finish(false));
      } catch { finish(false); }
      check();
    });
    return closePromise;
  }
  function failedConstructionCleanup() {
    // No usable SDK exists: retain ownership, request EOF/TERM/KILL on the same
    // fixed deadline. A construction failure can never authorize collection.
    try { child.stdin.end(); } catch { /* failed owner remains failed */ }
    const term = setTimer(() => { if (!closed) { try { child.kill("SIGTERM"); } catch { /* retain failure */ } } }, 100);
    const kill = setTimer(() => { if (!closed) { try { child.kill("SIGKILL"); } catch { /* retain failure */ } } }, 200);
    return new Promise(resolve => {
      const check = () => { if (closed && pipes.size === 3) { clearTimer(term); clearTimer(kill); waiters.delete(check); resolve(); } };
      waiters.add(check); check();
    });
  }
  let spawnResolve, spawnReject;
  const startup = new Promise((resolve, reject) => { spawnResolve = resolve; spawnReject = reject; });
  let startupSettled = false;
  function refuseStartup(code) {
    if (startupSettled) return;
    startupSettled = true; failed = true;
    void close().then(() => spawnReject(expiryFailure(code)), () => spawnReject(expiryFailure(code)));
  }
  child.once("spawn", () => { spawned = true; notify(); if (!startupSettled) { startupSettled = true; spawnResolve(); } });
  child.on("error", () => { failed = true; refuseStartup("expiry_observer_spawn_failed"); void close().catch(() => {}); notify(); });
  // The SDK also starts its own close on exit/EOF; observe those before its
  // listeners so even that path starts our original shared deadline.
  child.once("exit", () => { if (!closePromise) void close().catch(() => {}); });
  child.stdout.once("end", () => { if (!closePromise) void close().catch(() => {}); });
  child.once("close", (code, signal) => { closed = { code, signal }; if (!startupSettled) refuseStartup("expiry_observer_early_close");
    else if (!closePromise) void close().catch(() => {});
    notify(); });
  for (const name of ["stdin", "stdout", "stderr"]) {
    child[name].once("close", () => { pipes.add(name); notify(); });
    child[name].on("error", () => { failed = true; refuseStartup("expiry_observer_pipe_failed"); void close().catch(() => {}); notify(); });
  }
  const abort = () => refuseStartup("expiry_observer_startup_aborted");
  startupAbortSignal?.addEventListener("abort", abort, { once: true });
  try {
    try { sdk = makeTransport(child); }
    catch { refuseStartup("expiry_observer_construction_failed"); }
    if (startupAbortSignal?.aborted) abort();
    await startup;
  } finally { startupAbortSignal?.removeEventListener("abort", abort); }
  return { transport: { messages: sdk.messages, send: (message, version) => sdk.send(message, version), close }, cleanup,
    collectFinal(reader) {
      if (!success || !sdkClosed || failed || !complete()) throw expiryFailure("expiry_observer_collection_refused");
      return reader.readFinal();
    } };
}
export function startOwnedExpiryObserverForComponentTest(options, dependencies) { return ownedExpiryObserver(options, dependencies); }
function startOwnedExpiryObserver({ staged, runtimeProfile, verifiedPins, startupAbortSignal, markFirstTeardown }) {
  assert.equal(runtimeProfile, EXPIRY_EVIDENCE_PROFILE);
  assert.deepEqual(verifiedPins.provenance, EXPIRY_EVIDENCE_PROVENANCE);
  assert.equal(staged.runtimeProfile, runtimeProfile);
  assert.ok(path.isAbsolute(staged.launcherPath) && path.isAbsolute(staged.gatewayConfigPath));
  assert.equal(typeof StdioGatewayTransport.startWithChildForTest, "function", "pinned SDK TEST seam absent");
  return ownedExpiryObserver({ startupAbortSignal, markFirstTeardown }, {
    spawn: () => spawn(staged.launcherPath, ["--config", staged.gatewayConfigPath, "--client-protocol-version", "4"],
      { shell: false, stdio: ["pipe", "pipe", "pipe"], env: {} }),
    makeTransport: child => StdioGatewayTransport.startWithChildForTest(child),
  });
}

export function reconnectReady(records, events, bridgeSessionId) {
  const captures = records.flatMap((row, index) => row.type === "barrier" && row.name === "capture_emission_complete" ? [index] : []);
  const faults = records.flatMap((row, index) => row.type === "barrier" && row.name === "transport_write_fault" ? [index] : []);
  return captures.length === 2 && faults.length === 1 && captures[0] < faults[0] && faults[0] < captures[1] &&
    events.some(row => row.type === "reconnected" && row.sessionId === bridgeSessionId && row.attempt === 1);
}
export function metadataFailureReady(records, events, bridgeSessionId, faultBarrier = "metadata_clock_fault") {
  const captures = records.flatMap((row, index) => row.type === "barrier" && row.name === "capture_emission_complete" ? [index] : []);
  const faults = records.flatMap((row, index) => row.type === "barrier" && row.name === faultBarrier ? [index] : []);
  const connected = events.filter(row => row.type === "media_connected" && row.sessionId === bridgeSessionId);
  return captures.length === 1 && faults.length === 1 && captures[0] < faults[0] && connected.length === 1 &&
    !events.some(row => ["reconnecting", "reconnected"].includes(row.type)) &&
    events.slice(events.indexOf(connected[0]) + 1).some(row => row.type === "media_disconnected" &&
      row.sessionId === bridgeSessionId && row.captureDrain === undefined);
}

function safeCalibrationCode(error) {
  // Closed error vocabulary; arbitrary thrown properties may contain wire data.
  const allowed = ["EPERM", "EACCES", "ENOENT", "EIO", "expired_credential_refusal_unproven",
    ...["construction_failed", "startup_aborted", "spawn_failed", "early_close", "pipe_failed", "cleanup_failed", "collection_refused"].map(code => `expiry_observer_${code}`),
    "expiry_probe_ordering", "expiry_probe_refused", "expiry_release_deadline", "expiry_reader_close_failed",
    ...["descriptor", "path", "identity", "bounds", "file", "journal", "receipt", "provenance", "process", "observer", "state"].map(code => `expiry_collector_${code}`),
    ...["invalid", "schema", "bounds", "encoding", "grammar", "records", "instance", "sequence", "attempt", "address", "decision", "completion",
      "incomplete", "ambiguous", "chain", "transport", "profile", "provenance", "identity", "process", "probe", "cause", "ordering", "native", "cleanup"].map(code => `expiry_evidence_${code}`)];
  return allowed.includes(error?.code) ? error.code : "calibration_failed";
}
async function bounded(work) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("calibration_deadline")), 15000);
  })]); } finally { clearTimeout(timer); }
}
async function until(read, predicate) {
  const end = performance.now() + 15000;
  while (performance.now() < end) {
    const value = read(); if (predicate(value)) return value;
    await delay(10);
  }
  throw new Error("calibration_barrier_deadline");
}
function telemetry(filename, complete = false, parser = parseCalibrationTelemetry) {
  let text;
  try { text = readFileSync(filename, "utf8"); }
  catch (error) { if (!complete && error.code === "ENOENT") return []; throw error; }
  // A poll cannot interpret an in-progress final line as a complete record.
  return parser(complete ? text : text.slice(0, text.lastIndexOf("\n") + 1));
}
export function calibrationLease(lease, sessionId, bridgeSessionId) {
  assert.equal(lease.mediaProtocolVersion, 3); assert.equal(lease.sessionId, sessionId);
  assert.equal(lease.bridgeSessionId, bridgeSessionId, "issued bridge identity mismatch");
  return { ...lease, sessionId: lease.sessionId.toString(), expiresAtMs: lease.expiresAtMs.toString(),
    reconnectWindowMs: lease.reconnectWindowMs.toString() };
}

export async function runCalibration(executable, { scenario = "normal", runtimeProfile = RUNTIME_PIN } = {}) {
  runtimeProfile = calibrationProfile(scenario, runtimeProfile);
  const instrumented = runtimeProfile === EXPIRY_EVIDENCE_PROFILE;
  assert.ok(typeof executable === "string" && executable !== "/" && !executable.includes("\0") && path.isAbsolute(executable), "absolute Swift calibration child required");
  assert.ok(scenarios.includes(scenario));
  const reconnect = scenario === "confirmed-cleanup-write";
  const metadataFailure = scenario === "metadata-primary";
  const remainingFailure = ["native-primary", "unconfirmed-cleanup-write", "expiry-rollback"].includes(scenario);
  const faultBarrier = { "native-primary": "native_primary_fault", "unconfirmed-cleanup-write": "transport_write_fault", "expiry-rollback": "expiry_transport_fault" }[scenario];
  const parser = remainingFailure ? text => parseCalibrationFailureMetadata(text, scenario) : metadataFailure ? parseMetadataTelemetry : reconnect ? parseReconnectTelemetry : parseCalibrationTelemetry;
  const repository = path.resolve(import.meta.dirname, "..");
  let phase = "pinned_prerequisites", provider, staged, transport, client, child, voice, unsubscribe;
  let failure = null, proof = null, shutdown = null, expiredRefusal = false;
  let verifiedPins, owner, reader, sessionId, nativeProof, nativeLifecycle, probe, finalEvidence, providerClosed = false;
  const ordering = createExpiryOrdering();
  const markFirstTeardown = ordering.markFirstTeardown;
  try {
    assert.equal(run(process.execPath, [path.join(repository, "scripts/check-runtime-sdk.mjs")], { cwd: repository }).exit, 0,
      "imported Runtime SDK byte prerequisite failed");
    verifiedPins = await verifyPins(runtimeProfile);
    phase = "fixture_listener";
    provider = await startFixtureProvider();
    phase = "stage"; staged = stage({ repository, runtimeProfile });
    if (instrumented) reader = createExpiryEvidenceReader(staged.expiryEvidenceDescriptorPath);
    const telemetryPath = path.join(staged.directories.evidence, "mac11d-telemetry.jsonl");
    const readTelemetry = (complete = false) => telemetry(telemetryPath, complete, parser);
    const configTemplate = JSON.parse(readFileSync(path.join(repository, "e2e/mac11d-swift/static-config.json"), "utf8"));
    configTemplate.schema = "feishu-bridge-config/v1";
    delete configTemplate.custody; // The shipped child slot injects the actual generation binding.
    configTemplate.evidenceRoot = staged.directories.evidence;
    writeFileSync(staged.bridgeStaticConfigPath, JSON.stringify(configTemplate), { mode: 0o600 });
    writeFileSync(staged.gatewayConfigPath, postmeetingGatewayToml({
      recordingsDir: staged.directories.recordingsDir, keyEnv: RECORDING_KEY_ENV,
      modelsDir: staged.directories.runtimeModelsDir, fixtureEndpoint: provider.endpoint,
      ...(scenario === "expiry-rollback" ? { mediaTiming: { credentialLifetimeMs: 3000, reconnectWindowMs: 3000, maxOutboundQueueMs: 3000 } } : {}),
    }), { mode: 0o600 });
    phase = "runtime_preflight"; preflightLauncher(staged.launcherPath, { env: {} });
    phase = "runtime_connect";
    const startup = new globalThis.AbortController();
    const startupTimer = setTimeout(() => startup.abort(), 15000);
    try {
      if (instrumented) {
        owner = await startOwnedExpiryObserver({ staged, runtimeProfile, verifiedPins, startupAbortSignal: startup.signal, markFirstTeardown });
        transport = owner.transport;
      } else transport = await StdioGatewayTransport.start({ gatewayPath: staged.launcherPath, configPath: staged.gatewayConfigPath,
        protocolVersion: 4, env: {}, startupAbortSignal: startup.signal });
    } finally { clearTimeout(startupTimer); }
    client = await bounded(RuntimeClient.connect(transport, 4));
    sessionId = client.currentSessionId; assert.equal(typeof sessionId, "bigint");
    const bridgeSessionId = "mac11d-calibration";
    const binding = { physicalClientId: "mac11d-synthetic", physicalGenerationId: randomBytes(16).toString("hex"),
      occurrenceId: "mac11d-calibration@2026-10-01T00:00:00Z", bridgeSessionId };
    if (scenario === "expiry-rollback") {
      phase = "voice_start";
      voice = await bounded(client.startDrainableTimedVoiceSession({ bridgeSessionId, profile: "offline", responseMode: "external_gate" }));
    }
    phase = "child_launch";
    child = await createChildBridgeSlot({ physicalClientId: binding.physicalClientId, bridgeId: bridgeSessionId,
      executable, staticConfigPath: staged.bridgeStaticConfigPath, argv: ["--telemetry", telemetryPath, "--scenario", scenario, ...(voice ? ["--expires-at-ms", voice.mediaLease.expiresAtMs.toString()] : [])],
      cooperativeGraceMs: 10000, protocol: "bridge-session/v2" }).launch(binding);
    const events = []; let eventOverflow = false;
    unsubscribe = child.bridge.subscribe(event => {
      if (events.length >= 512) eventOverflow = true; else events.push(event);
    });
    const observed = () => { assert.equal(eventOverflow, false, "bridge event bound exceeded"); return events; };
    const command = async (commandId, payload) => {
      if (["leave", "stop_media", "finish_capture"].includes(payload.type)) markFirstTeardown();
      await bounded(child.bridge.send({ schema: "bridge-session/v2", sessionId: bridgeSessionId, commandId, ...payload }));
      const rows = await until(observed, rows => rows.some(row => row.type === "command_result" && row.commandId === commandId));
      assert.equal(rows.find(row => row.type === "command_result" && row.commandId === commandId).outcome, "ok");
    };
    await until(readTelemetry, rows => rows.some(row => row.name === "child_ready"));
    phase = "join";
    await command("join", { type: "join", meetingOccurrenceId: binding.occurrenceId, meetingNo: "000000001", leaseId: "calibration-lease" });
    await until(observed, rows => rows.some(row => row.type === "joined"));
    phase = "voice_start";
    voice ??= await bounded(client.startDrainableTimedVoiceSession({ bridgeSessionId, profile: "offline", responseMode: "external_gate" }));
    const lease = voice.mediaLease;
    phase = "media_capture";
    const beforeCapture = performance.now();
    await command("connect", { type: "connect_media", mediaLease: calibrationLease(lease, sessionId, bridgeSessionId) });
    await until(observed, rows => rows.some(row => row.type === "media_connected"));
    await until(readTelemetry, rows => rows.some(row => row.name === "capture_emission_complete"));
    if (reconnect) {
      phase = "confirmed_cleanup_reconnect";
      await until(readTelemetry, rows => reconnectReady(rows, observed(), bridgeSessionId));
    }
    if (metadataFailure) {
      phase = "metadata_primary_failure";
      await until(readTelemetry, rows => metadataFailureReady(rows, observed(), bridgeSessionId));
      // Hold the occurrence open beyond the shipped 100ms retry delay and two
      // configured observation ticks so an erroneous recovery is observable.
      await delay(600);
      assert.equal(metadataFailureReady(readTelemetry(), observed(), bridgeSessionId), true);
    }
    if (remainingFailure) {
      phase = scenario;
      await until(readTelemetry, rows => metadataFailureReady(rows, observed(), bridgeSessionId, faultBarrier) &&
        (scenario !== "unconfirmed-cleanup-write" || rows.some(row => row.name === "native_stop_completion_late")));
      await delay(600);
      assert.equal(metadataFailureReady(readTelemetry(), observed(), bridgeSessionId, faultBarrier), true);
      if (scenario === "expiry-rollback") {
        // The real lease is still active: no finish/voice stop can mask TTL refusal.
        phase = "expired_credential_probe";
        // The finite backend schedules 181 successive 20ms callbacks before
        // fault eligibility. Connect command precedes native start, so this
        // deadline is earlier than the gateway disconnect + its 3000ms
        // reconnect/outbound window. A slow host fails closed.
        const reconnectDeadline = beforeCapture + 181 * 20 + 3000;
        if (instrumented) {
          probe = await observeReleasedExpiryProbe({ reader, sessionId: sessionId.toString(), lease, reconnectDeadline, ordering });
          expiredRefusal = true; // Derived from that one accepted measured observation.
        } else expiredRefusal = await expiredCredentialRefused(lease, { reconnectDeadline });
      }
    }
    phase = "drain_and_departure";
    await command("leave", { type: "leave", reason: "meeting_ended" });
    await until(observed, rows => rows.some(row => row.type === "media_disconnected"));
    markFirstTeardown(); shutdown = await bounded(child.shutdown());
    observed();
    const records = readTelemetry(true), results = records.filter(row => row.type === "result");
    assert.equal(results.length, 1); assert.ok(records.some(row => row.name === "control_finished"));
    const disconnected = events.filter(row => row.type === "media_disconnected" && row.captureDrain !== undefined); assert.equal(disconnected.length, 1);
    if (!reconnect && !metadataFailure && !remainingFailure) assert.equal(events.filter(row => row.type === "media_disconnected").length, 1);
    phase = "finalize_and_authenticated_reopen";
    markFirstTeardown(); assert.equal(await bounded(voice.stopIfActive()), "stopped");
    markFirstTeardown(); const finalized = await bounded(client.finalizeRecording({ sessionId }));
    const pages = []; let complete = null;
    await bounded((async () => {
      for await (const row of client.readRecordingAlignment({ capability: finalized.recoveryCapability })) {
        if (row.type === "recording_alignment_page") { assert.ok(pages.length < 32); pages.push(row); }
        else { assert.equal(complete, null); complete = row; }
      }
    })());
    phase = "oracle";
    proof = (remainingFailure ? runCalibrationFailureOracles : metadataFailure ? metadataFailureOracle : reconnect ? reconnectOracle : calibrationOracle)({ records, result: results[0], events, drain: disconnected[0].captureDrain, shutdown,
      finalized, pages, complete, sessionId, bridgeSessionId, scenario, expiredCredentialRefused: expiredRefusal });
    if (instrumented) { nativeProof = proof; nativeLifecycle = expiryNativeLifecycle(events, sessionId.toString(), bridgeSessionId); }
    if (scenario === "expiry-rollback" && !instrumented) proof = { ...proof,
      credentialRefusal: "expired_issued_credential_refused", credentialRefusalCause: "unclassified",
      gatewayActiveFenceRelease: "unverified", ttlEnforcementAcceptance: "incomplete" };
    assert.ok(provider.calls.every(call => call.route === "health"), "calibration unexpectedly called provider");
  } catch (error) {
    // No wire payload, credential, provider text or PCM enters the report.
    failure ??= { phase, code: safeCalibrationCode(error) };
  } finally {
    unsubscribe?.();
    if (child && !shutdown) {
      try { markFirstTeardown(); shutdown = await bounded(child.shutdown()); }
      catch { failure ??= { phase: "child_cleanup", code: "cleanup_unconfirmed" }; }
    }
    try { if (client || transport) markFirstTeardown(); if (client) await bounded(client.close()); else if (transport) await bounded(transport.close()); }
    catch { failure ??= { phase: "runtime_cleanup", code: "cleanup_unconfirmed" }; }
    try { if (provider) { await bounded(provider.close()); providerClosed = true; } }
    catch { failure ??= { phase: "fixture_cleanup", code: "cleanup_unconfirmed" }; }
    if (reader) {
      try { finalEvidence = owner.collectFinal(reader); }
      catch (error) { failure ??= { phase: "expiry_collection", code: safeCalibrationCode(error) }; }
      finally { try { reader.close(); } catch { failure ??= { phase: "expiry_collection", code: "expiry_reader_close_failed" }; } }
    }
  }
  const expiryEvidence = instrumented && finalEvidence && nativeProof ? {
    ...finalEvidence, sessionId: sessionId.toString(), expectedProvenance: verifiedPins.provenance, probe,
    ordering: ordering.snapshot(), nativeLifecycle, nativeProof,
    cleanup: { ...owner.cleanup(), providerClosed, nativeChildReaped: shutdown?.reaped, nativeChildFailure: shutdown?.failure },
  } : null;
  const report = calibrationReport({ scenario, runtimeProfile, expiryEvidence, proof, failure, evidenceRoot: staged?.directories.evidence ?? null });
  if (staged) writeFileSync(path.join(staged.directories.evidence, "mac11d-report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { executable, scenario, runtimeProfile } = parseCalibrationArguments(process.argv.slice(2));
  const report = await runCalibration(executable, { scenario, runtimeProfile });
  process.stdout.write(JSON.stringify(report) + "\n");
  process.exitCode = calibrationExitCode(report);
}

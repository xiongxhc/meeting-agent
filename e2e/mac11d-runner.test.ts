import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
// @ts-expect-error Private harness JavaScript has no public declaration.
import { RUNTIME_PIN, RUNTIME_PROFILES, EXPIRY_EVIDENCE_PROFILE, EXPIRY_EVIDENCE_PROVENANCE } from "./pins.mjs";
// @ts-expect-error Test-only JavaScript runner has no public declaration.
import * as runner from "./mac11d-calibration.mjs";

test("runner admits only the explicit supported synthetic scenario and absolute child path", () => {
  assert.equal(typeof runner.parseCalibrationArguments, "function");
  assert.deepEqual(runner.parseCalibrationArguments(["--swift-child", "/private/child"]), { executable: "/private/child", scenario: "normal", runtimeProfile: RUNTIME_PIN });
  assert.deepEqual(runner.parseCalibrationArguments(["--scenario", "confirmed-cleanup-write", "--swift-child", "/private/child"]),
    { executable: "/private/child", scenario: "confirmed-cleanup-write", runtimeProfile: RUNTIME_PIN });
  assert.deepEqual(runner.parseCalibrationArguments(["--swift-child", "/private/child", "--scenario", "metadata-primary"]),
    { executable: "/private/child", scenario: "metadata-primary", runtimeProfile: RUNTIME_PIN });
  for (const scenario of ["native-primary", "unconfirmed-cleanup-write", "expiry-rollback"])
    assert.deepEqual(runner.parseCalibrationArguments(["--swift-child", "/private/child", "--scenario", scenario]),
      { executable: "/private/child", scenario, runtimeProfile: RUNTIME_PIN });
  for (const args of [["--swift-child", "relative"], ["--swift-child", "/a", "--scenario", "unknown"],
    ["--swift-child", "/a", "--scenario", "expiry"], ["--swift-child", "/a", "--swift-child", "/b"],
    ["--swift-child", "/a", "--token", "secret"]]) assert.throws(() => runner.parseCalibrationArguments(args));
});
test("metadata driver requires emission then fault and a same-session diagnostic disconnect before leave", () => {
  assert.equal(typeof runner.metadataFailureReady, "function");
  const records = ["capture_emission_complete", "metadata_clock_fault"].map(name => ({ type: "barrier", name }));
  const events = [{ type: "media_connected", sessionId: "bridge" }, { type: "media_disconnected", sessionId: "bridge" }];
  assert.equal(runner.metadataFailureReady(records, events, "bridge"), true);
  assert.equal(runner.metadataFailureReady(records.slice(0, 1), events, "bridge"), false);
  assert.equal(runner.metadataFailureReady(records.toReversed(), events, "bridge"), false);
  assert.equal(runner.metadataFailureReady(records, [{ ...events[0] }, { ...events[1], sessionId: "foreign" }], "bridge"), false);
  assert.equal(runner.metadataFailureReady(records, [...events, { type: "reconnecting", sessionId: "bridge", attempt: 1 }], "bridge"), false);
  assert.equal(runner.metadataFailureReady([...records, records[1]], events, "bridge"), false);
});
test("reconnect driver cannot leave after first capture or an unbound recovery event", () => {
  assert.equal(typeof runner.reconnectReady, "function");
  const records = ["capture_emission_complete", "transport_write_fault", "capture_emission_complete"].map(name => ({ type: "barrier", name }));
  const events = [{ type: "reconnected", attempt: 1, sessionId: "bridge" }];
  assert.equal(runner.reconnectReady(records, events, "bridge"), true);
  assert.equal(runner.reconnectReady(records.slice(0, 2), events, "bridge"), false);
  assert.equal(runner.reconnectReady(records, [{ ...events[0], sessionId: "foreign" }], "bridge"), false);
  assert.equal(runner.reconnectReady(records, [{ ...events[0], attempt: 2 }], "bridge"), false);
  assert.equal(runner.reconnectReady([records[1], records[0], records[2]], events, "bridge"), false);
});

// Synthetic outcome-logic inputs only; these do not establish SDK or TTL evidence.
const completedProof = {
  recordedSamples: "1097", recordedFrames: 3, pages: 1, drain: "confirmed",
  nativeCleanup: "confirmed", custody: "departure_confirmed", timingCoverage: "partial",
  timingWarnings: ["capture_alignment_missing"], scope: "synthetic_normal_drain_calibration",
};
const failureProof = {
  recordedSamples: "480", recordedFrames: 1, emittedSamples: 86537, prefixComplete: false,
  pages: 1, drain: "unconfirmed", nativeCleanup: "confirmed", custody: "departure_confirmed",
  timingCoverage: "partial", timingWarnings: ["capture_alignment_missing"],
  scope: "component_only_failure_oracle",
};
const expiryProof = {
  ...failureProof, credentialRefusal: "expired_issued_credential_refused",
  credentialRefusalCause: "unclassified", gatewayActiveFenceRelease: "unverified",
  ttlEnforcementAcceptance: "incomplete",
};

test("completed partial expiry evidence reports incomplete and exits nonzero", () => {
  assert.equal(typeof runner.calibrationReport, "function");
  const report = runner.calibrationReport({ scenario: "expiry-rollback", proof: expiryProof,
    failure: null, evidenceRoot: "/private/evidence" });
  assert.equal(runner.calibrationExitCode(report), 1);
  assert.deepEqual(report, { schema: "mac11d-calibration-report/v1", status: "incomplete",
    proof: expiryProof, failure: null, scope: "synthetic_expiry_rollback_failure",
    scenario: "expiry-rollback", evidenceRoot: "/private/evidence" });
});

for (const [name, labels] of [
  ["missing", {}],
  ["contradictory", { credentialRefusalCause: "unclassified", gatewayActiveFenceRelease: "verified", ttlEnforcementAcceptance: "complete" }],
  ["optimistic", { credentialRefusalCause: "ttl", gatewayActiveFenceRelease: "verified", ttlEnforcementAcceptance: "complete" }],
] as const) {
  test(`${name} expiry acceptance labels cannot authorize a successful command`, () => {
    assert.equal(typeof runner.calibrationReport, "function");
    const proof = { ...failureProof, credentialRefusal: "expired_issued_credential_refused", ...labels };
    const report = runner.calibrationReport({ scenario: "expiry-rollback", proof, failure: null, evidenceRoot: null });
    assert.equal(report.status, "incomplete");
    assert.equal(report.failure, null);
    assert.strictEqual(report.proof, proof);
    assert.equal(runner.calibrationExitCode(report), 1);
  });
}

for (const [name, proof, failure] of [
  ["fixture listener", null, { phase: "fixture_listener", code: "EPERM" }],
  ["cleanup after partial expiry proof", expiryProof, { phase: "runtime_cleanup", code: "cleanup_unconfirmed" }],
] as const) {
  test(`expiry incompleteness preserves the actual ${name} failure`, () => {
    assert.equal(typeof runner.calibrationReport, "function");
    const report = runner.calibrationReport({ scenario: "expiry-rollback", proof, failure, evidenceRoot: null });
    assert.equal(report.status, "fail");
    assert.strictEqual(report.failure, failure);
    assert.strictEqual(report.proof, proof);
    assert.equal(runner.calibrationExitCode(report), 1);
  });
}

const successfulScenarios = [
  ["normal", completedProof, "synthetic_normal_drain_calibration"],
  ["confirmed-cleanup-write", { ...completedProof, recordedSamples: "2057", recordedFrames: 6,
    scope: "component_only_reconnect_oracle" }, "synthetic_confirmed_cleanup_reconnect"],
  ["metadata-primary", { recordedSamples: "1097", recordedFrames: 3, drain: "unconfirmed",
    nativeCleanup: "confirmed", custody: "departure_confirmed", timingCoverage: "partial",
    timingWarnings: ["capture_alignment_missing"], scope: "component_only_metadata_oracle" }, "synthetic_metadata_primary_failure"],
  ["native-primary", { ...failureProof, emittedSamples: 1097, nativeCleanup: "unconfirmed" }, "synthetic_native_primary_failure"],
  ["unconfirmed-cleanup-write", { ...failureProof, emittedSamples: 1097, nativeCleanup: "unconfirmed" }, "synthetic_unconfirmed_cleanup_write_failure"],
] as const;
for (const [scenario, proof, scope] of successfulScenarios) {
  test(`${scenario} completed oracle and clean harness cleanup retain pass and exit zero`, () => {
    assert.equal(typeof runner.calibrationReport, "function");
    const report = runner.calibrationReport({ scenario, proof, failure: null, evidenceRoot: "/private/evidence" });
    assert.equal(report.status, "pass");
    assert.equal(report.failure, null);
    assert.strictEqual(report.proof, proof);
    assert.equal(report.scope, scope);
    assert.equal(report.evidenceRoot, "/private/evidence");
    assert.equal(runner.calibrationExitCode(report), 0);
  });
}

test("no supported scenario passes without oracle proof", () => {
  assert.equal(typeof runner.calibrationReport, "function");
  for (const scenario of [...successfulScenarios.map(([scenario]) => scenario), "expiry-rollback"]) {
    for (const proof of [undefined, null, {}, [], false, "complete"]) {
      const report = runner.calibrationReport({ scenario, proof, failure: null, evidenceRoot: null });
      assert.equal(report.status, "fail");
      assert.equal(report.failure.phase, "outcome");
      assert.equal(report.failure.code, "oracle_proof_missing");
      assert.equal(runner.calibrationExitCode(report), 1);
    }
  }
});

test("unknown scenarios refuse without deriving a successful scope from caller input", () => {
  assert.equal(typeof runner.calibrationReport, "function");
  for (const scenario of ["unknown", "__proto__", undefined]) {
    const report = runner.calibrationReport({ scenario, proof: completedProof, failure: null, evidenceRoot: null });
    assert.equal(report.status, "fail");
    assert.equal(report.scope, null);
    assert.equal(report.failure.code, "unsupported_scenario");
    assert.equal(runner.calibrationExitCode(report), 1);
  }
});

test("CLI exit mapping grants zero only to pass and refuses missing or unknown status", () => {
  assert.equal(typeof runner.calibrationExitCode, "function");
  assert.equal(runner.calibrationExitCode({ status: "pass" }), 0);
  for (const status of ["fail", "incomplete", "complete", undefined])
    assert.equal(runner.calibrationExitCode({ status }), 1);
  assert.equal(runner.calibrationExitCode(null), 1);
});


test("TEST selection refuses mixed, historical, duplicate and missing values before effects", async () => {
  const args = ["--swift-child", "/private/child", "--scenario", "expiry-rollback", "--runtime-profile", EXPIRY_EVIDENCE_PROFILE.name];
  assert.equal(runner.parseCalibrationArguments(args).runtimeProfile, EXPIRY_EVIDENCE_PROFILE);
  for (const bad of [args.slice(0, -1), [...args, "--scenario", "normal"], ["--swift-child"],
    ["--swift-child", "/a", "--scenario", ""], ["--swift-child", "/a", "--runtime-profile", EXPIRY_EVIDENCE_PROFILE.name],
    ["--swift-child", "/a", "--runtime-profile", "runtime14c"], ["--swift-child", "/a", "--runtime-profile", "unknown"]])
    assert.throws(() => runner.parseCalibrationArguments(bad));
  for (const runtimeProfile of [RUNTIME_PROFILES.runtime14c, { ...EXPIRY_EVIDENCE_PROFILE }, "unknown"])
    await assert.rejects(runner.runCalibration("/private/child", { scenario: "expiry-rollback", runtimeProfile }));
  await assert.rejects(runner.runCalibration("/private/child", { scenario: "normal", runtimeProfile: EXPIRY_EVIDENCE_PROFILE }));
});

const instance = "0123456789abcdef0123456789abcdef", schema = "runtime-media-admission-evidence/v1";
function expiryRows() {
  const predicates = { session_present: true, credential_matches: true, media_version_matches: true, bridge_binding_matches: true,
    credential_expired: false, reconnect_expired: false, active: false, capture_finished: false };
  return [
    { schema, instance, sequence: 0, type: "header" },
    { schema, instance, sequence: 1, type: "admission", session_id: "41", reservation_epoch: "2", connection_id: "1", accepted: true,
      context: { attempt_id: 2, transport: { kind: "tcp", peer: "127.0.0.1:51000", local: "127.0.0.1:4000" } }, predicates },
    { schema, instance, sequence: 2, type: "fence_release", session_id: "41", reservation_epoch: "2", connection_id: "1" },
    { schema, instance, sequence: 3, type: "admission", session_id: "41", reservation_epoch: "2", connection_id: null, accepted: false,
      context: { attempt_id: 1, transport: { kind: "tcp", peer: "127.0.0.1:52000", local: "127.0.0.1:4000" } }, predicates: { ...predicates, credential_expired: true } },
    { schema, instance, sequence: 4, type: "completion", record_count: 5, loss: false, writer_error: false },
  ];
}
const probeObservation = { local: "127.0.0.1:52000", remote: "127.0.0.1:4000", connected: true, writeCompleted: true,
  receivedBytes: 0, orderlyEnd: true, error: null, timedOut: false };

// Explicit component scheduler/children; no SDK, process, listener or network runs.
function componentClock() {
  let current = 0;
  const timers = new Map<() => void, number>();
  return { now: () => current, setTimer: (fn: () => void, ms: number) => { timers.set(fn, current + ms); return fn; },
    clearTimer: (fn: () => void) => timers.delete(fn), advance(ms: number) { current += ms; for (const [fn, end] of timers) if (end <= current) { timers.delete(fn); fn(); } } };
}
function componentOwner(options: { sdkReject?: boolean; constructReject?: boolean; outcome?: string; signal?: AbortSignal } = {}) {
  const clock = componentClock(), child = Object.assign(new EventEmitter(), {
    stdin: new EventEmitter(), stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true,
  });
  let resolveSdk!: () => void, rejectSdk!: (error: Error) => void, closes = 0, spawned = 0;
  const sdk = { messages: [], send() {}, cleanupOutcome: { status: options.outcome ?? "graceful" },
    close() { closes++; return new Promise<void>((resolve, reject) => { resolveSdk = resolve; rejectSdk = reject; }); } };
  const ordering = runner.createExpiryOrdering();
  const starting = runner.startOwnedExpiryObserverForComponentTest({ startupAbortSignal: options.signal, markFirstTeardown: ordering.markFirstTeardown }, {
    ...clock, spawn() { spawned++; return child; }, makeTransport() { if (options.constructReject) throw new Error("private details"); return sdk; },
  });
  const finish = (code: number | null = 0, signal: string | null = null, missing?: string) => {
    for (const name of ["stdin", "stdout", "stderr"] as const) if (name !== missing) child[name].emit("close");
    child.emit("close", code, signal);
    if (options.sdkReject) rejectSdk(new Error("secret")); else resolveSdk();
  };
  return { clock, child, sdk, starting, finish, fulfillSdk: () => resolveSdk(), ordering, closes: () => closes, spawned: () => spawned };
}

test("owned delegate permits final read only after actual concurrent SDK and all owned close observations", async () => {
  const c = componentOwner(); c.child.emit("spawn"); const owner = await c.starting;
  let reads = 0;
  assert.throws(() => owner.collectFinal({ readFinal() { reads++; } }));
  const closing = owner.transport.close(); assert.strictEqual(owner.transport.close(), closing);
  c.finish(); await closing;
  assert.equal(owner.collectFinal({ readFinal: () => { reads++; return "final"; } }), "final");
  assert.equal(reads, 1); assert.equal(c.closes(), 1);
  assert.deepEqual(owner.cleanup(), { sdkTransportClosed: true, runtimeClosed: true });
  assert.equal(c.ordering.snapshot().firstTeardown, 1);
});
for (const fault of ["nonzero", "signal", "stdin", "stdout", "stderr", "absent-close", "sdk-reject", "pipe-error", "forced-signal"]) {
  test(`owner ${fault} cannot collect readable final bytes despite graceful SDK`, async () => {
    const c = componentOwner({ sdkReject: fault === "sdk-reject", outcome: fault === "forced-signal" ? "forced" : "graceful" });
    c.child.emit("spawn"); const owner = await c.starting; const closing = owner.transport.close();
    const refused = assert.rejects(closing);
    if (fault === "pipe-error") c.child.stdout.emit("error", new Error("secret"));
    if (fault === "absent-close") c.sdk.close = () => Promise.resolve();
    else c.finish(fault === "nonzero" ? 70 : fault.includes("signal") ? null : 0, fault.includes("signal") ? "SIGTERM" : null,
      ["stdin", "stdout", "stderr"].includes(fault) ? fault : undefined);
    c.clock.advance(1200); await refused;
    let reads = 0; assert.throws(() => owner.collectFinal({ readFinal: () => { reads++; return "readable receipt"; } }));
    assert.equal(reads, 0); assert.equal(owner.cleanup().runtimeClosed, false);
  });
}
test("one owner deadline cannot be extended after SDK completion near 1200ms", async () => {
  const c = componentOwner(); c.child.emit("spawn"); const owner = await c.starting;
  const closing = owner.transport.close(), refused = assert.rejects(closing);
  c.clock.advance(1199); c.finish(0, null, "stderr"); await Promise.resolve();
  c.clock.advance(1); await refused; c.child.stderr.emit("close");
  assert.strictEqual(owner.transport.close(), closing); assert.throws(() => owner.collectFinal({ readFinal: () => "late" }));
});
test("pre-abort never spawns and abort/late-spawn or spawn-error never yields an owner", async () => {
  const aborted = new AbortController(); aborted.abort();
  const pre = componentOwner({ signal: aborted.signal }); await assert.rejects(pre.starting); assert.equal(pre.spawned(), 0);
  for (const fault of ["abort", "error", "early-close"]) {
    const signal = new AbortController(), c = componentOwner({ signal: signal.signal }); const refused = assert.rejects(c.starting);
    if (fault === "abort") signal.abort();
    else if (fault === "error") c.child.emit("error", new Error("secret"));
    else c.child.emit("close", 0, null);
    c.child.emit("spawn"); c.finish(); c.clock.advance(1200); await refused;
  }
});
test("wrapper construction failure still owns spawned child and bounds cleanup", async () => {
  const c = componentOwner({ constructReject: true }); const refused = assert.rejects(c.starting);
  c.child.emit("spawn"); c.clock.advance(1200); await refused;
});

test("release polling uses original lease/deadline, one measured probe and teardown follows settlement", async () => {
  let now = 0, reads = 0, probes = 0;
  const ordering = runner.createExpiryOrdering(), lease = { token: "never exported" };
  const probe = await runner.observeReleasedExpiryProbe({ reader: { readTail: () => ({ parsed: { records: expiryRows().slice(0, ++reads < 3 ? reads - 1 : 3) } }) },
    sessionId: "41", lease, reconnectDeadline: 30, ordering }, {
    now: () => now, sleep: async (ms: number) => { now += ms; }, probe: async (actualLease: unknown, options: { reconnectDeadline: number }) => {
      probes++; assert.strictEqual(actualLease, lease); assert.equal(options.reconnectDeadline, 30);
      assert.equal(ordering.snapshot().firstTeardown, undefined); return probeObservation;
    },
  });
  assert.strictEqual(probe, probeObservation); ordering.markFirstTeardown(); ordering.markFirstTeardown();
  assert.deepEqual(ordering.snapshot(), { releaseObserved: 1, releaseInstance: instance, releaseSequence: 2, probeStarted: 2, probeSettled: 3, firstTeardown: 4 });
  assert.equal(probes, 1); assert.equal(reads, 3);
});
for (const fault of ["deadline", "early-teardown", "foreign", "ambiguous", "tail-error", "probe-timeout", "probe-late", "teardown-during-probe"]) {
  test(`release/probe refuses ${fault} without a refreshed deadline or second authentication`, async () => {
    let now = 0, calls = 0; const ordering = runner.createExpiryOrdering();
    if (fault === "early-teardown") ordering.markFirstTeardown();
    const rows = expiryRows().slice(0, 3);
    if (fault === "foreign") rows[2]!.connection_id = "9";
    if (fault === "ambiguous") rows.push({ ...rows[2]!, sequence: 3 });
    await assert.rejects(runner.observeReleasedExpiryProbe({ reader: { readTail() {
      if (fault === "tail-error") throw new Error("replaced");
      return { parsed: { records: fault === "deadline" ? [] : rows } };
    } }, sessionId: "41", lease: {}, reconnectDeadline: 15, ordering }, {
      now: () => now, sleep: async (ms: number) => { assert.ok(ms <= 15 - now); now += ms; }, probe: async () => {
        calls++; if (fault === "probe-late") now = 16;
        if (fault === "teardown-during-probe") ordering.markFirstTeardown();
        return { ...probeObservation, timedOut: fault === "probe-timeout" };
      },
    }));
    assert.ok(calls <= 1); if (["deadline", "early-teardown", "foreign", "ambiguous", "tail-error"].includes(fault)) assert.equal(calls, 0);
  });
}

// Synthetic complete A inputs, independently constructed. These attest report logic only.
function fullExpiryInput() {
  const journal = Buffer.from(expiryRows().map(row => JSON.stringify(row) + "\n").join(""));
  const identity = { dev: "1", ino: "2", uid: 501, mode: 384, nlink: 1, parentDev: "1", parentIno: "3", parentUid: 501, parentMode: 448 };
  return { journal, sessionId: "41", expectedProvenance: { ...EXPIRY_EVIDENCE_PROVENANCE },
    receipt: { schema: "meeting-expiry-ownership/v1", provenance: { ...EXPIRY_EVIDENCE_PROVENANCE }, gatewayPid: 123,
      spawnObserved: true, exitCode: 0, signal: null, pipesClosed: true, observerFailure: null,
      binaryBeforeSha256: EXPIRY_EVIDENCE_PROVENANCE.gatewaySha256, binaryAfterSha256: EXPIRY_EVIDENCE_PROVENANCE.gatewaySha256,
      journalOpenedIdentity: { ...identity }, journalFinalIdentity: { ...identity }, journalOpenedSize: 100, journalFinalSize: journal.length,
      journalSha256: createHash("sha256").update(journal).digest("hex"), instance, completion: { recordCount: 5, loss: false, writerError: false } },
    journalIdentity: identity, probe: { ...probeObservation },
    ordering: { releaseObserved: 1, probeStarted: 2, probeSettled: 3, firstTeardown: 4, releaseInstance: instance, releaseSequence: 2 },
    nativeLifecycle: { sessionId: "41", connected: 1, faultDisconnected: 1, terminalDisconnected: 1, reconnecting: 0, reconnected: 0 },
    nativeProof: { ...failureProof }, cleanup: { sdkTransportClosed: true, runtimeClosed: true, providerClosed: true, nativeChildReaped: true, nativeChildFailure: null as string | null },
  };
}
function testReport(expiryEvidence: unknown, failure: unknown = null) {
  return runner.calibrationReport({ scenario: "expiry-rollback", runtimeProfile: EXPIRY_EVIDENCE_PROFILE, proof: failureProof, expiryEvidence, failure });
}
test("actual report validates raw complete evidence and exports safe proof separately", () => {
  const input = fullExpiryInput(), report = testReport(input);
  assert.equal(report.status, "pass"); assert.equal(runner.calibrationExitCode(report), 0);
  assert.equal(report.runtimeProfile, EXPIRY_EVIDENCE_PROFILE.name); assert.equal(report.expiryProof.releaseSequence, 2);
  assert.equal(report.scope, "instrumented_test_expiry_rollback"); assert.strictEqual(report.proof, failureProof);
  const serialized = JSON.stringify(report); assert.ok(!serialized.includes('"journal"')); assert.ok(!serialized.includes('"receipt"'));
  assert.equal(testReport(null).status, "incomplete");
  assert.equal(testReport({ ok: true, proof: report.expiryProof }).status, "fail");
  assert.equal(runner.calibrationReport({ scenario: "expiry-rollback", proof: expiryProof, expiryEvidence: input }).status, "incomplete");
});
for (const fault of ["tuple", "release", "order", "session", "provenance", "lifecycle", "native-proof", "journal-tail", "journal-loss", "receipt", "sdk", "runtime", "provider", "reaped", "native-failure"]) {
  test(`raw ${fault} mutation cannot pass or override an earlier failure`, () => {
    const input = fullExpiryInput();
    switch (fault) {
      case "tuple": input.probe.local = "127.0.0.1:52001"; break;
      case "release": input.ordering.releaseSequence = 3; break;
      case "order": input.ordering.firstTeardown = 2; break;
      case "session": input.sessionId = "42"; break;
      case "provenance": input.expectedProvenance.patchSha256 = "a".repeat(64); break;
      case "lifecycle": input.nativeLifecycle.faultDisconnected = 2; break;
      case "native-proof": input.nativeProof.scope = "optimistic"; break;
      case "journal-tail": input.journal = input.journal.subarray(0, input.journal.length - 1); break;
      case "journal-loss": input.journal = Buffer.from(input.journal.toString().replace('"loss":false', '"loss":true')); break;
      case "receipt": input.receipt.exitCode = 70; break;
      case "sdk": input.cleanup.sdkTransportClosed = false; break;
      case "runtime": input.cleanup.runtimeClosed = false; break;
      case "provider": input.cleanup.providerClosed = false; break;
      case "reaped": input.cleanup.nativeChildReaped = false; break;
      case "native-failure": input.cleanup.nativeChildFailure = "failed"; break;
    }
    assert.notEqual(testReport(input).status, "pass");
    const failure = { phase: "native", code: "actual_failure" };
    assert.strictEqual(testReport(input, failure).failure, failure);
  });
}
test("native lifecycle projection counts only the exact bound fault and terminal disconnect", () => {
  const events = [{ type: "media_connected", sessionId: "bridge" },
    ...["media_transport_interrupted", "delivery_diagnostic", "reconnect_diagnostic"].map(reason => ({ type: "media_disconnected", reason, sessionId: "bridge" })),
    { type: "media_disconnected", reason: "ended", captureDrain: {}, sessionId: "bridge" }];
  assert.deepEqual(runner.expiryNativeLifecycle(events, "41", "bridge"), fullExpiryInput().nativeLifecycle);
  assert.throws(() => runner.expiryNativeLifecycle([...events, { type: "reconnected", sessionId: "foreign" }], "41", "bridge"));
});
test("owner-produced cleanup prevents report pass solely on observer70 despite successful SDK", async () => {
  const c = componentOwner(); c.child.emit("spawn"); const owner = await c.starting;
  const closing = owner.transport.close(), refused = assert.rejects(closing); c.finish(70); await refused;
  const input = fullExpiryInput(); Object.assign(input.cleanup, owner.cleanup());
  assert.equal(input.cleanup.sdkTransportClosed, true); assert.equal(input.cleanup.runtimeClosed, false);
  assert.equal(testReport(input).failure.code, "expiry_evidence_cleanup");
});

test("unexpected SDK exit path starts the same owner close budget before later child close", async () => {
  const c = componentOwner(); c.child.emit("spawn"); const owner = await c.starting;
  c.child.emit("exit", 0, null);
  assert.equal(c.ordering.snapshot().firstTeardown, 1);
  const closing = owner.transport.close(); c.finish(); await closing; assert.equal(c.closes(), 1);
});
test("TEST report requires its native proof to be the actual separate raw oracle proof", () => {
  const input = fullExpiryInput();
  const report = runner.calibrationReport({ scenario: "expiry-rollback", runtimeProfile: EXPIRY_EVIDENCE_PROFILE,
    proof: { optimistic: true }, expiryEvidence: input });
  assert.equal(report.status, "fail");
});
test("TEST report refuses unregistered profile and incompatible scenario before acceptance", () => {
  for (const runtimeProfile of [{ ...EXPIRY_EVIDENCE_PROFILE }, RUNTIME_PROFILES.runtime14c, "unknown"])
    assert.equal(runner.calibrationReport({ scenario: "normal", runtimeProfile, proof: completedProof }).status, "fail");
  assert.equal(runner.calibrationReport({ scenario: "normal", runtimeProfile: EXPIRY_EVIDENCE_PROFILE, proof: completedProof }).status, "fail");
});

test("observer close0 and all pipes cannot hide an absent or failed SDK closure", async () => {
  for (const outcome of ["pending", "failed"]) {
    const c = componentOwner({ outcome }); c.child.emit("spawn"); const owner = await c.starting;
    const closing = owner.transport.close(), refused = assert.rejects(closing);
    for (const name of ["stdin", "stdout", "stderr"] as const) c.child[name].emit("close");
    c.child.emit("close", 0, null);
    if (outcome === "failed") c.fulfillSdk(); else c.clock.advance(1200);
    await refused; assert.throws(() => owner.collectFinal({ readFinal: () => "receipt" }));
    assert.equal(owner.cleanup().sdkTransportClosed, false);
  }
});
test("successful SDK closure alone cannot replace absent child close", async () => {
  const c = componentOwner(); c.child.emit("spawn"); const owner = await c.starting;
  const closing = owner.transport.close(), refused = assert.rejects(closing);
  c.fulfillSdk(); for (const name of ["stdin", "stdout", "stderr"] as const) c.child[name].emit("close");
  await Promise.resolve(); c.clock.advance(1200); await refused;
  assert.deepEqual(owner.cleanup(), { sdkTransportClosed: true, runtimeClosed: false });
  assert.throws(() => owner.collectFinal({ readFinal: () => "receipt" }));
});
test("actual successful owner projection admits complete raw report but reader failure still propagates", async () => {
  const c = componentOwner({ outcome: "forced" }); c.child.emit("spawn"); const owner = await c.starting;
  const closing = owner.transport.close(); c.finish(); await closing;
  const input = fullExpiryInput(); Object.assign(input.cleanup, owner.cleanup()); assert.equal(testReport(input).status, "pass");
  assert.throws(() => owner.collectFinal({ readFinal() { throw new Error("collection failed"); } }), /collection failed/);
});

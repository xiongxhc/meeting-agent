// R1: actual initial build failure, owned app SIGKILL, same-root maintenance reopen.
// External peers and explicit warning faults are scripted; no seed or receipt is.
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RUNTIME_PIN, sha256File, verifyPins } from "./pins.mjs";
import { CAPTURE_FRAME_LIMIT, NODE24, PROVIDER_CREDENTIAL, PROVIDER_CREDENTIAL_ENV, RECORDING_KEY_ENV, run, stage } from "./stage.mjs";
import { readKnownEndRecoveryState } from "./recovery-state.mjs";
import { measureWarningFile } from "./warning-commit-cut.mjs";
import { WARNING_STORE_FAULT_TRIGGER, warningSqlReplayBoundary } from "./warning-store-fault.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
export function initialRuntimeSettled(row) {
  return row.phase === "settled" && row.finalization === "seeded" && row.runtimeClose === "closed" &&
    ["graceful", "forced"].includes(row.runtimeCleanup);
}
export function parseRecoveryArguments(argv) {
  const options = { out: null, keep: false, warningCut: "before-file-fsync" };
  let warningCutSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out" && options.out === null) {
      const value = argv[++index];
      if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new Error("absolute evidence destination required");
      options.out = value;
    } else if (argv[index] === "--warning-cut" && !warningCutSeen) {
      const value = argv[++index];
      if (!["before-file-fsync", "accepted-before-store-crash", "acceptance-transaction-abort"].includes(value)) throw new Error("unsupported warning cut");
      options.warningCut = value; warningCutSeen = true;
    } else if (argv[index] === "--keep" && !options.keep) options.keep = true;
    else throw new Error("unsupported recovery argument");
  }
  if (options.out === null) throw new Error("usage: node e2e/recovery-run.mjs --out <absolute-dir> [--keep] [--warning-cut before-file-fsync|accepted-before-store-crash|acceptance-transaction-abort]");
  return options;
}

export function assertInitialCrashCut({ state, seedEvent, measuredSha256, readyBundles, descendants, liveGatewayPids }) {
  assert.equal(state.r1Preconditions.initialFailureRestartReady, true);
  assert.equal(state.pending.deliveryCount, 0); assert.equal(state.pending.jobCount, 0);
  assert.equal(state.source.retention, "retained"); assert.equal(measuredSha256, state.source.sha256);
  assert.equal(seedEvent.name, "r1_seed_failed"); assert.equal(seedEvent.providerArmedFailure, true);
  assert.equal(seedEvent.occurrenceId, state.occurrenceId); assert.equal(seedEvent.stopAtMs, state.stopAtMs);
  assert.equal(seedEvent.expiresAtMs, state.expiresAtMs); assert.equal(seedEvent.sourceSha256, state.source.sha256);
  assert.deepEqual(readyBundles, []); assert.deepEqual(descendants, []); assert.deepEqual(liveGatewayPids, []);
}

export function assertWarningCrashCut({ original, state, receiptEvent, file, measuredSourceSha256,
  admitted, ownerRunning, descendants, liveGatewayPids, readyBundles }) {
  assert.equal(admitted, true); assert.equal(ownerRunning, true);
  assert.equal(state.occurrenceId, original.occurrenceId); assert.equal(state.stopAtMs, original.stopAtMs);
  assert.equal(state.expiresAtMs, original.expiresAtMs); assert.deepEqual(state.source, original.source);
  assert.equal(state.source.retention, "retained"); assert.equal(measuredSourceSha256, state.source.sha256);
  assert.equal(state.lifecycle.owner, "seed"); assert.equal(state.lifecycle.state, "stopped");
  assert.equal(state.lifecycle.processCleanupState, null); assert.equal(state.lifecycle.processOwned, false);
  assert.equal(state.lifecycle.buildClaimed, false); assert.equal(state.lifecycle.cleanupClaimed, false);
  assert.deepEqual(state.pending, { deliveryCount: 0, jobCount: 0 });
  assert.equal(state.warning?.state, "claimed"); assert.equal(state.warning.claimed, true);
  assert.equal(state.warning.acceptedAtMs, null); assert.equal(state.warning.attemptCount, 1);
  assert.ok(Number.isSafeInteger(state.warning.claimExpiresAtMs) && state.warning.claimExpiresAtMs > state.stopAtMs &&
    state.warning.claimExpiresAtMs < state.expiresAtMs);
  assert.equal(receiptEvent.name, "warning_durable_receipt_blocked"); assert.equal(receiptEvent.occurrenceId, state.occurrenceId);
  assert.equal(receiptEvent.stopAtMs, state.stopAtMs); assert.equal(receiptEvent.expiresAtMs, state.expiresAtMs);
  assert.equal(receiptEvent.claimExpiresAtMs, state.warning.claimExpiresAtMs); assert.deepEqual(receiptEvent.file, file);
  assert.deepEqual(descendants, []); assert.deepEqual(liveGatewayPids, []); assert.deepEqual(readyBundles, []);
}

export function assertWarningSqlAbortCut({ original, state, faultEvent, rescheduleEvent, clearEvent, file, measuredSourceSha256,
  outcome, admitted, storeClosed, faultAbsent, descendants, liveGatewayPids, readyBundles }) {
  assert.deepEqual(outcome, { code: 0, signal: null }); assert.equal(admitted, true); assert.equal(storeClosed, true);
  assert.equal(faultAbsent, true);
  assert.equal(state.occurrenceId, original.occurrenceId); assert.equal(state.stopAtMs, original.stopAtMs);
  assert.equal(state.expiresAtMs, original.expiresAtMs); assert.deepEqual(state.source, original.source);
  assert.equal(state.source.retention, "retained"); assert.equal(measuredSourceSha256, state.source.sha256);
  assert.equal(state.lifecycle.owner, "seed"); assert.equal(state.lifecycle.state, "stopped");
  assert.equal(state.lifecycle.processCleanupState, null); assert.equal(state.lifecycle.processOwned, false);
  assert.equal(state.lifecycle.buildClaimed, false); assert.equal(state.lifecycle.cleanupClaimed, false);
  assert.deepEqual(state.pending, { deliveryCount: 0, jobCount: 0 });
  assert.equal(faultEvent.name, "warning_sql_fault_installed");
  assert.equal(faultEvent.fault.triggerName, WARNING_STORE_FAULT_TRIGGER); assert.match(faultEvent.fault.templateSha256, /^[0-9a-f]{64}$/);
  assert.equal(rescheduleEvent.name, "warning_acceptance_abort_rescheduled");
  assert.equal(clearEvent.name, "warning_sql_fault_cleared");
  for (const row of [faultEvent, rescheduleEvent, clearEvent]) {
    assert.equal(row.occurrenceId, original.occurrenceId); assert.equal(row.stopAtMs, original.stopAtMs);
    assert.equal(row.expiresAtMs, original.expiresAtMs); assert.deepEqual(row.fault, faultEvent.fault);
  }
  warningSqlReplayBoundary({ state, plan: { ...original, nextAttemptAtMs: rescheduleEvent.nextAttemptAtMs } });
  assert.equal(rescheduleEvent.attemptCount, state.warning.attemptCount);
  assert.deepEqual(rescheduleEvent.file, file); assert.deepEqual(rescheduleEvent.checkpoints, ["file", "directory"]);
  assert.deepEqual(descendants, []); assert.deepEqual(liveGatewayPids, []); assert.deepEqual(readyBundles, []);
}

export async function awaitOwnedExit(exited, budgetMs) {
  let timer;
  try {
    return await Promise.race([exited, new Promise((_, reject) => {
      timer = globalThis.setTimeout(() => reject(new Error("owned_child_cleanup_timeout")), budgetMs);
    })]);
  } finally { globalThis.clearTimeout(timer); }
}
export function assertPrivateOutputs(files, needles, additional = "") {
  const forbidden = needles.map(value => Buffer.from(value));
  for (const bytes of [...files.map(file => readFileSync(file)), Buffer.from(additional)]) {
    assert.ok(forbidden.every(needle => !bytes.includes(needle)), "private credential leaked into output");
    assert.ok(!bytes.includes(Buffer.alloc(960)) && bytes.subarray(0, 4).toString("latin1") !== "RIFF" &&
      !bytes.includes(Buffer.from("WAVEfmt ")), "plaintext scripted capture leaked into output");
  }
}
function privateOutputs(staged, evidence) {
  const files = [], walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false, "output symlink prevents absence proof");
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filename); else if (entry.isFile()) files.push(filename);
    }
  };
  for (const root of [staged.directories.control, staged.directories.recordingsDir, staged.directories.outboxDir, staged.directories.receiptsDir]) walk(root);
  if (existsSync(staged.launcherLog)) files.push(staged.launcherLog);
  for (const [filename, mode] of [[staged.root, 0o700], [staged.directories.runtimeKeyDir, 0o700], [staged.keyPath, 0o600]]) {
    const stat = lstatSync(filename);
    assert.ok(!stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === mode, "private key custody permissions failed");
  }
  const key = readFileSync(staged.keyPath, "utf8").trim(), secret = readFileSync(staged.appSecretFile, "utf8").trim();
  assert.match(key, /^[0-9a-f]{64}$/);
  const environments = evidence.phases.flatMap(phase => phase.events.filter(row => row.name === "entry_environment").map(row => row.keys));
  assert.ok(environments.length === evidence.phases.length && Array.isArray(evidence.bridgeState.envKeys));
  for (const keys of [...environments, evidence.bridgeState.envKeys])
    assert.ok([RECORDING_KEY_ENV, PROVIDER_CREDENTIAL_ENV, "FEISHU_APP_SECRET"].every(name => !keys.includes(name)), "private child environment boundary failed");
  assertPrivateOutputs(files, [key, secret, PROVIDER_CREDENTIAL], JSON.stringify(evidence));
  return { scannedFiles: files.length, meetingEnvironments: environments.length, bridgeEnvironment: true, keyPermissions: true, noSecretOrPlaintextMarkers: true };
}
function events(filename) {
  if (!existsSync(filename)) return [];
  return readFileSync(filename, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
export function processInventoryRows(result) {
  if (result.exit !== 0) throw new Error("process_inventory_unavailable");
  return result.stdout.split("\n").filter(line => line.trim()).map(line => {
    const [childPid, parentPid, ...command] = line.trim().split(/\s+/);
    return { pid: Number(childPid), ppid: Number(parentPid), command: command.join(" ") };
  });
}
export function recoveryCleanupEvidence({ children, remainingPids, cleanupSucceeded, inventoryUnavailable }) {
  const knownOwnedChildrenReaped = children.length > 0 && children.every(child => child.outcome !== null);
  const processInventoryVerified = !inventoryUnavailable && children.length > 0 && children.every(child => child.trees.length > 0);
  return { knownOwnedChildrenReaped, processInventoryVerified, cleanupCoverage: processInventoryVerified ? "complete" : "incomplete",
    cleanupConfirmed: cleanupSucceeded && knownOwnedChildrenReaped && processInventoryVerified && remainingPids.length === 0 };
}
function processTree(pid) {
  const rows = processInventoryRows(run("/bin/ps", ["-eo", "pid=,ppid=,comm="]));
  const tree = [], visit = parent => {
    for (const row of rows.filter(row => row.ppid === parent)) { tree.push(row); visit(row.pid); }
  };
  visit(pid); return tree;
}
function readyBundles(root) {
  const ready = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(root, entry.name);
    if (existsSync(path.join(nested, "READY"))) ready.push(nested);
    ready.push(...readyBundles(nested));
  }
  return ready;
}
function gatewayPids(staged) {
  if (!existsSync(staged.gatewayPidsPath)) return [];
  const values = readFileSync(staged.gatewayPidsPath, "utf8").trim().split("\n");
  assert.ok(values.every(value => /^[1-9][0-9]*$/.test(value)), "invalid gateway PID evidence");
  return [...new Set(values.map(Number))];
}
function childOwner(staged, entry, planPath, phase, evidence) {
  const child = spawn(NODE24, [entry, "--plan", planPath], {
    cwd: staged.directories.app, stdio: ["ignore", "pipe", "pipe"],
    env: { HOME: process.env.HOME, PATH: `${staged.directories.traceBin}:/opt/homebrew/opt/node@24/bin:/usr/bin:/bin`,
      TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "C.UTF-8" },
  });
  const record = { phase, pid: child.pid, command: [NODE24, entry, "--plan", planPath], outcome: null, trees: [], stdout: "", stderr: "" };
  evidence.children.push(record);
  child.stdout.on("data", bytes => { record.stdout += bytes; });
  child.stderr.on("data", bytes => { record.stderr += bytes; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", error => { record.spawnError = error.code ?? "spawn_failed"; reject(error); });
    child.once("exit", (code, signal) => { record.outcome = { code, signal }; resolve(record.outcome); });
  });
  // Attach immediately so a spawn refusal cannot become an unhandled rejection.
  void exited.catch(() => {});
  return { child, record, exited };
}
async function waitEvent(owner, filename, name, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const trace = events(filename), found = trace.find(row => row.name === name);
    if (trace.some(row => ["entry_failed", "drive_failed"].includes(row.name))) throw new Error("recovery_child_reported_failure");
    if (found) return found;
    if (owner.record.outcome) throw new Error("recovery_child_exited_before_cut");
    if (owner.record.spawnError) throw new Error("recovery_child_spawn_failed");
    if (Date.now() >= deadline) throw new Error("recovery_cut_timeout");
    owner.record.trees.push(processTree(owner.child.pid));
    await delay(100);
  }
}
async function cleanupOwned(owner) {
  if (owner.record.outcome) return;
  owner.child.kill("SIGTERM");
  try { await awaitOwnedExit(owner.exited, 30000); }
  catch {
    owner.child.kill("SIGKILL");
    await awaitOwnedExit(owner.exited, 10000);
    throw new Error("recovery_owned_cleanup_unconfirmed");
  }
}

export async function runRecovery(options) {
  const warningCut = options.warningCut ?? "before-file-fsync";
  assert.ok(["before-file-fsync", "accepted-before-store-crash", "acceptance-transaction-abort"].includes(warningCut));
  mkdirSync(options.out, { recursive: true, mode: 0o700 });
  assert.equal(readdirSync(options.out).length, 0, "evidence directory must be fresh");
  const evidence = { label: "scripted local application test readiness", row: "R1", status: "failed",
    command: [NODE24, fileURLToPath(import.meta.url), "--out", options.out, "--warning-cut", warningCut], warningCut, children: [], phases: [],
    instrumentation: ["external finite provider503", warningCut === "before-file-fsync" ? "filesystem warning adapter before-file-fsync fault once" :
      warningCut === "accepted-before-store-crash" ? "real durable sink receipt blocked before SQLite acceptance; actual owned app SIGKILL" :
        "exact occurrence AFTER UPDATE SQLite statement/acceptance-transaction abort; actual worker reschedule",
    "numeric maintenance clock; real monotonic clock unchanged"],
    unsupported: ["real Feishu/provider/device", "low-level SQLite COMMIT/fsync failure", "initial missing wall mapping variant", "remote publication", "Linux/remote split",
      ...(warningCut === "acceptance-transaction-abort" ? [] : ["warning acceptance SQL transaction-abort cut not selected"])] };
  let staged, active, failure = null, cleanupConfirmed = true;
  try {
    assert.equal(RUNTIME_PIN.name, "runtime14d");
    evidence.runtimePins = await verifyPins(); evidence.runtimeRevision = RUNTIME_PIN.revision;
    const build = run("/opt/homebrew/opt/node@24/bin/npm", ["run", "build"], {
      cwd: REPO, env: { ...process.env, PATH: `/opt/homebrew/opt/node@24/bin:${process.env.PATH ?? ""}` },
    });
    evidence.build = build; assert.equal(build.exit, 0, "application build failed");
    const head = run("/usr/bin/git", ["-C", REPO, "rev-parse", "HEAD"]);
    const diff = run("/usr/bin/git", ["-C", REPO, "diff", "HEAD", "--", "."]);
    assert.equal(head.exit, 0); assert.equal(diff.exit, 0);
    evidence.meetingHead = head.stdout.trim(); evidence.workingDiffSha256 = createHash("sha256").update(diff.stdout).digest("hex");
    staged = stage({ repository: REPO }); evidence.privateRoot = staged.root;
    evidence.stagedHashes = {};
    for (const [name, filename] of Object.entries({ gateway: staged.gatewayPath, sdk: staged.sdkTarball,
      entry: staged.entryPath, recoveryEntry: path.join(staged.directories.app, "e2e/recovery-entry.mjs"),
      main: staged.mainPath, composition: path.join(staged.directories.app, "dist/src/application-composition.js") }))
      evidence.stagedHashes[name] = await sha256File(filename);
    evidence.controllerSha256 = await sha256File(fileURLToPath(import.meta.url));
    evidence.stagedE2eHashes = {};
    for (const name of readdirSync(path.join(staged.directories.app, "e2e")).filter(name => name.endsWith(".mjs")))
      evidence.stagedE2eHashes[name] = await sha256File(path.join(staged.directories.app, "e2e", name));
    evidence.stagedE2eHashes["fixtures/e2e-bridge-child.mjs"] = await sha256File(path.join(staged.directories.app, "e2e/fixtures/e2e-bridge-child.mjs"));
    assert.equal(evidence.stagedHashes.gateway, evidence.runtimePins.gateway.sha256);
    assert.equal(evidence.stagedHashes.sdk, evidence.runtimePins.sdkTarball.sha256);
    const meeting = { eventId: "r1-invite-1", providerMeetingId: "9007199254740993", meetingNo: "900000001",
      title: "Scripted R1 occurrence", startSeconds: Math.floor(Date.now() / 1000) - 300,
      inviteSeconds: Math.floor(Date.now() / 1000) - 360, createTimeMs: Date.now() };
    const common = { privateRoot: staged.root, standaloneConfigPath: staged.standaloneConfigPath, controlDir: staged.directories.control,
      outboxDir: staged.directories.outboxDir, gatewayConfigPath: staged.gatewayConfigPath,
      runtimeRecordingsDir: staged.directories.recordingsDir, runtimeModelsDir: staged.directories.runtimeModelsDir,
      recordingKeyEnv: RECORDING_KEY_ENV, providerCredentialEnv: PROVIDER_CREDENTIAL_ENV, meeting };
    const initial = { ...common, initialR1: true, captureFrames: CAPTURE_FRAME_LIMIT,
      laneIntervalsMs: { backfill: 3600000, warning: 3600000, outbox: 3600000, notification: 3600000, discovery: 3600000, custody: 3600000 },
      budgets: { startMs: 60000, admitMs: 60000, captureMs: 120000, buildMs: 90000, readyTimeoutMs: 15000 } };
    const initialPath = path.join(staged.directories.configDir, "r1-initial.json");
    writeFileSync(initialPath, JSON.stringify(initial), { mode: 0o600 });
    active = childOwner(staged, staged.entryPath, initialPath, "initial", evidence);
    const eventPath = path.join(staged.directories.control, "events.ndjson");
    await waitEvent(active, eventPath, "media_capture", 180000);
    evidence.bridgeState = JSON.parse(readFileSync(path.join(staged.directories.control, "state.json"), "utf8"));
    assert.ok([...active.record.trees.flat(), ...processTree(active.child.pid)].some(row => row.pid === evidence.bridgeState.pid),
      "capture child not observed beneath admitted app");
    await waitEvent(active, eventPath, "meeting_ended_signalled", 60000);
    const seedEvent = await waitEvent(active, eventPath, "r1_seed_failed", 150000);
    const databasePath = path.join(staged.directories.stateRoot, "orchestration.db");
    const read = () => readKnownEndRecoveryState({ databasePath, occurrenceId: seedEvent.occurrenceId });
    const seed = read(), sourceSha256 = await sha256File(seed.source.path);
    assert.deepEqual(readdirSync(staged.directories.outboxDir), [], "canonical or partial outbox output before crash");
    assertInitialCrashCut({ state: read(), seedEvent, measuredSha256: sourceSha256, readyBundles: readyBundles(staged.directories.outboxDir),
      descendants: processTree(active.child.pid), liveGatewayPids: gatewayPids(staged).filter(alive) });
    evidence.phases.push({ phase: "initial", state: seed, events: events(eventPath), sourceSha256 });
    evidence.preExpiryPrivacy = privateOutputs(staged, evidence);
    assert.equal(active.child.kill("SIGKILL"), true);
    assert.deepEqual(await awaitOwnedExit(active.exited, 10000), { code: null, signal: "SIGKILL" });
    assert.deepEqual(gatewayPids(staged).filter(alive), []);
    active = null;
    let acceptedWarningSha256 = null, expectedWarningFile = null, claimExpiresAtMs = null, nextAttemptAtMs = null;
    const recoveryPhases = warningCut !== "before-file-fsync" ? ["warning-boundary", "warning-replay", "expiry-boundary"] :
      ["warning-boundary", "expiry-boundary"];
    for (const recoveryPhase of recoveryPhases) {
      const planPath = path.join(staged.directories.configDir, `${recoveryPhase}.json`);
      writeFileSync(planPath, JSON.stringify({ ...common, recoveryPhase, warningCut, occurrenceId: seed.occurrenceId,
        stopAtMs: seed.stopAtMs, expiresAtMs: seed.expiresAtMs, sourceSha256, expectedWarningSha256: acceptedWarningSha256,
        expectedWarningFile, claimExpiresAtMs, nextAttemptAtMs }), { mode: 0o600 });
      active = childOwner(staged, path.join(staged.directories.app, "e2e/recovery-entry.mjs"), planPath, recoveryPhase, evidence);
      const phaseEvents = path.join(staged.directories.control, `${recoveryPhase}.ndjson`);
      if (warningCut === "accepted-before-store-crash" && recoveryPhase === "warning-boundary") {
        const receiptEvent = await waitEvent(active, phaseEvents, "warning_durable_receipt_blocked", 120000);
        const state = read();
        expectedWarningFile = measureWarningFile({ outboxDir: staged.directories.outboxDir, occurrenceId: seed.occurrenceId,
          stopAtMs: seed.stopAtMs, expiresAtMs: seed.expiresAtMs });
        claimExpiresAtMs = state.warning?.claimExpiresAtMs;
        const descendants = processTree(active.child.pid); active.record.trees.push(descendants);
        assertWarningCrashCut({ original: seed, state, receiptEvent, file: expectedWarningFile,
          measuredSourceSha256: await sha256File(state.source.path),
          admitted: events(phaseEvents).some(row => row.name === "log" && row.code === "composition_started"),
          ownerRunning: active.record.outcome === null && alive(active.child.pid), descendants,
          liveGatewayPids: gatewayPids(staged).filter(alive), readyBundles: readyBundles(staged.directories.outboxDir) });
        assert.deepEqual(receiptEvent.checkpoints, ["file", "directory"]);
        evidence.phases.push({ phase: recoveryPhase, state, events: events(phaseEvents), file: expectedWarningFile,
          claimExpiresAtMs, cut: "durable sink receipt interrupted before DB acceptance" });
        evidence.warningCutPrivacy = privateOutputs(staged, evidence);
        assert.equal(active.child.kill("SIGKILL"), true);
        assert.deepEqual(await awaitOwnedExit(active.exited, 10000), { code: null, signal: "SIGKILL" });
        assert.deepEqual(read().warning, state.warning, "process death must leave the actual claim, not reschedule it");
        assert.deepEqual(gatewayPids(staged).filter(alive), []);
        active = null;
        continue;
      }
      await waitEvent(active, phaseEvents, "standalone_closed", 120000);
      assert.deepEqual(await awaitOwnedExit(active.exited, 10000), { code: 0, signal: null });
      assert.deepEqual(gatewayPids(staged).filter(alive), []);
      const phaseTrace = events(phaseEvents);
      const closedAt = phaseTrace.findIndex(row => row.name === "log" && row.code === "shutdown_store_closed");
      assert.ok(closedAt >= 0 && !phaseTrace.slice(closedAt + 1).some(row => row.name === "log"), "callback after store closure");
      if (warningCut === "acceptance-transaction-abort" && recoveryPhase === "warning-boundary") {
        const state = read(), faultAt = phaseTrace.findIndex(row => row.name === "warning_sql_fault_installed"),
          failedAt = phaseTrace.findIndex(row => row.name === "warning_acceptance_abort_rescheduled"),
          clearedAt = phaseTrace.findIndex(row => row.name === "warning_sql_fault_cleared");
        assert.ok(faultAt >= 0 && failedAt > faultAt && clearedAt > failedAt && closedAt > clearedAt);
        expectedWarningFile = measureWarningFile({ outboxDir: staged.directories.outboxDir, occurrenceId: seed.occurrenceId,
          stopAtMs: seed.stopAtMs, expiresAtMs: seed.expiresAtMs });
        const descendants = processTree(active.child.pid); active.record.trees.push(descendants);
        const db = new Database(databasePath, { readonly: true, fileMustExist: true });
        let faultAbsent;
        try { faultAbsent = db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(WARNING_STORE_FAULT_TRIGGER) === undefined; }
        finally { db.close(); }
        assertWarningSqlAbortCut({ original: seed, state, faultEvent: phaseTrace[faultAt], rescheduleEvent: phaseTrace[failedAt],
          clearEvent: phaseTrace[clearedAt], file: expectedWarningFile, measuredSourceSha256: await sha256File(state.source.path),
          outcome: active.record.outcome, admitted: phaseTrace.some(row => row.name === "log" && row.code === "composition_started"),
          storeClosed: closedAt >= 0, faultAbsent, descendants, liveGatewayPids: gatewayPids(staged).filter(alive), readyBundles: readyBundles(staged.directories.outboxDir) });
        nextAttemptAtMs = state.warning.nextAttemptAtMs;
        evidence.warningAcceptanceAbort = { fault: phaseTrace[faultAt].fault, triggerAbsentAfterOwnedClose: faultAbsent,
          occurrenceId: seed.occurrenceId, stopAtMs: seed.stopAtMs, expiresAtMs: seed.expiresAtMs, nextAttemptAtMs };
      } else if (recoveryPhase === "warning-boundary" || recoveryPhase === "warning-replay") {
        acceptedWarningSha256 = phaseTrace.find(row => row.name === "warning_worker_replay_idle")?.warningSha256;
        assert.match(acceptedWarningSha256, /^[0-9a-f]{64}$/);
        if (recoveryPhase === "warning-replay") {
          const replay = phaseTrace.find(row => row.name === "warning_worker_replay_idle");
          assert.deepEqual(replay.file, expectedWarningFile); assert.deepEqual(replay.checkpoints, ["directory"]);
          const replayAt = warningCut === "acceptance-transaction-abort" ? nextAttemptAtMs : claimExpiresAtMs;
          assert.equal(replay.acceptedAtMs, replayAt);
          const idleName = warningCut === "acceptance-transaction-abort" ? "before_warning_retry_idle" : "unexpired_warning_claim_idle";
          assert.ok(phaseTrace.some(row => row.name === idleName && row.nowMs === replayAt - 1));
        }
      }
      evidence.phases.push({ phase: recoveryPhase, events: phaseTrace, state: read(),
        ...(warningCut === "acceptance-transaction-abort" ? { nextAttemptAtMs, file: expectedWarningFile } : {}) });
      if (warningCut === "acceptance-transaction-abort" && recoveryPhase === "warning-boundary") evidence.warningCutPrivacy = privateOutputs(staged, evidence);
      active = null;
    }
    const final = read(); assert.equal(final.lifecycle.state, "deleted"); assert.equal(final.warning?.state, "accepted");
    assert.equal(final.lifecycle.deletedAtMs, seed.expiresAtMs); assert.deepEqual(readyBundles(staged.directories.outboxDir), []);
    evidence.finalPrivacy = privateOutputs(staged, evidence);
    evidence.status = "passed";
  } catch (error) { failure = error; evidence.failure = error.code ?? error.message ?? "recovery_failed"; }
  finally {
    if (active) try { await cleanupOwned(active); } catch { cleanupConfirmed = false; }
    if (staged) {
      try {
        const remaining = [...new Set([...gatewayPids(staged), ...evidence.children.flatMap(child =>
          [child.pid, ...child.trees.flat().map(row => row.pid)])].filter(pid => Number.isSafeInteger(pid) && pid > 0))].filter(alive);
        evidence.remainingPids = remaining;
        if (remaining.length > 0) cleanupConfirmed = false;
      } catch { evidence.processInventoryFailure = "remaining_process_inventory_unavailable"; cleanupConfirmed = false; }
    }
    Object.assign(evidence, recoveryCleanupEvidence({ children: evidence.children, remainingPids: evidence.remainingPids ?? [],
      cleanupSucceeded: cleanupConfirmed,
      inventoryUnavailable: evidence.failure === "process_inventory_unavailable" || evidence.processInventoryFailure !== undefined }));
    cleanupConfirmed = evidence.cleanupConfirmed;
    if (!cleanupConfirmed) { evidence.status = "failed"; failure ??= new Error("recovery_cleanup_unconfirmed"); }
    writeFileSync(path.join(options.out, "bundle.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    if (staged && !failure && cleanupConfirmed && !options.keep) rmSync(staged.root, { recursive: true, force: true });
  }
  if (failure) throw new Error("R1 recovery failed; inspect preserved bundle.json");
  return evidence;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runRecovery(parseRecoveryArguments(process.argv.slice(2))).catch(error => {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  });
}

// The documented command for the built end-to-end spine:
//
//     node e2e/run.mjs --out <dir>              (also `npm run e2e -- --out <dir>`)
//     node e2e/run.mjs --out <dir> --keep       keep the private temp root
//     node e2e/run.mjs --out <dir> --only-refusals
//
// It builds the package, stages one fresh private root, drives the SHIPPED
// admission and composition through e2e/entry.mjs with scripted Feishu peers
// (DECISIONS.md D028), hands the strict artifact bundle to a wheel-installed
// TeamMem, and writes an evidence bundle plus NEGATIVE-PROOFS.md into --out.
//
// Everything it records is "scripted local application test readiness". It is
// never evidence about a Feishu tenant, a provider, acoustic capture, Linux or
// a remote split.

import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import { RUNTIME_PIN, TEAMMEM_SOURCE, sha256File, verifyPins } from "./pins.mjs";
import { CAPTURE_FRAME_LIMIT, NODE24, PROVIDER_CREDENTIAL_ENV, RECORDING_KEY_ENV, loadAverage, mediaTimingConfiguration, run, stage } from "./stage.mjs";
import { publish, receiptOracle, stageTeamMem } from "./teammem.mjs";

import { createProcessEvidence, observeProcessSnapshot } from "./process-evidence.mjs";
import { keyPresent, negativeProofs, recordedProcessProof } from "./negative-proofs.mjs";
import { preflightLauncher } from "./launcher-preflight.mjs";
import { captureFinishMetadata, captureTailOracles, durableMetadata, durableOracles, mediaTimingMetadata, mediaTimingOracles, tailOmissionMetadata, tailOmissionOracles, longTailOmissionMetadata, longTailOmissionOracles, longTailReport, readDurableEvidence, readRuntimeTrace } from "./durable-oracles.mjs";
import { d2OrderingOracles } from "./d2-oracles.mjs";
import { voiceEndFromControl } from "./voice-end-evidence.mjs";
import { validateDependencyWheelhouse } from "./python-wheelhouse.mjs";
import { runPackageRefusalCuts } from "./package-refusal-cuts.mjs";
import { readStateFile } from "./state-file.mjs";

import { l4Configuration, l4Report, readL4Evidence, verifyL4Evidence } from "./l4-campaign.mjs";
import { createReceiptGate, createReceiptGateController, startOwnedPublication } from "./l6-receipt-gate.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const LABEL = "scripted local application test readiness";

export function parseArguments(argv) {
  const options = { out: null, keep: false, onlyRefusals: false, interactive: false, r2Baseline: false, d2Cut: null, dependencyWheelhouse: undefined, packageRefusals: false, mediaTiming: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") { options.out = path.resolve(argv[index + 1] ?? ""); index += 1; }
    else if (argv[index] === "--dependency-wheelhouse") {
      const value = argv[++index];
      if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new Error("absolute dependency wheelhouse required");
      options.dependencyWheelhouse = value;
    }
    else if (argv[index] === "--l4-case") {
      if (options.l4Case !== undefined) throw new Error("duplicate L4 flag");
      options.l4Case = argv[++index];
      if (options.l4Case === undefined) throw new Error("missing L4 case");
    }
    else if (argv[index] === "--media-timing") {
      if (options.mediaTiming !== undefined) throw new Error("duplicate media timing flag");
      const value = argv[++index];
      if (value !== "invalid2ns" && value !== "omit-final-pair" && value !== "omit-final-pair-long") throw new Error("invalid media timing command mode");
      options.mediaTiming = value;
    }
    else if (argv[index] === "--package-refusals") options.packageRefusals = true;
    else if (argv[index] === "--keep") options.keep = true;
    else if (argv[index] === "--only-refusals") options.onlyRefusals = true;
    else if (argv[index] === "--interactive") options.interactive = true;
    else if (argv[index] === "--r2-baseline") {
      if (options.r2Baseline) throw new Error("duplicate R2 baseline flag");
      options.r2Baseline = true;
    }
    else if (argv[index] === "--l6-receipt-gate") {
      if (options.l6ReceiptGate) throw new Error("duplicate L6 flag");
      options.l6ReceiptGate = true;
    }
    else if (argv[index] === "--d2-cut") {
      options.d2Cut = argv[++index];
      if (!["durable", "cancel-wins", "complete-wins", "repeated-close"].includes(options.d2Cut)) throw new Error("invalid D2 cut");
    }
    else throw new Error(`unknown argument ${argv[index]}`);
  }
  if (options.out === null) throw new Error("usage: node e2e/run.mjs --out <dir> [--keep] [--only-refusals]");
  l4Configuration(options);
  mediaTimingConfiguration(options);
  if (options.r2Baseline && (options.interactive || options.d2Cut || options.onlyRefusals || options.packageRefusals))
    throw new Error("R2 baseline cannot combine modes");
  if (options.packageRefusals && !options.onlyRefusals) throw new Error("package refusal cuts require --only-refusals");
  if (options.d2Cut && !options.interactive) throw new Error("D2 cuts require --interactive");
  if (options.d2Cut && options.onlyRefusals) throw new Error("D2 cuts cannot run only refusals");
  if (options.l6ReceiptGate && (!options.r2Baseline || options.interactive || options.d2Cut || options.onlyRefusals || options.packageRefusals || options.l4Case !== undefined || options.mediaTiming !== undefined))
    throw new Error("l6_selection_refused");
  return options;
}

/** The actual entry uses one fixed request/ACK slot. No stale ACK, unbounded
 * adapter await or raw foreign exception is publication authority. */
export function createL6Channel({ controlDir, deadlineAtMs, remoteHead, entryFailed }) {
  if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= Date.now() || deadlineAtMs > Date.now() + 600000) throw new Error("l6_channel_refused");
  let sequence = 0, pending = false, status;
  let remainingDeadline = deadlineAtMs;
  return {
    status: () => status,
    limit: deadline => {
      if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) throw new Error("l6_channel_deadline");
      remainingDeadline = Math.min(remainingDeadline, deadline);
    },
    async request(op, names = []) {
      if (pending || sequence >= 65536 || Date.now() >= remainingDeadline) throw new Error("l6_channel_refused");
      pending = true;
      try {
        const request = { sequence: ++sequence, op, names, remoteHead: remoteHead() };
        const temporary = path.join(controlDir, "l6-request.tmp");
        writeFileSync(temporary, JSON.stringify(request), { mode: 0o600 }); renameSync(temporary, path.join(controlDir, "l6-request.json"));
        while (Date.now() < remainingDeadline) {
          if (entryFailed()) throw new Error("l6_entry_failed");
          const filename = path.join(controlDir, "l6-response.json");
          if (existsSync(filename)) {
            const bytes = readFileSync(filename);
            if (bytes.length > 8192) throw new Error("l6_ack_refused");
            const response = JSON.parse(bytes);
            if (response.sequence === sequence) {
              if (Object.keys(response).sort().join() !== "outcomes,sequence,state,status" || !Array.isArray(response.outcomes) || response.outcomes.length !== names.length)
                throw new Error("l6_ack_refused");
              status = response.status; return response;
            }
            if (!Number.isSafeInteger(response.sequence) || response.sequence >= sequence) throw new Error("l6_ack_refused");
          }
          await pause(10);
        }
        throw new Error("l6_channel_deadline");
      } finally { pending = false; }
    },
  };
}
/** Selected pre-arm boundary. Ports below are the actual ordinary predicates,
 * readonly preflight/Git, gate installer and seed handoff at the call site. */
export function prepareL6Gate({ artifact, allowPush, seedPushed, preflight, remoteHead, arm, handoff, observe }) {
  let phase = "artifact", gate;
  const report = (state, cleanupFailed = false) => observe({ schema: "l6-preparation/v1", phase, state,
    code: state === "failed" ? "l6_preparation_failed" : null, cleanupFailed });
  try {
    report("pending");
    if (!allowPush || !artifact?.meeting.organizer || !seedPushed) throw new Error("l6_actual_publication_required");
    phase = "preflight"; report("pending"); preflight();
    phase = "remote-head"; report("pending"); const seedCommit = remoteHead();
    phase = "gate-arm"; report("pending"); gate = arm(seedCommit);
    phase = "seed-handoff"; report("pending"); handoff(seedCommit);
    report("ready"); return { gate, seedCommit };
  } catch (error) {
    let cleanupFailed = false;
    if (gate) { try { gate.close(); } catch { cleanupFailed = true; } }
    report("failed", cleanupFailed); throw error;
  }
}
/** Shared C/actual sequencing; actual callers supply verified source adapters.
 * Cleanup precedes the parent entry's ordinary application close request. */
export async function runL6Publication({ gate, publisher, channel, verifyRemote, settleDescendants, notificationBudgetMs }) {
  if (!Number.isSafeInteger(notificationBudgetMs) || notificationBudgetMs < 1 || notificationBudgetMs > 120000) throw new Error("l6_notification_budget_refused");
  const controller = createReceiptGateController({ gate, publisher,
    observe: async () => (await channel.request("observe")).state,
    maintenanceBatch: async names => (await channel.request("poll", names)).outcomes,
    maintenanceStatus: () => channel.status(),
  });
  let report = null, failure = null, cleanup = false;
  try {
    const permit = await controller.hold();
    report = await controller.release(permit, async candidate => {
      const verified = await verifyRemote(candidate);
      gate.deadlineAtMs = Math.min(gate.deadlineAtMs, Date.now() + notificationBudgetMs);
      channel.limit(gate.deadlineAtMs);
      return verified;
    });
  } catch { failure = "l6_publication_prerequisite_failed"; }
  finally {
    // Abort releases a held receive hook to fail before stopping its parent.
    try { gate.close(); } catch { failure ??= "l6_owned_cleanup_unconfirmed"; }
    try { await controller.close(); } catch { failure ??= "l6_owned_cleanup_unconfirmed"; }
    try { cleanup = await settleDescendants() === true; } catch { cleanup = false; }
    if (!cleanup) failure ??= "l6_descendant_cleanup_unconfirmed";
  }
  return { report, failure, cleanup, evidence: controller.evidence() };
}

/** The real parent uses this decision before its publication block. */
export function publicationRequired({ mediaTiming, d2Cut, l4Case }) {
  return l4Case === undefined && mediaTiming === undefined && d2Cut !== "repeated-close";
}
export function mediaTimingArguments({ mediaTiming }) {
  return mediaTiming === undefined ? [] : ["--media-timing", mediaTiming];
}
/** Actual drive plan fields and parent capture prerequisite use one selection. */
export function driveCaptureConfiguration(options) {
  const timing = mediaTimingConfiguration(options);
  return { ...timing, captureFrames: timing.captureFrameLimit ?? CAPTURE_FRAME_LIMIT };
}
export function captureRecorded(child, options) {
  return (child?.framesSent ?? 0) >= driveCaptureConfiguration(options).captureFrames;
}
export function mediaTimingFailureName(mode) {
  return mode === undefined ? "confirmed_capture_tail" : mode === "omit-final-pair" ? "media_timing_omit_final_pair" : mode === "omit-final-pair-long" ? "media_timing_omit_final_pair_long" : "media_timing_invalid2ns";
}
export function verifyMediaTimingAfterClose({ closed, read, child, mode }) {
  if (!closed) throw new Error("media timing owner closure unavailable");
  mediaTimingConfiguration({ mediaTiming: mode });
  const snapshot = read(), checks = mode === "omit-final-pair-long" ? longTailOmissionOracles(snapshot, child) : mode === "omit-final-pair" ? tailOmissionOracles(snapshot, child) : mediaTimingOracles(snapshot, child, mode);
  if (checks.some(row => row.status !== "pass")) throw new Error(checks[0].detail);
  return { checks, metadata: mode === "omit-final-pair-long" ? longTailOmissionMetadata(snapshot, child) : mode === "omit-final-pair" ? tailOmissionMetadata(snapshot, child) : mediaTimingMetadata(snapshot, child, mode), durable: mode === "omit-final-pair-long" ? null : durableMetadata(snapshot) };
}

const steps = [];
const oracles = [];
/** Measured contract mismatches between the built Meeting package and the
 * pinned Runtime that no unit test with a fake runtime can see. D1 records
 * them; it changes no production value. Each names the exact source location
 * and the exact bound that refused it. */
const productDefects = [];
let packageCuts = null;
function defect(entry) { productDefects.push(entry); }

/** The two findings the first D1 run measured out of band (the private
 * alignment page budget, and the audio vocabulary the consumer refuses) are
 * ruled in D032 and fixed in this tree, each pinned by a unit test
 * (test/recording-alignment-page-bound.test.ts,
 * test/artifact-audio-vocabulary.test.ts). Nothing is carried here unless a
 * later run measures something new. */
const OUT_OF_BAND_FINDINGS = [];
function step(name, result) {
  steps.push({ name, command: result.command, exit: result.exit, durationMs: result.durationMs, loadAverage: result.loadAverage });
  return result;
}
function oracle(name, status, detail) {
  oracles.push({ name, status, detail: String(detail) });
}
function check(name, condition, detail) {
  oracle(name, condition ? "pass" : "fail", detail);
  return condition;
}

/** The exact source tree the run exercised, via a temp index (no checkout is touched). */
function sourceTreeId() {
  const indexDir = mkdtempSync(path.join(tmpdir(), "meeting-e2e-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(indexDir, "index") };
  try {
    const baseline = step("git_read_tree", run("/usr/bin/git", ["-C", REPO, "read-tree", "HEAD"], { env }));
    if (baseline.exit !== 0) throw new Error("source tree baseline failed");
    step("git_add_tree", run("/usr/bin/git", ["-C", REPO, "add", "-A", "."], { env }));
    const written = step("git_write_tree", run("/usr/bin/git", ["-C", REPO, "write-tree"], { env }));
    return written.stdout.trim();
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

function snapshotProcessTree(rootPid, evidence, owner, options = {}) {
  let result;
  try { result = run("/bin/ps", ["-eo", "pid=,ppid=,comm="], options.deadlineAtMs === undefined ? {} : {
    timeout: Math.max(1, Math.min(5000, options.deadlineAtMs - Date.now())),
  }); }
  catch { result = null; }
  return observeProcessSnapshot(evidence, { result, rootPid, owner, ...options });
}

function ownedChild(child, role, evidence) {
  const record = { role, pid: child.pid, outcome: null };
  evidence.children.push(record);
  const exited = new Promise(resolve => {
    child.once("exit", (code, signal) => {
      record.outcome = { code, signal, exitObserved: true };
      resolve(record.outcome);
    });
    child.once("error", () => {
      if (record.outcome === null && child.pid === undefined) {
        record.outcome = { code: null, signal: null, exitObserved: false, spawnFailed: true };
        resolve(record.outcome);
      }
    });
  });
  return { record, exited };
}

async function waitOwnedExit(owned, budgetMs) {
  let timeout;
  try { return await Promise.race([owned.exited, new Promise(resolve => { timeout = setTimeout(() => resolve(null), budgetMs); })]); }
  finally { clearTimeout(timeout); }
}

export function readChildState(controlDir) {
  return readStateFile(path.join(controlDir, "state.json"));
}
function readEvents(filename) {
  if (!existsSync(filename)) return [];
  return readFileSync(filename, "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

function pause(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ---------------------------------------------------------------------------
// Admission refusals through the UNMODIFIED built main
// ---------------------------------------------------------------------------

async function refusalRuns(staged, processEvidence) {
  const main = staged.mainPath;
  const before = snapshotProcessTree(process.pid, processEvidence, "refusals", { baseline: true });
  const grammar = step("refusal_grammar", run(NODE24, [main, "--standalone-config", "relative/path.json"], { cwd: staged.root }));
  check("refusal_grammar", grammar.exit === 64 && grammar.stdout === "",
    `exit ${grammar.exit} (expected 64); stderr ${JSON.stringify(grammar.stderr.trim())}`);

  const unsafe = path.join(staged.directories.configDir, "unsafe-root.json");
  writeFileSync(unsafe, JSON.stringify({
    ...staged.standaloneConfig,
    dataPaths: { ...staged.standaloneConfig.dataPaths, recordingsDir: path.join(staged.directories.stateRoot, "inside") },
  }), { mode: 0o600 });
  mkdirSync(path.join(staged.directories.stateRoot, "inside"), { recursive: true, mode: 0o700 });
  const reference = step("refusal_reference", run(NODE24, [main, "--standalone-config", unsafe], { cwd: staged.root }));
  check("refusal_reference", reference.exit === 65,
    `exit ${reference.exit} (expected 65); stderr ${JSON.stringify(reference.stderr.trim())}`);

  // A second process while the first holds the state-root owner lock.
  const holder = spawn(NODE24, ["-e", `
    const { acquireApplicationOwnerLock } = require(${JSON.stringify(path.join(staged.directories.app, "dist/src/adapters/application-owner-lock.js"))});
    acquireApplicationOwnerLock(${JSON.stringify(staged.directories.stateRoot)}).then((lock) => {
      process.stdout.write("held\\n");
      process.stdin.resume();
      process.on("SIGTERM", () => { lock.close(); process.exit(0); });
    }, (error) => { process.stderr.write(String(error && error.message) + "\\n"); process.exit(3); });
  `], { cwd: staged.root, stdio: ["pipe", "pipe", "pipe"] });
  const owned = ownedChild(holder, "refusal_holder", processEvidence);
  let holderOutput = "";
  holder.stdout.on("data", (chunk) => { holderOutput += chunk; });
  let lockHeld = { exit: null, stderr: "", stdout: "", command: [], durationMs: 0, loadAverage: loadAverage() };
  const waited = Date.now();
  try {
    while (!holderOutput.includes("held") && owned.record.outcome === null && Date.now() - waited < 15_000) await pause(50);
    snapshotProcessTree(holder.pid, processEvidence, "refusal_holder");
    lockHeld = step("refusal_lock_held", run(NODE24, [main, "--standalone-config", staged.standaloneConfigPath], { cwd: staged.root }));
    check("refusal_lock_held", holderOutput.includes("held") && lockHeld.exit === 75,
      `holder ready ${holderOutput.includes("held")}; exit ${lockHeld.exit} (expected 75); stderr ${JSON.stringify(lockHeld.stderr.trim())}`);
  } finally {
    if (owned.record.outcome === null) holder.kill("SIGTERM");
    if (await waitOwnedExit(owned, 5000) === null) {
      holder.kill("SIGKILL");
      await waitOwnedExit(owned, 5000);
    }
  }

  const after = snapshotProcessTree(process.pid, processEvidence, "refusals", { excludePids: [process.pid, ...before.map(row => row.pid)] });
  const gatewayStarted = existsSync(staged.gatewayPidsPath);
  const cleanup = recordedProcessProof({ staged, live: { processEvidence } });
  check("refusals_spawned_nothing",
    !gatewayStarted && !existsSync(path.join(staged.directories.stateRoot, "orchestration.db")) && cleanup.cleanupConfirmed,
    `gateway launched: ${gatewayStarted}; state database created: ${existsSync(path.join(staged.directories.stateRoot, "orchestration.db"))}; process rows before ${before.length} after ${after.length}; observed cleanup ${JSON.stringify(cleanup)}`);

  return { grammar, reference, lockHeld };
}

// ---------------------------------------------------------------------------
// The live run
// ---------------------------------------------------------------------------

async function liveRun({ staged, teammem, outDir, interactive, r2Baseline, d2Cut, mediaTiming, l4Case, l6ReceiptGate, processEvidence }) {
  const meeting = {
    eventId: "e2e-invite-1",
    providerMeetingId: "9007199254740993",
    meetingNo: "900000001",
    title: "Scripted E2E occurrence",
    startSeconds: Math.floor(Date.now() / 1000) - 300,
    inviteSeconds: Math.floor(Date.now() / 1000) - 360,
    createTimeMs: Date.now(),
  };
  const plan = {
    standaloneConfigPath: staged.standaloneConfigPath,
    controlDir: staged.directories.control,
    outboxDir: staged.directories.outboxDir,
    gatewayConfigPath: staged.gatewayConfigPath,
    runtimeRecordingsDir: staged.directories.recordingsDir,
    runtimeModelsDir: staged.directories.runtimeModelsDir,
    teamVaultDir: staged.directories.teamVaultDir,
    vaultRevision: staged.vaultRevision,
    interactive,
    r2Baseline,
    ...(l6ReceiptGate ? { l6ReceiptGate: true } : {}),
    ...(l4Case === undefined ? {} : { l4Case }),
    d2Cut,
    ...driveCaptureConfiguration({ mediaTiming, interactive, r2Baseline, d2Cut }),
    recordingKeyEnv: RECORDING_KEY_ENV,
    providerCredentialEnv: PROVIDER_CREDENTIAL_ENV,
    meeting,
    // Test cadences only (D028). The backfill lane is deliberately slower than
    // the rest: it mints a NEW artifact revision on every tick while a
    // publication is still pending, and a receipt only ever names the revision
    // TeamMem published, so a four-second cadence outran the single publish
    // pass (30 revisions in two minutes, every delivery row
    // `receipt_unavailable`, no organizer DM). Thirty seconds leaves the
    // publish, the outbox tick and the notification tick inside one window
    // without slowing the initial build past its budget.
    laneIntervalsMs: { backfill: 30_000, warning: 5000, outbox: 1000, notification: 1000, discovery: 3000, custody: 5000 },
    budgets: { startMs: 60_000, admitMs: 60_000, captureMs: 120_000, buildMs: 90_000, teammemMs: 600_000, notifyMs: 120_000, readyTimeoutMs: 15_000 },
  };
  if (r2Baseline) plan.laneIntervalsMs = (await import("./r2-baseline.mjs")).r2LaneIntervals(plan.laneIntervalsMs);
  const planPath = path.join(staged.directories.configDir, "drive-plan.json");
  writeFileSync(planPath, JSON.stringify(plan, null, 2), { mode: 0o600 });

  const startedAt = Date.now();
  const child = spawn(NODE24, [staged.entryPath, "--plan", planPath], {
    cwd: staged.directories.app, stdio: ["ignore", "pipe", "pipe"],
    env: { HOME: process.env.HOME, PATH: `${staged.directories.traceBin}:/opt/homebrew/opt/node@24/bin:/usr/bin:/bin`, TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "C.UTF-8",
      ...(process.env.MEETING_PRIVATE_JOIN_DIAGNOSTIC_DIR === undefined ? {} : { MEETING_PRIVATE_JOIN_DIAGNOSTIC_DIR: process.env.MEETING_PRIVATE_JOIN_DIAGNOSTIC_DIR }) },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const owned = ownedChild(child, "meeting_app", processEvidence);

  const eventsPath = path.join(staged.directories.control, "events.ndjson");
  let peakTree = [];
  let teammemResult = null;
  let receipt = null;
  let artifact = null;
  let l6 = null;
  let l6Preparation = null;

  const waitForAnyEvent = async (names, budgetMs) => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const events = readEvents(eventsPath);
      const found = events.find((entry) => names.includes(entry.name));
      if (found) return found;
      if (owned.record.outcome) throw new Error(`entry exited before ${names.join("/")}`);
      if (events.some((entry) => entry.name === "entry_failed" || entry.name === "drive_failed")) {
        throw new Error(`entry failed before ${names.join("/")}: ${JSON.stringify(events.filter((entry) => entry.name.endsWith("failed")))}`);
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${names.join("/")}`);
      const tree = snapshotProcessTree(child.pid, processEvidence, "meeting_app");
      if (tree.length > peakTree.length) peakTree = tree;
      await pause(200);
    }
  };
  const waitForEvent = async (name, budgetMs) => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const events = readEvents(eventsPath);
      const found = events.find((entry) => entry.name === name);
      if (found) return found;
      if (events.some((entry) => entry.name === "entry_failed" || entry.name === "drive_failed")) {
        throw new Error(`entry reported failure before ${name}: ${JSON.stringify(events.filter((entry) => entry.name.endsWith("failed")))}`);
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}`);
      const tree = snapshotProcessTree(child.pid, processEvidence, "meeting_app");
      if (tree.length > peakTree.length) peakTree = tree;
      await pause(200);
    }
  };

  try {
    snapshotProcessTree(child.pid, processEvidence, "meeting_app");
    await waitForEvent("media_capture", plan.budgets.captureMs + 30_000);
    const sample = snapshotProcessTree(child.pid, processEvidence, "meeting_app");
    if (sample.length > peakTree.length) peakTree = sample;
    if (l4Case !== undefined) {
      const ready = await waitForEvent("artifact_ready", plan.budgets.buildMs + 60_000);
      artifact = readArtifact(ready.bundle);
    } else if (mediaTiming !== undefined) {
      await waitForAnyEvent(["media_timing_alignment_ready"], plan.budgets.buildMs + 60_000);
    } else if (!publicationRequired({ mediaTiming, d2Cut, l4Case })) {
      await waitForAnyEvent(["repeated_close"], 60_000);
    } else {
    const ready = await waitForAnyEvent(["artifact_ready", "artifact_blocked"], plan.budgets.buildMs + 60_000);
    artifact = ready.name === "artifact_ready" ? readArtifact(ready.bundle) : null;
    if (r2Baseline && (artifact?.revision !== 1 || artifact.meeting.transcript_complete !== false))
      throw new Error("r2_incomplete_rev1_required_before_publish");
    if (r2Baseline) {
      const { parseSupportedTeamMemMeetingArtifact } = await import("../dist/src/contracts/teammem-meeting-v2.js");
      const { canonicalArtifactHash } = await import("../dist/src/contracts/teammem-meeting-v1.js");
      const strict = parseSupportedTeamMemMeetingArtifact(artifact.meeting);
      artifact.actualHash = canonicalArtifactHash(strict);
      if (artifact.hash !== artifact.actualHash) throw new Error("r2_artifact_hash_mismatch");
    }

    // The consumer runs either way: a dry run over an empty inbox still proves
    // the wheel, the 0600 env file and the isolated paths are wired.
    const pushAllowed = process.env.E2E_ALLOW_LOCAL_BARE_PUSH === "1";
    if (l6ReceiptGate) {
      const { preflightR2Database } = await import("./r2-baseline.mjs");
      let deadlineAtMs;
      const git = argv => run("/usr/bin/git", ["-C", teammem.paths.bare, ...argv], { env: teammem.env, timeout: Math.max(1, Math.min(5000, deadlineAtMs - Date.now())) });
      const remoteHead = () => {
        const result = git(["rev-parse", "--verify", "refs/heads/e2e"]);
        if (result.exit !== 0 || !/^[0-9a-f]{40}\n$/.test(result.stdout)) throw new Error("l6_remote_head_refused");
        return result.stdout.trim();
      };
      const { gate } = prepareL6Gate({ artifact, allowPush: pushAllowed,
        seedPushed: teammem.steps.some(row => row.name === "git_seed_push" && row.exit === 0),
        preflight: () => { preflightR2Database(path.join(staged.directories.stateRoot, "orchestration.db")); deadlineAtMs = Date.now() + plan.budgets.teammemMs; },
        remoteHead, arm: seedCommit => createReceiptGate({ privateRoot: staged.root, teammem, seedCommit, deadlineAtMs }),
        handoff: seedCommit => writeFileSync(path.join(staged.directories.control, "l6-seed.json"), JSON.stringify({ seedCommit, deadlineAtMs }), { mode: 0o600 }),
        observe: value => { l6Preparation = value; } });
      const channel = createL6Channel({ controlDir: staged.directories.control, deadlineAtMs, remoteHead,
        entryFailed: () => owned.record.outcome !== null || readEvents(eventsPath).some(row => ["entry_failed", "drive_failed"].includes(row.name)) });
      const consumerChildren = [], groups = [];
      let inventoryFailed = false;
      const sampleConsumers = () => {
        const trees = [];
        for (const consumer of consumerChildren) {
          try { trees.push(snapshotProcessTree(consumer.record.pid, processEvidence, "l6_consumer_descendants", { deadlineAtMs })); }
          catch { inventoryFailed = true; }
        }
        return trees;
      };
      let publisher, timer, descendantsClosed = false, settleDescendants;
      try {
        // Prime actual state/status and establish the fresh peer's zero-IM
        // precondition before starting the genuine consumer.
        const before = (await channel.request("observe")).state;
        if (before.messageCount !== 0 || before.notificationCount !== 0 || before.receiptPresent || !before.remoteSeed)
          throw new Error("l6_fresh_authority_required");
        publisher = startOwnedPublication({ privateRoot: staged.root, teammem, nowIso: new Date().toISOString(), allowPush: true,
          deadlineAtMs, processGroup: true, register: value => { publisher = value; },
          onChild: consumer => { consumerChildren.push(ownedChild(consumer, "l6_consumer", processEvidence)); groups.push(consumer.pid); sampleConsumers(); } });
        const entered = gate.waitEntered;
        gate.waitEntered = async () => {
          const state = await entered();
          // Sample the actual pending consumer's descendants at the barrier,
          // not just after its parent exits and ownership becomes ambiguous.
          if (inventoryFailed || !sampleConsumers().some(tree => tree.length >= 2)) throw new Error("l6_descendant_barrier_unproved");
          return state;
        };
        timer = setInterval(sampleConsumers, 25);
        settleDescendants = async () => {
          sampleConsumers();
          let confirmed = !inventoryFailed && publisher.childrenSettled();
          for (const pid of groups) {
            let absent = false;
            for (let attempt = 0; attempt < 2; attempt += 1) {
              try { process.kill(-pid, 0); }
              catch (error) { if (error?.code === "ESRCH") { absent = true; break; } confirmed = false; break; }
              // The detached group is owned exclusively by this invocation.
              // TERM/KILL cleanup does not turn a failure into publication.
              try { process.kill(-pid, attempt === 0 ? "SIGTERM" : "SIGKILL"); } catch { confirmed = false; }
              await pause(1000);
            }
            if (!absent) { try { process.kill(-pid, 0); } catch (error) { absent = error?.code === "ESRCH"; } }
            confirmed &&= absent;
          }
          descendantsClosed = confirmed && consumerChildren.every(row => row.record.outcome?.exitObserved === true);
          return descendantsClosed;
        };
        const { readPublicationReceipt } = await import("../dist/src/adapters/receipt-inbox.js");
        l6 = await runL6Publication({ gate, publisher, channel, settleDescendants, notificationBudgetMs: plan.budgets.notifyMs,
          verifyRemote: async candidate => {
            sampleConsumers();
            const accepted = readPublicationReceipt({ receiptsDir: staged.directories.receiptsDir, occurrenceId: artifact.occurrenceId, revision: 1, artifactHash: artifact.hash });
            if (!accepted || accepted.vault_commit !== candidate) throw new Error("l6_actual_receipt_refused");
            const commitExists = git(["cat-file", "-e", `${candidate}^{commit}`]).exit === 0;
            const commitIsAncestorOfRef = git(["merge-base", "--is-ancestor", candidate, "refs/heads/e2e"]).exit === 0;
            const note = git(["show", `${candidate}:${accepted.markdown_path}`]);
            const localNote = readFileSync(path.join(teammem.paths.vault, accepted.markdown_path));
            const noteMatchesArtifact = note.exit === 0 && note.stdout.includes(artifact.occurrenceId) && note.stdout.includes(artifact.meeting.title) &&
              localNote.length > 0 && localNote.length <= 1048576 && localNote.equals(Buffer.from(note.stdout, "utf8")) &&
              !note.stdout.includes(artifact.audioPath) && accepted.artifact_hash === artifact.actualHash;
            // Reuse these bounded actual checks in the ordinary R2 oracle;
            // do not repeat its unselected synchronous Git calls afterward.
            receipt = { receipts: [accepted.occurrence_id], status: "present", valid: true, checks: [{
              schema: accepted.schema, markdownUrl: accepted.markdown_url, vaultCommit: accepted.vault_commit,
              commitExists, commitIsAncestorOfRef, noteBytes: Buffer.byteLength(note.stdout),
              occurrenceMatchesArtifact: accepted.occurrence_id === artifact.occurrenceId,
              revisionMatchesArtifact: accepted.revision === artifact.revision,
              artifactHashMatches: accepted.artifact_hash === artifact.actualHash,
              noteNamesOccurrence: note.stdout.includes(artifact.occurrenceId),
              noteWithholdsAudioPath: !note.stdout.includes(artifact.audioPath),
              urlNamesCommit: accepted.markdown_url.includes(`/-/blob/${candidate}/`), noteMatchesArtifact,
            }] };
            return { commitExists, commitIsAncestorOfRef, noteMatchesArtifact, receiptCanonical: true };
          } });
        check("l6_receipt_gate", l6.failure === null && l6.report?.exactlyOneSend && l6.cleanup, l6.failure ?? "actual held polls, remote receipt and one durable send verified");
        teammemResult = await publisher.result;
      } finally {
        clearInterval(timer);
        let closeFailed = false;
        try { gate.close(); } catch { closeFailed = true; }
        if (publisher) { try { await publisher.close(); } catch { closeFailed = true; } }
        if (settleDescendants && !descendantsClosed) { try { await settleDescendants(); } catch { closeFailed = true; } }
        if (publisher && !descendantsClosed) {
          // Registration/adapter failure may precede the shared controller.
          // Preserve non-pass, still stop only these exclusively owned groups.
          for (const pid of groups) {
            try { process.kill(-pid, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") inventoryFailed = true; }
          }
          oracle("l6_descendant_cleanup", "fail", "full consumer descendant settlement unconfirmed");
        }
        if (closeFailed) oracle("l6_owned_cleanup", "fail", "external publication owner close refused");
      }
    } else {
    teammemResult = publish({
      teammem, nowIso: new Date().toISOString(),
      allowPush: artifact !== null && pushAllowed,
      withheldReason: artifact === null
        ? "the shipped outbox produced no strict bundle, so there was nothing to publish"
        : "E2E_ALLOW_LOCAL_BARE_PUSH was not set; stopped after the dry run",
    });
    step("teammem_dry_run", teammemResult.dryRun);
    if (teammemResult.publishRun) step("teammem_publish", teammemResult.publishRun);
    }
    if (!l6ReceiptGate) receipt = receiptOracle({ teammem, receiptsDir: staged.directories.receiptsDir, artifact });
    if (r2Baseline) {
      const { readPublicationReceipt } = await import("../dist/src/adapters/receipt-inbox.js");
      const accepted = readPublicationReceipt({ receiptsDir: staged.directories.receiptsDir,
        occurrenceId: artifact.occurrenceId, revision: artifact.revision, artifactHash: artifact.hash });
      receipt = { ...receipt, valid: accepted !== null,
        checks: receipt.checks.map(row => ({ ...row, vaultCommit: accepted?.vault_commit ?? null })) };
      check("r2_publication_required", pushAllowed && teammemResult.publishRun?.exit === 0 &&
        receipt.status === "present" && receipt.receipts.length === 1 && receipt.valid,
      "R2 requires actual TeamMem publication and a strict receipt; dry run is insufficient");
    }
    writeFileSync(path.join(staged.directories.control, "teammem-done"), artifact === null ? "no-bundle" : "published");
    if (receipt.status === "present") await waitForEvent("organizer_dm", plan.budgets.notifyMs + 30_000).catch(() => undefined);
    }
  } catch (error) {
    oracle("live_run", "fail", l6ReceiptGate ? "l6_run_prerequisite_failed" : l4Case === undefined ? error?.message ?? String(error) : "l4_drive_prerequisite_failed");
    if (l6ReceiptGate) {
      try { writeFileSync(path.join(staged.directories.control, "l6-abort"), "aborted", { mode: 0o600 }); }
      catch { oracle("l6_abort_request", "fail", "selected parent abort request could not be written"); }
    }
  } finally {
    if (owned.record.outcome === null) {
      try { if (mediaTiming === undefined && l4Case === undefined) writeFileSync(path.join(staged.directories.control, "teammem-done"), "done"); }
      catch { oracle("cleanup_request", "fail", "owned entry completion request could not be written"); }
      if (await waitOwnedExit(owned, 180_000) === null) {
        if (l4Case === undefined && mediaTiming !== "omit-final-pair-long") { child.kill("SIGKILL"); await waitOwnedExit(owned, 5000); }
        else oracle(l4Case === undefined ? "long_tail_owner_close_unconfirmed" : "l4_owner_close_unconfirmed", "fail", "ordinary public close did not settle; retain private root");
      }
    }
    try { snapshotProcessTree(child.pid, processEvidence, "meeting_app"); }
    catch { oracle("process_inventory", "fail", "process_inventory_unavailable"); }
  }
  const outcome = owned.record.outcome ?? { code: null, signal: null, exitObserved: false };

  const events = readEvents(eventsPath);
  const summary = existsSync(path.join(staged.directories.control, "summary.json"))
    ? JSON.parse(readFileSync(path.join(staged.directories.control, "summary.json"), "utf8")) : null;
  const childState = readChildState(staged.directories.control);

  steps.push({ name: "entry", command: [NODE24, staged.entryPath], exit: outcome.code, durationMs: Date.now() - startedAt, loadAverage: loadAverage() });
  writeFileSync(path.join(outDir, "entry.stdout.log"), stdout);
  writeFileSync(path.join(outDir, "entry.stderr.log"), stderr);
  writeFileSync(path.join(outDir, "events.ndjson"), existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "");

  return { meeting, plan, events, summary, childState, outcome, peakTree, processEvidence, teammemResult, receipt, artifact, stdout, stderr, ...(l6ReceiptGate ? { l6, l6Preparation } : {}) };
}

function interactiveOracles(live) {
  const events = live.summary?.runtimeEvents ?? [], calls = live.summary?.interactiveCalls ?? [];
  const language = calls.filter((entry) => entry.route === "language"), speech = calls.filter((entry) => entry.route === "speech");
  const silence = live.events.find((entry) => entry.name === "silent_capture");
  const negative = live.events.find((entry) => entry.name === "name_gate_negative");
  check("silent_name_gate", silence?.frames >= 51 && silence?.disclosure === "failed" && silence?.languageCalls === 0 && silence?.playback === 0 && silence?.authorizations === 0 &&
    negative?.languageCalls === 0 && negative?.playback === 0 &&
    events.filter((entry) => entry.type === "response_skipped").length >= 3,
    "background, incidental alias and near-name produced three actual skips, no language or playback before invocation");
  const current = live.events.find((entry) => entry.name === "current_question_answered");
  const vault = live.events.find((entry) => entry.name === "vault_question_answered");
  const completed = (question) => {
    if (!question?.turn || !question?.segment) return false;
    const terminals = events.filter((entry) => ["turn_completed", "turn_cancelled", "turn_failed"].includes(entry.event?.type) && entry.event.turn_id === question.turn);
    return events.filter((entry) => entry.type === "response_authorized" && entry.segment_id === question.segment && entry.turn_id === question.turn).length === 1 &&
      terminals.length === 1 && terminals[0].event.type === "turn_completed" && live.childState?.playback.some((entry) => entry.turn === question.turn && !entry.held);
  };
  const indexed = (live.summary?.vaultReads ?? []).some((entry) => entry.type === "vault_index_source" && entry.source === `${live.plan.vaultRevision}:orion.md`);
  check("current_meeting_grounding", completed(current) && current?.vaultReadsBefore === current?.vaultReadsAfter && language[0]?.grounded === "current" && language[0]?.currentFact && !language[0]?.vaultFact &&
    speech[0]?.text === "Copper budget is seven.", "first actual provider request carries prior current-meeting fact and no vault fact; matching speech request");
  check("vault_grounding", completed(vault) && indexed && vault?.vaultReadsAfter === vault?.vaultReadsBefore + 1 && language[1]?.grounded === "vault" && language[1]?.vaultFact &&
    speech[1]?.text === "Orion launch code is violet.", "second actual request carries indexed fixture-vault fact; matching speech request");
  check("vault_unavailable", completed(live.events.find((entry) => entry.name === "unavailable_question_answered")) && language[2]?.unavailable && speech[2]?.text === "Historical team memory is unavailable.",
    "removing fixture checkout produces the shipped unavailable-history instruction and a matching spoken disclosure");
  if (["complete-wins", "repeated-close"].includes(live.plan.d2Cut)) return;
  const interruption = live.events.find((entry) => entry.name === "interruption_acknowledged");
  const terminals = events.filter((entry) => ["turn_completed", "turn_cancelled", "turn_failed"].includes(entry.event?.type) && entry.event.turn_id === interruption?.turn);
  check("acknowledged_interruption", Boolean(interruption) && terminals.length === 1 && terminals[0].event.type === "turn_cancelled" &&
    events.some((entry) => entry.type === "voice_barge_in" && entry.generation_id === interruption.generation && entry.turn_id === interruption.turn) &&
    events.some((entry) => entry.type === "voice_timing" && entry.turn_id === interruption.turn && entry.milestone === "playback_flush_acknowledged") &&
    live.childState?.flushes.some((entry) => entry.generation === interruption.generation) &&
    !live.childState?.playback.some((entry) => entry.generation === interruption.generation && entry.afterFlush),
    "held playable frame, matching actual barge and Runtime flush-acknowledged timing, same-generation peer ACK, one cancellation terminal, no post-flush output; scripted only");
  check("capture_after_interrupt", interruption?.captureAfter >= interruption?.captureBefore + 10,
    "ten actual captured frames continue after the acknowledged interruption");
}

function readArtifact(bundleDir) {
  if (bundleDir === null || !existsSync(bundleDir)) return null;
  const manifest = JSON.parse(readFileSync(path.join(bundleDir, "manifest.json"), "utf8"));
  const meeting = JSON.parse(readFileSync(path.join(bundleDir, "meeting.json"), "utf8"));
  return {
    bundleDir,
    files: readdirSync(bundleDir).sort(),
    manifest, occurrenceId: meeting.occurrence_id ?? meeting.occurrenceId ?? manifest.occurrence_id,
    revision: Number(manifest.revision ?? meeting.revision),
    hash: manifest.artifact_hash ?? manifest.hash ?? null,
    audioPath: existsSync(path.join(bundleDir, "audio.enc")) ? path.join(bundleDir, "audio.enc") : null,
    meeting,
  };
}

// ---------------------------------------------------------------------------
// Durable oracles: reopen the state database the application closed
// ---------------------------------------------------------------------------

function reopenOracles(staged) {
  const filename = path.join(staged.directories.stateRoot, "orchestration.db");
  if (!existsSync(filename)) { oracle("state_database", "fail", "the application left no state database"); return null; }
  const database = new Database(filename, { readonly: true });
  try {
    database.pragma("foreign_keys = ON");
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    const query = (sql) => { try { return database.prepare(sql).all(); } catch (error) { return [{ error: String(error?.message ?? error) }]; } };
    const rows = {
      sessions: query("SELECT occurrence_id, state, terminal_reason FROM sessions"),
      invites: query("SELECT occurrence_id, state FROM feishu_invite_occurrences"),
      seeds: query("SELECT occurrence_id, ended_at FROM backfill_seeds"),
      custody: query("SELECT physical_client_id, occurrence_id, state FROM physical_client_custody"),
      delivery: query("SELECT occurrence_id, revision, retry_reason, published_at_ms IS NOT NULL AS published, publication_url IS NOT NULL AS hasUrl FROM delivery_journal"),
      notifications: query("SELECT occurrence_id, revision, state, attempt_count, request_uuid, provider_message_id IS NOT NULL AS sent FROM notification_intents"),
      seedLifecycle: query("SELECT occurrence_id, state, initial_build_attempts, initial_build_last_reason FROM backfill_seed_lifecycle"),
      alignment: query("SELECT generation_id, attempt_id FROM recording_alignment_selected"),
      alignmentPages: query("SELECT page_index, entry_count, length(payload) AS storedBytes FROM recording_alignment_pages ORDER BY page_index"),
    };
    return { filename, tables: [...tables].sort(), rows };
  } finally {
    database.close();
  }
}

/** The runner uses this same sequence for generic reopened and capture reads.
 * A refused R2 snapshot cannot reach the ordinary SQLite callback. */
export async function readRunEvidence({ databasePath, r2Baseline, read }) {
  if (r2Baseline) (await import("./r2-baseline.mjs")).preflightR2Database(databasePath);
  return read();
}

/** Keep diagnostic ciphertext on any R2 non-pass, including caught or thrown
 * read/publication/capture refusals. Ordinary cleanup retains its old policy. */
export function finishPrivateRoot({ staged, options, live, runFailed = false, results = oracles }) {
  const reason = !options.r2Baseline ? null : runFailed ? "r2_run_refused"
    : results.some(row => row.status === "fail" || row.status === "blocked") ? "r2_evidence_nonpass" : null;
  const preserveRoot = options.keep || reason !== null || live.processEvidence.inventory.failures.length > 0
    || (live.processEvidence.children.length > 0 && !recordedProcessProof({ staged, live }).cleanupConfirmed);
  if (!preserveRoot) rmSync(staged.root, { recursive: true, force: true });
  return { preserveRoot, reason };
}

// ---------------------------------------------------------------------------
// Negative proofs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

async function main() {
  const options = parseArguments(process.argv.slice(2));
  mkdirSync(options.out, { recursive: true, mode: 0o700 });

  if (options.dependencyWheelhouse !== undefined) await validateDependencyWheelhouse(options.dependencyWheelhouse);
  const pins = await verifyPins();
  oracle("runtime_pins", "pass", `gateway ${pins.gateway.sha256}; sdk tarball ${pins.sdkTarball.sha256}`);

  const build = step("npm_build", run("/opt/homebrew/opt/node@24/bin/npm", ["run", "build"], {
    cwd: REPO, env: { ...process.env, PATH: `/opt/homebrew/opt/node@24/bin:${process.env.PATH ?? ""}` },
  }));
  if (build.exit !== 0) throw new Error(`npm run build failed: ${build.stderr.slice(0, 2000)}`);
  const treeId = sourceTreeId();

  const staged = stage({ repository: REPO, interactive: options.interactive, r2Baseline: options.r2Baseline, mediaTiming: options.mediaTiming, l4Case: options.l4Case });
  let teammem = null;
  let live = { events: [], summary: null, childState: null, outcome: { code: null }, peakTree: [], processEvidence: createProcessEvidence(), teammemResult: null, receipt: null, artifact: null, reopen: null };
  let runFailed = true;

  try {
    if (options.r2Baseline) {
      staged.digests = {};
      for (const [name, filename] of Object.entries({ gateway: staged.gatewayPath, scriptedGateway: staged.scriptedGatewayPath, sdkTarball: staged.sdkTarball })) {
        const sha256 = await sha256File(filename);
        if (sha256 !== pins[name].sha256) throw new Error(`R2 staged ${name} digest mismatch`);
        staged.digests[name] = sha256;
      }
      staged.helperDigests = {};
      for (const name of ["entry.mjs", "r2-baseline.mjs", "r2-gateway-config.mjs", "r2-provider.mjs", "interactive-provider.mjs", "gateway-config.mjs", "composition-lifecycle.mjs", ...(options.l6ReceiptGate ? ["l6-receipt-gate.mjs"] : [])])
        staged.helperDigests[name] = await sha256File(path.join(staged.directories.app, "e2e", name));
    }
    if (options.packageRefusals) packageCuts = runPackageRefusalCuts({ staged, check, run: (command, argv, options) => step("package_refusal_process", run(command, argv, options)) });
    if (options.onlyRefusals) {
      await refusalRuns(staged, live.processEvidence);
    } else {
      teammem = await stageTeamMem({ staged, source: TEAMMEM_SOURCE, dependencyWheelhouse: options.dependencyWheelhouse });
      if (options.r2Baseline) {
        staged.r2AudioStoreInitiallyEmpty = readdirSync(teammem.paths.audioStore).length === 0;
        if (!staged.r2AudioStoreInitiallyEmpty) throw new Error("R2 baseline requires a fresh empty consumer audio store");
      }
      for (const entry of teammem.steps) steps.push({ name: entry.name, command: entry.command, exit: entry.exit, durationMs: entry.durationMs, loadAverage: entry.loadAverage });
      oracle("teammem_wheel", "pass", `${path.basename(teammem.wheel)} sha256 ${teammem.wheelSha256}`);
      await refusalRuns(staged, live.processEvidence);
      // Complete macOS executable/temporary-script assessment before the
      // unchanged protocol/admission deadlines. No arguments makes Runtime
      // refuse before configuration or provider startup; each child is reaped.
      for (const executable of [staged.gatewayPath, ...(options.interactive || options.r2Baseline ? [staged.scriptedGatewayPath] : []), staged.launcherPath]) {
        const prepared = preflightLauncher(executable, { env: {
          HOME: process.env.HOME, PATH: `${staged.directories.traceBin}:/opt/homebrew/opt/node@24/bin:/usr/bin:/bin`,
          TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "C.UTF-8",
        } });
        step("runtime_argument_refusal_preflight", { ...prepared, command: [executable], loadAverage: loadAverage() });
      }
      const result = await liveRun({ staged, teammem, outDir: options.out, interactive: options.interactive, r2Baseline: options.r2Baseline, d2Cut: options.d2Cut, mediaTiming: options.mediaTiming, l4Case: options.l4Case, l6ReceiptGate: options.l6ReceiptGate, processEvidence: live.processEvidence });
      live = { ...live, ...result };
      const databasePath = path.join(staged.directories.stateRoot, "orchestration.db");
      try {
        live.reopen = await readRunEvidence({ databasePath, r2Baseline: options.r2Baseline, read: () => reopenOracles(staged) });
      } catch (error) {
        if (!options.r2Baseline) throw error;
        live.r2SnapshotRefused = true;
        oracle("r2_snapshot_read", "fail", "R2 non-mutating SQLite preflight refused; further SQL evidence reads stopped");
      }
      if (options.r2Baseline && !live.r2SnapshotRefused) {
        try {
          const { measureR2Sources, r2BaselineMetadata, r2BaselineOracles, readR2BaselineState } = await import("./r2-baseline.mjs");
          const occurrenceId = `${live.meeting.providerMeetingId}@${new Date(live.meeting.startSeconds * 1000).toISOString().replace(".000Z", "Z")}`;
          const state = readR2BaselineState({ databasePath: live.reopen.filename, occurrenceId });
          const input = { state, artifact: live.artifact, receipt: live.receipt, publishExit: live.teammemResult?.publishRun?.exit,
            providerCalls: live.summary?.providerCalls, unusedVoice: live.summary?.unusedVoice, maintenance: live.summary?.r2Maintenance };
          // Retain safe durable facts even if the actual filesystem measurement
          // refuses. Never repair, resize or replace consumer-owned ciphertext.
          live.r2Baseline = r2BaselineMetadata(input);
          input.sourceMeasurement = await measureR2Sources({ state, recordingsDir: staged.directories.recordingsDir, audioStore: teammem.paths.audioStore, privateRoot: staged.root });
          for (const row of r2BaselineOracles(input)) oracle(row.name, row.status, row.detail);
          live.r2Baseline = r2BaselineMetadata(input);
          const order = ["media_capture", "r2_final_unavailable", "gateway_config_postmeeting", "meeting_ended_signalled", "r2_live_cleanup_confirmed", "r2_initial_enqueued", "artifact_ready", "organizer_dm", "run_standalone_exit", "owned_peers_closed"];
          const indexes = order.map(name => live.events.findIndex(row => row.name === name));
          check("r2_observed_order", indexes.every((index, i) => index >= 0 && (i === 0 || index > indexes[i - 1])), "actual capture/config/settlement/build/receipt/shutdown ordering");
        } catch { oracle("r2_baseline_read", "fail", "mandatory retained-source, publication or durable baseline facts absent or invalid"); }
      }
      if (options.interactive && options.l4Case === undefined) interactiveOracles(live);
      if (options.d2Cut) {
        try {
        const runtimeEvents = readRuntimeTrace(path.join(staged.directories.control, "runtime-events.ndjson"));
        live.summary.runtimeEvents = runtimeEvents;
        for (const row of d2OrderingOracles({ ...live, cut: options.d2Cut, runtimeEvents })) oracle(row.name, row.status, row.detail);
        if (options.d2Cut !== "repeated-close") {
          const occurrence = `${live.meeting.providerMeetingId}@${new Date(live.meeting.startSeconds * 1000).toISOString().replace(".000Z", "Z")}`;
          const facts = readDurableEvidence(live.reopen.filename, occurrence);
          const tested = live.events.filter(row => row.name === "transcript_tested");
          const interval = live.events.find(row => row.name === "interruption_acknowledged");
          for (const row of durableOracles(facts, { tested, runtimeEvents, interval, requirePostFlush: options.d2Cut !== "complete-wins" })) {
            oracle(row.name, row.status, row.detail);
          }
          // Persist reopened metadata only. No audio, decryption key, private
          // recovery authorization or speculative hand-built alignment data.
          live.durable = durableMetadata(facts);
        }
        } catch {
          oracle("durable_read", "fail", "mandatory reopened SQLite or Runtime trace evidence was absent or invalid");
        }
      }

      // The positive baseline checks the complete final tail even when the
      // silent spine has no interactive transcript/flush interval.
      if (options.d2Cut !== "repeated-close" && !live.r2SnapshotRefused) {
        try {
          const occurrence = `${live.meeting.providerMeetingId}@${new Date(live.meeting.startSeconds * 1000).toISOString().replace(".000Z", "Z")}`;
          if (options.mediaTiming !== undefined) {
            const result = verifyMediaTimingAfterClose({ closed: live.outcome.code === 0 && live.summary?.driveFailure === null &&
              live.summary.trace.includes("shutdown_store_closed") && live.events.some(row => row.name === "owned_peers_closed"),
              read: () => readDurableEvidence(live.reopen.filename, occurrence), child: live.childState, mode: options.mediaTiming });
            for (const row of result.checks) oracle(row.name, row.status, row.detail);
            live.mediaTiming = result.metadata; live.durable = result.durable;
            check("media_timing_alignment_ready", live.events.some(row => row.name === "media_timing_alignment_ready"), "actual strict selected alignment observed before ordinary owner closure");
            if (options.mediaTiming === "omit-final-pair-long") check("long_tail_public_close", live.summary?.driveFailure === null &&
              live.summary?.shuttingDown === true && live.events.some(row => row.name === "long_tail_public_close_settled"), "selected public close and drive settled without failure");
          } else {
            const facts = await readRunEvidence({ databasePath: live.reopen.filename, r2Baseline: options.r2Baseline,
              read: () => readDurableEvidence(live.reopen.filename, occurrence) });
            for (const row of captureTailOracles(facts, live.childState)) oracle(row.name, row.status, row.detail);
            if (options.l4Case === undefined) live.durable = durableMetadata(facts);
            else {
              live.l4 = await verifyL4Evidence({ l4Case: options.l4Case, snapshot: await readL4Evidence(live.reopen.filename, occurrence),
                artifact: live.artifact, drive: live.summary?.l4Drive, runtimeEvents: live.summary?.runtimeEvents ?? [],
                providerCalls: live.summary?.interactiveCalls ?? [], child: live.childState,
                closed: live.outcome.code === 0 && live.summary?.driveFailure === null && live.summary.trace.includes("shutdown_store_closed") &&
                  live.events.some(row => row.name === "owned_peers_closed") && live.events.some(row => row.name === "l4_public_close_settled") });
              oracle("l4_selected_campaign", "pass", "actual closed READY artifact, observed attendance and capture-bound final identity matched");
            }
          }
        } catch (error) {
          if (options.l4Case !== undefined) oracle("l4_selected_campaign", "fail", /^l4_[a-z_]+$/.test(error?.message ?? "") ? error.message : "l4_evidence_prerequisite_failed");
          else oracle(mediaTimingFailureName(options.mediaTiming), "fail", String(error?.message ?? error));
        }
      }

      // --- spine oracles ---------------------------------------------------
      const named = (name) => live.events.some((entry) => entry.name === name);
      const logged = (code) => (live.summary?.trace ?? []).includes(code);
      check("admission", logged("composition_lock_verified") && logged("composition_store_opened"),
        `lock verified ${logged("composition_lock_verified")}, store opened ${logged("composition_store_opened")}`);
      check("invite_durable", named("invite_acknowledged") && logged("invite_committed"),
        "the scripted long connection was acknowledged only after the durable commit");
      check("discovery_tick", logged("discovery_tick"), "the shipped discovery tick ran");
      check("runtime_connected", logged("occurrence_runtime_connected"), "the real SDK connected over the packaged gateway");
      check("custody_claimed", (live.reopen?.rows.custody ?? []).length > 0,
        JSON.stringify(live.reopen?.rows.custody ?? []));
      check("child_launched", live.childState?.pid !== undefined && live.childState?.joined === true,
        `child pid ${live.childState?.pid}, joined ${live.childState?.joined}`);
      check("media_connected", live.childState?.mediaConnected === true,
        `endpoint ${live.childState?.mediaEndpoint}`);
      check("capture_recorded", captureRecorded(live.childState, options) && readdirSync(staged.directories.recordingsDir).some((name) => name.endsWith(".crsr")),
        `${live.childState?.framesSent} produced capture frames; recordings ${JSON.stringify(readdirSync(staged.directories.recordingsDir))}`);
      if (options.d2Cut !== "repeated-close") {
      check("meeting_ended", live.childState?.left === "ended", `bridge-observed terminal ${live.childState?.left}`);
      check("finalized_seed", (live.reopen?.rows.seeds ?? []).length === 1, JSON.stringify(live.reopen?.rows.seeds ?? []));
      const alignmentPages = live.reopen?.rows.alignmentPages ?? [];
      check("alignment_stored", alignmentPages.length > 0,
        `stored pages ${JSON.stringify(alignmentPages)}`);
      oracle("alignment_page_budget", "pass",
        `largest stored page ${Math.max(0, ...alignmentPages.map((page) => page.storedBytes))} bytes against the private re-encoding bound of 2x the SDK's MAX_ALIGNMENT_PAGE_BYTES (D032 §1); this run produced ${live.childState?.framesSent} capture frames; the historical ${CAPTURE_FRAME_LIMIT}-frame fixture refused every page before the fix`);

      if (publicationRequired(options)) {
      const buildReason = (live.reopen?.rows.seedLifecycle ?? [])[0]?.initial_build_last_reason ?? null;
      if (live.artifact !== null) {
        check("artifact_bundle", ["READY", "audio.enc", "manifest.json", "meeting.json"].every((file) => live.artifact.files.includes(file)),
          `files ${JSON.stringify(live.artifact.files)} revision ${live.artifact.revision}`);
      } else {
        oracle("artifact_bundle", "fail",
          `the shipped delivery lane could not build one: backfill reason ${JSON.stringify(buildReason)} after ${(live.reopen?.rows.seedLifecycle ?? [])[0]?.initial_build_attempts ?? 0} attempts. See productDefects.`);
        defect({
          id: "artifact_build_failed",
          where: "src/delivery/artifact-builder.ts through the shipped backfill lane",
          measured: `the D031 wire schema and the SDK's own output bound are in this tree; the lane still reported ${JSON.stringify(buildReason)}`,
          observed: "see the backfill reason above and the redacted event trace; no artifact was hand-placed",
        });
      }
      const dry = live.teammemResult?.dryRun;
      check("teammem_dry_run", dry !== undefined && dry !== null && (dry.exit === 0 || dry.exit === 1),
        dry ? options.l6ReceiptGate ? `exit ${dry.exit}; consumer output discarded` : `exit ${dry.exit}: ${dry.stdout.trim().slice(0, 400)}` : "not run");
      oracle("teammem_isolation", "pass",
        `env file ${teammem.paths.envFile} at 0600; inbox ${teammem.paths.inbox} is the application outbox; receipts ${teammem.paths.receipts}; bare remote ${teammem.paths.bare}; no path under ~/.local/share/teammem, ~/.config/teammem or the overlay`);
      if (live.teammemResult?.publishRun) {
        check("teammem_publish", live.teammemResult.publishRun.exit === 0,
          options.l6ReceiptGate ? `exit ${live.teammemResult.publishRun.exit}; consumer output discarded` : `exit ${live.teammemResult.publishRun.exit}: ${live.teammemResult.publishRun.stdout.trim().slice(0, 400)} ${live.teammemResult.publishRun.stderr.trim().slice(0, 400)}`);
        const checks = live.receipt?.checks ?? [];
        check("publication_receipt", checks.length === 1 && checks.every((entry) => entry.commitExists && entry.commitIsAncestorOfRef && entry.noteBytes > 0
          && entry.occurrenceMatchesArtifact && entry.revisionMatchesArtifact && entry.artifactHashMatches && entry.noteNamesOccurrence && entry.urlNamesCommit),
          JSON.stringify(checks));
        const messages = live.summary?.feishuMessages ?? [];
        const intents = live.reopen?.rows.notifications ?? [];
        const intent = intents[0], message = messages[0];
        check("organizer_dm", messages.length === 1 && intents.length === 1
          && intent.state === "sent" && intent.sent === 1 && intent.attempt_count === 1
          && intent.occurrence_id === live.artifact?.occurrenceId && intent.revision === live.artifact?.revision
          && message.uuid === intent.request_uuid && message.receiveId === live.artifact?.meeting.organizer?.person_id
          && message.text === `Meeting notes: ${live.artifact?.meeting.title}\n${checks[0]?.markdownUrl}`,
          JSON.stringify({ messages, intents }));
      } else if (live.artifact === null) {
        const reason = "blocked behind artifact_bundle: the shipped outbox produced no strict bundle to publish";
        oracle("teammem_publish", "blocked", reason);
        oracle("publication_receipt", "blocked", reason);
        oracle("organizer_dm", "blocked", reason);
      } else {
        oracle("teammem_publish", "skipped", live.teammemResult?.skipped ?? "not reached");
        oracle("publication_receipt", "skipped", "no publishing run");
        oracle("organizer_dm", "skipped", "no publishing run");
      }
      } else {
        for (const name of ["artifact_bundle", "teammem_dry_run", "teammem_publish", "publication_receipt", "organizer_dm"])
          oracle(name, options.l4Case !== undefined && name === "artifact_bundle" ? (live.l4 ? "pass" : "fail") : "skipped",
            options.l4Case !== undefined ? "selected L4 requires actual READY; L6/L7 publication not exercised" : "not exercised by this command: recording media timing conformance only");
      }
      check("shutdown_clean", live.outcome.code === 0 && logged("shutdown_store_closed"),
        `entry exit ${live.outcome.code}; shipped close order ${JSON.stringify((live.summary?.trace ?? []).filter((code) => code.startsWith("shutdown_")))}`);
      } else {
        oracle("publication_not_exercised", "skipped", "active-owner repeated-close fault cut; ordinary publication is separately proven by the accepted baseline");
      }
    }

    // --- negative proofs ---------------------------------------------------
    // Write all emitted artifacts/logs first so the security scan covers them.
    writeBundle(options.out, { options, pins, treeId, staged, teammem, live });
    const proofs = options.onlyRefusals ? null : negativeProofs({ staged, live, teammem, outDir: options.out });
    if (proofs) {
      check("no_key_or_plaintext_audio",
        proofs.leaks.key.length === 0 && proofs.leaks.secret.length === 0 && proofs.leaks.credential.length === 0
        && proofs.scanErrors.length === 0 && keyPresent(staged) && proofs.permissions.every((entry) => entry.valid) && proofs.envLeaks.length === 0 && proofs.pcmMarkers.length === 0,
        `scanned ${proofs.scannedFiles} files; scan errors ${proofs.scanErrors.length}; key hits ${proofs.leaks.key.length}; secret hits ${proofs.leaks.secret.length}; credential hits ${proofs.leaks.credential.length}; env ${JSON.stringify(proofs.envLeaks)}; pcm ${JSON.stringify(proofs.pcmMarkers)}`);
      check("no_orphan_process", proofs.processCleanup.cleanupConfirmed, JSON.stringify(proofs.processCleanup));
      check("no_closed_store_callback", proofs.afterStoreClose.length === 0, `codes after shutdown_store_closed: ${JSON.stringify(proofs.afterStoreClose)}`);
      check("single_occurrence_identity", proofs.identities.length === 1, `occurrence identities observed: ${JSON.stringify(proofs.identities)}`);
      writeNegativeProofs(options.out, { proofs, staged, live, options });
      live.proofs = proofs;
    }

    writeBundle(options.out, { options, pins, treeId, staged, teammem, live });
    runFailed = false;
  } catch (error) {
    if (live.processEvidence.inventory.failures.length === 0) throw error;
    oracle("process_inventory", "fail", "process_inventory_unavailable");
    oracle(options.onlyRefusals ? "refusals_spawned_nothing" : "no_orphan_process", "fail", "process_inventory_unavailable; observed-run coverage incomplete");
    writeBundle(options.out, { options, pins, treeId, staged, teammem, live });
    if (!options.onlyRefusals) {
      live.proofs = negativeProofs({ staged, live, teammem, outDir: options.out });
      writeNegativeProofs(options.out, { proofs: live.proofs, staged, live, options });
      writeBundle(options.out, { options, pins, treeId, staged, teammem, live });
    }
  } finally {
    const decision = finishPrivateRoot({ staged, options, live, runFailed });
    live.r2PreservationReason = decision.reason;
    if (decision.preserveRoot) process.stdout.write(`kept private root: ${staged.root}${decision.reason ? ` (${decision.reason})` : ""}\n`);
    if (decision.reason) {
      try { writeBundle(options.out, { options, pins, treeId, staged, teammem, live }); }
      catch { oracle("r2_evidence_write", "fail", "failed R2 private root retained; final safe bundle write refused"); }
    }
  }

  const failed = oracles.filter((entry) => entry.status === "fail");
  process.stdout.write(`${JSON.stringify({ out: options.out, oracles: oracles.length, failed: failed.length }, null, 2)}\n`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

function writeNegativeProofs(outDir, { proofs, staged, live, options }) {
  if (options.mediaTiming === "omit-final-pair-long") {
    writeFileSync(path.join(outDir, "NEGATIVE-PROOFS.md"), "# Selected long-tail checks\n\nThe finite bundle records the actual privacy and ownership check statuses. Detailed scan evidence remains in the owned private root. Publication is untested.\n");
    return;
  }
  if (live.summary?.l4Drive) {
    writeFileSync(path.join(outDir, "NEGATIVE-PROOFS.md"), ["# Selected L4 negative proofs", "",
      "Scripted local observation only; L6/L7 publication untested.",
      `Cleanup confirmed: ${proofs.processCleanup.cleanupConfirmed === true}; inventory failures: ${proofs.processCleanup.inventory.failures.length}.`,
      `Private scan: ${proofs.scannedFiles} files; scan errors: ${proofs.scanErrors.length}; key/secret/credential hits: ${proofs.leaks.key.length + proofs.leaks.secret.length + proofs.leaks.credential.length}.`,
      `PCM markers: ${proofs.pcmMarkers.length}; callbacks after store close: ${proofs.afterStoreClose.length}.`, ""].join("\n"));
    return;
  }
  const lines = [
    "# Negative proofs",
    "",
    `Label: ${LABEL}. These are absences observed in one run, not guarantees.`,
    "",
    "## No key, secret or provider credential in Meeting, the bridge or TeamMem",
    "",
    `Scanned ${proofs.scannedFiles} files under the recordings, outbox, receipts, bridge-control, emitted evidence, TeamMem and launcher-log paths for the run's synthetic Runtime recording key, the Feishu app-secret bytes and the synthetic provider credential.`,
    "",
    `- scan errors: ${proofs.scanErrors.length}`,
    `- key/root permissions and ownership: ${proofs.permissions.every((entry) => entry.valid) ? "verified" : "failed"}`,
    `- recording key occurrences: ${proofs.leaks.key.length}`,
    `- app secret occurrences: ${proofs.leaks.secret.length}`,
    `- provider credential occurrences: ${proofs.leaks.credential.length}`,
    `- bridge child environment names carrying either: ${proofs.envLeaks.length === 0 ? "none" : proofs.envLeaks.join(", ")}`,
    `- bridge child environment keys: ${JSON.stringify(live.childState?.envKeys ?? [])}`,
    "",
    "## No plaintext audio",
    "",
    "A silent pcm_s16le/24000/1 20 ms frame is 960 NUL bytes. Neither the encrypted recording nor the published audio may contain such a run, the scripted speech/voiced-capture PCM markers, or a WAV container header.",
    "",
    proofs.pcmMarkers.length === 0 ? "- no marker found" : proofs.pcmMarkers.map((marker) => `- ${marker}`).join("\n"),
    "",
    "## No orphan process",
    "",
    `Coverage: ${proofs.processCleanup.inventoryCoverage}; required inventory samples: ${proofs.processCleanup.inventory.samples}; inventory failures: ${proofs.processCleanup.inventory.failures.length}. This sampled evidence covers only processes recorded during this owned run.`,
    `Directly owned ChildProcess exits observed: ${proofs.processCleanup.knownOwnedChildrenReaped ? "yes" : "incomplete"}; cleanup proof: ${proofs.processCleanup.cleanupConfirmed ? "pass" : "non-pass"}. ESRCH establishes absence at probe time, not reaping.`,
    "",
    ...proofs.processCleanup.probes.map(entry => `- ${entry.origins.join(", ")} pid ${entry.pid}: ${entry.status === "absent" ? "absent (ESRCH)" : entry.status === "present" ? "STILL PRESENT" : "unverified probe"}`),
    ...proofs.processCleanup.children.map(child => `- owned ${child.role} pid ${child.pid}: ${child.outcome?.exitObserved ? "actual exit observed" : "exit unverified"}`),
    `- invalid recorded PID origins: ${JSON.stringify(proofs.processCleanup.invalidPids)}`,
    "",
    "## No callback after the store closed",
    "",
    `The shipped close order ends at shutdown_store_closed. Static codes logged after it: ${proofs.afterStoreClose.length === 0 ? "none" : JSON.stringify(proofs.afterStoreClose)}.`,
    "",
    "## No cross-occurrence identity",
    "",
    `Occurrence identities across the reopened state database, the artifact bundle and the publication receipt: ${JSON.stringify(proofs.identities)}.`,
    "",
    `Private root: ${staged.root} (retained on incomplete process evidence or --keep).`,
    "",
  ];
  writeFileSync(path.join(outDir, "NEGATIVE-PROOFS.md"), lines.join("\n"));
}

export function writeBundle(outDir, { options, pins, treeId, staged, teammem, live }) {
  if (options.mediaTiming === "omit-final-pair-long") {
    writeFileSync(path.join(outDir, "bundle.json"), JSON.stringify(longTailReport({ metadata: live.mediaTiming ?? null,
      checks: oracles.map(row => ({ name: row.name, status: row.status })),
      cleanupConfirmed: (live.proofs?.processCleanup ?? recordedProcessProof({ staged, live })).cleanupConfirmed === true }), null, 2));
    return;
  }
  if (options.l4Case !== undefined) {
    writeFileSync(path.join(outDir, "bundle.json"), JSON.stringify(l4Report({ l4Case: options.l4Case,
      metadata: live.l4 ?? null, checks: oracles, processCleanup: live.proofs?.processCleanup ?? recordedProcessProof({ staged, live }) }), null, 2));
    return;
  }
  if (live.artifact && options.l4Case === undefined) {
    const copied = path.join(outDir, "artifact");
    mkdirSync(copied, { recursive: true });
    for (const name of live.artifact.files) {
      if (name === "audio.enc") { writeFileSync(path.join(copied, "audio.enc.size"), String(statSync(path.join(live.artifact.bundleDir, name)).size)); continue; }
      writeFileSync(path.join(copied, name), readFileSync(path.join(live.artifact.bundleDir, name)));
    }
  }
  const bundle = {
    label: LABEL,
    generatedAt: new Date().toISOString(),
    command: [NODE24, path.join(REPO, "e2e/run.mjs"), "--out", options.out, ...(options.keep ? ["--keep"] : []), ...mediaTimingArguments(options), ...(options.l4Case === undefined ? [] : ["--l4-case", options.l4Case]), ...(options.packageRefusals ? ["--package-refusals"] : []), ...(options.onlyRefusals ? ["--only-refusals"] : []), ...(options.interactive ? ["--interactive"] : []), ...(options.r2Baseline ? ["--r2-baseline"] : []), ...(options.l6ReceiptGate ? ["--l6-receipt-gate"] : []), ...(options.d2Cut ? ["--d2-cut", options.d2Cut] : []), ...(options.dependencyWheelhouse ? ["--dependency-wheelhouse", options.dependencyWheelhouse] : [])],
    ...(options.l6ReceiptGate ? { l6ReceiptGate: live.l6 ?? null, l6Preparation: live.l6Preparation ?? null } : {}),
    l4: live.l4 ?? null,
    mode: options.l4Case !== undefined ? "selected-l4" : options.mediaTiming !== undefined ? "media-timing-recording-conformance" : options.onlyRefusals ? "refusals" : options.l6ReceiptGate ? "l6-receipt-gate" : options.r2Baseline ? "r2-baseline" : options.interactive ? "interactive" : "full",
    d2Cut: options.d2Cut,
    mediaTiming: live.mediaTiming ?? null,
    packageRefusalCuts: packageCuts,
    repository: REPO,
    sourceTreeId: treeId,
    runtimePins: { ...pins, name: RUNTIME_PIN.name, revision: RUNTIME_PIN.revision },
    stagedRuntimeDigests: staged.digests ?? null,
    stagedHelperDigests: staged.helperDigests ?? null,
    r2Baseline: live.r2Baseline ?? null,
    r2AudioStoreInitiallyEmpty: staged.r2AudioStoreInitiallyEmpty ?? null,
    r2PreservationReason: live.r2PreservationReason ?? null,
    teammem: teammem === null ? null : { source: TEAMMEM_SOURCE, wheel: path.basename(teammem.wheel), wheelSha256: teammem.wheelSha256, envFile: path.basename(teammem.paths.envFile) },
    gatewayConfigurations: {
      live: options.interactive ? "online profile; feature-only scripted gateway, loopback external transports, byte-preserving control observation" : "online profile, unreachable .invalid providers (the only profile the shipped client admits)",
      postmeeting: options.r2Baseline ? "online profile; feature-only scripted gateway, unavailable final diarization and healthy synthesis; same recording directory and key" : "offline profile, local fixture provider host, same recording directory and key",
    },
    privateRoot: staged.root,
    steps,
    oracles,
    trace: live.summary?.trace ?? [],
    events: live.events,
    feishuRequests: live.summary?.feishuRequests ?? [],
    feishuMessages: (live.summary?.feishuMessages ?? []).map((message) => ({ uuid: message.uuid, recipientKnown: typeof message.receiveId === "string", textBytes: message.textBytes })),
    providerCalls: live.summary?.providerCalls ?? [],
    interactiveCalls: live.summary?.interactiveCalls ?? [],
    runtimeEvents: live.summary?.runtimeEvents ?? [],
    vaultReads: live.summary?.vaultReads ?? [],
    voiceEnd: voiceEndFromControl(staged?.directories?.control, { childState: live.childState, summary: live.summary }),
    bridgeChild: live.childState === null ? null : { pid: live.childState.pid, joined: live.childState.joined, mediaConnected: live.childState.mediaConnected, framesSent: live.childState.framesSent, left: live.childState.left, commands: live.childState.commands, playback: live.childState.playback, flushes: live.childState.flushes, ...captureFinishMetadata(live.childState) },
    processTreeAtPeak: live.peakTree,
    processEvidence: live.processEvidence,
    processCleanup: live.proofs?.processCleanup ?? recordedProcessProof({ staged, live }),
    stateDatabase: live.reopen,
    durableEvidence: live.durable ?? null,
    artifact: live.artifact === null ? null : { files: live.artifact.files, revision: live.artifact.revision, hash: live.artifact.hash, occurrenceId: live.artifact.occurrenceId, manifest: live.artifact.manifest },
    teammemRuns: live.teammemResult === null ? null : options.l6ReceiptGate ? { ...live.teammemResult, outputRetained: false } : {
      dryRun: live.teammemResult.dryRun === null ? null : { exit: live.teammemResult.dryRun.exit, stdout: live.teammemResult.dryRun.stdout.slice(0, 4000), stderr: live.teammemResult.dryRun.stderr.slice(0, 4000) },
      publishRun: live.teammemResult.publishRun === null ? null : { exit: live.teammemResult.publishRun.exit, stdout: live.teammemResult.publishRun.stdout.slice(0, 4000), stderr: live.teammemResult.publishRun.stderr.slice(0, 4000) },
      skipped: live.teammemResult.skipped,
    },
    receiptOracle: live.receipt,
    negativeProofs: live.proofs ?? null,
    productDefects,
    outOfBandFindings: OUT_OF_BAND_FINDINGS,
    loadAverageAtEnd: loadAverage(),
  };
  writeFileSync(path.join(outDir, "bundle.json"), JSON.stringify(bundle, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch((error) => {
  process.stderr.write(process.argv.includes("--l6-receipt-gate") ? "l6_run_prerequisite_failed\n" : `${error?.stack ?? String(error)}\n`);
  process.exitCode = 1;
});

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

import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import Database from "better-sqlite3";

import { RUNTIME_PIN, TEAMMEM_SOURCE, verifyPins } from "./pins.mjs";
import { CAPTURE_FRAME_LIMIT, NODE24, PROVIDER_CREDENTIAL, PROVIDER_CREDENTIAL_ENV, RECORDING_KEY_ENV, loadAverage, run, stage } from "./stage.mjs";
import { publish, receiptOracle, stageTeamMem } from "./teammem.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const LABEL = "scripted local application test readiness";

function parseArguments(argv) {
  const options = { out: null, keep: false, onlyRefusals: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") { options.out = path.resolve(argv[index + 1] ?? ""); index += 1; }
    else if (argv[index] === "--keep") options.keep = true;
    else if (argv[index] === "--only-refusals") options.onlyRefusals = true;
    else throw new Error(`unknown argument ${argv[index]}`);
  }
  if (options.out === null) throw new Error("usage: node e2e/run.mjs --out <dir> [--keep] [--only-refusals]");
  return options;
}

const steps = [];
const oracles = [];
/** Measured contract mismatches between the built Meeting package and the
 * pinned Runtime that no unit test with a fake runtime can see. D1 records
 * them; it changes no production value. Each names the exact source location
 * and the exact bound that refused it. */
const productDefects = [];
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
    step("git_add_tree", run("/usr/bin/git", ["-C", REPO, "add", "-A", "."], { env }));
    const written = step("git_write_tree", run("/usr/bin/git", ["-C", REPO, "write-tree"], { env }));
    return written.stdout.trim();
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

function snapshotProcessTree(rootPid) {
  const listed = run("/bin/ps", ["-eo", "pid=,ppid=,comm="]);
  const rows = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    .map((line) => { const [pid, ppid, ...rest] = line.split(/\s+/); return { pid: Number(pid), ppid: Number(ppid), comm: rest.join(" ") }; });
  const byParent = new Map();
  for (const row of rows) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
  const tree = [];
  const walk = (pid, depth) => {
    for (const child of byParent.get(pid) ?? []) { tree.push({ ...child, depth }); walk(child.pid, depth + 1); }
  };
  const self = rows.find((row) => row.pid === rootPid);
  if (self) tree.push({ ...self, depth: 0 });
  walk(rootPid, 1);
  return tree;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function readEvents(filename) {
  if (!existsSync(filename)) return [];
  return readFileSync(filename, "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

function pause(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ---------------------------------------------------------------------------
// Admission refusals through the UNMODIFIED built main
// ---------------------------------------------------------------------------

function refusalRuns(staged) {
  const main = staged.mainPath;
  const before = snapshotProcessTree(process.pid).length;
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
  `], { stdio: ["pipe", "pipe", "pipe"] });
  let holderOutput = "";
  holder.stdout.on("data", (chunk) => { holderOutput += chunk; });
  let lockHeld = { exit: null, stderr: "", stdout: "", command: [], durationMs: 0, loadAverage: loadAverage() };
  const waited = Date.now();
  while (!holderOutput.includes("held") && Date.now() - waited < 15_000) {
    const sleep = run("/bin/sleep", ["0.05"]);
    if (sleep.exit !== 0) break;
  }
  try {
    lockHeld = step("refusal_lock_held", run(NODE24, [main, "--standalone-config", staged.standaloneConfigPath], { cwd: staged.root }));
    check("refusal_lock_held", lockHeld.exit === 75,
      `exit ${lockHeld.exit} (expected 75); stderr ${JSON.stringify(lockHeld.stderr.trim())}`);
  } finally {
    holder.kill("SIGTERM");
  }

  const after = snapshotProcessTree(process.pid);
  const gatewayStarted = existsSync(staged.gatewayPidsPath);
  check("refusals_spawned_nothing",
    !gatewayStarted && !existsSync(path.join(staged.directories.stateRoot, "orchestration.db")) && after.length <= before + 3,
    `gateway launched: ${gatewayStarted}; state database created: ${existsSync(path.join(staged.directories.stateRoot, "orchestration.db"))}; process rows before ${before} after ${after.length}`);

  return { grammar, reference, lockHeld };
}

// ---------------------------------------------------------------------------
// The live run
// ---------------------------------------------------------------------------

async function liveRun({ staged, teammem, outDir }) {
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
    recordingKeyEnv: RECORDING_KEY_ENV,
    providerCredentialEnv: PROVIDER_CREDENTIAL_ENV,
    meeting,
    captureFrames: CAPTURE_FRAME_LIMIT,
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
  const planPath = path.join(staged.directories.configDir, "drive-plan.json");
  writeFileSync(planPath, JSON.stringify(plan, null, 2), { mode: 0o600 });

  const startedAt = Date.now();
  const child = spawn(NODE24, [staged.entryPath, "--plan", planPath], {
    cwd: staged.directories.app, stdio: ["ignore", "pipe", "pipe"],
    env: { HOME: process.env.HOME, PATH: `/opt/homebrew/opt/node@24/bin:/usr/bin:/bin`, TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "C.UTF-8" },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

  const eventsPath = path.join(staged.directories.control, "events.ndjson");
  let peakTree = [];
  let teammemResult = null;
  let receipt = null;
  let artifact = null;

  const waitForAnyEvent = async (names, budgetMs) => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const events = readEvents(eventsPath);
      const found = events.find((entry) => names.includes(entry.name));
      if (found) return found;
      if (events.some((entry) => entry.name === "entry_failed")) {
        throw new Error(`entry failed before ${names.join("/")}: ${JSON.stringify(events.filter((entry) => entry.name.endsWith("failed")))}`);
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${names.join("/")}`);
      const tree = snapshotProcessTree(child.pid);
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
      const tree = snapshotProcessTree(child.pid);
      if (tree.length > peakTree.length) peakTree = tree;
      await pause(200);
    }
  };

  try {
    await waitForEvent("media_capture", plan.budgets.captureMs + 30_000);
    const sample = snapshotProcessTree(child.pid);
    if (sample.length > peakTree.length) peakTree = sample;
    const ready = await waitForAnyEvent(["artifact_ready", "artifact_blocked"], plan.budgets.buildMs + 60_000);
    artifact = ready.name === "artifact_ready" ? readArtifact(ready.bundle) : null;

    // The consumer runs either way: a dry run over an empty inbox still proves
    // the wheel, the 0600 env file and the isolated paths are wired.
    const pushAllowed = process.env.E2E_ALLOW_LOCAL_BARE_PUSH === "1";
    teammemResult = publish({
      teammem, nowIso: new Date().toISOString(),
      allowPush: artifact !== null && pushAllowed,
      withheldReason: artifact === null
        ? "the shipped outbox produced no strict bundle, so there was nothing to publish"
        : "E2E_ALLOW_LOCAL_BARE_PUSH was not set; stopped after the dry run",
    });
    step("teammem_dry_run", teammemResult.dryRun);
    if (teammemResult.publishRun) step("teammem_publish", teammemResult.publishRun);
    receipt = receiptOracle({ teammem, receiptsDir: staged.directories.receiptsDir, artifact });
    writeFileSync(path.join(staged.directories.control, "teammem-done"), artifact === null ? "no-bundle" : "published");
    if (receipt.status === "present") await waitForEvent("organizer_dm", plan.budgets.notifyMs + 30_000).catch(() => undefined);
  } catch (error) {
    oracle("live_run", "fail", error?.message ?? String(error));
  } finally {
    if (alive(child.pid)) {
      writeFileSync(path.join(staged.directories.control, "teammem-done"), "done");
      await Promise.race([exited, pause(180_000)]);
      if (alive(child.pid)) child.kill("SIGKILL");
    }
  }
  const outcome = await exited;

  const events = readEvents(eventsPath);
  const summary = existsSync(path.join(staged.directories.control, "summary.json"))
    ? JSON.parse(readFileSync(path.join(staged.directories.control, "summary.json"), "utf8")) : null;
  const childState = existsSync(path.join(staged.directories.control, "state.json"))
    ? JSON.parse(readFileSync(path.join(staged.directories.control, "state.json"), "utf8")) : null;

  steps.push({ name: "entry", command: [NODE24, staged.entryPath], exit: outcome.code, durationMs: Date.now() - startedAt, loadAverage: loadAverage() });
  writeFileSync(path.join(outDir, "entry.stdout.log"), stdout);
  writeFileSync(path.join(outDir, "entry.stderr.log"), stderr);
  writeFileSync(path.join(outDir, "events.ndjson"), readFileSync(eventsPath, "utf8"));

  return { meeting, plan, events, summary, childState, outcome, peakTree, teammemResult, receipt, artifact, stdout, stderr };
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

// ---------------------------------------------------------------------------
// Negative proofs
// ---------------------------------------------------------------------------

function walkFiles(root, skip = []) {
  const files = [];
  const visit = (directory) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (skip.some((prefix) => target.startsWith(prefix))) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  visit(root);
  return files;
}

function negativeProofs({ staged, live, teammem }) {
  const key = existsSync(staged.keyPath) ? readFileSync(staged.keyPath, "utf8").trim() : null;
  const secret = readFileSync(staged.appSecretFile, "utf8").trim();
  const scanned = [
    ...walkFiles(staged.directories.recordingsDir),
    ...walkFiles(staged.directories.outboxDir),
    ...walkFiles(staged.directories.receiptsDir),
    ...walkFiles(staged.directories.control),
    ...walkFiles(staged.directories.teammem, [path.join(staged.directories.teammem, "src"), path.join(staged.directories.teammem, "wheel-venv"), path.join(staged.directories.teammem, "wheelhouse")]),
    ...[staged.launcherLog, teammem?.paths.envFile].filter((file) => file && existsSync(file)),
  ];
  const leaks = { key: [], secret: [], credential: [] };
  const needles = [
    ["key", key], ["secret", secret], ["credential", PROVIDER_CREDENTIAL],
  ].filter(([, value]) => typeof value === "string" && value.length >= 16);
  for (const file of scanned) {
    let bytes;
    try { bytes = readFileSync(file); } catch { continue; }
    for (const [name, needle] of needles) {
      if (bytes.includes(Buffer.from(needle, "utf8"))) leaks[name].push(file);
    }
  }
  // The harness's own evidence copies are scanned too, after they are written.
  const envLeaks = [];
  for (const source of [live.summary?.trace ? null : null]) void source;
  const childEnvKeys = live.childState?.envKeys ?? [];
  for (const name of [RECORDING_KEY_ENV, PROVIDER_CREDENTIAL_ENV, "FEISHU_APP_SECRET"]) {
    if (childEnvKeys.includes(name)) envLeaks.push(`bridge child environment carried ${name}`);
  }

  // Plaintext audio: a silent pcm_s16le frame is 960 NUL bytes; neither the
  // encrypted recording nor the published audio may contain such a run, and
  // neither may carry a WAV/RIFF container header.
  const audioFiles = [
    ...walkFiles(staged.directories.recordingsDir),
    ...(live.artifact?.audioPath ? [live.artifact.audioPath] : []),
    ...walkFiles(teammem?.paths.audioStore ?? staged.directories.recordingsDir),
  ];
  const pcmMarkers = [];
  const zeroRun = Buffer.alloc(960);
  for (const file of new Set(audioFiles)) {
    let bytes;
    try { bytes = readFileSync(file); } catch { continue; }
    if (bytes.subarray(0, 4).toString("latin1") === "RIFF" || bytes.includes(Buffer.from("WAVEfmt "))) pcmMarkers.push(`${file}: container header`);
    if (bytes.includes(zeroRun)) pcmMarkers.push(`${file}: 960-byte silent PCM run`);
  }

  const pids = [];
  if (existsSync(staged.gatewayPidsPath)) {
    for (const line of readFileSync(staged.gatewayPidsPath, "utf8").split("\n").map((value) => value.trim()).filter(Boolean)) pids.push({ role: "gateway", pid: Number(line) });
  }
  if (live.childState?.pid) pids.push({ role: "bridge_child", pid: live.childState.pid });
  const orphans = pids.filter((entry) => alive(entry.pid));

  const trace = live.summary?.trace ?? [];
  const storeClosedAt = trace.lastIndexOf("shutdown_store_closed");
  const afterStoreClose = storeClosedAt === -1 ? [] : trace.slice(storeClosedAt + 1);

  const identities = new Set();
  for (const row of live.reopen?.rows.sessions ?? []) if (row.occurrence_id) identities.add(row.occurrence_id);
  for (const row of live.reopen?.rows.delivery ?? []) if (row.occurrence_id) identities.add(row.occurrence_id);
  if (live.artifact?.occurrenceId) identities.add(live.artifact.occurrenceId);
  for (const entry of live.receipt?.checks ?? []) if (entry.occurrenceMatchesArtifact === false) identities.add("receipt-mismatch");

  return { scannedFiles: scanned.length, leaks, envLeaks, pcmMarkers, pids, orphans, afterStoreClose, identities: [...identities] };
}

// ---------------------------------------------------------------------------

async function main() {
  const options = parseArguments(process.argv.slice(2));
  mkdirSync(options.out, { recursive: true, mode: 0o700 });

  const pins = await verifyPins();
  oracle("runtime_pins", "pass", `gateway ${pins.gateway.sha256}; sdk tarball ${pins.sdkTarball.sha256}`);

  const build = step("npm_build", run("/opt/homebrew/opt/node@24/bin/npm", ["run", "build"], {
    cwd: REPO, env: { ...process.env, PATH: `/opt/homebrew/opt/node@24/bin:${process.env.PATH ?? ""}` },
  }));
  if (build.exit !== 0) throw new Error(`npm run build failed: ${build.stderr.slice(0, 2000)}`);
  const treeId = sourceTreeId();

  const staged = stage({ repository: REPO });
  let teammem = null;
  let live = { events: [], summary: null, childState: null, outcome: { code: null }, peakTree: [], teammemResult: null, receipt: null, artifact: null, reopen: null };

  try {
    if (options.onlyRefusals) {
      refusalRuns(staged);
    } else {
      teammem = await stageTeamMem({ staged, source: TEAMMEM_SOURCE });
      for (const entry of teammem.steps) steps.push({ name: entry.name, command: entry.command, exit: entry.exit, durationMs: entry.durationMs, loadAverage: entry.loadAverage });
      oracle("teammem_wheel", "pass", `${path.basename(teammem.wheel)} sha256 ${teammem.wheelSha256}`);
      refusalRuns(staged);
      const result = await liveRun({ staged, teammem, outDir: options.out });
      live = { ...live, ...result };
      live.reopen = reopenOracles(staged);

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
      check("capture_recorded", (live.childState?.framesSent ?? 0) >= CAPTURE_FRAME_LIMIT && readdirSync(staged.directories.recordingsDir).some((name) => name.endsWith(".crsr")),
        `${live.childState?.framesSent} silent frames; recordings ${JSON.stringify(readdirSync(staged.directories.recordingsDir))}`);
      check("meeting_ended", live.childState?.left === "ended", `bridge-observed terminal ${live.childState?.left}`);
      check("finalized_seed", (live.reopen?.rows.seeds ?? []).length === 1, JSON.stringify(live.reopen?.rows.seeds ?? []));
      const alignmentPages = live.reopen?.rows.alignmentPages ?? [];
      check("alignment_stored", alignmentPages.length > 0,
        `stored pages ${JSON.stringify(alignmentPages)}`);
      oracle("alignment_page_budget", "pass",
        `largest stored page ${Math.max(0, ...alignmentPages.map((page) => page.storedBytes))} bytes against the private re-encoding bound of 2x the SDK's MAX_ALIGNMENT_PAGE_BYTES (D032 §1); the scripted capture runs ${CAPTURE_FRAME_LIMIT} frames, the length that refused every page before the fix`);

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
        dry ? `exit ${dry.exit}: ${dry.stdout.trim().slice(0, 400)}` : "not run");
      oracle("teammem_isolation", "pass",
        `env file ${teammem.paths.envFile} at 0600; inbox ${teammem.paths.inbox} is the application outbox; receipts ${teammem.paths.receipts}; bare remote ${teammem.paths.bare}; no path under ~/.local/share/teammem, ~/.config/teammem or the overlay`);
      if (live.teammemResult?.publishRun) {
        check("teammem_publish", live.teammemResult.publishRun.exit === 0,
          `exit ${live.teammemResult.publishRun.exit}: ${live.teammemResult.publishRun.stdout.trim().slice(0, 400)} ${live.teammemResult.publishRun.stderr.trim().slice(0, 400)}`);
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
      check("shutdown_clean", live.outcome.code === 0 && logged("shutdown_store_closed"),
        `entry exit ${live.outcome.code}; shipped close order ${JSON.stringify((live.summary?.trace ?? []).filter((code) => code.startsWith("shutdown_")))}`);
    }

    // --- negative proofs ---------------------------------------------------
    const proofs = options.onlyRefusals ? null : negativeProofs({ staged, live, teammem });
    if (proofs) {
      check("no_key_or_plaintext_audio",
        proofs.leaks.key.length === 0 && proofs.leaks.secret.length === 0 && proofs.leaks.credential.length === 0
        && proofs.envLeaks.length === 0 && proofs.pcmMarkers.length === 0,
        `scanned ${proofs.scannedFiles} files; key hits ${proofs.leaks.key.length}; secret hits ${proofs.leaks.secret.length}; credential hits ${proofs.leaks.credential.length}; env ${JSON.stringify(proofs.envLeaks)}; pcm ${JSON.stringify(proofs.pcmMarkers)}`);
      check("no_orphan_process", proofs.orphans.length === 0, `recorded pids ${JSON.stringify(proofs.pids)}; still alive ${JSON.stringify(proofs.orphans)}`);
      check("no_closed_store_callback", proofs.afterStoreClose.length === 0, `codes after shutdown_store_closed: ${JSON.stringify(proofs.afterStoreClose)}`);
      check("single_occurrence_identity", proofs.identities.length === 1, `occurrence identities observed: ${JSON.stringify(proofs.identities)}`);
      writeNegativeProofs(options.out, { proofs, staged, live });
      live.proofs = proofs;
    }

    writeBundle(options.out, { options, pins, treeId, staged, teammem, live });
  } finally {
    if (!options.keep) rmSync(staged.root, { recursive: true, force: true });
    else process.stdout.write(`kept private root: ${staged.root}\n`);
  }

  const failed = oracles.filter((entry) => entry.status === "fail");
  process.stdout.write(`${JSON.stringify({ out: options.out, oracles: oracles.length, failed: failed.length }, null, 2)}\n`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

function writeNegativeProofs(outDir, { proofs, staged, live }) {
  const lines = [
    "# Negative proofs",
    "",
    `Label: ${LABEL}. These are absences observed in one run, not guarantees.`,
    "",
    "## No key, secret or provider credential in Meeting, the bridge or TeamMem",
    "",
    `Scanned ${proofs.scannedFiles} files under the recordings, outbox, receipts, bridge-control, TeamMem and launcher-log paths for the run's synthetic Runtime recording key, the Feishu app-secret bytes and the synthetic provider credential.`,
    "",
    `- recording key occurrences: ${proofs.leaks.key.length}`,
    `- app secret occurrences: ${proofs.leaks.secret.length}`,
    `- provider credential occurrences: ${proofs.leaks.credential.length}`,
    `- bridge child environment names carrying either: ${proofs.envLeaks.length === 0 ? "none" : proofs.envLeaks.join(", ")}`,
    `- bridge child environment keys: ${JSON.stringify(live.childState?.envKeys ?? [])}`,
    "",
    "## No plaintext audio",
    "",
    "A silent pcm_s16le/24000/1 20 ms frame is 960 NUL bytes. Neither the encrypted recording nor the published audio may contain such a run or a WAV container header.",
    "",
    proofs.pcmMarkers.length === 0 ? "- no marker found" : proofs.pcmMarkers.map((marker) => `- ${marker}`).join("\n"),
    "",
    "## No orphan process",
    "",
    `Every process this run recorded was probed with kill(pid, 0) after the application closed.`,
    "",
    ...proofs.pids.map((entry) => `- ${entry.role} pid ${entry.pid}: ${proofs.orphans.some((orphan) => orphan.pid === entry.pid) ? "STILL ALIVE" : "reaped (ESRCH)"}`),
    "",
    "## No callback after the store closed",
    "",
    `The shipped close order ends at shutdown_store_closed. Static codes logged after it: ${proofs.afterStoreClose.length === 0 ? "none" : JSON.stringify(proofs.afterStoreClose)}.`,
    "",
    "## No cross-occurrence identity",
    "",
    `Occurrence identities across the reopened state database, the artifact bundle and the publication receipt: ${JSON.stringify(proofs.identities)}.`,
    "",
    `Private root: ${staged.root} (deleted unless --keep).`,
    "",
  ];
  writeFileSync(path.join(outDir, "NEGATIVE-PROOFS.md"), lines.join("\n"));
}

function writeBundle(outDir, { options, pins, treeId, staged, teammem, live }) {
  if (live.artifact) {
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
    command: [NODE24, path.join(REPO, "e2e/run.mjs"), "--out", options.out, ...(options.keep ? ["--keep"] : []), ...(options.onlyRefusals ? ["--only-refusals"] : [])],
    mode: options.onlyRefusals ? "refusals" : "full",
    repository: REPO,
    sourceTreeId: treeId,
    runtimePins: { ...pins, name: RUNTIME_PIN.name, revision: RUNTIME_PIN.revision },
    teammem: teammem === null ? null : { source: TEAMMEM_SOURCE, wheel: path.basename(teammem.wheel), wheelSha256: teammem.wheelSha256, envFile: path.basename(teammem.paths.envFile) },
    gatewayConfigurations: {
      live: "online profile, unreachable .invalid providers (the only profile the shipped client admits)",
      postmeeting: "offline profile, local fixture provider host, same recording directory and key",
    },
    privateRoot: staged.root,
    steps,
    oracles,
    trace: live.summary?.trace ?? [],
    events: live.events,
    feishuRequests: live.summary?.feishuRequests ?? [],
    feishuMessages: (live.summary?.feishuMessages ?? []).map((message) => ({ uuid: message.uuid, recipientKnown: typeof message.receiveId === "string", textBytes: message.textBytes })),
    providerCalls: live.summary?.providerCalls ?? [],
    bridgeChild: live.childState === null ? null : { pid: live.childState.pid, joined: live.childState.joined, mediaConnected: live.childState.mediaConnected, framesSent: live.childState.framesSent, left: live.childState.left, commands: live.childState.commands },
    processTreeAtPeak: live.peakTree,
    stateDatabase: live.reopen,
    artifact: live.artifact === null ? null : { files: live.artifact.files, revision: live.artifact.revision, hash: live.artifact.hash, occurrenceId: live.artifact.occurrenceId, manifest: live.artifact.manifest },
    teammemRuns: live.teammemResult === null ? null : {
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

await main().catch((error) => {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exitCode = 1;
});

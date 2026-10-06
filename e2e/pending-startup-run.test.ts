import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Duplex } from "node:stream";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { test, mock } from "node:test";
import Database from "better-sqlite3";
// @ts-expect-error Private controller has no declaration.
const module = await import("./pending-startup-run.mjs").catch(() => ({}));
// @ts-expect-error Accepted private controls have no declaration.
const controls = await import("./feishu-peer-controls.mjs");
function api(name: string) { const value = Reflect.get(module, name); assert.equal(typeof value, "function", name); return value; }
const tables = ["feishu_invite_occurrences", "feishu_invite_events", "sessions", "bridge_leases", "physical_client_custody", "reconciliation_generations", "recordings", "bridge_failure_recordings", "recording_recovery_bindings", "unknown_end_custody", "backfill_seeds", "delivery_journal", "notification_intents"];
const shutdownCodes = ["shutdown_fenced", "maintenance_fenced", "maintenance_closed", "shutdown_owned_work_settled", "shutdown_application_closed", "shutdown_runtime_owners_closed", "shutdown_transports_closed", "shutdown_store_closed"];
const budgets = { label: "component-facts", admissionMs: 100, pendingMs: 25, cleanupMs: 100, overallMs: 400, pollMs: 1 };
class Wire extends Duplex { _read() {} _write(_chunk: Buffer, _encoding: string, done: () => void) { done(); } }
function component(options: { incomplete?: boolean; noArrival?: boolean; lateBegin?: number; stale?: boolean; rejectedClose?: boolean; nonmemoized?: boolean; neverFinish?: boolean } = {}) {
  const p = controls.createFeishuPeerControls({ meeting: { providerMeetingId: "component", meetingNo: "1", startSeconds: 1, title: "component" }, wsPath: () => "ws://peer.invalid/ws" });
  const id = p.armNext({ route: "ws_endpoint", outcome: "hold" }), wire = new Wire(), request = new IncomingMessage(wire as unknown as Socket);
  request.method = "POST"; request.url = "/callback/ws/endpoint";
  const response = new ServerResponse(request); response.assignSocket(wire as unknown as Socket);
  let ordinal = 0, handles = 0, owners = 0, lifecycleSettled = false, cleanup = false, peerOrdinal = 0, ownerOrdinal = 0, cancelled = false;
  let closePromise: Promise<void> | undefined, first: Promise<void>, second: Promise<void>, requestedOrdinal = 0;
  let beginPromise: Promise<void> | undefined;
  const log: { ordinal: number; code: string }[] = [], calls = { selected: 0, normal: 0, cancel: 0, finish: 0 };
  const mark = (code: string) => { const n = ++ordinal; if (!code.startsWith("test_")) log.push({ ordinal: n, code }); return n; };
  function snapshot() {
    return { holdId: id, hold: p.readPendingHold(id), admittedOwnerCount: owners, handleCount: handles, elapsedMs: 10, lifecycleSettled,
      httpActive: lifecycleSettled ? 0 : 1, httpSockets: { active: lifecycleSettled ? 0 : 1, pending: 0 }, connectionSockets: { active: 0, pending: 0 },
      peer: { connections: 0, ackCount: 0, legacyAckCount: 0, messageCount: 0, invalid: false, overflow: false },
      requests: p.requests.map((row: { method: string; route: string; status: number }) => ({ ...row })), lifecycle: log.map(row => ({ ...row })),
      invalidObservation: false, historyOverflow: false, fixtureCleanupStarted: cleanup, peerCloseOrdinal: peerOrdinal, ownerCloseOrdinal: ownerOrdinal };
  }
  const app = { close() {
    calls.normal++;
    const make = () => Promise.resolve().then(() => { request.emit("aborted"); lifecycleSettled = true; for (const code of shutdownCodes) mark(code); if (options.rejectedClose) throw new Error("private-close-secret"); });
    if (options.nonmemoized) { const value = make(); value.catch(() => {}); return value; }
    return closePromise ??= make();
  } };
  const effects = {
    begin(signal: AbortSignal) {
      beginPromise = (async () => {
        if (options.lateBegin) await delay(options.lateBegin);
        owners = 1; handles = 1; mark("composition_lock_verified"); mark("composition_store_opened"); mark("maintenance_started");
        if (!options.noArrival) { p.handler(request, response); if (!options.incomplete) { request.complete = true; request.push(null); await setImmediate(); } }
        if (signal.aborted || cancelled) app.close().catch(() => {});
      })(); return beginPromise;
    },
    readPending: snapshot,
    closeWhileHeld(expected: ReturnType<typeof snapshot>) {
      if (options.stale) request.emit("aborted");
      const result = api("closeHeldStartup")(expected, effects.readPending, app, () => requestedOrdinal = mark("test_close_requested"));
      calls.selected++; first = result.first; second = result.second; return result;
    },
    async settleBeforeFixtureCleanup() {
      const statuses = await Promise.allSettled([first, second]), settledOrdinal = mark("test_public_close_settled");
      const before = snapshot(), third = app.close(); await third.catch(() => {});
      return { snapshot: before, composition: { status: "composition_closed", clean: false }, close: { requestedOrdinal, settledOrdinal,
        firstFulfilled: statuses[0]!.status === "fulfilled", secondFulfilled: statuses[1]!.status === "fulfilled", promiseSame: first === second,
        thirdFulfilled: !options.rejectedClose, thirdPromiseSame: first === third, repeatUnchanged: JSON.stringify(before) === JSON.stringify(snapshot()) } };
    },
    async finish() {
      calls.finish++; if (options.neverFinish) return new Promise<never>(() => {});
      if (beginPromise) await beginPromise; if (closePromise) await closePromise.catch(() => {});
      cleanup = true; p.close(); peerOrdinal = mark("test_peer_settled");
      const admittedReturnOrdinal = mark("test_admitted_return"), ownerCloseBeginOrdinal = mark("test_owner_close_begin"); ownerOrdinal = mark("test_owner_close_end");
      return { snapshot: snapshot(), composition: { status: "composition_closed", clean: false }, standaloneExit: 70,
        peerSettledOrdinal: peerOrdinal, admittedReturnOrdinal, ownerCloseBeginOrdinal, ownerCloseEndOrdinal: ownerOrdinal, cleanupFailures: [] as string[],
        emptyState: { identity: { dev: 1, ino: 2, size: 4096, uid: 501, mode: 384 }, counts: Object.fromEntries(tables.map(name => [name, 0])) },
        files: { recordings: 0, outbox: 0, receipts: 0, runtimePids: false, launcherLog: false, key: false, bridgeState: false },
        liveCount: 0, outcomeCount: 0, diagnostics: [{ channel: "stderr", code: "composition_closed" }] };
    },
    cancel() { calls.cancel++; cancelled = true; if (handles) app.close().catch(() => {}); },
  };
  return { effects, calls, snapshot, dispose() { wire.destroy(); try { p.close(); } catch { /* Deliberate peer repeated-close refusal. */ } } };
}
test("component shared controller observes real held arrival, public close and owner-last cleanup", async () => {
  const c = component();
  try { const result = await api("runPendingStartupPhase")(c.effects, budgets); assert.equal(result.success, true); assert.deepEqual(result.failures, []);
    assert.equal(result.label, "component-facts"); assert.equal(result.heldSnapshot.hold.method, "POST"); assert.equal(result.cancellationSnapshot.snapshot.hold, null);
    assert.deepEqual(result.finalSnapshot.composition, { status: "composition_closed", clean: false }); assert.equal(result.finalSnapshot.standaloneExit, 70);
    assert.equal(result.cleanupConfirmed, true); assert.equal(c.calls.selected, 1); assert.equal(c.calls.cancel, 0); assert.equal(c.calls.finish, 1);
  } finally { c.dispose(); }
});
for (const [name, option] of [["no arrival", { noArrival: true }], ["incomplete body", { incomplete: true }], ["stale synchronous recheck", { stale: true }]] as const) test(`component ${name} refuses selected close and cleans up`, async () => {
  const c = component(option); try { const r = await api("runPendingStartupPhase")(c.effects, budgets); assert.equal(r.success, false); assert.equal(c.calls.selected, 0); assert.equal(c.calls.cancel, 1); assert.equal(c.calls.finish, 1); } finally { c.dispose(); }
});
const pendingChanges: [string, (v: ReturnType<ReturnType<typeof component>["snapshot"]>) => void][] = [
  ["armed ID alone", v => { v.hold = null; }], ["wrong ID", v => { v.hold.id = "foreign"; }], ["wrong route", v => { v.hold.route = "tenant_access_token"; }], ["wrong method", v => { v.hold.method = "GET"; }],
  ["false ready", v => { v.lifecycle.push({ ordinal: 99, code: "composition_started" }); }], ["already settled", v => { v.lifecycleSettled = true; }], ["multiple owners", v => { v.admittedOwnerCount = 2; }], ["missing handle", v => { v.handleCount = 0; }],
  ["HTTP inactive", v => { v.httpActive = 0; }], ["peer disposed", v => { v.fixtureCleanupStarted = true; }], ["prior499", v => { v.requests.push({ method: "POST", route: "ws_endpoint", status: 499 }); }],
  ["ACK", v => { v.peer.ackCount = 1; }], ["legacy ACK", v => { v.peer.legacyAckCount = 1; }], ["message", v => { v.peer.messageCount = 1; }], ["invalid receiver", v => { v.peer.invalid = true; }], ["overflow receiver", v => { v.peer.overflow = true; }], ["connection", v => { v.peer.connections = 1; }],
  ["history overflow", v => { v.historyOverflow = true; }], ["missing composition evidence", v => { v.lifecycle = []; }], ["extra private fact", v => { Reflect.set(v, "secret", "private-secret"); }],
];
for (const [name, change] of pendingChanges) test(`component pending ${name} cannot select close`, async () => {
  const c = component(), read = c.effects.readPending; c.effects.readPending = () => { const v = structuredClone(read()); change(v); return v; };
  try { const r = await api("runPendingStartupPhase")(c.effects, budgets); assert.equal(r.success, false); assert.equal(c.calls.selected, 0); assert.equal(JSON.stringify(r).includes("private-secret"), false); } finally { c.dispose(); }
});
type ComponentSettlement = Awaited<ReturnType<ReturnType<typeof component>["effects"]["settleBeforeFixtureCleanup"]>>;
const settlementChanges: [string, (v: ComponentSettlement) => void][] = [
  ["missing499", v => { Reflect.get(v, "snapshot").requests = []; }], ["duplicate499", v => { Reflect.get(v, "snapshot").requests.push({ method: "POST", route: "ws_endpoint", status: 499 }); }], ["endpoint200", v => { Reflect.get(v, "snapshot").requests.push({ method: "POST", route: "ws_endpoint", status: 200 }); }],
  ["HTTP active", v => { Reflect.get(v, "snapshot").httpActive = 1; }], ["HTTP socket active", v => { Reflect.get(v, "snapshot").httpSockets.active = 1; }], ["HTTP socket pending", v => { Reflect.get(v, "snapshot").httpSockets.pending = 1; }], ["connection active", v => { Reflect.get(v, "snapshot").connectionSockets.active = 1; }], ["connection pending", v => { Reflect.get(v, "snapshot").connectionSockets.pending = 1; }],
  ["fixture cleanup first", v => { Reflect.get(v, "snapshot").fixtureCleanupStarted = true; }], ["third identity", v => { Reflect.get(v, "close").thirdPromiseSame = false; }], ["third work", v => { Reflect.get(v, "close").repeatUnchanged = false; }],
  ["store close absent", v => { Reflect.get(v, "snapshot").lifecycle = Reflect.get(v, "snapshot").lifecycle.filter((r: { code: string }) => r.code !== "shutdown_store_closed"); }], ["timeout guard", v => { Reflect.get(v, "snapshot").elapsedMs = 4500; }], ["clean rewritten", v => { Reflect.get(v, "composition").clean = true; }],
];
for (const [name, change] of settlementChanges) test(`component cancellation ${name} remains failed after cleanup`, async () => {
  const c = component(), settle = c.effects.settleBeforeFixtureCleanup; c.effects.settleBeforeFixtureCleanup = async () => { const v = await settle(); change(v); return v; };
  try { const r = await api("runPendingStartupPhase")(c.effects, budgets); assert.equal(r.success, false); assert.equal(c.calls.finish, 1); } finally { c.dispose(); }
});
type ComponentFinal = Awaited<ReturnType<ReturnType<typeof component>["effects"]["finish"]>>;
const finalChanges: [string, (v: ComponentFinal) => void][] = [
  ["standalone zero", v => { v.standaloneExit = 0; }], ["owner premature", v => { v.ownerCloseBeginOrdinal = 1; }], ["owner failed", v => { v.ownerCloseEndOrdinal = 0; }], ["peer failed", v => { v.cleanupFailures = ["pending_startup_peer_close_failed"]; }],
  ["late ACK", v => { Reflect.get(v, "snapshot").peer.ackCount = 1; }], ["late overflow", v => { Reflect.get(v, "snapshot").peer.overflow = true; }], ["late retry", v => { Reflect.get(v, "snapshot").requests.push({ method: "POST", route: "ws_endpoint", status: 503 }); }], ["late ready", v => { Reflect.get(v, "snapshot").lifecycle.push({ ordinal: 100, code: "composition_started" }); }],
  ["nonempty state", v => { Reflect.get(v, "emptyState").counts.sessions = 1; }], ["Runtime PID file", v => { Reflect.get(v, "files").runtimePids = true; }], ["live occurrence", v => { v.liveCount = 1; }], ["occurrence outcome", v => { v.outcomeCount = 1; }],
];
for (const [name, change] of finalChanges) test(`component final ${name} cannot erase cancellation evidence`, async () => {
  const c = component(), finish = c.effects.finish; c.effects.finish = async () => { const v = await finish(); change(v); return v; };
  try { const r = await api("runPendingStartupPhase")(c.effects, budgets); assert.equal(r.success, false); assert.notEqual(r.cancellationSnapshot, null); } finally { c.dispose(); }
});
for (const option of [{ rejectedClose: true }, { nonmemoized: true }]) test(`component public close refuses ${Object.keys(option)[0]}`, async () => {
  const c = component(option); try { const r = await api("runPendingStartupPhase")(c.effects, budgets); assert.equal(r.success, false); assert.equal(JSON.stringify(r).includes("private-close-secret"), false); } finally { c.dispose(); }
});
test("component late handle gets normal cleanup but deadline remains failed", async () => {
  const c = component({ lateBegin: 15 }); try { const r = await api("runPendingStartupPhase")(c.effects, { ...budgets, admissionMs: 2 }); assert.equal(r.success, false); assert.equal(r.failures[0], "pending_startup_admission_timeout"); assert.ok(c.calls.normal > 0); assert.equal(c.calls.selected, 0); } finally { c.dispose(); }
});
test("component cleanup that never settles is explicitly unconfirmed", async () => {
  const c = component({ neverFinish: true }); try { const r = await api("runPendingStartupPhase")(c.effects, { ...budgets, cleanupMs: 2 }); assert.equal(r.success, false); assert.equal(r.cleanupConfirmed, false); assert.equal(r.finalSnapshot, null); assert.ok(r.failures.includes("pending_startup_cleanup_unconfirmed")); } finally { c.dispose(); }
});
test("component arbitrary rejection remains static and private", async () => {
  const c = component(); c.effects.begin = async () => { throw new Error("private-token path body"); }; try { const r = await api("runPendingStartupPhase")(c.effects, budgets); assert.equal(r.success, false); assert.equal(JSON.stringify(r).includes("private-token"), false); } finally { c.dispose(); }
});
function fixture() {
  const root = mkdtempSync("/private/tmp/pending-startup-schema29-"); chmodSync(root, 0o700);
  const databasePath = path.join(root, "component.db"), db = new Database(databasePath);
  for (const file of readdirSync(path.resolve(import.meta.dirname, "../migrations")).filter(f => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(path.resolve(import.meta.dirname, "../migrations", file), "utf8")); db.prepare("INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(?,?,0)").run(Number(file.slice(0, 3)), file);
  }
  db.close(); return { root, databasePath, dispose() { rmSync(root, { recursive: true, force: true }); } };
}
test("component migrated empty schema29 reader is count-only and leaves bytes unchanged", () => {
  const f = fixture(); try { const before = readFileSync(f.databasePath), s = api("readStartupEmptyState")({ databasePath: f.databasePath }); assert.deepEqual(Object.keys(s), ["identity", "counts"]); assert.deepEqual(s.counts, Object.fromEntries(tables.map(name => [name, 0]))); assert.deepEqual(readFileSync(f.databasePath), before); assert.deepEqual(readdirSync(f.root), ["component.db"]); } finally { f.dispose(); }
});
for (const table of tables) test(`component reader refuses any ${table} row`, () => {
  const f = fixture(); try { const db = new Database(f.databasePath); db.exec(`PRAGMA foreign_keys=OFF; DROP TABLE ${table}; CREATE TABLE ${table}(private TEXT); INSERT INTO ${table} VALUES('private-row');`); db.close(); assert.throws(() => api("readStartupEmptyState")({ databasePath: f.databasePath }), /pending_startup_reader_nonempty/); } finally { f.dispose(); }
});
for (const kind of ["wrong schema", "WAL header", "WAL sidecar", "SHM sidecar", "symlink file", "symlink parent", "directory file", "overlarge", "unsafe parent", "short header"]) test(`component reader guards ${kind}`, () => {
  const f = fixture(); let readPath = f.databasePath;
  try {
    if (kind === "wrong schema") { const db = new Database(readPath); db.exec("DELETE FROM schema_migrations WHERE version=29"); db.close(); }
    else if (kind === "WAL header") { const b = readFileSync(readPath); b[18] = 2; b[19] = 2; writeFileSync(readPath, b); }
    else if (kind === "WAL sidecar") writeFileSync(`${readPath}-wal`, "private-wal"); else if (kind === "SHM sidecar") writeFileSync(`${readPath}-shm`, "private-shm");
    else if (kind === "symlink file") { renameSync(readPath, `${readPath}.real`); symlinkSync(`${readPath}.real`, readPath); }
    else if (kind === "symlink parent") { symlinkSync(f.root, `${f.root}.link`); readPath = path.join(`${f.root}.link`, "component.db"); }
    else if (kind === "directory file") readPath = f.root; else if (kind === "overlarge") truncateSync(readPath, 8388609); else if (kind === "unsafe parent") chmodSync(f.root, 0o755); else truncateSync(readPath, 99);
    const before = readdirSync(f.root); assert.throws(() => api("readStartupEmptyState")({ databasePath: readPath }), /pending_startup_reader_/); assert.deepEqual(readdirSync(f.root), before);
  } finally { rmSync(`${f.root}.link`, { recursive: true, force: true }); f.dispose(); }
});
test("component reader detects identity replacement during readonly transaction", () => {
  const f = fixture(), original = Database.prototype.prepare; let swapped = false;
  const replacement = mock.method(Database.prototype, "prepare", function(this: Database.Database, sql: string) {
    if (!swapped && sql.startsWith("SELECT count")) { swapped = true; renameSync(f.databasePath, `${f.databasePath}.old`); writeFileSync(f.databasePath, readFileSync(`${f.databasePath}.old`)); } return original.call(this, sql);
  });
  try { assert.throws(() => api("readStartupEmptyState")({ databasePath: f.databasePath }), /pending_startup_reader_identity/); assert.equal(swapped, true); } finally { replacement.mock.restore(); f.dispose(); }
});
test("command arguments reject selectors, duplicate output, existing and unsafe paths", () => {
  const root = mkdtempSync("/private/tmp/pending-startup-arguments-"); try { const out = path.join(root, "new"); assert.deepEqual(api("parsePendingStartupArguments")(["--out", out]), { out });
    for (const argv of [[], ["--out"], ["--out", root], ["--out", "/"], ["--out", "relative"], ["--out", `${root}/../out`], ["--out", `${root}/private\n`], ["--out", out, "--out", out], ["--out", out, "--route", "ws_endpoint"], ["--out", out, "--mode", "signal"]]) assert.throws(() => api("parsePendingStartupArguments")(argv), /pending_startup_argument|pending_startup_output/);
    symlinkSync(root, `${root}.link`); assert.throws(() => api("parsePendingStartupArguments")(["--out", `${root}.link/new`]), /pending_startup_output/);
  } finally { rmSync(`${root}.link`, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});
test("shared finite log and diagnostics retain no secret input and keep overflow sticky", () => {
  const log = api("createStartupLog")(); log.log("private-token body path"); assert.equal(log.snapshot().invalid, true); assert.equal(JSON.stringify(log.snapshot()).includes("private-token"), false);
  for (let i = 0; i < 129; i++) log.log("feishu_sdk_debug"); assert.equal(log.snapshot().overflow, true); assert.equal(log.snapshot().observations.length, 128); log.log("composition_store_opened"); assert.equal(log.snapshot().overflow, true);
  assert.deepEqual(api("observeStartupDiagnostic")("stderr", "meeting-agent: composition_closed"), { channel: "stderr", code: "composition_closed" });
  for (const line of ["private-token", "meeting-agent: application_owner_lock_private_secret", "meeting-agent: composition_unavailable private_secret", "x".repeat(10000)]) assert.throws(() => api("observeStartupDiagnostic")("stderr", line), /pending_startup_diagnostic_invalid/);
});
test("entry import exposes callable adapter without application or SDK startup", async () => {
  // @ts-expect-error Private adapter has no declaration.
  const entry = await import("./pending-startup-entry.mjs"); assert.equal(typeof entry.runRealPendingStartup, "function");
});
test("artifact writer revalidates a claimed success and omits private extra facts", async () => {
  const c = component(), root = mkdtempSync("/private/tmp/pending-startup-evidence-"); chmodSync(root, 0o700);
  try {
    const result = await api("runPendingStartupPhase")(c.effects, budgets), falseHeld = structuredClone(result);
    falseHeld.heldSnapshot.hold = null;
    assert.throws(() => api("writePendingStartupEvidence")(root, falseHeld), /pending_startup_/);
    const extra = { ...result, secret: "private-secret" }; assert.throws(() => api("writePendingStartupEvidence")(root, extra), /pending_startup_fact_invalid/);
    api("writePendingStartupEvidence")(root, result);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, "evidence.json"), "utf8")), result);
    assert.throws(() => api("writePendingStartupEvidence")(root, result));
  } finally { c.dispose(); rmSync(root, { recursive: true, force: true }); }
});
test("environment names refuse without reading either private value", () => {
  let touched = 0;
  for (const key of ["E2E_RUNTIME_RECORDING_KEY", "E2E_PROVIDER_CREDENTIAL"]) {
    const environment = Object.defineProperty({}, key, { get() { touched++; throw new Error("private-value"); } });
    assert.throws(() => api("assertPendingStartupEnvironment")(environment), /pending_startup_environment_refused/);
  }
  api("assertPendingStartupEnvironment")({}); assert.equal(touched, 0);
});
test("staged plan validates its exact six fields before any built import", () => {
  const plan = { standaloneConfigPath: "/private/tmp/component/config.json", databasePath: "/private/tmp/component/state/orchestration.db",
    directories: { recordingsDir: "/private/tmp/component/recordings", outboxDir: "/private/tmp/component/outbox", receiptsDir: "/private/tmp/component/receipts", control: "/private/tmp/component/control" },
    runtimePidsPath: "/private/tmp/component/pids", launcherLog: "/private/tmp/component/launcher.log", keyPath: "/private/tmp/component/key" };
  assert.equal(api("validatePendingStartupPlan")(plan), plan);
  for (const invalid of [{ ...plan, mode: "signal" }, { ...plan, databasePath: "relative" }, { ...plan, directories: { ...plan.directories, secret: "private-value" } }]) assert.throws(() => api("validatePendingStartupPlan")(invalid), /pending_startup_/);
});
test("source refusal retains its actual standalone category and cannot become a pending result", async () => {
  const c = component(), finish = c.effects.finish;
  c.effects.begin = async () => { throw new Error("pending_startup_admission_refused"); };
  c.effects.finish = async () => { const value = await finish(); value.standaloneExit = 65; value.diagnostics = [{ channel: "stderr", code: "application_owner_lock_unsupported" }]; return value; };
  try { const result = await api("runPendingStartupPhase")(c.effects, budgets); assert.equal(result.success, false); assert.equal(result.heldSnapshot, null); assert.equal(result.cancellationSnapshot, null); assert.equal(result.finalSnapshot.standaloneExit, 65); assert.equal(result.failures[0], "pending_startup_admission_refused"); }
  finally { c.dispose(); }
});
test("exception getters are never invoked or serialized", async () => {
  const c = component(); let touched = 0;
  c.effects.begin = async () => { throw Object.defineProperty({}, "message", { get() { touched++; throw new Error("private-exception"); } }); };
  try { const result = await api("runPendingStartupPhase")(c.effects, budgets); assert.equal(result.success, false); assert.equal(touched, 0); assert.equal(JSON.stringify(result).includes("private-exception"), false); }
  finally { c.dispose(); }
});
test("component empty-file reader ignores the configured launcher but refuses every launch/side-effect role", () => {
  const root = mkdtempSync("/private/tmp/pending-startup-empty-files-"); chmodSync(root, 0o700);
  const directories = { recordingsDir: path.join(root, "recordings"), outboxDir: path.join(root, "outbox"), receiptsDir: path.join(root, "receipts"), control: path.join(root, "control") };
  for (const directory of Object.values(directories)) mkdirSync(directory, { mode: 0o700 });
  const plan = { directories, runtimePidsPath: path.join(root, "pids"), launcherLog: path.join(root, "launcher.log"), keyPath: path.join(root, "key") };
  try {
    writeFileSync(path.join(root, "runtime-launcher"), "component configured file");
    assert.deepEqual(api("readStartupEmptyFiles")(plan), { recordings: 0, outbox: 0, receipts: 0, runtimePids: false, launcherLog: false, key: false, bridgeState: false });
    for (const filename of [plan.runtimePidsPath, plan.launcherLog, plan.keyPath, path.join(directories.control, "state.json"), path.join(directories.recordingsDir, "one"), path.join(directories.outboxDir, "one"), path.join(directories.receiptsDir, "one")]) {
      writeFileSync(filename, "private-component-content"); assert.throws(() => api("readStartupEmptyFiles")(plan), /pending_startup_files_invalid/); rmSync(filename);
    }
    renameSync(directories.recordingsDir, `${directories.recordingsDir}.real`); symlinkSync(`${directories.recordingsDir}.real`, directories.recordingsDir);
    assert.throws(() => api("readStartupEmptyFiles")(plan), /pending_startup_files_invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("one private polling allowance bounds the combined pending and cancellation observations", async () => {
  const c = component(), allowance = { remaining: 250 }, read = c.effects.readPending; let reads = 0;
  c.effects.readPending = () => { const value = read(); if (++reads <= 3) value.hold = null; return value; };
  try { const result = await api("runPendingStartupPhase")(c.effects, { ...budgets, pollAllowance: allowance }); assert.equal(result.success, true); assert.equal(allowance.remaining, 246); }
  finally { c.dispose(); }
});
function blockFor(ms: number) { const until = performance.now() + ms; while (performance.now() < until) { /* Finite listener-free scheduler blocking. */ } }
test("synchronous admission blocking crosses its absolute deadline before timer dispatch", async () => {
  const c = component(), begin = c.effects.begin;
  c.effects.begin = signal => { blockFor(30); return begin(signal); };
  try {
    const result = await api("runPendingStartupPhase")(c.effects, { ...budgets, admissionMs: 5 });
    assert.equal(result.success, false); assert.equal(result.failures[0], "pending_startup_admission_timeout");
    assert.equal(c.calls.selected, 0); assert.equal(c.calls.cancel, 1); assert.equal(c.calls.finish, 1); assert.ok(c.calls.normal > 0);
  } finally { c.dispose(); }
});
test("synchronous final evidence blocking cannot pass an expired overall deadline", async () => {
  const c = component(), finish = c.effects.finish; let ordinary: Awaited<ReturnType<typeof finish>> | undefined;
  c.effects.finish = async () => { ordinary = await finish(); blockFor(50); return ordinary; };
  try {
    const result = await api("runPendingStartupPhase")(c.effects, { ...budgets, overallMs: 30 });
    assert.equal(result.success, false); assert.ok(result.failures.includes("pending_startup_cleanup_unconfirmed"));
    assert.equal(result.cleanupConfirmed, false); assert.equal(result.finalSnapshot, null); assert.equal(c.calls.finish, 1);
    assert.deepEqual(ordinary!.composition, { status: "composition_closed", clean: false }); assert.equal(ordinary!.standaloneExit, 70);
  } finally { c.dispose(); }
});
test("synchronous effects within both deadlines preserve cancelled-start evidence", async () => {
  const c = component(), begin = c.effects.begin, finish = c.effects.finish;
  c.effects.begin = signal => { blockFor(2); return begin(signal); };
  c.effects.finish = async () => { const value = await finish(); blockFor(2); return value; };
  try {
    const result = await api("runPendingStartupPhase")(c.effects, budgets);
    assert.equal(result.success, true); assert.deepEqual(result.failures, []); assert.equal(result.cleanupConfirmed, true);
    assert.equal(result.finalSnapshot.standaloneExit, 70); assert.equal(result.finalSnapshot.composition.clean, false);
  } finally { c.dispose(); }
});
test("deferred final settlement retains owned cleanup and cannot erase deadline failure", async () => {
  const c = component(), finish = c.effects.finish; let late: ReturnType<typeof finish> | undefined;
  c.effects.finish = () => late = delay(25).then(() => finish());
  try {
    const result = await api("runPendingStartupPhase")(c.effects, { ...budgets, cleanupMs: 5 });
    assert.equal(result.success, false); assert.equal(result.cleanupConfirmed, false); assert.equal(result.finalSnapshot, null);
    assert.equal(c.snapshot().fixtureCleanupStarted, false); assert.equal(c.snapshot().ownerCloseOrdinal, 0);
    const failures = [...result.failures], ordinary = await late!;
    assert.equal(c.calls.finish, 1); assert.ok(ordinary.ownerCloseEndOrdinal > ordinary.peerSettledOrdinal);
    assert.equal(ordinary.standaloneExit, 70); assert.equal(ordinary.composition.clean, false);
    assert.deepEqual(result.failures, failures); assert.equal(result.success, false); assert.equal(result.cleanupConfirmed, false);
  } finally { c.dispose(); }
});
test("overall expiry during settlement still invokes ordinary final cleanup exactly once", async () => {
  const c = component(), settle = c.effects.settleBeforeFixtureCleanup;
  c.effects.settleBeforeFixtureCleanup = async () => { const value = await settle(); blockFor(50); return value; };
  try {
    const result = await api("runPendingStartupPhase")(c.effects, { ...budgets, overallMs: 30 });
    assert.equal(result.success, false); assert.ok(result.failures.includes("pending_startup_cleanup_unconfirmed"));
    assert.equal(c.calls.cancel, 1); assert.equal(c.calls.finish, 1); assert.ok(c.snapshot().ownerCloseOrdinal > c.snapshot().peerCloseOrdinal);
    assert.equal(result.cleanupConfirmed, false);
  } finally { c.dispose(); }
});

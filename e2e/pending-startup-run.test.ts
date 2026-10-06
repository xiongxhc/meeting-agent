import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { Agent as HttpAgent, IncomingMessage, ServerResponse } from "node:http";
import type { ClientRequestArgs } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Duplex } from "node:stream";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { test, mock } from "node:test";
import Database from "better-sqlite3";
import type { createFeishuSocketOwner as SocketOwnerFactory } from "../src/adapters/feishu-sdk-connection.ts";
// Runtime exercises compiled owner code; compilation derives its type from source.
const socketOwnerModule: unknown = await import(new URL("../dist/src/adapters/feishu-sdk-connection.js", import.meta.url).href);
assert.ok(socketOwnerModule && typeof socketOwnerModule === "object");
const socketOwnerFactory: unknown = Reflect.get(socketOwnerModule, "createFeishuSocketOwner");
assert.equal(typeof socketOwnerFactory, "function");
const createFeishuSocketOwner = socketOwnerFactory as typeof SocketOwnerFactory;
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

// Synthetic component facts on actual owner/handler streams; no SDK/network/app.
const upgradeModule: unknown = await import(new URL("./feishu-upgrade-controls.mjs", import.meta.url).href);
type UpgradeObservation = { arrivals: number; accepted: number; pending: number; disposed: boolean; invalid: boolean; overflow: boolean;
  events: { ordinal: number; id: string | null; kind: "held" | "accepted" | "remote_closed" | "fixture_closed" | "refused" }[] };
type UpgradeControls = { handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void; armNextUpgrade: () => string;
  readPendingUpgrade: (id: string) => { id: string; method: "GET"; route: "ws_upgrade"; arrival: number } | null;
  readUpgradeObservation: () => UpgradeObservation; close: () => Promise<void> };
function upgradeControls(): UpgradeControls {
  assert.ok(upgradeModule && typeof upgradeModule === "object");
  const factory: unknown = Reflect.get(upgradeModule, "createFeishuUpgradeControls"); assert.equal(typeof factory, "function");
  return (factory as (server: { handleUpgrade: () => never }) => UpgradeControls)({ handleUpgrade() { assert.fail("held upgrade must not accept101"); } });
}
class UpgradeWire extends Duplex {
  destroyRequested = false; completeDestroy: (() => void) | undefined; writes = 0; closing: Promise<void> | undefined;
  constructor() { super({ autoDestroy: false, allowHalfOpen: true }); }
  _read() {}
  _write(_chunk: Buffer, _encoding: string, callback: () => void) { this.writes++; callback(); }
  _destroy(_error: Error | null, callback: () => void) { this.destroyRequested = true; this.completeDestroy = callback; }
  settleClose() { return this.closing ??= (async () => { if (this.closed) return; this.destroy(); this.completeDestroy!(); await setImmediate(); })(); }
}
const upgradeMode = "ws-upgrade-normal-close";
function upgradeComponent(options: { noArrival?: boolean; stale?: boolean; neverRemote?: boolean; endOnly?: boolean; delayedCreation?: boolean;
  rejectedClose?: boolean; nonmemoized?: boolean; lateBegin?: number } = {}) {
  const p = upgradeControls(), id = p.armNextUpgrade(), wire = new UpgradeWire();
  let completeCreation: (() => void) | undefined;
  class InMemoryAgent extends HttpAgent {
    override createConnection(_options: ClientRequestArgs, callback?: (error: Error | null, stream: Duplex) => void): Duplex | undefined {
      if (options.delayedCreation) { completeCreation = () => callback?.(null, wire); return undefined; }
      return wire;
    }
  }
  const socketOwner = createFeishuSocketOwner(InMemoryAgent);
  const message = new IncomingMessage(wire as unknown as Socket); message.method = "GET"; message.url = "/ws?private-upgrade-query";
  message.headers = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
  let ordinal = 0, owners = 0, handles = 0, lifecycleSettled = false, cleanup = false, peerOrdinal = 0, ownerOrdinal = 0;
  let requestedOrdinal = 0, first: Promise<void>, second: Promise<void>, closePromise: Promise<void> | undefined, beginPromise: Promise<void> | undefined;
  const log: { ordinal: number; code: string }[] = [], requests: { method: string; route: string; status: number }[] = [];
  const calls = { selected: 0, normal: 0, cancel: 0, finish: 0 }, mark = (code: string) => { const n = ++ordinal; if (!code.startsWith("test_")) log.push({ ordinal: n, code }); return n; };
  function snapshot() {
    return { holdId: id, hold: null as { id: string; method: string; route: string } | null, upgradeHold: p.readPendingUpgrade(id), upgrade: p.readUpgradeObservation(),
      admittedOwnerCount: owners, handleCount: handles, elapsedMs: 10, lifecycleSettled, httpActive: 0,
      httpSockets: { active: 0, pending: 0 }, connectionSockets: { active: socketOwner.activeCount, pending: socketOwner.pendingCount },
      peer: { connections: 0, ackCount: 0, legacyAckCount: 0, messageCount: 0, invalid: false, overflow: false },
      requests: requests.map(row => ({ ...row })), lifecycle: log.map(row => ({ ...row })), invalidObservation: false, historyOverflow: false,
      fixtureCleanupStarted: cleanup, peerCloseOrdinal: peerOrdinal, ownerCloseOrdinal: ownerOrdinal };
  }
  const app = { close() {
    calls.normal++;
    const make = async () => {
      socketOwner.fence(); const closing = socketOwner.close(100);
      if (!options.neverRemote && !options.endOnly) { await setImmediate(); await wire.settleClose(); }
      if (options.endOnly) { wire.push(null); await setImmediate(); }
      const clean = await closing; if (!clean) throw new Error("pending_startup_socket_close_failed");
      lifecycleSettled = true; for (const code of shutdownCodes) mark(code);
      if (options.rejectedClose) throw new Error("private-upgrade-close-secret");
    };
    if (options.nonmemoized) { const pending = make(); pending.catch(() => {}); return pending; }
    return closePromise ??= make();
  } };
  const effects = {
    begin(signal: AbortSignal) {
      return beginPromise = (async () => {
      if (options.lateBegin) await delay(options.lateBegin);
      owners = handles = 1; for (const code of ["composition_lock_verified", "composition_store_opened", "maintenance_started"]) mark(code);
      requests.push({ method: "POST", route: "ws_endpoint", status: 200 }); socketOwner.agent.createConnection({});
      if (!options.noArrival) p.handler(message, wire, Buffer.alloc(0)); if (signal.aborted) app.close().catch(() => {});
      })();
    },
    readPending: snapshot,
    closeWhileHeld(expected: ReturnType<typeof snapshot>) {
      if (options.stale) wire.emit("close");
      const value = api("closeHeldStartup")(expected, effects.readPending, app, () => requestedOrdinal = mark("test_close_requested"), upgradeMode);
      calls.selected++; first = value.first; second = value.second; return value;
    },
    async settleBeforeFixtureCleanup() {
      const statuses = await Promise.allSettled([first, second]), settledOrdinal = mark("test_public_close_settled");
      const before = snapshot(), third = app.close(); const thirdStatus = await Promise.allSettled([third]);
      return { snapshot: before, composition: { status: "composition_closed", clean: false }, close: { requestedOrdinal, settledOrdinal,
        firstFulfilled: statuses[0]!.status === "fulfilled", secondFulfilled: statuses[1]!.status === "fulfilled", promiseSame: first === second,
        thirdFulfilled: thirdStatus[0]!.status === "fulfilled", thirdPromiseSame: first === third, repeatUnchanged: JSON.stringify(before) === JSON.stringify(snapshot()) } };
    },
    async finish() {
      calls.finish++; await beginPromise; completeCreation?.(); await wire.settleClose(); await closePromise?.catch(() => {});
      cleanup = true; await p.close(); peerOrdinal = mark("test_peer_settled");
      const admittedReturnOrdinal = mark("test_admitted_return"), ownerCloseBeginOrdinal = mark("test_owner_close_begin"); ownerOrdinal = mark("test_owner_close_end");
      return { snapshot: snapshot(), composition: { status: "composition_closed", clean: false }, standaloneExit: 70,
        peerSettledOrdinal: peerOrdinal, admittedReturnOrdinal, ownerCloseBeginOrdinal, ownerCloseEndOrdinal: ownerOrdinal, cleanupFailures: [] as string[],
        emptyState: { identity: { dev: 1, ino: 2, size: 4096, uid: 501, mode: 384 }, counts: Object.fromEntries(tables.map(table => [table, 0])) },
        files: { recordings: 0, outbox: 0, receipts: 0, runtimePids: false, launcherLog: false, key: false, bridgeState: false }, liveCount: 0, outcomeCount: 0,
        diagnostics: [{ channel: "stderr", code: "composition_closed" }] };
    },
    cancel() { calls.cancel++; if (handles) app.close().catch(() => {}); },
  };
  return { p, id, wire, socketOwner, app, effects, snapshot, calls, completeCreation() { completeCreation?.(); }, async dispose() { await wire.settleClose(); await p.close(); } };
}
// Catch endpoint-only selection, hidden owner counts, or fixture-first cancellation.
test("upgrade shared controller uses actual Agent and U1 close events before fixture disposal", async () => {
  const c = upgradeComponent();
  try {
    const r = await api("runPendingStartupPhase")(c.effects, budgets, upgradeMode);
    assert.equal(r.success, true); assert.deepEqual(r.failures, []); assert.equal(r.label, "component-facts");
    assert.equal(r.mode, upgradeMode); assert.equal(r.schema, "meeting-pending-upgrade-evidence/v1");
    assert.deepEqual(r.heldSnapshot.connectionSockets, { active: 1, pending: 0 }); assert.equal(r.heldSnapshot.httpActive, 0);
    assert.deepEqual(r.heldSnapshot.requests, [{ method: "POST", route: "ws_endpoint", status: 200 }]);
    assert.equal(r.heldSnapshot.hold, null); assert.equal(r.heldSnapshot.upgradeHold.method, "GET"); assert.equal(c.wire.writes, 0);
    assert.deepEqual(r.cancellationSnapshot.snapshot.upgrade.events, [{ ordinal: 1, id: c.id, kind: "held" }, { ordinal: 2, id: c.id, kind: "remote_closed" }]);
    assert.equal(r.cancellationSnapshot.snapshot.upgrade.disposed, false); assert.equal(r.finalSnapshot.snapshot.upgrade.disposed, true);
    assert.deepEqual(r.finalSnapshot.composition, { status: "composition_closed", clean: false }); assert.equal(r.finalSnapshot.standaloneExit, 70);
    assert.equal(r.cleanupConfirmed, true); assert.equal(c.calls.selected, 1); assert.equal(c.calls.cancel, 0);
    assert.equal(Object.isFrozen(r), true); assert.equal(Object.isFrozen(r.heldSnapshot.upgrade.events[0]), true);
  } finally { await c.dispose(); }
});
test("real in-memory Agent destroy retains actual ownership until Duplex close", async () => {
  const c = upgradeComponent({ neverRemote: true });
  try {
    await c.effects.begin(new AbortController().signal); const pending = c.app.close(); let settled = false; pending.then(() => settled = true);
    assert.equal(c.wire.destroyRequested, true); assert.equal(c.socketOwner.activeCount, 1); assert.equal(c.socketOwner.pendingCount, 0);
    assert.equal(c.p.readUpgradeObservation().pending, 1); assert.equal(c.p.readPendingUpgrade(c.id)?.arrival, 1);
    c.wire.emit("end"); await setImmediate(); assert.equal(settled, false); assert.equal(c.socketOwner.activeCount, 1);
    await c.wire.settleClose(); await pending; assert.equal(c.socketOwner.activeCount, 0); assert.equal(c.p.readUpgradeObservation().events[1]?.kind, "remote_closed");
  } finally { await c.dispose(); }
});
for (const [name, options] of [["arm only", { noArrival: true }], ["cleared at synchronous recheck", { stale: true }], ["pending socket creation", { delayedCreation: true }], ["remote FIN alone", { endOnly: true }], ["absent remote close", { neverRemote: true }], ["rejected public close", { rejectedClose: true }], ["nonmemoized public close", { nonmemoized: true }]] as const)
  test(`upgrade ${name} cannot pass and ordinary cleanup remains owned`, async () => {
    const c = upgradeComponent(options); try { const r = await api("runPendingStartupPhase")(c.effects, { ...budgets, cleanupMs: 15 }, upgradeMode);
      assert.equal(r.success, false); assert.equal(c.calls.cancel, 1); assert.equal(c.calls.finish, 1); assert.equal(JSON.stringify(r).includes("private-upgrade"), false);
    } finally { await c.dispose(); }
  });
type UpgradeSnapshot = ReturnType<ReturnType<typeof upgradeComponent>["snapshot"]>;
const upgradePendingChanges: [string, (v: UpgradeSnapshot) => void][] = [
  ["endpoint alone", v => { v.upgradeHold = null; v.upgrade = { arrivals: 0, accepted: 0, pending: 0, disposed: false, invalid: false, overflow: false, events: [] }; }],
  ["HTTP hold", v => { v.hold = { id: v.holdId, method: "POST", route: "ws_endpoint" }; }],
  ["wrong selected ID", v => { v.upgradeHold!.id = "foreign"; }], ["stale arrival", v => { v.upgradeHold!.arrival = 2; }],
  ["WebSocket ownership zero", v => { v.connectionSockets.active = 0; }], ["pending socket", v => { v.connectionSockets.pending = 1; }],
  ["HTTP work active", v => { v.httpActive = 1; }], ["HTTP socket active", v => { v.httpSockets.active = 1; }], ["HTTP socket pending", v => { v.httpSockets.pending = 1; }],
  ["startup settled", v => { v.lifecycleSettled = true; }], ["false ready", v => { v.lifecycle.push({ ordinal: 99, code: "composition_started" }); }],
  ["accepted101", v => { v.upgrade.accepted = 1; }], ["extra upgrade", v => { v.upgrade.arrivals = 2; }], ["peer disposal", v => { v.upgrade.disposed = true; }],
  ["overflow", v => { v.upgrade.overflow = true; }], ["invalid", v => { v.upgrade.invalid = true; }],
  ["endpoint499", v => { v.requests[0]!.status = 499; }], ["extra endpoint", v => { v.requests.push({ method: "POST", route: "ws_endpoint", status: 200 }); }],
  ["token", v => { v.requests.push({ method: "POST", route: "tenant_access_token", status: 200 }); }],
  ["ACK", v => { v.peer.ackCount = 1; }], ["ping/message", v => { v.peer.messageCount = 1; }], ["receiver overflow", v => { v.peer.overflow = true; }],
  ["fixture started", v => { v.fixtureCleanupStarted = true; }], ["transport closed early", v => { v.upgrade.events.push({ ordinal: 2, id: v.holdId, kind: "remote_closed" }); }],
  ["too late", v => { v.elapsedMs = 4500; }], ["unbounded counter", v => { v.upgrade.pending = Infinity; }],
];
for (const [name, mutate] of upgradePendingChanges) test(`upgrade pending ${name} refuses selected success close`, async () => {
  const c = upgradeComponent(), read = c.effects.readPending; c.effects.readPending = () => { const v = structuredClone(read()); mutate(v); return v; };
  try { const r = await api("runPendingStartupPhase")(c.effects, budgets, upgradeMode); assert.equal(r.success, false); assert.equal(c.calls.selected, 0); }
  finally { await c.dispose(); }
});
type UpgradeSettlement = Awaited<ReturnType<ReturnType<typeof upgradeComponent>["effects"]["settleBeforeFixtureCleanup"]>>;
const upgradeSettlementChanges: [string, (v: UpgradeSettlement) => void][] = [
  ["fixture closed instead", v => { v.snapshot.upgrade.events[1]!.kind = "fixture_closed"; }], ["fixture disposed", v => { v.snapshot.upgrade.disposed = true; }],
  ["remote close absent", v => { v.snapshot.upgrade.events.pop(); }], ["extra upgrade", v => { v.snapshot.upgrade.arrivals = 2; }],
  ["pending upgrade", v => { v.snapshot.upgrade.pending = 1; }], ["pending client", v => { v.snapshot.connectionSockets.pending = 1; }],
  ["HTTP499", v => { v.snapshot.requests[0]!.status = 499; }], ["wrong remote ID", v => { v.snapshot.upgrade.events[1]!.id = "foreign"; }],
  ["late4500", v => { v.snapshot.elapsedMs = 4500; }], ["store log absent", v => { v.snapshot.lifecycle = v.snapshot.lifecycle.filter(row => row.code !== "shutdown_store_closed"); }],
  ["clean rewritten", v => { v.composition.clean = true; }], ["fixture first", v => { v.snapshot.fixtureCleanupStarted = true; }],
  ["third identity", v => { v.close.thirdPromiseSame = false; }], ["third mutation", v => { v.close.repeatUnchanged = false; }],
];
for (const [name, mutate] of upgradeSettlementChanges) test(`upgrade settlement ${name} remains failed after fallback cleanup`, async () => {
  const c = upgradeComponent(), settle = c.effects.settleBeforeFixtureCleanup; c.effects.settleBeforeFixtureCleanup = async () => { const v = structuredClone(await settle()); mutate(v); return v; };
  try { const r = await api("runPendingStartupPhase")(c.effects, budgets, upgradeMode); assert.equal(r.success, false); assert.equal(c.calls.finish, 1); assert.equal(r.cleanupConfirmed, false); }
  finally { await c.dispose(); }
});
type UpgradeFinal = Awaited<ReturnType<ReturnType<typeof upgradeComponent>["effects"]["finish"]>>;
const upgradeFinalChanges: [string, (v: UpgradeFinal) => void][] = [
  ["standalone zero", v => { v.standaloneExit = 0; }], ["owner first", v => { v.ownerCloseBeginOrdinal = 1; }],
  ["peer failure", v => { v.cleanupFailures.push("pending_startup_peer_close_failed"); }], ["not disposed", v => { v.snapshot.upgrade.disposed = false; }],
  ["late invalid", v => { v.snapshot.upgrade.invalid = true; }], ["late pending", v => { v.snapshot.upgrade.pending = 1; }],
  ["changed terminal history", v => { v.snapshot.upgrade.events[1]!.ordinal = 3; }], ["nonempty DB", v => { v.emptyState.counts.sessions = 1; }],
  ["launch file", v => { v.files.launcherLog = true; }], ["new ACK", v => { v.snapshot.peer.ackCount = 1; }],
];
for (const [name, mutate] of upgradeFinalChanges) test(`upgrade final ${name} cannot certify cleanup`, async () => {
  const c = upgradeComponent(), finish = c.effects.finish; c.effects.finish = async () => { const v = structuredClone(await finish()); mutate(v); return v; };
  try { const r = await api("runPendingStartupPhase")(c.effects, budgets, upgradeMode); assert.equal(r.success, false); assert.equal(r.cleanupConfirmed, false); }
  finally { await c.dispose(); }
});
for (const phase of ["begin", "closeWhileHeld", "settleBeforeFixtureCleanup"] as const) test(`upgrade synchronous ${phase} overrun cannot pass before timer dispatch`, async () => {
  const c = upgradeComponent();
  if (phase === "begin") { const begin = c.effects.begin; c.effects.begin = signal => { blockFor(20); return begin(signal); }; }
  else if (phase === "closeWhileHeld") { const close = c.effects.closeWhileHeld; c.effects.closeWhileHeld = expected => { blockFor(20); return close(expected); }; }
  else { const settle = c.effects.settleBeforeFixtureCleanup; c.effects.settleBeforeFixtureCleanup = async () => { const v = await settle(); blockFor(20); return v; }; }
  try { const r = await api("runPendingStartupPhase")(c.effects, { ...budgets, admissionMs: 5, cleanupMs: 5 }, upgradeMode);
    assert.equal(r.success, false); assert.equal(c.calls.cancel, 1); assert.equal(c.calls.finish, 1); assert.equal(r.cleanupConfirmed, false);
  } finally { await c.dispose(); }
});
test("upgrade selection and artifact validation are strict, finite and getter-free", async () => {
  const root = mkdtempSync("/private/tmp/pending-upgrade-output-"); chmodSync(root, 0o700); const c = upgradeComponent();
  try {
    const out = path.join(root, "new"); assert.deepEqual(api("parsePendingStartupArguments")(["--mode", upgradeMode, "--out", out]), { out, mode: upgradeMode });
    for (const argv of [["--mode", "unknown", "--out", out], ["--mode", "ws-endpoint-normal-close", "--out", out], ["--out", out, "--mode", upgradeMode], ["--mode", upgradeMode, "--out", out, "--mode", upgradeMode]]) assert.throws(() => api("parsePendingStartupArguments")(argv));
    await assert.rejects(api("runPendingStartupPhase")(c.effects, budgets, "unknown"), /pending_startup_fact_invalid/); assert.equal(c.calls.normal, 0);
    const r = await api("runPendingStartupPhase")(c.effects, budgets, upgradeMode); assert.equal(r.success, true);
    let touched = 0;
    for (const kind of ["mode", "schema", "missing pre-fixture", "unknown key", "getters", "overlarge events", "counter overflow", "private failure"]) {
      const v = structuredClone(r);
      if (kind === "mode") v.mode = "unknown"; else if (kind === "schema") v.schema = "meeting-pending-startup-evidence/v1";
      else if (kind === "missing pre-fixture") v.cancellationSnapshot = null; else if (kind === "unknown key") v.heldSnapshot.upgrade.secret = "private-secret";
      else if (kind === "getters") Object.defineProperty(v.heldSnapshot.upgrade, "pending", { enumerable: true, get() { touched++; return 0; } });
      else if (kind === "overlarge events") v.heldSnapshot.upgrade.events = Array.from({ length: 17 }, () => ({ ordinal: 1, id: c.id, kind: "held" }));
      else if (kind === "counter overflow") v.heldSnapshot.upgrade.arrivals = Number.MAX_SAFE_INTEGER + 1;
      else v.failures = ["private-secret-token"];
      assert.throws(() => api("writePendingStartupEvidence")(root, v), /pending_startup_/);
    }
    assert.equal(touched, 0); api("writePendingStartupEvidence")(root, r); assert.deepEqual(JSON.parse(readFileSync(path.join(root, "evidence.json"), "utf8")), r);
    assert.equal(JSON.stringify(r).includes("private-upgrade-query"), false); assert.equal(JSON.stringify(r).includes("dGhlIHNh"), false);
  } finally { await c.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("upgrade endpoint discovery can settle across polls without resetting the shared allowance", async () => {
  const c = upgradeComponent(), read = c.effects.readPending, allowance = { remaining: 250 }; let reads = 0;
  c.effects.readPending = () => {
    const v = structuredClone(read());
    if (++reads <= 2) { v.upgradeHold = null; v.upgrade = { arrivals: 0, accepted: 0, pending: 0, disposed: false, invalid: false, overflow: false, events: [] }; v.connectionSockets.active = 0;
      if (reads === 1) { v.httpActive = 1; v.httpSockets.active = 1; v.requests = []; } }
    return v;
  };
  try { const r = await api("runPendingStartupPhase")(c.effects, { ...budgets, pollAllowance: allowance }, upgradeMode); assert.equal(r.success, true); assert.equal(allowance.remaining, 247); }
  finally { await c.dispose(); }
});
test("upgrade blocking pending read cannot refresh a phase deadline", async () => {
  const c = upgradeComponent(), read = c.effects.readPending;
  c.effects.readPending = () => { blockFor(20); return read(); };
  try { const r = await api("runPendingStartupPhase")(c.effects, { ...budgets, pendingMs: 5 }, upgradeMode); assert.equal(r.success, false); assert.equal(c.calls.selected, 0); assert.equal(r.failures[0], "pending_startup_pending_timeout"); }
  finally { await c.dispose(); }
});
test("upgrade late pre-start handle is normally closed while admission failure remains sticky", async () => {
  const c = upgradeComponent({ lateBegin: 15 });
  try { const r = await api("runPendingStartupPhase")(c.effects, { ...budgets, admissionMs: 2 }, upgradeMode);
    assert.equal(r.success, false); assert.equal(r.failures[0], "pending_startup_admission_timeout"); assert.equal(c.calls.selected, 0); assert.ok(c.calls.normal > 0);
    assert.ok(c.snapshot().ownerCloseOrdinal > c.snapshot().peerCloseOrdinal); assert.equal(r.cleanupConfirmed, false);
  } finally { await c.dispose(); }
});
test("delayed real Agent creation remains fenced and owned until late Duplex close", async () => {
  const c = upgradeComponent({ delayedCreation: true, neverRemote: true });
  try {
    await c.effects.begin(new AbortController().signal); assert.equal(c.socketOwner.pendingCount, 1); assert.equal(c.socketOwner.activeCount, 0);
    const pending = c.app.close(); let settled = false; pending.then(() => settled = true);
    c.completeCreation(); assert.equal(c.socketOwner.pendingCount, 0); assert.equal(c.socketOwner.activeCount, 1); assert.equal(c.wire.destroyRequested, true);
    await setImmediate(); assert.equal(settled, false); assert.equal(c.p.readUpgradeObservation().pending, 1);
    await c.wire.settleClose(); await pending; assert.equal(c.socketOwner.activeCount, 0); assert.equal(c.p.readUpgradeObservation().events[1]?.kind, "remote_closed");
  } finally { await c.dispose(); }
});
test("upgrade deferred final cleanup retains owner lifetime after observation expires", async () => {
  const c = upgradeComponent(), finish = c.effects.finish; let late: ReturnType<typeof finish> | undefined;
  c.effects.finish = () => late = delay(25).then(finish);
  try { const r = await api("runPendingStartupPhase")(c.effects, { ...budgets, cleanupMs: 5 }, upgradeMode);
    assert.equal(r.success, false); assert.equal(r.cleanupConfirmed, false); assert.equal(r.finalSnapshot, null); assert.equal(c.snapshot().ownerCloseOrdinal, 0);
    const failures = [...r.failures], actual = await late!; assert.ok(actual.ownerCloseEndOrdinal > actual.peerSettledOrdinal); assert.equal(actual.standaloneExit, 70); assert.equal(actual.composition.clean, false);
    assert.deepEqual(r.failures, failures); assert.equal(r.cleanupConfirmed, false);
  } finally { await c.dispose(); }
});
test("upgrade shared snapshot capture is exact and recursively immutable without reading getters", async () => {
  const c = upgradeComponent();
  try {
    await c.effects.begin(new AbortController().signal); const value = c.snapshot(), captured = api("capturePendingStartupSnapshot")(value, upgradeMode);
    assert.equal(Object.isFrozen(captured), true); assert.equal(Object.isFrozen(captured.requests), true); assert.equal(Object.isFrozen(captured.upgradeHold), true);
    assert.throws(() => captured.requests.push({ method: "POST", route: "tenant_access_token", status: 200 }));
    let touched = 0; Object.defineProperty(value, "upgrade", { enumerable: true, get() { touched++; throw new Error("private-query"); } });
    assert.throws(() => api("capturePendingStartupSnapshot")(value, upgradeMode), /pending_startup_fact_invalid/); assert.equal(touched, 0);
  } finally { await c.dispose(); }
});

test("actual U1 overflow keeps cleanup unconfirmed after all test wires later close", async () => {
  const c = upgradeComponent(), extra = Array.from({ length: 4 }, () => new UpgradeWire()), begin = c.effects.begin;
  c.effects.begin = async signal => { await begin(signal); for (const wire of extra) {
    const request = new IncomingMessage(wire as unknown as Socket); request.method = "POST"; request.url = "/invalid";
    c.p.handler(request, wire, Buffer.alloc(0));
  } };
  try {
    const r = await api("runPendingStartupPhase")(c.effects, { ...budgets, cleanupMs: 5 }, upgradeMode);
    assert.equal(r.success, false); assert.equal(r.cleanupConfirmed, false); assert.equal(r.finalSnapshot, null); assert.equal(c.calls.selected, 0);
    assert.equal(r.failureSnapshot.upgrade.invalid, true); assert.equal(r.failureSnapshot.upgrade.overflow, true);
    for (const wire of extra) await wire.settleClose(); await c.wire.settleClose();
    assert.equal(c.p.readUpgradeObservation().pending, 1); assert.equal(c.snapshot().ownerCloseOrdinal, 0); assert.equal(r.cleanupConfirmed, false);
  } finally { for (const wire of extra) await wire.settleClose(); await c.wire.settleClose(); /* Deliberately unconfirmed U1 promise stays retained. */ }
});
test("actual U1 late disposed callback cannot reuse historical cleanup fulfillment", async () => {
  const c = upgradeComponent(), late = new UpgradeWire(), finish = c.effects.finish;
  c.effects.finish = async () => {
    const value = await finish(), request = new IncomingMessage(late as unknown as Socket); request.method = "POST"; request.url = "/invalid";
    c.p.handler(request, late, Buffer.alloc(0)); value.snapshot = c.snapshot(); return value;
  };
  try { const r = await api("runPendingStartupPhase")(c.effects, budgets, upgradeMode);
    assert.equal(r.success, false); assert.equal(r.cleanupConfirmed, false); assert.equal(r.finalSnapshot.snapshot.upgrade.invalid, true);
    assert.equal(r.finalSnapshot.snapshot.upgrade.pending, 1); assert.equal(late.destroyRequested, true);
  } finally { await late.settleClose(); await c.dispose(); }
});

// Catch writer validation invoking inherited serialization or failure methods.
for (const mode of ["ws-endpoint-normal-close", upgradeMode]) test(`writer ${mode} rejects a nonprimitive failure without invoking methods`, () => {
  const out = mkdtempSync("/private/tmp/pending-writer-primitive-"); chmodSync(out, 0o700); let calls = 0;
  const value = { schema: mode === upgradeMode ? "meeting-pending-upgrade-evidence/v1" : "meeting-pending-startup-evidence/v1", label: "component-facts", mode, success: false,
    failures: [{ slice() { calls++; return "phase_failed"; }, startsWith() { calls++; return true; }, toJSON() { calls++; return "private-output-sentinel"; } }],
    heldSnapshot: null, cancellationSnapshot: null, finalSnapshot: null, failureSnapshot: null, cleanupConfirmed: false };
  try {
    let rejected = false; try { api("writePendingStartupEvidence")(out, value); } catch { rejected = true; }
    assert.equal(calls, 0); assert.equal(rejected, true); assert.deepEqual(readdirSync(out), []);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
for (const location of ["failures", "events", "lifecycle", "requests"]) test(`upgrade writer rejects inherited ${location} serialization without reading it`, async () => {
  const c = upgradeComponent(), out = mkdtempSync("/private/tmp/pending-writer-array-"); chmodSync(out, 0o700); let calls = 0;
  try {
    const result = structuredClone(await api("runPendingStartupPhase")(c.effects, budgets, upgradeMode)); assert.equal(result.success, true);
    result.success = false; result.failures = ["pending_startup_phase_failed"];
    const array = location === "failures" ? result.failures : location === "events" ? result.heldSnapshot.upgrade.events : result.heldSnapshot[location];
    const prototype = Object.create(Array.prototype); Object.defineProperty(prototype, "toJSON", { get() { calls++; return () => ["private-output-sentinel"]; } });
    Object.setPrototypeOf(array, prototype);
    let rejected = false; try { api("writePendingStartupEvidence")(out, result); } catch { rejected = true; }
    assert.equal(calls, 0); assert.equal(rejected, true); assert.deepEqual(readdirSync(out), []);
  } finally { await c.dispose(); rmSync(out, { recursive: true, force: true }); }
});

// Keep cancellation/final histories coherent so these guard failures cannot be
// attributed to a later cross-history mismatch instead of the selected predicate.
for (const violation of ["fixture_closed", "endpoint499"] as const) test(`coherent upgrade ${violation} histories still reject the selected cancellation`, async () => {
  const c = upgradeComponent(), settle = c.effects.settleBeforeFixtureCleanup, finish = c.effects.finish;
  const change = (snapshot: UpgradeSnapshot) => {
    if (violation === "fixture_closed") snapshot.upgrade.events[1]!.kind = "fixture_closed";
    else snapshot.requests[0]!.status = 499;
  };
  c.effects.settleBeforeFixtureCleanup = async () => { const value = structuredClone(await settle()); change(value.snapshot); return value; };
  c.effects.finish = async () => { const value = structuredClone(await finish()); change(value.snapshot); return value; };
  try { const result = await api("runPendingStartupPhase")(c.effects, budgets, upgradeMode);
    assert.equal(result.success, false); assert.equal(result.failures[0], "pending_startup_settlement_invalid"); assert.equal(result.cleanupConfirmed, false);
    assert.deepEqual(result.cancellationSnapshot.snapshot.requests, result.finalSnapshot.snapshot.requests);
    assert.deepEqual(result.cancellationSnapshot.snapshot.upgrade.events, result.finalSnapshot.snapshot.upgrade.events);
  } finally { await c.dispose(); }
});

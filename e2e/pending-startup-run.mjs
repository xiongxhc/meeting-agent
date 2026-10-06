// Private normal-close startup controller. Importing it opens no database,
// listener, application, SDK, native helper or stage.
import { Buffer } from "node:buffer";
import Database from "better-sqlite3";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const MODE = "ws-endpoint-normal-close";
const TABLES = ["feishu_invite_occurrences", "feishu_invite_events", "sessions", "bridge_leases", "physical_client_custody", "reconciliation_generations", "recordings", "bridge_failure_recordings", "recording_recovery_bindings", "unknown_end_custody", "backfill_seeds", "delivery_journal", "notification_intents"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE", "OTHER"];
const ROUTES = ["tenant_access_token", "ws_endpoint", "reserve_active_meeting", "reserve_get", "contact_user_get", "im_message", "unmatched"];
const SHUTDOWN = ["shutdown_fenced", "maintenance_fenced", "maintenance_closed", "shutdown_owned_work_settled", "shutdown_application_closed", "shutdown_runtime_owners_closed", "shutdown_transports_closed", "shutdown_store_closed"];
const LOG_CODES = new Set(["composition_lock_verified", "composition_store_opened", "maintenance_started", "composition_started", "discovery_tick", "invite_committed", "occurrence_launched", ...SHUTDOWN,
  "feishu_sdk_error", "feishu_sdk_warning", "feishu_sdk_info", "feishu_sdk_debug", "feishu_sdk_trace"]);
const REASONS = new Set(["fact_invalid", "effects_invalid", "budget_invalid", "admission_timeout", "admission_refused", "pending_timeout", "cancel_boundary_unconfirmed", "held_unconfirmed", "public_close_failed", "close_identity", "phase_failed", "cleanup_unconfirmed", "cancel_failed", "settlement_invalid", "cleanup_invalid", "empty_state_invalid", "receiver_invalid", "history_changed", "failure_overflow", "diagnostic_invalid", "argument", "output_path", "output_extent", "environment_refused", "plan_invalid", "http_close_failed", "socket_close_failed", "peer_close_failed", "reader_arguments", "reader_path", "reader_private", "reader_WAL", "reader_header", "reader_identity", "reader_schema29", "reader_nonempty", "reader_failed", "files_invalid"]);
export function requireStartup(value, reason) { if (!value) throw new Error(`pending_startup_${reason}`); }
function safeFailure(error) {
  let value; try { value = Object.getOwnPropertyDescriptor(error ?? {}, "message")?.value; } catch { /* Never invoke exception getters. */ }
  return typeof value === "string" && REASONS.has(value.slice(16)) && value.startsWith("pending_startup_") ? value : "pending_startup_phase_failed";
}
function integer(value, maximum = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
function record(value, keys) {
  requireStartup(value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length, "fact_invalid");
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); requireStartup(d && Object.hasOwn(d, "value") && d.enumerable, "fact_invalid"); }
}
function array(value, maximum) {
  requireStartup(Array.isArray(value) && value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1, "fact_invalid");
  for (let at = 0; at < value.length; at++) requireStartup(Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(at)) ?? {}, "value"), "fact_invalid");
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function composition(value) {
  if (value === null) return;
  const status = Object.getOwnPropertyDescriptor(value, "status")?.value;
  if (status === "composition_closed") { record(value, ["status", "clean"]); requireStartup(typeof value.clean === "boolean", "fact_invalid"); }
  else { record(value, ["status", "reason"]); requireStartup(value.status === "composition_unavailable" && COMPOSE_REASONS.has(value.reason), "fact_invalid"); }
}
function validateSnapshot(v) {
  record(v, ["holdId", "hold", "admittedOwnerCount", "handleCount", "elapsedMs", "lifecycleSettled", "httpActive", "httpSockets", "connectionSockets", "peer", "requests", "lifecycle", "invalidObservation", "historyOverflow", "fixtureCleanupStarted", "peerCloseOrdinal", "ownerCloseOrdinal"]);
  requireStartup(v.holdId === null || typeof v.holdId === "string" && v.holdId.length <= 64, "fact_invalid");
  if (v.hold !== null) { record(v.hold, ["id", "method", "route"]); requireStartup(typeof v.hold.id === "string" && v.hold.id.length <= 64 && METHODS.includes(v.hold.method) && ROUTES.slice(0, 5).includes(v.hold.route), "fact_invalid"); }
  for (const key of ["admittedOwnerCount", "handleCount", "peerCloseOrdinal", "ownerCloseOrdinal"]) requireStartup(integer(v[key], 1000000), "fact_invalid");
  requireStartup(Number.isFinite(v.elapsedMs) && v.elapsedMs >= 0 && v.elapsedMs <= 3600000 && (v.httpActive === null || integer(v.httpActive, 32)), "fact_invalid");
  for (const key of ["lifecycleSettled", "invalidObservation", "historyOverflow", "fixtureCleanupStarted"]) requireStartup(typeof v[key] === "boolean", "fact_invalid");
  for (const sockets of [v.httpSockets, v.connectionSockets]) if (sockets !== null) { record(sockets, ["active", "pending"]); requireStartup(integer(sockets.active, 32) && integer(sockets.pending, 32), "fact_invalid"); }
  if (v.peer !== null) {
    record(v.peer, ["connections", "ackCount", "legacyAckCount", "messageCount", "invalid", "overflow"]);
    for (const key of ["connections", "ackCount", "legacyAckCount", "messageCount"]) requireStartup(integer(v.peer[key], 1000000), "fact_invalid");
    requireStartup(typeof v.peer.invalid === "boolean" && typeof v.peer.overflow === "boolean", "fact_invalid");
  }
  array(v.requests, 256); for (const row of v.requests) { record(row, ["method", "route", "status"]); requireStartup(METHODS.includes(row.method) && ROUTES.includes(row.route) && integer(row.status, 599) && row.status >= 100, "fact_invalid"); }
  array(v.lifecycle, 128); let ordinal = 0;
  for (const row of v.lifecycle) { record(row, ["ordinal", "code"]); requireStartup(integer(row.ordinal, 1000000) && row.ordinal > ordinal && LOG_CODES.has(row.code), "fact_invalid"); ordinal = row.ordinal; }
  return v;
}
function peerEmpty(v) {
  requireStartup(v.peer && !v.peer.invalid && !v.peer.overflow && ["connections", "ackCount", "legacyAckCount", "messageCount"].every(key => v.peer[key] === 0) && !v.invalidObservation && !v.historyOverflow, "receiver_invalid");
  requireStartup(!v.lifecycle.some(row => ["composition_started", "discovery_tick", "invite_committed", "occurrence_launched"].includes(row.code)), "held_unconfirmed");
}
export function assertPendingStartupHeld(v) {
  validateSnapshot(v); peerEmpty(v);
  requireStartup(v.admittedOwnerCount === 1 && v.handleCount === 1 && !v.lifecycleSettled && !v.fixtureCleanupStarted && v.peerCloseOrdinal === 0 && v.ownerCloseOrdinal === 0 && v.httpActive === 1 && v.httpSockets && v.connectionSockets &&
    v.holdId !== null && v.hold?.id === v.holdId && v.hold.method === "POST" && v.hold.route === "ws_endpoint" && v.requests.length === 0, "held_unconfirmed");
  requireStartup(v.elapsedMs < 4500, "cancel_boundary_unconfirmed");
  let previous = 0;
  for (const code of ["composition_lock_verified", "composition_store_opened", "maintenance_started"]) { const rows = v.lifecycle.filter(row => row.code === code); requireStartup(rows.length === 1 && rows[0].ordinal > previous, "held_unconfirmed"); previous = rows[0].ordinal; }
}
/** One synchronous stack: final real read -> validation -> ordinal -> public closes. */
export function closeHeldStartup(expected, readPending, app, markClose) {
  assertPendingStartupHeld(expected);
  const observed = readPending(); assertPendingStartupHeld(observed);
  requireStartup(observed.holdId === expected.holdId && observed.hold.id === expected.hold.id, "held_unconfirmed");
  const requestedOrdinal = markClose(), first = app.close(); first.catch(() => {});
  const second = app.close(); second.catch(() => {});
  return { observed: copy(observed), requestedOrdinal, first, second };
}
function validateSettlement(v) {
  record(v, ["snapshot", "composition", "close"]); validateSnapshot(v.snapshot); composition(v.composition);
  record(v.close, ["requestedOrdinal", "settledOrdinal", "firstFulfilled", "secondFulfilled", "promiseSame", "thirdFulfilled", "thirdPromiseSame", "repeatUnchanged"]);
  for (const key of ["requestedOrdinal", "settledOrdinal"]) requireStartup(integer(v.close[key], 1000000), "fact_invalid");
  for (const key of ["firstFulfilled", "secondFulfilled", "promiseSame", "thirdFulfilled", "thirdPromiseSame", "repeatUnchanged"]) requireStartup(typeof v.close[key] === "boolean", "fact_invalid");
  return v;
}
function assertSettlement(v, held) {
  validateSettlement(v); const s = v.snapshot, c = v.close; peerEmpty(s);
  requireStartup(s.holdId === held.holdId && s.hold === null && s.lifecycleSettled && !s.fixtureCleanupStarted && s.peerCloseOrdinal === 0 && s.ownerCloseOrdinal === 0 && s.httpActive === 0 &&
    [s.httpSockets, s.connectionSockets].every(owner => owner?.active === 0 && owner.pending === 0), "settlement_invalid");
  requireStartup(s.requests.length === 1 && s.requests[0].method === "POST" && s.requests[0].route === "ws_endpoint" && s.requests[0].status === 499, "settlement_invalid");
  requireStartup(s.elapsedMs < 4500, "cancel_boundary_unconfirmed");
  requireStartup(c.firstFulfilled && c.secondFulfilled && c.thirdFulfilled, "public_close_failed");
  requireStartup(c.promiseSame && c.thirdPromiseSame && c.repeatUnchanged, "close_identity");
  requireStartup(v.composition?.status === "composition_closed" && v.composition.clean === false, "settlement_invalid");
  requireStartup(c.requestedOrdinal > (held.lifecycle.at(-1)?.ordinal ?? 0), "settlement_invalid");
  let previous = c.requestedOrdinal;
  for (const code of SHUTDOWN) { const rows = s.lifecycle.filter(row => row.code === code); requireStartup(rows.length === 1 && rows[0].ordinal > previous, "settlement_invalid"); previous = rows[0].ordinal; }
  requireStartup(c.settledOrdinal > previous, "settlement_invalid");
}
function validateEmptyState(v) {
  record(v, ["identity", "counts"]); record(v.identity, ["dev", "ino", "size", "uid", "mode"]);
  for (const key of ["dev", "ino", "size", "uid", "mode"]) requireStartup(integer(v.identity[key]), "fact_invalid");
  requireStartup(v.identity.size <= 8388608 && v.identity.mode <= 511, "fact_invalid"); record(v.counts, TABLES);
  for (const count of Object.values(v.counts)) requireStartup(integer(count), "fact_invalid");
}
function validateFinal(v) {
  record(v, ["snapshot", "composition", "standaloneExit", "peerSettledOrdinal", "admittedReturnOrdinal", "ownerCloseBeginOrdinal", "ownerCloseEndOrdinal", "cleanupFailures", "emptyState", "files", "liveCount", "outcomeCount", "diagnostics"]);
  validateSnapshot(v.snapshot); composition(v.composition);
  requireStartup(v.standaloneExit === null || [0, 64, 65, 70, 75].includes(v.standaloneExit), "fact_invalid");
  for (const key of ["peerSettledOrdinal", "admittedReturnOrdinal", "ownerCloseBeginOrdinal", "ownerCloseEndOrdinal", "liveCount", "outcomeCount"]) requireStartup(integer(v[key], 1000000), "fact_invalid");
  array(v.cleanupFailures, 8); for (const code of v.cleanupFailures) requireStartup(["pending_startup_http_close_failed", "pending_startup_socket_close_failed", "pending_startup_peer_close_failed", "pending_startup_reader_failed", "pending_startup_files_invalid"].includes(code), "fact_invalid");
  if (v.emptyState !== null) validateEmptyState(v.emptyState);
  if (v.files !== null) { record(v.files, ["recordings", "outbox", "receipts", "runtimePids", "launcherLog", "key", "bridgeState"]); for (const key of ["recordings", "outbox", "receipts"]) requireStartup(integer(v.files[key], 1024), "fact_invalid"); for (const key of ["runtimePids", "launcherLog", "key", "bridgeState"]) requireStartup(typeof v.files[key] === "boolean", "fact_invalid"); }
  array(v.diagnostics, 16); for (const row of v.diagnostics) { record(row, ["channel", "code"]); requireStartup(["stdout", "stderr"].includes(row.channel) && DIAGNOSTIC_CODES.has(row.code), "fact_invalid"); }
  return v;
}
function assertFinal(v, cancelled) {
  validateFinal(v); const s = v.snapshot; peerEmpty(s);
  requireStartup(v.cleanupFailures.length === 0 && s.fixtureCleanupStarted && s.hold === null && s.httpActive === 0 && [s.httpSockets, s.connectionSockets].every(owner => owner?.active === 0 && owner.pending === 0), "cleanup_invalid");
  requireStartup(s.admittedOwnerCount === 1 && s.handleCount === 1 && s.lifecycleSettled && s.holdId === cancelled.snapshot.holdId && cancelled.close.firstFulfilled && cancelled.close.secondFulfilled && cancelled.close.thirdFulfilled && cancelled.close.promiseSame && cancelled.close.thirdPromiseSame && cancelled.close.repeatUnchanged, "cleanup_invalid");
  requireStartup(v.peerSettledOrdinal > cancelled.close.settledOrdinal && v.admittedReturnOrdinal > v.peerSettledOrdinal && v.ownerCloseBeginOrdinal > v.admittedReturnOrdinal && v.ownerCloseEndOrdinal > v.ownerCloseBeginOrdinal && s.peerCloseOrdinal === v.peerSettledOrdinal && s.ownerCloseOrdinal === v.ownerCloseEndOrdinal, "cleanup_invalid");
  requireStartup(JSON.stringify(s.requests) === JSON.stringify(cancelled.snapshot.requests) && JSON.stringify(s.lifecycle) === JSON.stringify(cancelled.snapshot.lifecycle), "history_changed");
  requireStartup(v.composition?.status === "composition_closed" && v.composition.clean === false && v.standaloneExit === 70, "cleanup_invalid");
  requireStartup(v.emptyState && Object.values(v.emptyState.counts).every(count => count === 0) && v.liveCount === 0 && v.outcomeCount === 0 && v.files && Object.values(v.files).every(value => value === 0 || value === false), "empty_state_invalid");
  requireStartup(v.diagnostics.length === 1 && v.diagnostics[0].channel === "stderr" && v.diagnostics[0].code === "composition_closed", "diagnostic_invalid");
}

export async function runPendingStartupPhase(effects, budgets = {}) {
  record(effects, ["begin", "readPending", "closeWhileHeld", "settleBeforeFixtureCleanup", "finish", "cancel"]);
  requireStartup(Object.values(effects).every(value => typeof value === "function"), "effects_invalid");
  record(budgets, Object.keys(budgets));
  requireStartup(Object.keys(budgets).every(key => ["label", "admissionMs", "pendingMs", "cleanupMs", "overallMs", "pollMs", "pollAllowance"].includes(key)), "budget_invalid");
  const pollAllowance = budgets.pollAllowance ?? { remaining: 250 }; record(pollAllowance, ["remaining"]);
  requireStartup(pollAllowance.remaining === 250 && Object.getOwnPropertyDescriptor(pollAllowance, "remaining").writable, "budget_invalid");
  const budgetValues = Object.fromEntries(Object.entries(budgets).filter(([key]) => key !== "pollAllowance"));
  const limits = { label: "component-facts", admissionMs: 15000, pendingMs: 2500, cleanupMs: 15000, overallMs: 35000, pollMs: 10, ...budgetValues };
  record(limits, ["label", "admissionMs", "pendingMs", "cleanupMs", "overallMs", "pollMs"]);
  requireStartup(["component-facts", "attempted-application"].includes(limits.label), "budget_invalid");
  for (const [key, maximum] of [["admissionMs", 15000], ["pendingMs", 2500], ["cleanupMs", 15000], ["overallMs", 35000], ["pollMs", 10]]) requireStartup(integer(limits[key], maximum) && limits[key] > 0, "budget_invalid");
  const controller = new globalThis.AbortController(), failures = [], overallDeadline = performance.now() + limits.overallMs;
  let heldSnapshot = null, cancellationSnapshot = null, finalSnapshot = null, failureSnapshot = null, cleanupConfirmed = false;
  const failed = error => { const code = safeFailure(error); if (!failures.includes(code)) { if (failures.length < 12) failures.push(code); else failures[11] = "pending_startup_failure_overflow"; } };
  const bounded = async (effect, ms, reason, phaseDeadline = Infinity) => {
    const deadline = Math.min(performance.now() + ms, overallDeadline, phaseDeadline); let timer;
    const timeout = new Promise((_, reject) => { timer = globalThis.setTimeout(() => reject(new Error(`pending_startup_${reason}`)), Math.max(0, deadline - performance.now())); });
    try {
      // Invoke even expired final cleanup; deadlines bound observation, not ownership.
      const promise = Promise.resolve(effect()); promise.catch(() => {});
      const value = await Promise.race([promise, timeout]); requireStartup(performance.now() < deadline, reason); return value;
    } catch (error) { requireStartup(performance.now() < deadline, reason); throw error; }
    finally { globalThis.clearTimeout(timer); }
  };
  try {
    await bounded(() => effects.begin(controller.signal), limits.admissionMs, "admission_timeout");
    const pendingDeadline = Math.min(performance.now() + limits.pendingMs, overallDeadline);
    for (let at = 0; at < 250 && pollAllowance.remaining > 0; at++) {
      pollAllowance.remaining--;
      const value = validateSnapshot(effects.readPending()); peerEmpty(value);
      requireStartup(value.admittedOwnerCount === 1 && value.handleCount === 1 && !value.lifecycleSettled && !value.fixtureCleanupStarted && value.ownerCloseOrdinal === 0 && value.peerCloseOrdinal === 0 && value.requests.length === 0, "held_unconfirmed");
      requireStartup(value.elapsedMs < limits.pendingMs && performance.now() < pendingDeadline, "pending_timeout");
      if (value.hold !== null) { assertPendingStartupHeld(value); heldSnapshot = copy(value); break; }
      await bounded(() => delay(limits.pollMs), limits.pendingMs, "pending_timeout", pendingDeadline);
    }
    requireStartup(heldSnapshot !== null && performance.now() < pendingDeadline, "pending_timeout");
    const cleanupDeadline = Math.min(performance.now() + limits.cleanupMs, overallDeadline);
    const close = effects.closeWhileHeld(heldSnapshot); record(close, ["observed", "requestedOrdinal", "first", "second"]);
    assertPendingStartupHeld(close.observed); requireStartup(close.observed.holdId === heldSnapshot.holdId && integer(close.requestedOrdinal) && close.first instanceof Promise && close.second instanceof Promise && close.first === close.second, "close_identity");
    close.first.catch(() => {}); close.second.catch(() => {});
    requireStartup(performance.now() < cleanupDeadline, "cleanup_unconfirmed");
    const settlement = await bounded(() => effects.settleBeforeFixtureCleanup(), limits.cleanupMs, "cleanup_unconfirmed", cleanupDeadline);
    validateSettlement(settlement); cancellationSnapshot = copy(settlement); assertSettlement(settlement, heldSnapshot);
    requireStartup(settlement.close.requestedOrdinal === close.requestedOrdinal, "settlement_invalid");
    requireStartup(performance.now() < cleanupDeadline, "cleanup_unconfirmed");
  } catch (error) { failed(error); }
  finally {
    if (failures.length) {
      try { failureSnapshot = copy(validateSnapshot(effects.readPending())); } catch { /* Unknown failed observation stays explicitly null. */ }
      controller.abort(); try { effects.cancel(); } catch { failed(new Error("pending_startup_cancel_failed")); }
    }
    try {
      const value = await bounded(() => effects.finish(), limits.cleanupMs, "cleanup_unconfirmed"); validateFinal(value); finalSnapshot = copy(value);
      if (cancellationSnapshot) { assertFinal(value, cancellationSnapshot); requireStartup(performance.now() < overallDeadline, "cleanup_unconfirmed"); cleanupConfirmed = true; }
      else requireStartup(false, "cleanup_unconfirmed");
    } catch (error) { failed(error); }
  }
  return { schema: "meeting-pending-startup-evidence/v1", label: limits.label, mode: MODE, success: failures.length === 0 && heldSnapshot !== null && cancellationSnapshot !== null && finalSnapshot !== null && cleanupConfirmed,
    failures, heldSnapshot, cancellationSnapshot, finalSnapshot, failureSnapshot, cleanupConfirmed };
}

export function createStartupLog() {
  const observations = []; let ordinal = 0, invalid = false, overflow = false;
  const mark = () => ++ordinal;
  return { mark, log(code) {
    if (!LOG_CODES.has(code)) { invalid = true; return; }
    if (observations.length === 128) { overflow = true; return; }
    observations.push({ ordinal: mark(), code });
  }, snapshot() { return { invalid, overflow, observations: observations.map(row => ({ ...row })) }; } };
}
const COMPOSE_REASONS = new Set(["composition_failed", "composition_aborted", "state_unavailable:Error", "private_state_unsafe", "app_secret_unreadable", "bridge_slot_invalid", "feishu_scope_invalid",
  ...["recordingsDir", "outboxDir", "receiptsDir", "teamVaultDir"].map(field => `data_path_unsafe:${field}`)]);
const DIAGNOSTIC_CODES = new Set(["composition_closed", "composition_failed", "standalone_config_admission_failed", "invocation_error",
  ...["held", "root_unsafe", "unsupported", "failed", "helper_unavailable", "cleanup_unconfirmed"].map(code => `application_owner_lock_${code}`),
  ...[...COMPOSE_REASONS].map(reason => `composition_unavailable:${reason}`)]);
const CONFIG_FIELDS = ["config", "schema", "stateRoot", "feishu", "feishu.region", "feishu.tenantKey", "feishu.appId", "feishu.appSecretFile", "agentIdentity", "agentIdentity.aliases", "dataPaths", "dataPaths.recordingsDir", "dataPaths.outboxDir", "dataPaths.receiptsDir", "dataPaths.teamVaultDir", "runtime", "runtime.launcherPath", "runtime.gatewayConfigPath", "runtime.protocolVersion", "bridgeSlots", ...Array.from({ length: 8 }, (_, i) => `bridgeSlots[${i}]`)];
for (const category of ["grammar", "reference"]) for (const field of CONFIG_FIELDS) DIAGNOSTIC_CODES.add(`standalone_config_${category}:${field}`);
export function observeStartupDiagnostic(channel, line) {
  requireStartup(["stdout", "stderr"].includes(channel) && typeof line === "string" && line.length <= 256, "diagnostic_invalid");
  let code = line.startsWith("meeting-agent: ") ? line.slice(15) : "";
  if (code === "standalone config admission failed") code = "standalone_config_admission_failed";
  else if (code === "invocation error in argv") code = "invocation_error";
  else if (code === "composition failed") code = "composition_failed";
  else if (code.startsWith("composition_unavailable ")) code = `composition_unavailable:${code.slice(24)}`;
  else { const match = /^standalone config (grammar|reference) error in (.+)$/.exec(code); if (match) code = `standalone_config_${match[1]}:${match[2]}`; }
  requireStartup(DIAGNOSTIC_CODES.has(code), "diagnostic_invalid"); return { channel, code };
}
function exists(filename) { try { lstatSync(filename); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
function canonical(filename) { return typeof filename === "string" && filename.length <= 4096 && path.isAbsolute(filename) && filename !== "/" && path.resolve(filename) === filename && [...filename].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127); }
function noLinks(filename, reason) {
  let current = path.parse(filename).root;
  for (const part of filename.slice(current.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); requireStartup(!lstatSync(current).isSymbolicLink(), reason); }
}
export function parsePendingStartupArguments(argv) {
  requireStartup(Array.isArray(argv) && argv.length === 2 && argv[0] === "--out", "argument"); const out = argv[1];
  requireStartup(canonical(out) && !exists(out), "output_path");
  try { noLinks(path.dirname(out), "output_path"); requireStartup(lstatSync(path.dirname(out)).isDirectory(), "output_path"); } catch { throw new Error("pending_startup_output_path"); }
  return { out };
}
export function assertPendingStartupEnvironment(environment) {
  requireStartup(!Object.hasOwn(environment, "E2E_RUNTIME_RECORDING_KEY") && !Object.hasOwn(environment, "E2E_PROVIDER_CREDENTIAL"), "environment_refused");
}
export function validatePendingStartupPlan(plan) {
  record(plan, ["standaloneConfigPath", "databasePath", "directories", "runtimePidsPath", "launcherLog", "keyPath"]);
  record(plan.directories, ["recordingsDir", "outboxDir", "receiptsDir", "control"]);
  for (const filename of [...Object.values(plan.directories), ...["standaloneConfigPath", "databasePath", "runtimePidsPath", "launcherLog", "keyPath"].map(key => plan[key])]) requireStartup(canonical(filename), "plan_invalid");
  return plan;
}
/** Count-only fixed SELECTs, guarded before SQLite sees a path. No writable DB. */
export function readStartupEmptyState({ databasePath }) {
  requireStartup(canonical(databasePath), "reader_arguments"); let fd, db;
  try {
    noLinks(databasePath, "reader_path"); const parent = lstatSync(path.dirname(databasePath)), file = lstatSync(databasePath);
    requireStartup(parent.isDirectory() && parent.uid === process.getuid() && (parent.mode & 0o077) === 0 && file.isFile() && file.nlink === 1 && file.uid === process.getuid() && (file.mode & 0o022) === 0 && file.size >= 100 && file.size <= 8388608, "reader_private");
    requireStartup(!exists(`${databasePath}-wal`) && !exists(`${databasePath}-shm`), "reader_WAL");
    fd = openSync(databasePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const held = fstatSync(fd), header = Buffer.alloc(100);
    requireStartup(held.isFile() && held.dev === file.dev && held.ino === file.ino && held.size === file.size && readSync(fd, header, 0, 100, 0) === 100 && header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")) && header[18] === 1 && header[19] === 1, "reader_header");
    const guard = () => {
      noLinks(databasePath, "reader_identity"); const now = lstatSync(databasePath), directory = lstatSync(path.dirname(databasePath));
      requireStartup(directory.isDirectory() && directory.dev === parent.dev && directory.ino === parent.ino && directory.uid === parent.uid && (directory.mode & 0o077) === 0 &&
        now.isFile() && now.nlink === 1 && now.uid === held.uid && (now.mode & 0o022) === 0 && now.dev === held.dev && now.ino === held.ino && now.size === held.size && now.size <= 8388608 && !exists(`${databasePath}-wal`) && !exists(`${databasePath}-shm`), "reader_identity");
    };
    guard(); db = new Database(databasePath, { readonly: true, fileMustExist: true }); guard();
    requireStartup(db.readonly && db.pragma("journal_mode", { simple: true }) !== "wal", "reader_WAL");
    const counts = db.transaction(() => {
      requireStartup(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version === 29, "reader_schema29");
      const values = {};
      for (const table of TABLES) { const count = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n; requireStartup(count === 0, "reader_nonempty"); values[table] = count; }
      return values;
    })(); guard();
    return { identity: { dev: held.dev, ino: held.ino, size: held.size, uid: held.uid, mode: held.mode & 0o777 }, counts };
  } catch (error) { const code = safeFailure(error); throw new Error(code.startsWith("pending_startup_reader_") ? code : "pending_startup_reader_failed"); }
  finally { try { db?.close(); } finally { if (fd !== undefined) closeSync(fd); } }
}
export function readStartupEmptyFiles(plan) {
  try {
    const files = {};
    for (const [key, directory] of [["recordings", plan.directories.recordingsDir], ["outbox", plan.directories.outboxDir], ["receipts", plan.directories.receiptsDir]]) {
      requireStartup(canonical(directory), "files_invalid"); noLinks(directory, "files_invalid"); const stat = lstatSync(directory);
      requireStartup(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, "files_invalid");
      const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const held = fstatSync(fd); requireStartup(held.dev === stat.dev && held.ino === stat.ino, "files_invalid");
        const reader = opendirSync(directory, { bufferSize: 1 }); try { requireStartup(reader.readSync() === null, "files_invalid"); } finally { reader.closeSync(); }
        noLinks(directory, "files_invalid"); const after = lstatSync(directory); requireStartup(after.dev === held.dev && after.ino === held.ino, "files_invalid"); files[key] = 0;
      } finally { closeSync(fd); }
    }
    for (const [key, filename] of [["runtimePids", plan.runtimePidsPath], ["launcherLog", plan.launcherLog], ["key", plan.keyPath], ["bridgeState", path.join(plan.directories.control, "state.json")]]) {
      requireStartup(canonical(filename), "files_invalid"); noLinks(path.dirname(filename), "files_invalid"); files[key] = exists(filename); requireStartup(!files[key], "files_invalid");
    }
    return files;
  } catch { throw new Error("pending_startup_files_invalid"); }
}
export function writePendingStartupEvidence(out, result) {
  record(result, ["schema", "label", "mode", "success", "failures", "heldSnapshot", "cancellationSnapshot", "finalSnapshot", "failureSnapshot", "cleanupConfirmed"]);
  requireStartup(result.schema === "meeting-pending-startup-evidence/v1" && ["component-facts", "attempted-application"].includes(result.label) && result.mode === MODE && typeof result.success === "boolean" && typeof result.cleanupConfirmed === "boolean", "fact_invalid");
  array(result.failures, 12); for (const code of result.failures) requireStartup(REASONS.has(code.slice(16)) && code.startsWith("pending_startup_"), "fact_invalid");
  for (const value of [result.heldSnapshot, result.failureSnapshot]) if (value !== null) validateSnapshot(value);
  if (result.cancellationSnapshot !== null) validateSettlement(result.cancellationSnapshot); if (result.finalSnapshot !== null) validateFinal(result.finalSnapshot);
  requireStartup(!result.success || result.failures.length === 0 && result.heldSnapshot && result.cancellationSnapshot && result.finalSnapshot && result.cleanupConfirmed, "fact_invalid");
  if (result.success) { assertPendingStartupHeld(result.heldSnapshot); assertSettlement(result.cancellationSnapshot, result.heldSnapshot); assertFinal(result.finalSnapshot, result.cancellationSnapshot); }
  const bytes = Buffer.from(JSON.stringify(result, null, 2)); requireStartup(bytes.length <= 131072, "output_extent");
  noLinks(out, "output_path"); const stat = lstatSync(out); requireStartup(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, "output_path");
  writeFileSync(path.join(out, "evidence.json"), bytes, { mode: 0o600, flag: "wx" });
}
async function realMain(argv) {
  const options = parsePendingStartupArguments(argv); assertPendingStartupEnvironment(process.env);
  const [staging, pins] = await Promise.all([import("./stage.mjs"), import("./pins.mjs")]);
  await pins.verifyPins(); mkdirSync(options.out, { mode: 0o700 });
  const staged = staging.stage({ repository: path.resolve(import.meta.dirname, "..") });
  const plan = { standaloneConfigPath: staged.standaloneConfigPath, databasePath: path.join(staged.directories.stateRoot, "orchestration.db"), directories: { recordingsDir: staged.directories.recordingsDir, outboxDir: staged.directories.outboxDir, receiptsDir: staged.directories.receiptsDir, control: staged.directories.control },
    runtimePidsPath: staged.gatewayPidsPath, launcherLog: staged.launcherLog, keyPath: staged.keyPath };
  const names = ["dist/src/main.js", "dist/src/application-composition.js", "dist/src/standalone-config.js", "dist/src/adapters/application-owner-lock.js", "dist/src/adapters/feishu-sdk-http.js", "dist/src/adapters/feishu-sdk-connection.js", "dist/src/adapters/feishu-invite-ingress.js", "e2e/pending-startup-run.mjs", "e2e/pending-startup-entry.mjs", "e2e/composition-lifecycle.mjs", "e2e/feishu-peer.mjs", "e2e/feishu-peer-controls.mjs", "e2e/stage.mjs", "e2e/pins.mjs", "node_modules/@larksuiteoapi/node-sdk/package.json", "node_modules/@larksuiteoapi/node-sdk/lib/index.js"];
  const digests = await Promise.all(names.map(async name => ({ role: name, sha256: await pins.sha256File(path.join(staged.directories.app, name)) })));
  for (const [role, filename] of [["runtime_gateway_pin", staged.gatewayPath], ["runtime_sdk_pin", staged.sdkTarball]]) digests.push({ role, sha256: await pins.sha256File(filename) });
  writeFileSync(path.join(options.out, "staged.json"), JSON.stringify({ schema: "meeting-pending-startup-stage/v1", mode: MODE, root: staged.root, digests }), { mode: 0o600, flag: "wx" });
  const entry = await import(pathToFileURL(path.join(staged.directories.app, "e2e/pending-startup-entry.mjs")).href);
  const result = await entry.runRealPendingStartup(plan); writePendingStartupEvidence(options.out, result); process.exitCode = result.success ? 0 : 70;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void realMain(process.argv.slice(2)).catch(() => { process.stderr.write("pending_startup_runner_refused\n"); process.exitCode = 70; });
}

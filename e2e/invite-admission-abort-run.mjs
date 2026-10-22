// One literal, finite transaction-abort/recovery/ordinary-reopen campaign.
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { ingressData } from "./ingress-run.mjs";
import { isAttemptedInviteAbortResult, runActualInviteAdmissionAbort } from "./invite-admission-abort-entry.mjs";
export const ABORT_DESIGN_SHA256 = "a6434c52b79b364d2a1ce03338a8ab1385617ac54b4e368435cca3d5316c4a42";
export const ABORT_DEPENDENCY_SHA256 = "0b72273f27d2268253e8f81ce442817c0b89c3fd9930e6f2ccb6b49463c71406";
const DESIGN_BASE = "c4bb36116ac5580a566f5d120ead01b580d5265f7a7d9bffbd4ec4655655d4dd";
const TABLES = ["feishu_invite_occurrences", "feishu_invite_events", "sessions", "bridge_leases", "physical_client_custody", "reconciliation_generations", "recordings", "bridge_failure_recordings", "recording_recovery_bindings", "unknown_end_custody", "backfill_seeds", "delivery_journal", "notification_intents"];
const SOURCE_KEYS = ["design", "originalDesignBase", "dependencyManifest", "entry", "runner", "fault", "reader", "emptyReader", "normalizer", "store", "migrations", "lifecycle", "owner", "http", "socket", "peer", "sdk", "sqlite", "sqliteNative", "ws", "applicationGraph", "stage", "pins", "l4Campaign", "mediaClient", "peerControls", "upgradeControls", "reservationRegistry", "processRules"];
const CLOSE_KEYS = ["owner", "firstSecondSame", "thirdSame", "fulfilled", "repeatUnchanged", "clean", "httpActive", "httpSockets", "wsSockets", "peerConnections", "preFixtureObserved", "fixtureCleanupStarted", "publicCloseOrdinal", "storeClosedOrdinal", "preFixtureOrdinal", "peerClosedOrdinal", "admittedReturnOrdinal", "ownerCloseBeginOrdinal", "ownerCloseEndOrdinal", "standaloneExit", "invalid", "overflow", "cleanupFailures"];
const DURABLE_KEYS = ["databaseIdentitySame", "immutableSame", "eventHash", "eventRows", "occurrenceRows", "acceptedAtMs", "state", "reason", "claimed", "claimExpiresAtMs", "organizerNull", "referenceNull", "admittedAtMs", "totalAttempts", "generationAttempts", "retryGeneration", "operatorRetryCount", "metadataSame", "downstreamZero", "triggerAbsent", "schemaRestored"];
const FAILURE_CODES = new Set(["invite_abort_fact", "invite_abort_sources", "invite_abort_ready", "invite_abort_empty", "invite_abort_fault", "invite_abort_delivery", "invite_abort_rollback", "invite_abort_acceptance", "invite_abort_durable", "invite_abort_close", "invite_abort_history", "invite_abort_deadline", "invite_abort_effect", "invite_abort_cleanup", "invite_abort_provenance", "invite_abort_output"]);
export const INVITE_ABORT_LIFECYCLE_CODES = Object.freeze(["owner_acquired", "composition_lock_verified", "invite_admission_no_inviters_configured", "composition_started", "composition_store_opened", "invite_committed", "invite_admission_inviter_not_allowed", "discovery_tick", "maintenance_started", "maintenance_fenced", "maintenance_closed", "shutdown_fenced", "shutdown_owned_work_settled", "shutdown_application_closed", "shutdown_runtime_owners_closed", "shutdown_transports_closed", "shutdown_store_closed", "public_close", "pre_fixture", "peer_closed", "admitted_return", "owner_close_begin", "owner_close_end", "feishu_sdk_error", "feishu_sdk_warning", "feishu_sdk_info", "feishu_sdk_debug", "feishu_sdk_trace"]);
export const requireInviteAbort = (v, reason) => { if (!v) throw new Error(`invite_abort_${reason}`); };
const integer = n => Number.isSafeInteger(n) && n >= 0;
const ordinal = n => integer(n) && n > 0;
const hash = s => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
function record(v, keys) { requireInviteAbort(v && !Array.isArray(v) && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype && Reflect.ownKeys(v).length === keys.length && Reflect.ownKeys(v).every(k => typeof k === "string" && keys.includes(k)), "fact"); for (const k of keys) { const d = Object.getOwnPropertyDescriptor(v, k); requireInviteAbort(d && "value" in d && d.enumerable, "fact"); } }
function array(v, max) { requireInviteAbort(Array.isArray(v) && Object.getPrototypeOf(v) === Array.prototype && v.length <= max && Reflect.ownKeys(v).length === v.length + 1 && v.every((_, i) => Object.hasOwn(v, i)), "fact"); }
const booleans = (v, keys) => keys.forEach(k => requireInviteAbort(typeof v[k] === "boolean", "fact"));
function sourcesFact(v) { record(v, SOURCE_KEYS); requireInviteAbort(SOURCE_KEYS.every(k => hash(v[k])) && v.design === ABORT_DESIGN_SHA256 && v.originalDesignBase === DESIGN_BASE && v.dependencyManifest === ABORT_DEPENDENCY_SHA256, "sources"); return v; }
export function componentSourceIds() { return Object.fromEntries(SOURCE_KEYS.map(k => [k, k === "design" ? ABORT_DESIGN_SHA256 : k === "originalDesignBase" ? DESIGN_BASE : k === "dependencyManifest" ? ABORT_DEPENDENCY_SHA256 : "c".repeat(64)])); }
export function inviteAbortFaultFact(value) {
  const v = ingressData(value); record(v, ["phase", "trigger", "templateSha256", "targetHash", "ownerCurrent", "databaseBound", "schemaExact", "helperHandles", "installOrdinal", "clearOrdinal", "invalid"]);
  requireInviteAbort(["absent", "installed", "cleared", "refused"].includes(v.phase) && v.trigger === "e2e_invite_admission_abort" && hash(v.targetHash) && (v.templateSha256 === null || hash(v.templateSha256)) && [0, 1].includes(v.helperHandles) && (v.installOrdinal === null || ordinal(v.installOrdinal)) && (v.clearOrdinal === null || ordinal(v.clearOrdinal)), "fact"); booleans(v, ["ownerCurrent", "databaseBound", "schemaExact", "invalid"]); return v;
}
function assertFault(v, phase, expectedHash) { v = inviteAbortFaultFact(v); requireInviteAbort(v.phase === phase && v.targetHash === expectedHash && v.ownerCurrent && v.databaseBound && v.schemaExact && v.helperHandles === 0 && !v.invalid && hash(v.templateSha256) && ordinal(v.installOrdinal) && (phase === "installed" ? v.clearOrdinal === null : ordinal(v.clearOrdinal) && v.clearOrdinal > v.installOrdinal), "fault"); return v; }
export function inviteAbortEmptyFact(value) { const v = ingressData(value); record(v, ["databaseIdentitySame", "counts", "filesEmpty"]); record(v.counts, TABLES); booleans(v, ["databaseIdentitySame", "filesEmpty"]); requireInviteAbort(TABLES.every(t => integer(v.counts[t])), "fact"); return v; }
function assertEmpty(value) { const v = inviteAbortEmptyFact(value); requireInviteAbort(v.databaseIdentitySame && v.filesEmpty && TABLES.every(t => v.counts[t] === 0), "empty"); return v; }
export function inviteAbortDeliveryFact(value) {
  const v = ingressData(value); record(v, ["owner", "wireId", "expectedHash", "ack", "commit", "auditRows", "occurrenceRows", "refusalLogs", "fault", "receiverInvalid", "receiverOverflow"]); record(v.ack, ["code", "receiverOrdinal", "matchingWire"]);
  requireInviteAbort([1, 2].includes(v.owner) && ["abort-first", "abort-recover", "abort-reopened"].includes(v.wireId) && hash(v.expectedHash) && [200, 500].includes(v.ack.code) && ordinal(v.ack.receiverOrdinal) && typeof v.ack.matchingWire === "boolean" && integer(v.auditRows) && integer(v.occurrenceRows) && integer(v.refusalLogs), "fact"); booleans(v, ["receiverInvalid", "receiverOverflow"]); v.fault = inviteAbortFaultFact(v.fault);
  if (v.commit !== null) { record(v.commit, ["ordinal", "persistedHash", "ackFloor"]); requireInviteAbort(ordinal(v.commit.ordinal) && hash(v.commit.persistedHash) && integer(v.commit.ackFloor), "fact"); } return v;
}
export function assertInviteAbortDelivery(value, owner, wireId, expectedHash, previousOrdinal = 0) {
  const v = inviteAbortDeliveryFact(value), rejected = wireId === "abort-first";
  requireInviteAbort(v.owner === owner && v.wireId === wireId && v.expectedHash === expectedHash && v.ack.matchingWire && v.ack.receiverOrdinal > previousOrdinal && !v.receiverInvalid && !v.receiverOverflow, "delivery"); assertFault(v.fault, rejected ? "installed" : "cleared", expectedHash);
  // A rolled-back statement never reaches the join decision. The first durable
  // acceptance is refused by the empty allowlist exactly once; an exact replay
  // of the refused invite is not decided or logged again.
  if (rejected) requireInviteAbort(v.ack.code === 500 && v.commit === null && v.auditRows === 0 && v.occurrenceRows === 0 && v.refusalLogs === 0, "rollback");
  else requireInviteAbort(v.ack.code === 200 && v.auditRows === 1 && v.occurrenceRows === 1 && v.commit && v.commit.persistedHash === expectedHash && v.commit.ackFloor < v.ack.receiverOrdinal &&
    v.refusalLogs === (wireId === "abort-recover" ? 1 : 0), "acceptance"); return v;
}
export function inviteAbortDurableFact(value) { const v = ingressData(value); record(v, DURABLE_KEYS); booleans(v, ["databaseIdentitySame", "immutableSame", "claimed", "organizerNull", "referenceNull", "metadataSame", "downstreamZero", "triggerAbsent", "schemaRestored"]); requireInviteAbort(hash(v.eventHash) && ["eventRows", "occurrenceRows", "acceptedAtMs", "totalAttempts", "generationAttempts", "retryGeneration", "operatorRetryCount"].every(k => integer(v[k])) && v.state === "metadata_blocked" && v.reason === "inviter_not_allowed" && (v.claimExpiresAtMs === null || integer(v.claimExpiresAtMs)) && (v.admittedAtMs === null || integer(v.admittedAtMs)), "fact"); return v; }
/** The empty allowlist refuses the recovered invite on its row: no session or
 * other downstream row, and the organizer lane is parked without any lookup. */
export function assertInviteAbortDurable(value, expectedHash, baseline = null) {
  const v = inviteAbortDurableFact(value); requireInviteAbort(v.databaseIdentitySame && v.immutableSame && v.eventHash === expectedHash && v.eventRows === 1 && v.occurrenceRows === 1 && v.state === "metadata_blocked" && v.reason === "inviter_not_allowed" && !v.claimed && v.claimExpiresAtMs === null && v.organizerNull && v.referenceNull && v.admittedAtMs === null && v.totalAttempts === 0 && v.generationAttempts === 0 && v.retryGeneration === 0 && v.operatorRetryCount === 0 && v.metadataSame && v.downstreamZero && v.triggerAbsent && v.schemaRestored && (baseline === null || JSON.stringify(v) === JSON.stringify(baseline)), "durable"); return v;
}
export function inviteAbortCloseFact(value) { const v = ingressData(value); record(v, CLOSE_KEYS); booleans(v, ["firstSecondSame", "thirdSame", "fulfilled", "repeatUnchanged", "clean", "preFixtureObserved", "fixtureCleanupStarted", "invalid", "overflow"]); for (const k of ["httpSockets", "wsSockets"]) { record(v[k], ["active", "pending"]); requireInviteAbort(integer(v[k].active) && integer(v[k].pending), "fact"); } array(v.cleanupFailures, 8); requireInviteAbort(v.cleanupFailures.every(s => typeof s === "string" && ["public_close", "fixture_close", "owner_close", "controller_clear", "late_history", "transport_close"].includes(s)) && [1, 2].includes(v.owner) && integer(v.httpActive) && integer(v.peerConnections) && Number.isSafeInteger(v.standaloneExit) && ["publicCloseOrdinal", "storeClosedOrdinal", "preFixtureOrdinal", "peerClosedOrdinal", "admittedReturnOrdinal", "ownerCloseBeginOrdinal", "ownerCloseEndOrdinal"].every(k => ordinal(v[k])), "fact"); return v; }
export function assertInviteAbortClose(value, owner) {
  const v = inviteAbortCloseFact(value); requireInviteAbort(v.owner === owner && v.firstSecondSame && v.thirdSame && v.fulfilled && v.repeatUnchanged && v.clean && v.httpActive === 0 && v.httpSockets.active === 0 && v.httpSockets.pending === 0 && v.wsSockets.active === 0 && v.wsSockets.pending === 0 && v.peerConnections === 0 && v.preFixtureObserved && v.fixtureCleanupStarted && v.publicCloseOrdinal < v.storeClosedOrdinal && v.storeClosedOrdinal < v.preFixtureOrdinal && v.preFixtureOrdinal < v.peerClosedOrdinal && v.peerClosedOrdinal < v.admittedReturnOrdinal && v.admittedReturnOrdinal < v.ownerCloseBeginOrdinal && v.ownerCloseBeginOrdinal < v.ownerCloseEndOrdinal && v.standaloneExit === 0 && !v.invalid && !v.overflow && v.cleanupFailures.length === 0, "close"); return v;
}
function historyFact(value) {
  const v = ingressData(value); record(v, ["owner", "acks", "commits", "lifecycle", "invalid", "overflow"]); requireInviteAbort([1, 2].includes(v.owner), "fact"); booleans(v, ["invalid", "overflow"]); array(v.acks, 3); array(v.commits, 2); array(v.lifecycle, 256);
  for (const row of v.acks) { record(row, ["wireId", "code", "receiverOrdinal"]); requireInviteAbort(["abort-first", "abort-recover", "abort-reopened"].includes(row.wireId) && [200, 500].includes(row.code) && ordinal(row.receiverOrdinal), "fact"); }
  for (const row of v.commits) { record(row, ["wireId", "ordinal", "persistedHash", "ackFloor"]); requireInviteAbort(["abort-first", "abort-recover", "abort-reopened"].includes(row.wireId) && ordinal(row.ordinal) && hash(row.persistedHash) && integer(row.ackFloor), "fact"); }
  for (const row of v.lifecycle) { record(row, ["ordinal", "code"]); requireInviteAbort(ordinal(row.ordinal) && INVITE_ABORT_LIFECYCLE_CODES.includes(row.code), "fact"); } return v;
}
function assertHistory(value, close, deliveries) { const v = historyFact(value), expected = deliveries.filter(d => d.owner === close.owner); requireInviteAbort(v.owner === close.owner && !v.invalid && !v.overflow && JSON.stringify(v.acks) === JSON.stringify(expected.map(d => ({ wireId: d.wireId, code: d.ack.code, receiverOrdinal: d.ack.receiverOrdinal }))) && JSON.stringify(v.commits) === JSON.stringify(expected.filter(d => d.commit).map(d => ({ wireId: d.wireId, ...d.commit }))) && v.lifecycle.every((r, i) => i === 0 || r.ordinal > v.lifecycle[i - 1].ordinal), "history"); for (const [key, code] of [["publicCloseOrdinal", "public_close"], ["storeClosedOrdinal", "shutdown_store_closed"], ["preFixtureOrdinal", "pre_fixture"], ["peerClosedOrdinal", "peer_closed"], ["admittedReturnOrdinal", "admitted_return"], ["ownerCloseBeginOrdinal", "owner_close_begin"], ["ownerCloseEndOrdinal", "owner_close_end"]]) requireInviteAbort(v.lifecycle.filter(r => r.code === code).length === 1 && v.lifecycle.some(r => r.code === code && r.ordinal === close[key]), "history");
  let previous = close.publicCloseOrdinal;
  for (const code of ["shutdown_fenced", "maintenance_fenced", "maintenance_closed", "shutdown_owned_work_settled", "shutdown_application_closed", "shutdown_runtime_owners_closed", "shutdown_transports_closed", "shutdown_store_closed"]) {
    const rows = v.lifecycle.filter(r => r.code === code); requireInviteAbort(rows.length === 1, "history"); requireInviteAbort(rows[0].ordinal > previous && rows[0].ordinal < close.preFixtureOrdinal, "history"); previous = rows[0].ordinal;
  }
  return v;
}
export const inviteAbortNow = () => Number(process.hrtime.bigint() / 1000000n);
export async function inviteAbortDeadline(thunk, parentDeadline, ceilingMs, now = inviteAbortNow) {
  requireInviteAbort(typeof thunk === "function" && Number.isSafeInteger(parentDeadline) && integer(ceilingMs) && ceilingMs > 0 && typeof now === "function", "deadline");
  const start = now(), deadline = Math.min(parentDeadline, start + ceilingMs); requireInviteAbort(integer(start) && deadline > start, "deadline"); let timer;
  try { const value = await Promise.race([Promise.resolve().then(() => { requireInviteAbort(now() < deadline, "deadline"); return thunk(deadline); }), new Promise((_, reject) => { timer = globalThis.setTimeout(() => reject(new Error("invite_abort_deadline")), deadline - start); })]); requireInviteAbort(now() < deadline, "deadline"); return value; }
  catch (e) { if (now() >= deadline) throw new Error("invite_abort_deadline"); throw e; } finally { globalThis.clearTimeout(timer); }
}
const failure = e => { const d = e && (typeof e === "object" || typeof e === "function") ? Object.getOwnPropertyDescriptor(e, "message") : null; return d && "value" in d && typeof d.value === "string" && FAILURE_CODES.has(d.value) ? d.value : "invite_abort_effect"; };
export async function runInviteAdmissionAbortCampaign(effects, { expectedHash, sources, now = inviteAbortNow } = {}) {
  requireInviteAbort(hash(expectedHash), "fact"); sources = sourcesFact(ingressData(sources));
  const overall = now() + 90000, failures = [], deliveries = [], closes = [], histories = []; let empty = null, firstDurable = null, finalDurable = null;
  for (const owner of [1, 2]) {
    let current; const phase = Math.min(overall, now() + 40000), step = (thunk, ms) => inviteAbortDeadline(thunk, phase, ms, now);
    try {
      current = await step(deadline => effects.beginOwner(owner, phase, overall, deadline), 30000);
      const ready = ingressData(await step(deadline => current.ready(deadline), 30000)); record(ready, ["admitted", "started", "endpoint200", "connections", "receiverEmpty", "commitEmpty", "discoveryEmpty", "sideEffectsZero", "admissionWarned"]); requireInviteAbort(["admitted", "started", "endpoint200", "receiverEmpty", "commitEmpty", "discoveryEmpty", "sideEffectsZero", "admissionWarned"].every(k => ready[k] === true) && ready.connections === 1, "ready");
      if (owner === 1) {
        empty = assertEmpty(await step(() => current.empty(), 5000)); assertFault(await step(() => current.install(), 5000), "installed", expectedHash); empty = assertEmpty(await step(() => current.empty(), 5000));
        assertFault(await step(() => current.inspectFault(), 5000), "installed", expectedHash);
        deliveries.push(assertInviteAbortDelivery(await step(deadline => current.deliver("abort-first", deadline), 5000), owner, "abort-first", expectedHash)); empty = assertEmpty(await step(() => current.empty(), 5000));
        assertFault(await step(() => current.clear(), 5000), "cleared", expectedHash);
        deliveries.push(assertInviteAbortDelivery(await step(deadline => current.deliver("abort-recover", deadline), 5000), owner, "abort-recover", expectedHash, deliveries[0].ack.receiverOrdinal)); firstDurable = assertInviteAbortDurable(await step(deadline => current.blocked(deadline), 5000), expectedHash);
      } else {
        assertInviteAbortDurable(await step(() => current.durable(), 5000), expectedHash, firstDurable);
        deliveries.push(assertInviteAbortDelivery(await step(deadline => current.deliver("abort-reopened", deadline), 5000), owner, "abort-reopened", expectedHash)); finalDurable = assertInviteAbortDurable(await step(deadline => current.blocked(deadline), 5000), expectedHash, firstDurable);
      }
    } catch (e) { failures.push(failure(e)); }
    finally {
      if (current) try {
        const selectedDeadline = Math.min(overall, phase); let settled;
        if (now() >= selectedDeadline) {
          // Retained ordinary failure cleanup still runs once. An expired
          // selected phase cannot be promoted by its eventual settlement.
          failures.push("invite_abort_deadline"); const cleanup = current.close(Math.min(overall, now() + 10000)); Promise.resolve(cleanup).catch(() => {});
          settled = await inviteAbortDeadline(() => cleanup, overall, 10000, now);
        } else settled = await inviteAbortDeadline(deadline => current.close(deadline), selectedDeadline, 10000, now);
        settled = ingressData(settled); record(settled, ["close", "history", "durable"]); const c = assertInviteAbortClose(settled.close, owner); closes.push(c); histories.push(assertHistory(settled.history, c, deliveries)); if (firstDurable) finalDurable = assertInviteAbortDurable(settled.durable, expectedHash, firstDurable);
      }
      catch (e) { failures.push(failure(e)); }
    }
    if (failures.length) break;
  }
  const result = { schema: "meeting-invite-admission-abort/v1", family: "invite-admission-abort", label: "component-facts", sources, expectedHash, success: failures.length === 0, failures, empty, deliveries, firstDurable, finalDurable, closes, histories };
  return validateInviteAbortResult(result);
}
export function validateInviteAbortResult(value) {
  // Capture identity before getter-free copying. Only the real entry can mint it.
  const actual = isAttemptedInviteAbortResult(value), v = ingressData(value); record(v, ["schema", "family", "label", "sources", "expectedHash", "success", "failures", "empty", "deliveries", "firstDurable", "finalDurable", "closes", "histories"]);
  requireInviteAbort(v.schema === "meeting-invite-admission-abort/v1" && v.family === "invite-admission-abort" && hash(v.expectedHash) && typeof v.success === "boolean", "fact"); requireInviteAbort(v.label === "component-facts" || v.label === "attempted-application" && actual, "provenance"); sourcesFact(v.sources);
  array(v.failures, 16); requireInviteAbort(v.failures.every(c => typeof c === "string" && FAILURE_CODES.has(c)), "fact"); array(v.deliveries, 3); array(v.closes, 2); array(v.histories, 2);
  if (v.empty !== null) v.empty = inviteAbortEmptyFact(v.empty); v.deliveries = v.deliveries.map(inviteAbortDeliveryFact); v.closes = v.closes.map(inviteAbortCloseFact); v.histories = v.histories.map(historyFact); if (v.firstDurable !== null) v.firstDurable = inviteAbortDurableFact(v.firstDurable); if (v.finalDurable !== null) v.finalDurable = inviteAbortDurableFact(v.finalDurable);
  if (v.success) { requireInviteAbort(v.failures.length === 0 && v.deliveries.length === 3 && v.closes.length === 2 && v.histories.length === 2 && v.empty && v.firstDurable && v.finalDurable, "fact"); assertEmpty(v.empty); v.deliveries.forEach((d, i) => assertInviteAbortDelivery(d, i === 2 ? 2 : 1, ["abort-first", "abort-recover", "abort-reopened"][i], v.expectedHash, i === 1 ? v.deliveries[0].ack.receiverOrdinal : 0)); assertInviteAbortDurable(v.firstDurable, v.expectedHash); assertInviteAbortDurable(v.finalDurable, v.expectedHash, v.firstDurable); v.closes.forEach((c, i) => { assertInviteAbortClose(c, i + 1); assertHistory(v.histories[i], c, v.deliveries); }); } else requireInviteAbort(v.failures.length > 0, "fact"); return v;
}
export function parseInviteAbortArguments(argv) { const v = ingressData(argv); array(v, 2); requireInviteAbort(v.length === 2 && v[0] === "--out" && typeof v[1] === "string" && path.isAbsolute(v[1]) && path.normalize(v[1]) === v[1] && realpathSync(path.dirname(v[1])) === path.dirname(v[1]), "output"); const parent = lstatSync(path.dirname(v[1])); requireInviteAbort(parent.isDirectory() && !parent.isSymbolicLink(), "output"); try { lstatSync(v[1]); throw new Error("invite_abort_output"); } catch (e) { if (e.code !== "ENOENT") throw e; } return { out: v[1] }; }
export function writeInviteAbortEvidence(out, value) { const result = validateInviteAbortResult(value); writeFileSync(out, JSON.stringify(result), { mode: 0o600, flag: "wx" }); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void (async () => { const { out } = parseInviteAbortArguments(process.argv.slice(2)); const result = await runActualInviteAdmissionAbort(); writeInviteAbortEvidence(out, result); process.exitCode = result.success ? 0 : 70; })().catch(() => { process.stderr.write("invite_abort_command_failed\n"); process.exitCode = 70; });

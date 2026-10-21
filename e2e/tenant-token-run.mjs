// Opt-in preparation. Imports do not construct SDK clients or admit an app.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { assertPendingStartupEnvironment, parsePendingStartupArguments, validatePendingStartupPlan } from "./pending-startup-run.mjs";

export const TENANT_FAMILY = "tenant-token-timeout-close";
const BASE = "ae4316ed2bc7a5c652ea44f32c16b3fdc260a5bb93f933bf45e63b49a5c0ad01";
const SHUTDOWN = ["shutdown_fenced", "maintenance_fenced", "maintenance_closed", "shutdown_owned_work_settled", "shutdown_application_closed", "shutdown_runtime_owners_closed", "shutdown_transports_closed", "shutdown_store_closed"];
const LOGS = ["composition_lock_verified", "composition_store_opened", "maintenance_started", "composition_started", "discovery_tick", "invite_committed", "occurrence_launched", ...SHUTDOWN, "feishu_sdk_error", "feishu_sdk_warning", "feishu_sdk_info", "feishu_sdk_debug", "feishu_sdk_trace"];
const MARKS = ["admitted", "handle", "started", "initialDiscovery", "commit", "ack", "tokenStart", "tokenSettlement", "closeRequested", "closeSettled", "lifecycleSettled", "fixtureStarted", "peerClosed", "admittedReturned", "ownerCloseBegin", "ownerCloseEnd"];
const CLOCKS = ["acceptedAtMs", "claimExpiresAtMs", "generationStartedAtMs", "firstAttemptAtMs", "lastAttemptAtMs", "lastBlockedAtMs", "lastObservedAtMs", "nextAttemptAtMs"];
const COUNTERS = ["occurrences", "events", "sessions", "custody", "generations", "claimed", "totalAttempts", "generationAttempts", "retryGeneration", "operatorRetryCount"];
const FAILURE = ["fact_invalid", "qualification_invalid", "held_invalid", "history_changed", "ready_invalid", "settlement_invalid", "cleanup_invalid", "close_identity", "close_failed", "deadline", "poll_exhausted", "effects_invalid", "phase_failed", "cancel_failed", "cleanup_failed", "output_invalid", "actual_unqualified", "entry_repeated"];
export function requireTenant(value, reason = "fact_invalid") { if (!value) throw new Error(`tenant_token_${reason}`); }
function rec(value, keys) { requireTenant(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype); requireTenant(Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))); }
function integer(value, max = 1000000) { requireTenant(Number.isSafeInteger(value) && value >= 0 && value <= max); }
function time(value, nullable = false) { requireTenant(nullable && value === null || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER); }
function bool(value) { requireTenant(typeof value === "boolean"); }
function array(value, max) { requireTenant(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max); }
function freeze(value) { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function data(value) {
  let nodes = 0;
  function copy(v, depth) {
    requireTenant(++nodes <= 16384 && depth <= 16);
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") { time(v); return v; }
    if (typeof v === "string") { requireTenant(Buffer.byteLength(v) <= 8192); return v; }
    requireTenant(v && typeof v === "object"); const list = Array.isArray(v);
    requireTenant(Object.getPrototypeOf(v) === (list ? Array.prototype : Object.prototype));
    const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(descriptors);
    requireTenant(keys.length <= 512 && keys.every(key => typeof key === "string" && key !== "toJSON" && key !== "__proto__" && Object.hasOwn(descriptors[key], "value")));
    const out = list ? [] : {}; if (list) requireTenant(v.length <= 256 && keys.length === v.length + 1);
    for (const key of keys) { if (list && key === "length") continue; requireTenant(!list || /^(0|[1-9][0-9]*)$/.test(key)); out[key] = copy(descriptors[key].value, depth + 1); }
    return out;
  }
  return copy(value, 0);
}
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
export function captureTenantTokenSnapshot(input) {
  const v = data(input);
  rec(v, ["marks", "times", "emptyState", "operations", "requests", "hold", "owners", "receiver", "lifecycle", "durable", "files", "liveCount", "outcomeCount", "fixtureCleanupStarted", "invalid", "overflow"]);
  rec(v.marks, MARKS); for (const n of Object.values(v.marks)) integer(n);
  rec(v.times, ["commitAt", "tokenStartAt"]); for (const n of Object.values(v.times)) time(n, true);
  for (const key of ["emptyState", "fixtureCleanupStarted", "invalid", "overflow"]) bool(v[key]);
  array(v.operations, 2); for (const row of v.operations) { rec(row, ["kind", "method", "startOrdinal", "settleOrdinal", "outcome", "timeoutMs"]); requireTenant(["ws_endpoint", "tenant_token_internal", "invalid"].includes(row.kind) && ["POST", "GET", "invalid"].includes(row.method) && ["pending", "fulfilled", "rejected"].includes(row.outcome)); integer(row.startOrdinal); integer(row.settleOrdinal); integer(row.timeoutMs, 5000); }
  array(v.requests, 2); for (const row of v.requests) { rec(row, ["method", "route", "status"]); requireTenant(["POST", "GET", "OTHER"].includes(row.method) && ["ws_endpoint", "tenant_access_token", "unmatched", "reserve_active_meeting", "reserve_get", "contact_user_get", "im_message"].includes(row.route)); integer(row.status, 599); }
  if (v.hold !== null) { rec(v.hold, ["id", "method", "route"]); requireTenant(typeof v.hold.id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(v.hold.id) && ["POST", "GET", "OTHER"].includes(v.hold.method) && ["tenant_access_token", "ws_endpoint"].includes(v.hold.route)); }
  rec(v.owners, ["admitted", "handles", "http", "httpSockets", "httpPending", "wsSockets", "wsPending", "connections"]); for (const n of Object.values(v.owners)) integer(n, 4);
  rec(v.receiver, ["ackCount", "legacyAckCount", "messageCount", "matchingAck", "invalid", "overflow"]); for (const key of ["ackCount", "legacyAckCount", "messageCount"]) integer(v.receiver[key], 256); for (const key of ["matchingAck", "invalid", "overflow"]) bool(v.receiver[key]);
  array(v.lifecycle, 128); for (const row of v.lifecycle) { rec(row, ["ordinal", "code"]); integer(row.ordinal); requireTenant(LOGS.includes(row.code)); }
  requireTenant(v.lifecycle.every((row, i) => row.ordinal > (v.lifecycle[i - 1]?.ordinal ?? 0)));
  if (v.durable !== null) {
    rec(v.durable, [...COUNTERS, ...CLOCKS, "counts", "state", "reason", "metadataNull", "operatorNull", "auditEqual", "identityEqual"]);
    for (const key of COUNTERS) integer(v.durable[key]); for (const key of CLOCKS) { time(v.durable[key], true); if (v.durable[key] !== null) integer(v.durable[key], Number.MAX_SAFE_INTEGER); }
    rec(v.durable.counts, ["custody", "recording", "seed", "delivery", "notification"]); for (const n of Object.values(v.durable.counts)) integer(n);
    requireTenant(["pending_metadata", "metadata_blocked", "admitted"].includes(v.durable.state) && [null, "timeout", "cancelled", "metadata_unavailable", "reference_missing", "retry_exhausted"].includes(v.durable.reason));
    for (const key of ["metadataNull", "operatorNull", "auditEqual", "identityEqual"]) bool(v.durable[key]);
  }
  rec(v.files, ["recordings", "outbox", "receipts", "runtimePids", "launcherLog", "key", "bridgeState"]); for (const key of ["recordings", "outbox", "receipts"]) integer(v.files[key]); for (const key of ["runtimePids", "launcherLog", "key", "bridgeState"]) bool(v.files[key]);
  integer(v.liveCount); integer(v.outcomeCount); return freeze(v);
}
function isolated(v) {
  requireTenant(!v.invalid && !v.overflow && !v.receiver.invalid && !v.receiver.overflow && v.receiver.messageCount === 0 && v.liveCount === 0 && v.outcomeCount === 0 && !v.lifecycle.some(row => row.code === "occurrence_launched"), "held_invalid");
  requireTenant(Object.values(v.files).every(n => n === 0 || n === false), "held_invalid");
  requireTenant(v.owners.admitted === 1 && v.owners.handles === 1 && v.owners.httpPending === 0 && v.owners.wsPending === 0, "held_invalid");
}
function audit(v) {
  const d = v.durable;
  requireTenant(d && d.occurrences === 1 && d.events === 1 && d.sessions === 0 && d.custody === 0 && d.generations === 0 && Object.values(d.counts).every(n => n === 0) && d.state === "pending_metadata" && d.totalAttempts === 1 && d.generationAttempts === 1 && d.retryGeneration === 0 && d.operatorRetryCount === 0 && d.metadataNull && d.operatorNull && d.auditEqual && d.identityEqual, "held_invalid");
  requireTenant(d.acceptedAtMs !== null && d.firstAttemptAtMs !== null && d.firstAttemptAtMs === d.lastAttemptAtMs && d.firstAttemptAtMs === d.generationStartedAtMs && d.firstAttemptAtMs >= d.acceptedAtMs && d.lastObservedAtMs === d.acceptedAtMs, "held_invalid");
}
function startup(v) {
  const m = v.marks;
  requireTenant(m.admitted > 0 && m.handle > m.admitted && m.started > m.handle && m.initialDiscovery > m.started && v.lifecycle.some(row => row.ordinal === m.started && row.code === "composition_started") && v.lifecycle.some(row => row.ordinal === m.initialDiscovery && row.code === "discovery_tick"), "ready_invalid");
  const endpoint = v.operations[0]; requireTenant(endpoint?.kind === "ws_endpoint" && endpoint.method === "POST" && endpoint.timeoutMs === 5000 && endpoint.outcome === "fulfilled" && endpoint.startOrdinal > m.handle && endpoint.settleOrdinal > endpoint.startOrdinal && endpoint.settleOrdinal < m.started, "ready_invalid");
  requireTenant(v.requests[0]?.route === "ws_endpoint" && v.requests[0].method === "POST" && v.requests[0].status === 200, "ready_invalid");
}
export function assertTenantTokenHeld(input) {
  const v = captureTenantTokenSnapshot(input); isolated(v); startup(v); audit(v);
  const m = v.marks, token = v.operations[1];
  requireTenant(!v.emptyState && !v.fixtureCleanupStarted && m.fixtureStarted === 0 && m.closeRequested === 0 && m.closeSettled === 0 && m.lifecycleSettled === 0 && m.peerClosed === 0 && m.admittedReturned === 0 && m.ownerCloseBegin === 0 && m.ownerCloseEnd === 0 && !v.lifecycle.some(row => SHUTDOWN.includes(row.code)), "held_invalid");
  requireTenant(m.commit > m.initialDiscovery && m.ack > m.commit && m.tokenStart > m.commit && m.tokenSettlement === 0 && v.lifecycle.some(row => row.code === "invite_committed" && row.ordinal === m.commit) && v.times.commitAt !== null && v.times.tokenStartAt !== null && v.times.tokenStartAt >= v.times.commitAt, "held_invalid");
  requireTenant(v.operations.length === 2 && token.kind === "tenant_token_internal" && token.method === "POST" && token.timeoutMs === 5000 && token.outcome === "pending" && token.startOrdinal === m.tokenStart && token.settleOrdinal === 0 && v.requests.length === 1, "held_invalid");
  requireTenant(v.hold?.method === "POST" && v.hold.route === "tenant_access_token" && v.owners.http === 1 && v.owners.httpSockets === 1 && v.owners.wsSockets === 1 && v.owners.connections === 1 && v.receiver.ackCount === 1 && v.receiver.legacyAckCount === 1 && v.receiver.matchingAck, "held_invalid");
  const d = v.durable; requireTenant(d.claimed === 1 && d.claimExpiresAtMs === d.lastAttemptAtMs + 30000 && d.reason === null && d.lastBlockedAtMs === null && d.nextAttemptAtMs === d.acceptedAtMs, "held_invalid"); return v;
}
export function closeHeldTenantToken(expected, read, app, mark, checkpoint = () => {}) {
  checkpoint();
  const before = assertTenantTokenHeld(expected), fresh = assertTenantTokenHeld(read()); requireTenant(equal(before, fresh), "history_changed");
  checkpoint(); mark(); checkpoint(); const first = app.close(); first.catch(() => {}); checkpoint(); const second = app.close(); second.catch(() => {}); checkpoint(); requireTenant(first === second, "close_identity"); return { first, second };
}
function assertReady(input) {
  const v = captureTenantTokenSnapshot(input); isolated(v); startup(v);
  requireTenant(v.emptyState && v.durable === null && v.hold === null && v.operations.length === 1 && v.requests.length === 1 && v.receiver.ackCount === 0 && v.receiver.legacyAckCount === 0 && !v.fixtureCleanupStarted && v.owners.http === 0 && v.owners.httpSockets === 0 && v.owners.wsSockets === 1 && v.owners.connections === 1 && MARKS.slice(4).every(key => v.marks[key] === 0) && v.times.commitAt === null && v.times.tokenStartAt === null && !v.lifecycle.some(row => SHUTDOWN.includes(row.code)), "ready_invalid"); return v;
}
function selectedStable(v) {
  return { times: v.times, receiver: v.receiver, operations: v.operations, requests: v.requests, durable: v.durable, lifecycle: v.lifecycle, files: v.files, owners: v.owners, liveCount: v.liveCount, outcomeCount: v.outcomeCount, invalid: v.invalid, overflow: v.overflow };
}
function assertDrained(input, held, final = false) {
  const v = captureTenantTokenSnapshot(input); isolated(v); startup(v); audit(v);
  const m = v.marks, t = v.operations[1], d = v.durable;
  requireTenant(equal(v.times, held.times) && equal(v.operations[0], held.operations[0]) && equal(v.receiver, held.receiver) && ["admitted", "handle", "started", "initialDiscovery", "commit", "ack", "tokenStart"].every(key => m[key] === held.marks[key]), "history_changed");
  requireTenant(v.operations.length === 2 && t.kind === "tenant_token_internal" && t.method === "POST" && t.timeoutMs === 5000 && t.startOrdinal === m.tokenStart && t.outcome === "rejected" && t.settleOrdinal === m.tokenSettlement && m.tokenSettlement > m.closeRequested && m.closeRequested > Math.max(m.commit, m.ack, m.tokenStart) && m.closeSettled > m.tokenSettlement && m.lifecycleSettled > m.closeSettled, "settlement_invalid");
  requireTenant(v.requests.length === 2 && v.requests[1].method === "POST" && v.requests[1].route === "tenant_access_token" && v.requests[1].status === 499 && v.hold === null && v.owners.http === 0 && v.owners.httpSockets === 0 && v.owners.wsSockets === 0 && v.owners.connections === 0 && !v.emptyState, "settlement_invalid");
  requireTenant(d.claimed === 0 && d.claimExpiresAtMs === null && d.reason === "timeout" && d.lastBlockedAtMs >= d.lastAttemptAtMs && d.lastObservedAtMs === held.durable.lastObservedAtMs && d.nextAttemptAtMs === d.lastBlockedAtMs + 1000 && ["acceptedAtMs", "totalAttempts", "generationAttempts", "generationStartedAtMs", "firstAttemptAtMs", "lastAttemptAtMs", "retryGeneration", "operatorRetryCount"].every(key => d[key] === held.durable[key]), "settlement_invalid");
  const rows = v.lifecycle.filter(row => SHUTDOWN.includes(row.code)); requireTenant(equal(rows.map(row => row.code), SHUTDOWN) && rows[0].ordinal > m.closeRequested && rows.at(-1).ordinal < m.closeSettled && v.lifecycle.slice(0, held.lifecycle.length).every((row, i) => equal(row, held.lifecycle[i])), "settlement_invalid");
  if (!final) requireTenant(!v.fixtureCleanupStarted && ["fixtureStarted", "peerClosed", "admittedReturned", "ownerCloseBegin", "ownerCloseEnd"].every(key => m[key] === 0), "settlement_invalid");
  return v;
}
function settlement(input, held) {
  const v = data(input); rec(v, ["snapshot", "repeated", "close", "composition"]); rec(v.close, ["firstFulfilled", "secondFulfilled", "promiseSame", "thirdFulfilled", "thirdPromiseSame"]); for (const n of Object.values(v.close)) bool(n);
  rec(v.composition, ["status", "clean"]); requireTenant(v.composition.status === "composition_closed" && v.composition.clean === true && Object.values(v.close).every(n => n === true), "close_failed");
  v.snapshot = assertDrained(v.snapshot, held); v.repeated = assertDrained(v.repeated, held); requireTenant(equal(v.snapshot, v.repeated), "history_changed"); return freeze(v);
}
function finalFact(input, held, settled) {
  const v = data(input); rec(v, ["snapshot", "composition", "standaloneExit", "cleanupFailures"]); rec(v.composition, ["status", "clean"]); array(v.cleanupFailures, 8); for (const code of v.cleanupFailures) requireTenant(typeof code === "string" && ["http_close", "socket_close", "peer_close", "reader", "diagnostic"].includes(code));
  v.snapshot = assertDrained(v.snapshot, held, true); const m = v.snapshot.marks;
  requireTenant(v.standaloneExit === 0 && v.composition.status === "composition_closed" && v.composition.clean === true && v.cleanupFailures.length === 0 && v.snapshot.fixtureCleanupStarted && m.fixtureStarted > m.lifecycleSettled && m.peerClosed > m.fixtureStarted && m.admittedReturned > m.peerClosed && m.ownerCloseBegin > m.admittedReturned && m.ownerCloseEnd > m.ownerCloseBegin, "cleanup_invalid");
  requireTenant(equal(selectedStable(v.snapshot), selectedStable(settled.snapshot)), "history_changed"); return freeze(v);
}
// Filled below from the accepted source inventory, never a moving dist walk.
const SOURCE_ROLES = [
  "e2e/tenant-token-entry.mjs",
  "e2e/tenant-token-run.mjs",
  "e2e/tenant-token-run.test.ts",
  "e2e/pending-startup-run.mjs",
  "e2e/ingress-run.mjs",
  "e2e/composition-lifecycle.mjs",
  "e2e/feishu-peer.mjs",
  "e2e/feishu-peer-controls.mjs",
  "e2e/feishu-upgrade-controls.mjs",
  "e2e/feishu-reservation-registry.mjs",
  "e2e/process-evidence.mjs",
  "e2e/stage.mjs",
  "e2e/l4-campaign.mjs",
  "e2e/media-client.mjs",
  "e2e/pins.mjs",
  "dist/src/adapters/application-owner-lock.js",
  "dist/src/adapters/child-bridge-process.js",
  "dist/src/adapters/conversation-runtime-client.js",
  "dist/src/adapters/feishu-api.js",
  "dist/src/adapters/feishu-invite-ingress.js",
  "dist/src/adapters/feishu-organizer-metadata.js",
  "dist/src/adapters/feishu-organizer-sender.js",
  "dist/src/adapters/feishu-sdk-connection.js",
  "dist/src/adapters/feishu-sdk-http.js",
  "dist/src/adapters/filesystem-operator-warning.js",
  "dist/src/adapters/filesystem-outbox.js",
  "dist/src/adapters/receipt-inbox.js",
  "dist/src/adapters/sqlite-session-store.js",
  "dist/src/adapters/team-vault-index.js",
  "dist/src/application-composition.js",
  "dist/src/application-maintenance.js",
  "dist/src/application.js",
  "dist/src/config.js",
  "dist/src/contracts/bridge-process-outcome-v1.js",
  "dist/src/contracts/bridge-session-v1.js",
  "dist/src/contracts/bridge-session-v2.js",
  "dist/src/contracts/teammem-meeting-v1.js",
  "dist/src/contracts/teammem-meeting-v2.js",
  "dist/src/delivery/artifact-builder.js",
  "dist/src/delivery/backfill-worker.js",
  "dist/src/delivery/notification-worker.js",
  "dist/src/delivery/outbox-worker.js",
  "dist/src/domain/attribution-evidence.js",
  "dist/src/domain/meeting.js",
  "dist/src/domain/occurrence-id.js",
  "dist/src/domain/participants.js",
  "dist/src/domain/transcript.js",
  "dist/src/main.js",
  "dist/src/operator.js",
  "dist/src/ports/bridge-process.js",
  "dist/src/ports/bridge-v2.js",
  "dist/src/ports/bridge.js",
  "dist/src/ports/conversation-runtime.js",
  "dist/src/ports/feishu-ingress.js",
  "dist/src/ports/feishu.js",
  "dist/src/ports/knowledge.js",
  "dist/src/ports/live-evidence-authority.js",
  "dist/src/ports/operator-warning.js",
  "dist/src/ports/recording-alignment-authority.js",
  "dist/src/ports/session-store.js",
  "dist/src/sessions/coordinator.js",
  "dist/src/sessions/invite-discovery.js",
  "dist/src/sessions/invocation-gate.js",
  "dist/src/sessions/live-evidence-codec.js",
  "dist/src/sessions/live-provisional.js",
  "dist/src/sessions/meeting-session.js",
  "dist/src/sessions/recording-alignment.js",
  "dist/src/sessions/retrieval-router.js",
  "dist/src/sessions/speaker-reconciler.js",
  "dist/src/sessions/timed-evidence-merge.js",
  "dist/src/standalone-config.js",
  "node_modules/@larksuiteoapi/node-sdk/lib/index.js",
  "node_modules/@larksuiteoapi/node-sdk/package.json",
  "node_modules/ws/index.js",
  "node_modules/ws/package.json",
  "node_modules/ws/lib/buffer-util.js",
  "node_modules/ws/lib/constants.js",
  "node_modules/ws/lib/event-target.js",
  "node_modules/ws/lib/extension.js",
  "node_modules/ws/lib/limiter.js",
  "node_modules/ws/lib/permessage-deflate.js",
  "node_modules/ws/lib/receiver.js",
  "node_modules/ws/lib/sender.js",
  "node_modules/ws/lib/stream.js",
  "node_modules/ws/lib/subprotocol.js",
  "node_modules/ws/lib/validation.js",
  "node_modules/ws/lib/websocket-server.js",
  "node_modules/ws/lib/websocket.js",
  "node_modules/@conversation/runtime/package.json",
  "node_modules/@conversation/runtime/dist/src/browser.js",
  "node_modules/@conversation/runtime/dist/src/client.js",
  "node_modules/@conversation/runtime/dist/src/framing.js",
  "node_modules/@conversation/runtime/dist/src/index.js",
  "node_modules/@conversation/runtime/dist/src/protocol.js",
  "node_modules/@conversation/runtime/dist/src/stdio.js",
  "migrations/001_orchestration.sql",
  "dist/migrations/001_orchestration.sql",
  "migrations/002_recordings.sql",
  "dist/migrations/002_recordings.sql",
  "migrations/003_bridge_capacity.sql",
  "dist/migrations/003_bridge_capacity.sql",
  "migrations/004_recording_runtime_metadata.sql",
  "dist/migrations/004_recording_runtime_metadata.sql",
  "migrations/005_bridge_recovery.sql",
  "dist/migrations/005_bridge_recovery.sql",
  "migrations/006_bridge_failure_recordings.sql",
  "dist/migrations/006_bridge_failure_recordings.sql",
  "migrations/007_recording_runtime_gaps.sql",
  "dist/migrations/007_recording_runtime_gaps.sql",
  "migrations/008_reconciliation_evidence.sql",
  "dist/migrations/008_reconciliation_evidence.sql",
  "migrations/009_reconciliation_generations.sql",
  "dist/migrations/009_reconciliation_generations.sql",
  "migrations/010_reconciliation_evidence_hardening.sql",
  "dist/migrations/010_reconciliation_evidence_hardening.sql",
  "migrations/011_reconciliation_provenance_and_terminal.sql",
  "dist/migrations/011_reconciliation_provenance_and_terminal.sql",
  "migrations/012_reconciliation_upgrade_safety.sql",
  "dist/migrations/012_reconciliation_upgrade_safety.sql",
  "migrations/013_delivery_journal.sql",
  "dist/migrations/013_delivery_journal.sql",
  "migrations/014_delivery_recovery.sql",
  "dist/migrations/014_delivery_recovery.sql",
  "migrations/015_delivery_recovery_reason.sql",
  "dist/migrations/015_delivery_recovery_reason.sql",
  "migrations/016_delivery_recording_identity.sql",
  "dist/migrations/016_delivery_recording_identity.sql",
  "migrations/017_delivery_recording_reservations.sql",
  "dist/migrations/017_delivery_recording_reservations.sql",
  "migrations/018_notifications.sql",
  "dist/migrations/018_notifications.sql",
  "migrations/019_physical_client_custody.sql",
  "dist/migrations/019_physical_client_custody.sql",
  "migrations/020_feishu_invite_discovery.sql",
  "dist/migrations/020_feishu_invite_discovery.sql",
  "migrations/021_recording_recovery_alignment.sql",
  "dist/migrations/021_recording_recovery_alignment.sql",
  "migrations/022_live_timed_evidence.sql",
  "dist/migrations/022_live_timed_evidence.sql",
  "migrations/023_backfill_seed_storage.sql",
  "dist/migrations/023_backfill_seed_storage.sql",
  "migrations/024_backfill_jobs.sql",
  "dist/migrations/024_backfill_jobs.sql",
  "migrations/025_backfill_worker.sql",
  "dist/migrations/025_backfill_worker.sql",
  "migrations/026_unknown_end_custody.sql",
  "dist/migrations/026_unknown_end_custody.sql",
  "migrations/027_generation_terminal_reason.sql",
  "dist/migrations/027_generation_terminal_reason.sql",
  "migrations/028_recording_capture_drain.sql",
  "dist/migrations/028_recording_capture_drain.sql",
  "migrations/029_alignment_page_private_bound.sql",
  "dist/migrations/029_alignment_page_private_bound.sql",
  "migrations/030_recording_retention.sql",
  "dist/migrations/030_recording_retention.sql",
  "node_modules/better-sqlite3/package.json",
  "node_modules/better-sqlite3/lib/binding.js",
  "node_modules/better-sqlite3/lib/darwin-arm64.js",
  "node_modules/better-sqlite3/lib/darwin-x64.js",
  "node_modules/better-sqlite3/lib/database.js",
  "node_modules/better-sqlite3/lib/index.js",
  "node_modules/better-sqlite3/lib/linux-arm64.js",
  "node_modules/better-sqlite3/lib/linux-x64.js",
  "node_modules/better-sqlite3/lib/linuxmusl-arm64.js",
  "node_modules/better-sqlite3/lib/linuxmusl-x64.js",
  "node_modules/better-sqlite3/lib/methods/aggregate.js",
  "node_modules/better-sqlite3/lib/methods/backup.js",
  "node_modules/better-sqlite3/lib/methods/explain.js",
  "node_modules/better-sqlite3/lib/methods/function.js",
  "node_modules/better-sqlite3/lib/methods/inspect.js",
  "node_modules/better-sqlite3/lib/methods/pragma.js",
  "node_modules/better-sqlite3/lib/methods/serialize.js",
  "node_modules/better-sqlite3/lib/methods/table.js",
  "node_modules/better-sqlite3/lib/methods/transaction.js",
  "node_modules/better-sqlite3/lib/methods/wrappers.js",
  "node_modules/better-sqlite3/lib/sqlite-error.js",
  "node_modules/better-sqlite3/lib/util.js",
  "node_modules/better-sqlite3/lib/win32-arm64.js",
  "node_modules/better-sqlite3/lib/win32-x64.js"
];
export function tenantTokenSourceRoles() { return [...SOURCE_ROLES]; }
export function validateTenantTokenQualification(input) {
  const q = data(input); rec(q, ["schema", "baselineSha256", "sources"]); requireTenant(q.schema === "meeting-tenant-token-sources/v1" && q.baselineSha256 === BASE, "qualification_invalid"); array(q.sources, 256);
  requireTenant(q.sources.length === SOURCE_ROLES.length && q.sources.every((row, i) => { rec(row, ["role", "sha256"]); return row.role === SOURCE_ROLES[i] && typeof row.sha256 === "string" && /^[a-f0-9]{64}$/.test(row.sha256); }), "qualification_invalid"); return freeze(q);
}
export async function runTenantTokenPhase(effects, qualification, options = {}) {
  qualification = validateTenantTokenQualification(qualification);
  requireTenant(effects && ["begin", "send", "read", "closeHeld", "settle", "finish", "cancel"].every(key => typeof effects[key] === "function"), "effects_invalid");
  const clock = options.now ?? (() => performance.now()), sleep = options.sleep ?? (ms => delay(ms)), allowance = options.pollAllowance ?? { remaining: 512 };
  let previousTime = 0, clockInvalid = false;
  const now = () => { try { const value = clock(); time(value); if (value < previousTime) clockInvalid = true; else previousTime = value; } catch { clockInvalid = true; } return previousTime; };
  integer(allowance.remaining, 512); const current = now(), start = options.startedAt ?? current, overallMs = options.overallMs ?? 60000, admissionMs = options.admissionMs ?? 30000, cleanupMs = options.cleanupMs ?? 10000;
  time(start); requireTenant(start <= current, "deadline");
  for (const [n, max] of [[overallMs, 60000], [admissionMs, 30000], [cleanupMs, 10000]]) requireTenant(Number.isFinite(n) && n > 0 && n <= max); time(start);
  const overall = start + overallMs; let polls = 0, held = null, settled = null, final = null, selected = false, cleanupConfirmed = false;
  const failures = [], controller = new globalThis.AbortController();
  function check(deadline) { const current = now(); requireTenant(!clockInvalid && current < deadline, "deadline"); }
  function failure(error, fallback) { const descriptor = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "message") : null; const message = descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null; const code = typeof message === "string" && FAILURE.some(reason => message === `tenant_token_${reason}`) ? message : `tenant_token_${fallback}`; if (!failures.includes(code) && failures.length < 12) failures.push(code); }
  async function step(thunk, deadline) {
    check(deadline); let timer; let pending;
    try {
      pending = Promise.resolve(thunk()); pending.catch(() => {});
      if (now() >= deadline || clockInvalid) {
        // Observe an already-rejected primary promise without waiting for late
        // work or allowing it to extend the expired absolute allowance.
        await Promise.race([pending.then(() => {}, error => failure(error, "phase_failed")), Promise.resolve()]);
        throw new Error("tenant_token_deadline");
      }
      const value = await Promise.race([pending, new Promise((_, reject) => { timer = globalThis.setTimeout(() => reject(new Error("tenant_token_deadline")), Math.max(1, deadline - now())); })]); check(deadline); return value;
    }
    catch (error) { if (now() >= deadline) { failure(error, "phase_failed"); throw new Error("tenant_token_deadline"); } throw error; } finally { globalThis.clearTimeout(timer); }
  }
  const phase = Object.freeze({ now, overall, check, step, poll: async deadline => { check(deadline); requireTenant(allowance.remaining > 0, "poll_exhausted"); allowance.remaining--; polls++; await step(() => sleep(Math.min(10, Math.max(0, deadline - now()))), deadline); }, read: deadline => { check(deadline); const v = captureTenantTokenSnapshot(effects.read()); check(deadline); return v; } });
  try {
    const admission = Math.min(overall, start + admissionMs); const ready = await step(() => effects.begin(controller.signal, phase, admission), admission); assertReady(ready); check(admission);
    await step(() => effects.send(phase), admission);
    let current = phase.read(overall); // Keep the initial snapshot even at poll exhaustion.
    while (current.times.commitAt === null) { await phase.poll(admission); current = phase.read(admission); }
    const eligibility = Math.min(overall, current.times.commitAt + 2500);
    while (current.hold === null || !current.receiver.matchingAck || current.durable?.claimed !== 1) { await phase.poll(eligibility); current = phase.read(eligibility); }
    held = assertTenantTokenHeld(current); requireTenant(held.times.commitAt <= now() && held.times.tokenStartAt <= now(), "held_invalid"); check(eligibility);
    const drain = Math.min(overall, held.times.tokenStartAt + 12000, held.times.commitAt + 14500);
    const close = await step(() => effects.closeHeld(held, phase, eligibility), Math.min(eligibility, drain));
    settled = settlement(await step(() => effects.settle(close, phase, drain), drain), held); check(drain); selected = true;
  } catch (error) { failure(error, "phase_failed"); controller.abort(); try { effects.cancel(); } catch (error) { failure(error, "cancel_failed"); } }
  // Ownership remains retained after expiry; invoke finish once, but never let
  // its late/fallback facts qualify the selected pre-fixture result.
  const cleanupDeadline = Math.min(overall, now() + cleanupMs); let finishPromise;
  try {
    if (now() >= cleanupDeadline || clockInvalid) { failure(new Error("tenant_token_deadline"), "cleanup_failed"); finishPromise = Promise.resolve(effects.finish(phase)); finishPromise.catch(() => {}); }
    else { final = data(await step(() => effects.finish(phase), cleanupDeadline)); if (selected) { final = finalFact(final, held, settled); check(cleanupDeadline); cleanupConfirmed = true; } else final = null; }
  } catch (error) { failure(error, "cleanup_failed"); final = null; cleanupConfirmed = false; }
  const result = { schema: "meeting-tenant-token-evidence/v1", family: TENANT_FAMILY, provenance: "component", success: selected && cleanupConfirmed && failures.length === 0, failures, qualification, elapsedMs: Math.max(0, now() - start), polls, held, settlement: settled, final, cleanupConfirmed };
  // Serialization is part of the same absolute campaign ceiling.
  try { JSON.stringify(result); check(overall); } catch (error) { failure(error, "deadline"); result.success = false; result.cleanupConfirmed = false; }
  return freeze(result);
}
export function validateTenantTokenResult(input, provenance = "component") {
  const r = data(input); rec(r, ["schema", "family", "provenance", "success", "failures", "qualification", "elapsedMs", "polls", "held", "settlement", "final", "cleanupConfirmed"]);
  requireTenant(r.schema === "meeting-tenant-token-evidence/v1" && r.family === TENANT_FAMILY && r.provenance === provenance, "output_invalid"); bool(r.success); bool(r.cleanupConfirmed); time(r.elapsedMs); integer(r.polls, 512); validateTenantTokenQualification(r.qualification); array(r.failures, 12);
  for (const code of r.failures) requireTenant(typeof code === "string" && FAILURE.some(reason => code === `tenant_token_${reason}`), "output_invalid");
  if (r.held !== null) assertTenantTokenHeld(r.held); if (r.settlement !== null) { requireTenant(r.held !== null); settlement(r.settlement, r.held); } if (r.final !== null) { requireTenant(r.held !== null && r.settlement !== null); finalFact(r.final, r.held, r.settlement); }
  requireTenant(!r.success || r.failures.length === 0 && r.held && r.settlement && r.final && r.cleanupConfirmed && r.elapsedMs < 60000, "output_invalid"); requireTenant(!r.cleanupConfirmed || r.success, "output_invalid"); return freeze(r);
}
export function writeTenantTokenEvidence(out, input) {
  const result = validateTenantTokenResult(input); const bytes = Buffer.from(JSON.stringify(result, null, 2)); requireTenant(bytes.length <= 262144, "output_invalid");
  writeValidatedTenantEvidence(out, bytes);
}
export function writeValidatedTenantEvidence(out, bytes) {
  requireTenant(typeof out === "string" && path.isAbsolute(out) && path.resolve(out) === out, "output_invalid"); let current = path.parse(out).root;
  for (const part of out.slice(current.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); requireTenant(!lstatSync(current).isSymbolicLink(), "output_invalid"); }
  const stat = lstatSync(out); requireTenant(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, "output_invalid"); writeFileSync(path.join(out, "evidence.json"), bytes, { mode: 0o600, flag: "wx" });
}
export function parseTenantTokenArguments(argv) { const v = data(argv); requireTenant(Array.isArray(v) && v.length === 2 && v[0] === "--out", "output_invalid"); return parsePendingStartupArguments(v); }
export function qualifyTenantTokenSources(repository) {
  return validateTenantTokenQualification({ schema: "meeting-tenant-token-sources/v1", baselineSha256: BASE, sources: SOURCE_ROLES.map(role => ({ role, sha256: createHash("sha256").update(readFileSync(path.join(repository, role))).digest("hex") })) });
}
async function realMain(argv) {
  const { out } = parseTenantTokenArguments(argv); assertPendingStartupEnvironment(process.env);
  const startedAt = performance.now(), deadline = startedAt + 60000, check = () => requireTenant(performance.now() < deadline, "deadline");
  async function prepare(thunk) { check(); let timer; try { const pending = Promise.resolve(thunk()); pending.catch(() => {}); check(); const value = await Promise.race([pending, new Promise((_, reject) => { timer = globalThis.setTimeout(() => reject(new Error("tenant_token_deadline")), Math.max(1, deadline - performance.now())); })]); check(); return value; } finally { globalThis.clearTimeout(timer); } }
  const [staging, pins] = await prepare(() => Promise.all([import("./stage.mjs"), import("./pins.mjs")])); await prepare(() => pins.verifyPins()); check(); mkdirSync(out, { mode: 0o700 }); check();
  const staged = await prepare(() => staging.stage({ repository: path.resolve(import.meta.dirname, "..") }));
  const plan = { standaloneConfigPath: staged.standaloneConfigPath, databasePath: path.join(staged.directories.stateRoot, "orchestration.db"), directories: { recordingsDir: staged.directories.recordingsDir, outboxDir: staged.directories.outboxDir, receiptsDir: staged.directories.receiptsDir, control: staged.directories.control }, runtimePidsPath: staged.gatewayPidsPath, launcherLog: staged.launcherLog, keyPath: staged.keyPath };
  validatePendingStartupPlan(plan); check(); const qualification = await prepare(() => qualifyTenantTokenSources(staged.directories.app)), entry = await prepare(() => import(pathToFileURL(path.join(staged.directories.app, "e2e/tenant-token-entry.mjs")).href));
  check(); const result = await entry.runRealTenantToken(plan, qualification, startedAt); check(); validateTenantTokenResult(result, "attempted-application"); requireTenant(equal(qualification, result.qualification), "qualification_invalid"); check();
  requireTenant(readdirSync(out).length === 0, "output_invalid"); check(); entry.writeRealTenantTokenEvidence(out, result); check(); process.exitCode = result.success ? 0 : 70;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void realMain(process.argv.slice(2)).catch(() => { process.stderr.write("tenant_token_runner_refused\n"); process.exitCode = 70; });

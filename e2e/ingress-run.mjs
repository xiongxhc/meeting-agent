// Private two-owner ingress campaign. Imports have no application/SDK effects.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import Database from "better-sqlite3";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { observeProcessSnapshot, processCleanupProof } from "./process-evidence.mjs";
import { ADMISSION_HELPER_BASENAMES, ADMISSION_HELPER_ROLES, ADMISSION_HELPER_SCHEMA } from "./admission-helper-provenance.mjs";

export function requireIngress(value, reason) { if (!value) throw new Error(`ingress_${reason}`); }
export function ingressFailure(error, fallback) {
  const descriptor = error && (typeof error === "object" || typeof error === "function") ? Object.getOwnPropertyDescriptor(error, "message") : null;
  const message = descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null;
  return typeof message === "string" && message.length <= 128 && /^ingress_[A-Za-z_]+$/.test(message) ? message : fallback;
}
/** Getter-free bounded data copy before controls, effects or serialization. */
export function ingressData(value) {
  let nodes = 0;
  function visit(v, depth) {
    requireIngress(++nodes <= 16384 && depth <= 16, "data_extent");
    if (v === null || v === undefined || typeof v === "boolean") return v;
    if (typeof v === "number") { requireIngress(Number.isFinite(v), "data_number"); return v; }
    if (typeof v === "string") { requireIngress(Buffer.byteLength(v) <= 8192, "data_string"); return v; }
    requireIngress(typeof v === "object", "data_type");
    const array = Array.isArray(v), prototype = Object.getPrototypeOf(v);
    requireIngress(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null, "data_prototype");
    const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(descriptors);
    requireIngress(keys.length <= 512 && keys.every(key => typeof key === "string" && key !== "toJSON" && key !== "__proto__" &&
      Object.hasOwn(descriptors[key], "value")), "data_descriptor");
    const out = array ? [] : {};
    if (array) requireIngress(v.length <= 256 && keys.length === v.length + 1, "data_array");
    for (const key of keys) {
      if (array && key === "length") continue;
      requireIngress(!array || /^(0|[1-9][0-9]*)$/.test(key), "data_array");
      out[key] = visit(descriptors[key].value, depth + 1);
    }
    return out;
  }
  return visit(value, 0);
}
export function selectIngressSends(original, conflict) {
  original = ingressData(original); requireIngress(original.length === 4 && new Set(original.map(s => s.wireMessageId)).size === 4, "fresh_wire_ids");
  if (conflict === undefined) return original;
  conflict = ingressData(conflict); const first = original[0];
  requireIngress(conflict.eventId === first.eventId && conflict.occurrenceId === first.occurrenceId && conflict.title !== first.title &&
    /^[a-f0-9]{64}$/.test(conflict.hash) && conflict.hash !== first.hash, "conflict_selection");
  const selected = [original[0], { ...conflict, wireMessageId: "phase1-a-conflict" },
    { ...original[0], wireMessageId: "phase1-a-replay" }, ...original.slice(1)];
  requireIngress(new Set(selected.map(s => s.wireMessageId)).size === 6, "fresh_wire_ids");
  return selected.map((send, index) => ({ ...send, expectedCode: index === 1 ? 500 : 200 }));
}
export function assertIngressSelection(plan) {
  ingressData(plan);
  requireIngress(plan.conflictingReplay === undefined || plan.conflictingReplay === false || plan.conflictingReplay === true, "conflict_selection");
  requireIngress(plan.closedGenerationReopen === undefined || typeof plan.closedGenerationReopen === "boolean", "reopen_selection");
  requireIngress(!plan.closedGenerationReopen || !plan.missingLauncher && !plan.conflictingReplay, "reopen_selection");
  if (plan.phase !== 1 || !plan.sends) return;
  requireIngress(plan.sends.length === (plan.conflictingReplay ? 6 : 4) && new Set(plan.sends.map(s => s.wireMessageId)).size === plan.sends.length, "fresh_wire_ids");
  requireIngress(plan.sends.every(s => typeof s.wireMessageId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(s.wireMessageId)), "wire_id");
  if (!plan.conflictingReplay) { requireIngress(plan.sends.every(s => s.expectedCode === undefined || s.expectedCode === 200), "conflict_selection"); return; }
  const [first, conflict, replay] = plan.sends;
  requireIngress(plan.sends.every((s, i) => s.expectedCode === (i === 1 ? 500 : 200)) && conflict.wireMessageId === "phase1-a-conflict" &&
    replay.wireMessageId === "phase1-a-replay" && conflict.eventId === first.eventId && conflict.occurrenceId === first.occurrenceId &&
    conflict.title !== first.title && /^[a-f0-9]{64}$/.test(conflict.hash) && conflict.hash !== first.hash &&
    ["eventId", "hash", "title", "createTime", "inviteSeconds", "startSeconds", "occurrenceId"].every(k => replay[k] === first[k]), "conflict_selection");
}
function assertReply(send, delivery, code) {
  const receiver = ingressData(delivery.receiver);
  requireIngress(receiver && receiver.invalid === false && receiver.overflow === false && receiver.observations.length === 1, "ack_observation");
  const reply = receiver.observations[0];
  requireIngress(reply.kind === "ack" && reply.messageId === send.wireMessageId && reply.payload?.code === code &&
    Number.isSafeInteger(reply.ordinal) && reply.ordinal > 0, "ack_identity_order");
  return reply;
}
export function assertIngressConflict(send, delivery, before) {
  ingressData(send); ingressData(delivery); ingressData(before);
  requireIngress(send.expectedCode === 500 && before?.metadata.state === "metadata_blocked" &&
    before.events.some(e => e.eventId === send.eventId && e.hash !== send.hash), "conflict_prerequisite");
  assertReply(send, delivery, 500);
  requireIngress(delivery.commit === undefined || delivery.commit === null, "rejection_commit");
  requireIngress(JSON.stringify(delivery.state) === JSON.stringify(before), "conflict_mutation");
}
/** Retain decoded wire facts, never arbitrary SDK error bodies or headers. */
export function ingressReceiverFact(receiver) {
  receiver = ingressData(receiver);
  requireIngress(receiver && typeof receiver.invalid === "boolean" && typeof receiver.overflow === "boolean" && Array.isArray(receiver.observations), "receiver_history");
  return { invalid: receiver.invalid, overflow: receiver.overflow, observations: receiver.observations.map(row => {
    requireIngress(Number.isSafeInteger(row.ordinal) && row.ordinal > 0 && row.kind === "ack" && typeof row.messageId === "string" &&
      /^[A-Za-z0-9-]{1,128}$/.test(row.messageId) && (row.payload?.code === 200 || row.payload?.code === 500), "receiver_identity");
    return { ordinal: row.ordinal, kind: "ack", messageId: row.messageId, payload: { code: row.payload.code } };
  }) };
}
export function ingressFact(value) {
  value = ingressData(value);
  if (value?.receiver) value.receiver = ingressReceiverFact(value.receiver);
  if (value?.activity?.receiver) value.activity.receiver = ingressReceiverFact(value.activity.receiver);
  if (value?.ackObservations) value.ackObservations = ingressReceiverFact({ invalid: false, overflow: false, observations: value.ackObservations }).observations;
  return value;
}
const ingressImmutableFields = ["occurrenceId", "region", "tenantKey", "appId", "providerMeetingId", "meetingNo", "occurrenceStartedAt", "title", "acceptedAtMs"];
function ingressCloseRecord(value, keys, nested = []) {
  requireIngress(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)), "close_fields");
  for (const [key, field] of Object.entries(value)) if (!nested.includes(key)) {
    requireIngress(field === null || field === undefined || ["string", "boolean", "number"].includes(typeof field), "close_fields");
  }
}
function ingressCloseRows(rows, keys, nested = []) {
  requireIngress(Array.isArray(rows), "close_fields");
  for (const row of rows) ingressCloseRecord(row, keys, nested);
}
function ingressCloseState(state) {
  ingressCloseRecord(state, ["fileIdentity", "immutable", "metadata", "events", "sessions", "counts", "custody", "generations", "reopenEvidence"],
    ["immutable", "metadata", "events", "sessions", "counts", "custody", "generations", "reopenEvidence"]);
  ingressCloseRecord(state.immutable, ingressImmutableFields);
  ingressCloseRecord(state.metadata, ["state", "reason", "lastBlockedAtMs", "lastObservedAtMs", "claimed", "claimExpiresAtMs", "organizerId", "organizerSource",
    "reference", "admittedAtMs", "totalAttempts", "generationAttempts", "generationStartedAtMs", "firstAttemptAtMs", "lastAttemptAtMs", "retryGeneration",
    "operatorRetryCount", "lastOperator", "lastOperatorRetryAtMs", "nextAttemptAtMs"], ["reference"]);
  if (state.metadata.reference !== null && state.metadata.reference !== undefined) ingressCloseRecord(state.metadata.reference,
    ["kind", "reserveId", "calendarId", "eventId", "occurrenceId", "providerMeetingId", "occurrenceStartedAt", "vcOrganizerOpenId"]);
  ingressCloseRows(state.events, ["eventId", "hash", "title", "createTime", "inviteSeconds", "startSeconds", "acceptedAtMs"]);
  ingressCloseRows(state.sessions, ["occurrenceId", "providerMeetingId", "occurrenceStartedAt", "state", "terminalReason"]);
  ingressCloseRecord(state.counts, ["custody", "recording", "seed", "delivery", "notification"]);
  if (state.custody !== undefined) ingressCloseRows(state.custody, ["physicalClientId", "physicalGenerationId", "bridgeSessionId", "state", "failure", "recordedAtMs", "outcome", "reason"]);
  if (state.generations !== undefined) ingressCloseRows(state.generations, ["bridgeSessionId", "controlSessionId"]);
}
export function ingressCloseFact(value) {
  value = ingressData(value);
  const keys = ["standaloneExit", "compositionClosed", "peerClosed", "lockClosedLast", "cleanupFailures", "finalState", "keyCustody",
    "outcomes", "trace", "environmentKeys", "commitObservations", "ackObservations", "receiver", "observerFailure", "overflow", "history"];
  ingressCloseRecord(value, keys, ["cleanupFailures", "finalState", "outcomes", "trace", "environmentKeys", "commitObservations", "ackObservations", "receiver", "history"]);
  for (const key of ["compositionClosed", "peerClosed", "lockClosedLast", "observerFailure", "overflow"]) {
    requireIngress(value[key] === undefined || typeof value[key] === "boolean", "close_fields");
  }
  requireIngress(value.keyCustody === undefined || ["not_created", "private_runtime_file"].includes(value.keyCustody), "close_fields");
  if (value.finalState !== undefined && value.finalState !== null) { ingressCloseState(value.finalState); if (value.finalState.reopenEvidence) ingressReopenState(value.finalState); }
  if (value.history !== undefined) ingressHistoryFact(value.history);
  ingressCloseRows(value.outcomes, ["occurrenceId", "bridgeId", "organizer", "phase", "controlSessionId", "failure", "finalization", "custody", "runtimeClose", "runtimeCleanup"], ["organizer"]);
  for (const row of value.outcomes) {
    const choices = { phase: ["starting", "live", "settled"], failure: [null, "runtime_startup_aborted", "runtime_startup_timeout", "runtime_startup_failed",
      "application_closed", "physical_client_quarantined", "launch_failed", "join_failed", "media_format_rejected", "join_cancelled"],
    finalization: ["none", "seeded", "recorded", "stop_failed", "finalize_failed", "transaction_failed"],
    custody: ["not_applicable", "assigned", "existing", "refused", "unpersisted"], runtimeClose: ["pending", "closed", "failed"],
    runtimeCleanup: [null, "graceful", "forced", "failed", "unconfirmed"] };
    for (const [key, allowed] of Object.entries(choices)) requireIngress(row[key] === undefined || allowed.includes(row[key]), "close_fields");
    if (row.organizer !== undefined && row.organizer !== null) ingressCloseRecord(row.organizer, ["feishuUserId", "displayName", "source"]);
  }
  ingressCloseRows(value.commitObservations, ["ordinal", "wireMessageId", "eventId", "expectedHash", "persistedHash", "immutable", "ackFloor"], ["immutable"]);
  for (const row of value.commitObservations) if (row.immutable !== undefined) ingressCloseRecord(row.immutable, ingressImmutableFields);
  for (const key of ["trace", "environmentKeys", "cleanupFailures"]) if (value[key] !== undefined) {
    requireIngress(Array.isArray(value[key]) && value[key].every(row => typeof row === "string"), "close_fields");
  }
  return ingressFact(value);
}
// Selected reopen DTOs expose identity and lifecycle facts, never source paths or tokens.
const reopenRows = {
  generation: ["generationId", "occurrenceId", "bridgeSessionId", "controlSessionId", "handle", "terminalAtMs", "terminalSource", "terminalReason", "expiresAtMs"],
  timedOwner: ["generationId", "bridgeSessionId", "controlSessionId", "state", "tokenPresent"],
  recording: ["occurrenceId", "handle", "sha256", "keyId", "durationMs", "finalizedAtMs", "format", "captureDrain", "captureDrainReason", "captureDrainEpoch", "captureDrainLastFrameSequence", "captureDrainOutputEndSample", "captureDrainFinalPairSequence", "bytes", "device", "inode"],
  recovery: ["generationId", "occurrenceId", "bridgeSessionId", "controlSessionId", "handle", "sha256", "keyId", "kind", "failureAttempt"],
  physical: ["occurrenceId", "physicalClientId", "physicalGenerationId", "bridgeSessionId", "claimedAtMs", "clearedAtMs", "clearReason", "operatorPresent", "exitDiagnostic", "outcomeOccurrenceId", "outcomePhysicalClientId", "outcomePhysicalGenerationId", "outcomeBridgeSessionId", "observedAt"],
  unknownEnd: ["occurrenceId", "sourceKind", "failureAttempt", "handle", "sha256", "keyId", "bytes", "device", "inode", "detectedAtMs", "deadlineMs", "state", "claimed", "claimExpiresAtMs", "failure", "deletedAtMs", "lastObservedAtMs"],
};
export function ingressReopenState(value) {
  value = ingressData(value); ingressCloseState(value);
  const e = value.reopenEvidence;
  ingressCloseRecord(e, [...Object.keys(reopenRows), "counts"], [...Object.keys(reopenRows), "counts"]);
  for (const [name, keys] of Object.entries(reopenRows)) {
    ingressCloseRows(e[name], keys); requireIngress(e[name].length <= 1, "reopen_cardinality");
    for (const row of e[name]) {
      requireIngress(keys.every(key => Object.hasOwn(row, key)), "reopen_fields");
      const enums = { terminalSource: ["bridge_observed", "local_clock", "legacy_unknown"], terminalReason: ["ended", "removed", "bridge_failure"],
        captureDrain: ["confirmed", "unconfirmed"], kind: ["final", "bridge_failure"], sourceKind: ["final", "bridge_failure"],
        clearReason: ["departure_observed", "join_not_issued", "operator_inspected_idle"], exitDiagnostic: ["nonzero_exit"],
        state: name === "timedOwner" ? ["active", "recovering", "closed"] : ["assigned", "cleanup_claimed", "cleanup_failed", "deleted"],
        failure: ["identity_mismatch", "source_missing", "unsafe_source", "detach_failed", "reader_active", "quiescence_unproven"] };
      for (const [key, field] of Object.entries(row)) {
        if (field === null) continue;
        if (enums[key]) requireIngress(enums[key].includes(field), "reopen_fields");
        else if (["tokenPresent", "operatorPresent", "claimed"].includes(key)) requireIngress(typeof field === "boolean", "reopen_fields");
        else if (["handle", "sha256", "keyId", "device", "inode", "controlSessionId", "captureDrainEpoch", "captureDrainLastFrameSequence", "captureDrainOutputEndSample", "captureDrainFinalPairSequence"].includes(key)) {
          const pattern = key === "handle" ? /^[a-f0-9]{32}$/ : key === "sha256" ? /^[a-f0-9]{64}$/ : key === "keyId" ? /^[a-f0-9]{16}$/ : /^[0-9]{1,40}$/;
          requireIngress(typeof field === "string" && pattern.test(field), "reopen_fields");
        } else if (key === "observedAt") requireIngress(typeof field === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(field) && Number.isSafeInteger(Date.parse(field)), "reopen_fields");
        else if (typeof field === "number") requireIngress(Number.isSafeInteger(field) && field >= 0, "reopen_fields");
        else requireIngress(typeof field === "string" && (key === "format" ? /^[a-z0-9_/.-]{1,128}$/ : /^[A-Za-z0-9._@:-]{1,2048}$/).test(field), "reopen_fields");
      }
    }
  }
  ingressCloseRecord(e.counts, ["failedRecording", "alignmentAttempt"]);
  requireIngress(Object.keys(e.counts).length === 2 && Object.values(e.counts).every(n => Number.isSafeInteger(n) && n >= 0), "reopen_counts");
  return value;
}
export function assertIngressClosedGeneration(state, removal) {
  state = ingressReopenState(state); removal = ingressRemovalFact(removal);
  const e = state.reopenEvidence, [g] = e.generation, [t] = e.timedOwner, [r] = e.recording, [b] = e.recovery, [p] = e.physical, [u] = e.unknownEnd, [c] = state.custody ?? [];
  requireIngress(state.metadata.state === "admitted" && state.sessions.length === 1 && state.sessions[0].state === "finalizing" && state.sessions[0].terminalReason === null, "reopen_session");
  requireIngress(g && t && r && b && p && u && c && state.generations.length === 1 && state.counts.custody === 1 && state.counts.recording === 1 &&
    state.counts.seed === 0 && state.counts.delivery === 0 && state.counts.notification === 0 && e.counts.failedRecording === 0 && e.counts.alignmentAttempt === 0, "reopen_cardinality");
  const id = state.immutable.occurrenceId;
  requireIngress(g.occurrenceId === id && g.bridgeSessionId === removal.bridgeSessionId && g.controlSessionId === removal.controlSessionId &&
    g.terminalSource === "bridge_observed" && g.terminalReason === "removed" && g.terminalAtMs === Date.parse(removal.observedAt) &&
    g.expiresAtMs === g.terminalAtMs + 1209600000 && state.generations[0].bridgeSessionId === g.bridgeSessionId && state.generations[0].controlSessionId === g.controlSessionId, "reopen_generation");
  requireIngress(t.generationId === g.generationId && t.bridgeSessionId === g.bridgeSessionId && t.controlSessionId === g.controlSessionId && t.state === "closed" && typeof t.tokenPresent === "boolean", "reopen_timed_owner");
  requireIngress(/^[a-f0-9]{32}$/.test(r.handle) && /^[a-f0-9]{64}$/.test(r.sha256) && /^[a-f0-9]{16}$/.test(r.keyId) && r.occurrenceId === id &&
    r.handle === g.handle && b.generationId === g.generationId && b.occurrenceId === id && b.bridgeSessionId === g.bridgeSessionId && b.controlSessionId === g.controlSessionId &&
    b.handle === r.handle && b.sha256 === r.sha256 && b.keyId === r.keyId && b.kind === "final" && b.failureAttempt === null &&
    Number.isSafeInteger(r.durationMs) && r.durationMs >= 0 && Number.isSafeInteger(r.finalizedAtMs) && r.finalizedAtMs >= g.terminalAtMs &&
    typeof r.format === "string" && /^[a-z0-9_/.-]{1,128}$/.test(r.format) && r.captureDrain === "confirmed" && r.captureDrainReason === null &&
    r.captureDrainEpoch === removal.captureEpoch && r.captureDrainLastFrameSequence === removal.lastFrameSequence && r.captureDrainOutputEndSample === removal.outputEndSample &&
    r.captureDrainFinalPairSequence === removal.finalClockPairSequence, "reopen_recording");
  requireIngress(c.state === "cleared" && c.failure === null && c.outcome === "departure_confirmed" && c.reason === "departure_observed" &&
    c.bridgeSessionId === g.bridgeSessionId && p.occurrenceId === id && p.physicalClientId === c.physicalClientId && p.physicalGenerationId === c.physicalGenerationId &&
    p.bridgeSessionId === c.bridgeSessionId && p.outcomeOccurrenceId === id && p.outcomePhysicalClientId === c.physicalClientId &&
    p.outcomePhysicalGenerationId === c.physicalGenerationId && p.outcomeBridgeSessionId === c.bridgeSessionId && p.clearReason === "departure_observed" &&
    p.operatorPresent === false && p.exitDiagnostic === null && Number.isSafeInteger(p.claimedAtMs) && p.claimedAtMs <= g.terminalAtMs &&
    Number.isSafeInteger(c.recordedAtMs) && c.recordedAtMs >= Date.parse(p.observedAt) && Date.parse(p.observedAt) >= g.terminalAtMs && p.clearedAtMs === c.recordedAtMs, "reopen_physical");
  requireIngress(u.occurrenceId === id && u.sourceKind === "final" && u.failureAttempt === 0 && u.handle === r.handle && u.sha256 === r.sha256 && u.keyId === r.keyId &&
    Number.isSafeInteger(u.bytes) && u.bytes > 0 && u.bytes <= 8589934592 && /^[0-9]{1,40}$/.test(u.device) && /^[0-9]{1,40}$/.test(u.inode) &&
    u.bytes === r.bytes && u.device === r.device && u.inode === r.inode && Number.isSafeInteger(u.detectedAtMs) && u.detectedAtMs >= r.finalizedAtMs &&
    u.deadlineMs === u.detectedAtMs + 1209600000 && u.lastObservedAtMs === u.detectedAtMs && u.state === "assigned" && u.claimed === false &&
    u.claimExpiresAtMs === null && u.failure === null && u.deletedAtMs === null, "reopen_unknown_end");
}
export function ingressRemovalFact(value) {
  value = ingressData(value);
  const keys = ["reason", "observedAt", "observationTiming", "observationTimingReason", "bridgeSessionId", "controlSessionId", "captureEpoch", "lastFrameSequence", "outputEndSample", "finalClockPairSequence"];
  ingressCloseRecord(value, keys, ["observationTiming"]); requireIngress(keys.every(k => Object.hasOwn(value, k)), "removal_fields");
  ingressCloseRecord(value.observationTiming, ["clockDomainId", "hostBeforeNs", "hostAfterNs"]);
  const t = value.observationTiming;
  requireIngress(value.reason === "removed" && typeof value.observedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.observedAt) && Number.isSafeInteger(Date.parse(value.observedAt)) &&
    t.clockDomainId === "e2e-clock" && /^[0-9]{1,40}$/.test(t.hostBeforeNs) && /^[0-9]{1,40}$/.test(t.hostAfterNs) && BigInt(t.hostBeforeNs) <= BigInt(t.hostAfterNs) &&
    value.observationTimingReason === null && typeof value.bridgeSessionId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(value.bridgeSessionId) && /^[1-9][0-9]{0,19}$/.test(value.controlSessionId) &&
    ["captureEpoch", "lastFrameSequence", "outputEndSample", "finalClockPairSequence"].every(k => typeof value[k] === "string" && /^[1-9][0-9]{0,19}$/.test(value[k])), "removal_observation");
  return value;
}
export function ingressHistoryFact(value) {
  value = ingressData(value); ingressCloseRecord(value, ["runtime", "bridge", "files"], ["runtime", "bridge", "files"]);
  ingressCloseRecord(value.runtime, ["bytes", "sha256", "pids"], ["pids"]); ingressCloseRecord(value.bridge, ["bytes", "sha256", "pid"]);
  for (const row of [value.runtime, value.bridge]) requireIngress(Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= 1048576 && /^[a-f0-9]{64}$/.test(row.sha256), "history_extent");
  requireIngress(value.runtime.pids.length === 1 && value.runtime.pids.every(n => Number.isSafeInteger(n) && n > 0) && Number.isSafeInteger(value.bridge.pid) && value.bridge.pid > 0, "history_identity");
  ingressCloseRecord(value.files, ["recording", "outbox", "receipt", "key"]);
  requireIngress(value.files.recording === 1 && value.files.outbox === 0 && value.files.receipt === 0 && value.files.key === true, "history_files"); return value;
}
export function readIngressHistory(plan, files) {
  const runtime = boundedBytes(plan.runtimePidsPath), bridge = boundedBytes(path.join(plan.controlDir, "state.json"));
  const child = ingressData(JSON.parse(bridge.toString("utf8")));
  return ingressHistoryFact({ runtime: { bytes: runtime.length, sha256: createHash("sha256").update(runtime).digest("hex"),
    pids: runtime.toString("utf8").trim().split("\n").filter(Boolean).map(Number) },
    bridge: { bytes: bridge.length, sha256: createHash("sha256").update(bridge).digest("hex"), pid: child.pid }, files });
}
export function assertIngressReopenActivity(activity, history) {
  activity = ingressData(activity); history = ingressHistoryFact(history);
  requireIngress(activity.outcomes.length === 0 && activity.runtimePids.length === 0 && activity.bridge === null &&
    !activity.trace.some(code => code.startsWith("occurrence_")) && activity.messages.length === 0 &&
    activity.requests.length <= 2 && activity.requests.every(row => ["ws_endpoint", "tenant_access_token"].includes(row.route) && row.status === 200), "reopen_activity");
  requireIngress(JSON.stringify(ingressHistoryFact(activity.history)) === JSON.stringify(history) && JSON.stringify(activity.files) === JSON.stringify(history.files), "reopen_history");
  assertIngressIsolation({ counts: { seed: 0, delivery: 0, notification: 0 } }, activity, false);
}
export function assertIngressReopenDiscovery(fact) {
  fact = ingressData(fact); ingressCloseRecord(fact, ["resolved", "launched", "deferred"]);
  requireIngress(fact.resolved === 0 && fact.launched === 0 && fact.deferred === 0, "reopen_discovery");
}

export function ingressPathExists(filename) {
  try { lstatSync(filename); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function noSymlinkAncestors(filename) {
  const parsed = path.parse(filename); let current = parsed.root;
  for (const part of filename.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); requireIngress(!lstatSync(current).isSymbolicLink(), "symlink_path");
  }
}
export function boundedBytes(filename, optional = false) {
  if (optional && !ingressPathExists(filename)) return null;
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    requireIngress(stat.isFile() && stat.size <= 1048576, "file_extent");
    const bytes = readFileSync(fd);
    requireIngress(bytes.length <= 1048576, "file_overflow");
    return bytes;
  } finally { closeSync(fd); }
}
export function boundedJson(filename, optional = false) {
  const bytes = boundedBytes(filename, optional); return bytes === null ? null : JSON.parse(bytes.toString("utf8"));
}
export function parseIngressArguments(argv) {
  argv = ingressData(argv); requireIngress(Array.isArray(argv) && argv.every(v => typeof v === "string"), "argument");
  const options = { out: null, missingLauncher: false };
  for (let at = 0; at < argv.length; at++) {
    if (argv[at] === "--out" && options.out === null) {
      const value = argv[++at];
      requireIngress(typeof value === "string" && path.isAbsolute(value) && value !== "/" && path.normalize(value) === value &&
        [...value].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) && !ingressPathExists(value), "output_path");
      options.out = value;
    } else if (argv[at] === "--missing-launcher" && !options.missingLauncher) options.missingLauncher = true;
    else if (argv[at] === "--conflicting-replay" && options.conflictingReplay === undefined) options.conflictingReplay = true;
    else if (argv[at] === "--closed-generation-reopen" && options.closedGenerationReopen === undefined) options.closedGenerationReopen = true;
    else throw new Error("ingress_argument");
  }
  requireIngress(!options.closedGenerationReopen || !options.missingLauncher && !options.conflictingReplay, "reopen_selection");
  requireIngress(options.out !== null, "output_required"); return options;
}

/** Only SELECT/readonly PRAGMAs. Guard the regular no-follow file/header before
 * SQLite can create WAL sidecars. The private parent protects readable DB bits. */
export function readIngressState(input) {
  input = ingressData(input);
  const { databasePath, occurrenceId, closedGenerationReopen = false } = input;
  requireIngress(typeof closedGenerationReopen === "boolean", "reader_selection");
  requireIngress(typeof databasePath === "string" && path.isAbsolute(databasePath) && path.normalize(databasePath) === databasePath &&
    typeof occurrenceId === "string" && occurrenceId.length > 0 && Buffer.byteLength(occurrenceId) <= 4096, "reader_arguments");
  noSymlinkAncestors(databasePath);
  const parent = lstatSync(path.dirname(databasePath)), file = lstatSync(databasePath);
  requireIngress(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid() && (parent.mode & 0o077) === 0 &&
    file.isFile() && !file.isSymbolicLink() && file.nlink === 1 && file.uid === process.getuid() && (file.mode & 0o022) === 0, "private_database");
  requireIngress(!ingressPathExists(`${databasePath}-wal`) && !ingressPathExists(`${databasePath}-shm`), "reader_WAL");
  const fd = openSync(databasePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let db;
  try {
    const held = fstatSync(fd), header = Buffer.alloc(100);
    requireIngress(held.isFile() && held.dev === file.dev && held.ino === file.ino && readSync(fd, header, 0, 100, 0) === 100 &&
      header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")) && header[18] === 1 && header[19] === 1, "database_header_nonWAL");
    const guard = () => { const now = lstatSync(databasePath), directory = lstatSync(path.dirname(databasePath));
      requireIngress(directory.isDirectory() && !directory.isSymbolicLink() && directory.dev === parent.dev && directory.ino === parent.ino &&
      now.isFile() && !now.isSymbolicLink() && now.nlink === 1 && now.uid === held.uid && (now.mode & 0o022) === 0 && now.dev === held.dev && now.ino === held.ino &&
      !ingressPathExists(`${databasePath}-wal`) && !ingressPathExists(`${databasePath}-shm`), "database_identity_WAL"); };
    guard(); db = new Database(databasePath, { readonly: true, fileMustExist: true }); guard();
    requireIngress(db.readonly && db.pragma("journal_mode", { simple: true }) !== "wal", "reader_WAL");
    const state = db.transaction(() => {
      requireIngress(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version === 30, "schema29_required");
      requireIngress(db.prepare("SELECT count(*) AS n FROM feishu_invite_occurrences").get().n === 1, "occurrence_count");
      const immutable = db.prepare(`SELECT occurrence_id AS occurrenceId,region,tenant_key AS tenantKey,app_id AS appId,
        provider_meeting_id AS providerMeetingId,meeting_no AS meetingNo,occurrence_started_at AS occurrenceStartedAt,
        title,accepted_at_ms AS acceptedAtMs FROM feishu_invite_occurrences WHERE occurrence_id=?`).get(occurrenceId);
      requireIngress(immutable, "occurrence_missing");
      const metadata = db.prepare(`SELECT state,last_blocked_reason AS reason,last_blocked_at_ms AS lastBlockedAtMs,
        last_observed_at_ms AS lastObservedAtMs,claim_token IS NOT NULL AS claimed,
        claim_expires_at_ms AS claimExpiresAtMs,organizer_open_id AS organizerId,organizer_source AS organizerSource,
        reference_json AS reference,admitted_at_ms AS admittedAtMs,total_attempts AS totalAttempts,generation_attempts AS generationAttempts,
        generation_started_at_ms AS generationStartedAtMs,first_attempt_at_ms AS firstAttemptAtMs,last_attempt_at_ms AS lastAttemptAtMs,
        retry_generation AS retryGeneration,operator_retry_count AS operatorRetryCount,last_operator AS lastOperator,
        last_operator_retry_at_ms AS lastOperatorRetryAtMs,next_attempt_at_ms AS nextAttemptAtMs
        FROM feishu_invite_occurrences WHERE occurrence_id=?`).get(occurrenceId);
      metadata.reference = metadata.reference === null ? null : JSON.parse(metadata.reference);
      const events = db.prepare(`SELECT event_id AS eventId,normalized_sha256 AS hash,topic AS title,
        create_time AS createTime,invite_seconds AS inviteSeconds,start_seconds AS startSeconds,accepted_at_ms AS acceptedAtMs
        FROM feishu_invite_events WHERE occurrence_id=? ORDER BY event_id LIMIT 4`).all(occurrenceId);
      requireIngress(events.length <= 3 && db.prepare("SELECT count(*) AS n FROM feishu_invite_events").get().n === events.length, "audit_count");
      const sessions = db.prepare(`SELECT occurrence_id AS occurrenceId,provider_meeting_id AS providerMeetingId,
        occurrence_started_at AS occurrenceStartedAt,state,terminal_reason AS terminalReason FROM sessions LIMIT 2`).all();
      requireIngress(sessions.length <= 1 && sessions.every(row => row.occurrenceId === occurrenceId), "session_count");
      const counts = {};
      for (const [name, table] of Object.entries({ custody: "physical_client_custody", recording: "recordings", seed: "backfill_seeds",
        delivery: "delivery_journal", notification: "notification_intents" })) {
        counts[name] = db.prepare(`SELECT count(*) AS n FROM ${table} WHERE occurrence_id=?`).get(occurrenceId).n;
        requireIngress(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n === counts[name], "foreign_occurrence");
      }
      const custody = db.prepare(`SELECT physical_client_id AS physicalClientId,physical_generation_id AS physicalGenerationId,
        bridge_session_id AS bridgeSessionId,state,outcome_failure AS failure,outcome_recorded_at_ms AS recordedAtMs,
        json_extract(outcome_json,'$.outcome') AS outcome,json_extract(outcome_json,'$.reason') AS reason
        FROM physical_client_custody WHERE occurrence_id=? LIMIT 2`).all(occurrenceId);
      const generations = db.prepare(`SELECT bridge_session_id AS bridgeSessionId,runtime_session_id AS controlSessionId
        FROM reconciliation_generations WHERE occurrence_id=? LIMIT 2`).all(occurrenceId);
      requireIngress(custody.length <= 1 && generations.length <= 1, "binding_count");
      let reopenEvidence;
      if (closedGenerationReopen) {
        // All rows share the same guarded readonly transaction. Global counts
        // refuse foreign or extra sources; LIMIT 2 only bounds returned facts.
        const rows = (table, sql) => {
          const found = db.prepare(sql).all(occurrenceId);
          requireIngress(found.length <= 1 && db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n === found.length, "reopen_cardinality"); return found;
        };
        const generation = rows("reconciliation_generations", `SELECT generation_id AS generationId,occurrence_id AS occurrenceId,
          bridge_session_id AS bridgeSessionId,runtime_session_id AS controlSessionId,recording_handle AS handle,
          terminal_at_ms AS terminalAtMs,terminal_source AS terminalSource,terminal_reason AS terminalReason,expires_at_ms AS expiresAtMs
          FROM reconciliation_generations WHERE occurrence_id=? LIMIT 2`);
        const timedOwner = rows("timed_evidence_owners", `SELECT o.generation_id AS generationId,g.bridge_session_id AS bridgeSessionId,
          g.runtime_session_id AS controlSessionId,o.state,o.owner_token IS NOT NULL AS tokenPresent
          FROM timed_evidence_owners o JOIN reconciliation_generations g ON g.generation_id=o.generation_id WHERE g.occurrence_id=? LIMIT 2`);
        for (const row of timedOwner) row.tokenPresent = row.tokenPresent === 1;
        const recording = rows("recordings", `SELECT occurrence_id AS occurrenceId,handle,sha256,key_id AS keyId,duration_ms AS durationMs,
          finalized_at_ms AS finalizedAtMs,format,capture_drain AS captureDrain,capture_drain_reason AS captureDrainReason,
          capture_drain_epoch AS captureDrainEpoch,capture_drain_last_frame_sequence AS captureDrainLastFrameSequence,
          capture_drain_output_end_sample AS captureDrainOutputEndSample,capture_drain_final_pair_sequence AS captureDrainFinalPairSequence
          FROM recordings WHERE occurrence_id=? LIMIT 2`);
        for (const row of recording) {
          const internal = db.prepare("SELECT encrypted_path AS source FROM recordings WHERE occurrence_id=?").get(occurrenceId);
          requireIngress(typeof internal.source === "string" && path.isAbsolute(internal.source) && path.normalize(internal.source) === internal.source, "recording_source");
          noSymlinkAncestors(internal.source); const file = lstatSync(internal.source);
          requireIngress(file.isFile() && !file.isSymbolicLink() && file.nlink === 1 && file.uid === process.getuid() && (file.mode & 0o077) === 0 && file.size > 0 && file.size <= 8589934592, "recording_source");
          row.bytes = file.size; row.device = String(file.dev); row.inode = String(file.ino);
        }
        const recovery = rows("recording_recovery_bindings", `SELECT generation_id AS generationId,occurrence_id AS occurrenceId,
          bridge_session_id AS bridgeSessionId,source_session_id AS controlSessionId,recording_handle AS handle,sha256,key_id AS keyId,
          recording_kind AS kind,failure_attempt AS failureAttempt FROM recording_recovery_bindings WHERE occurrence_id=? LIMIT 2`);
        const physical = rows("physical_client_custody", `SELECT occurrence_id AS occurrenceId,physical_client_id AS physicalClientId,
          physical_generation_id AS physicalGenerationId,bridge_session_id AS bridgeSessionId,claimed_at_ms AS claimedAtMs,
          cleared_at_ms AS clearedAtMs,clear_reason AS clearReason,clear_operator IS NOT NULL AS operatorPresent,exit_diagnostic AS exitDiagnostic,
          json_extract(outcome_json,'$.occurrenceId') AS outcomeOccurrenceId,json_extract(outcome_json,'$.physicalClientId') AS outcomePhysicalClientId,
          json_extract(outcome_json,'$.physicalGenerationId') AS outcomePhysicalGenerationId,json_extract(outcome_json,'$.bridgeSessionId') AS outcomeBridgeSessionId,
          json_extract(outcome_json,'$.observedAt') AS observedAt FROM physical_client_custody WHERE occurrence_id=? LIMIT 2`);
        for (const row of physical) row.operatorPresent = row.operatorPresent === 1;
        const unknownEnd = rows("unknown_end_custody", `SELECT occurrence_id AS occurrenceId,source_kind AS sourceKind,failure_attempt AS failureAttempt,
          recording_handle AS handle,recording_sha256 AS sha256,recording_key_id AS keyId,recording_bytes AS bytes,recording_device AS device,recording_inode AS inode,
          unknown_end_detected_at_ms AS detectedAtMs,unknown_end_deadline_ms AS deadlineMs,state,cleanup_claim_token IS NOT NULL AS claimed,
          cleanup_claim_expires_at_ms AS claimExpiresAtMs,cleanup_failure_reason AS failure,deleted_at_ms AS deletedAtMs,last_observed_at_ms AS lastObservedAtMs
          FROM unknown_end_custody WHERE occurrence_id=? LIMIT 2`);
        for (const row of unknownEnd) row.claimed = row.claimed === 1;
        const extraCounts = {};
        for (const [name, table] of Object.entries({ failedRecording: "bridge_failure_recordings", alignmentAttempt: "recording_alignment_attempts" })) {
          extraCounts[name] = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
        }
        reopenEvidence = { generation, timedOwner, recording, recovery, physical, unknownEnd, counts: extraCounts };
      }
      const result = { fileIdentity: `${parent.dev}:${parent.ino}:${parent.birthtimeMs}:${held.dev}:${held.ino}:${held.birthtimeMs}`, immutable, metadata, events, sessions, counts, custody, generations,
        ...(closedGenerationReopen ? { reopenEvidence } : {}) };
      return closedGenerationReopen ? ingressReopenState(result) : result;
    })(); guard(); return state;
  } finally { db?.close(); closeSync(fd); }
}
export function assertIngressAudit(state, expected, immutable) {
  if (immutable) assert.deepEqual(state.immutable, immutable);
  requireIngress(state.events.length === expected.length, "audit_count");
  for (const event of expected) {
    const actual = state.events.find(row => row.eventId === event.eventId);
    requireIngress(actual && ["eventId", "hash", "title", "createTime", "inviteSeconds", "startSeconds"].every(key => actual[key] === event[key]), "audit_identity");
  }
}
export function assertIngressAck(send, delivery, immutable) {
  ingressData(send); ingressData(delivery); ingressData(immutable);
  const { commit, receiver } = delivery;
  assertReply(send, delivery, 200);
  requireIngress(commit && receiver && !receiver.invalid && !receiver.overflow, "ack_observation");
  requireIngress(commit.wireMessageId === send.wireMessageId && commit.eventId === send.eventId && commit.expectedHash === send.hash &&
    commit.persistedHash === send.hash && commit.immutable.occurrenceId === send.occurrenceId && Number.isSafeInteger(commit.ordinal) && commit.ordinal > 0, "commit_identity");
  if (immutable) assert.deepEqual(commit.immutable, immutable);
  const replies = receiver.observations;
  requireIngress(replies.length === 1 && replies[0].kind === "ack" && replies[0].messageId === send.wireMessageId &&
    replies[0].payload?.code === 200 && replies[0].ordinal > commit.ackFloor, "ack_identity_order");
}
export function assertIngressReceiver(receiver, expected) {
  ingressData(receiver); ingressData(expected);
  requireIngress(receiver && receiver.invalid === false && receiver.overflow === false && receiver.observations.length === expected.length, "receiver_history");
  let ordinal = 0; const seen = new Set();
  for (const [index, row] of receiver.observations.entries()) {
    const send = expected[index], id = typeof send === "string" ? send : send.wireMessageId, code = typeof send === "string" ? 200 : send.expectedCode ?? 200;
    requireIngress(row.kind === "ack" && row.payload?.code === code && row.messageId === id && !seen.has(id) &&
      Number.isSafeInteger(row.ordinal) && row.ordinal > ordinal, "receiver_identity");
    seen.add(id); ordinal = row.ordinal;
  }
}
const forbiddenKeys = ["E2E_RUNTIME_RECORDING_KEY", "E2E_RECORDING_KEY", "E2E_PROVIDER_CREDENTIAL", "FEISHU_APP_SECRET", "RUNTIME_SECRET", "NODE_OPTIONS"];
export function assertIngressIsolation(state, activity, blocked = true) {
  requireIngress(state.counts.seed === 0 && state.counts.delivery === 0 && state.counts.notification === 0 && activity.messages.length === 0 &&
    activity.files.outbox === 0 && activity.files.receipt === 0, "publication_isolation");
  requireIngress(forbiddenKeys.every(key => !activity.envKeys.includes(key)), "environment_boundary");
  if (!blocked) return;
  const m = state.metadata;
  requireIngress(m.state === "metadata_blocked" && m.reason === "metadata_unavailable" && m.claimed === 0 && m.claimExpiresAtMs === null &&
    m.organizerId === null && m.organizerSource === null && m.reference === null && m.admittedAtMs === null && state.sessions.length === 0 &&
    Object.values(state.counts).every(n => n === 0) && activity.runtimePids.length === 0 && activity.bridge === null && activity.outcomes.length === 0 &&
    !activity.trace.some(code => code.startsWith("occurrence_")) && activity.files.recording === 0 && activity.files.key === false, "blocked_isolation");
}
export function assertIngressRetry(before, result) {
  requireIngress(result.result === "pending", "public_retry");
  const state = result.state, m = state.metadata, old = before.metadata;
  assertIngressAudit(state, before.events, before.immutable); assert.deepEqual(state.events, before.events);
  requireIngress(state.fileIdentity === before.fileIdentity && state.sessions.length === 0 && m.state === "pending_metadata" && m.claimed === 0 &&
    m.retryGeneration === old.retryGeneration + 1 && m.operatorRetryCount === old.operatorRetryCount + 1 && m.lastOperator === "e2e-ingress-operator" &&
    m.totalAttempts === old.totalAttempts && m.generationAttempts === 0 && m.generationStartedAtMs === null &&
    m.firstAttemptAtMs === old.firstAttemptAtMs && m.lastAttemptAtMs === old.lastAttemptAtMs && m.lastOperatorRetryAtMs >= before.immutable.acceptedAtMs &&
    m.nextAttemptAtMs === m.lastOperatorRetryAtMs && m.organizerId === null && m.reference === null && m.admittedAtMs === null, "retry_projection");
  assert.deepEqual(state.counts, before.counts);
}
export function assertIngressLaunch(before, fact, missingLauncher) {
  const { state, activity: a } = fact, m = state.metadata;
  assertIngressAudit(state, before.events, before.immutable); assert.deepEqual(state.events, before.events);
  requireIngress(state.fileIdentity === before.fileIdentity && m.state === "admitted" && m.organizerId === "ou_e2e_organizer" && m.organizerSource === "reservation" &&
    m.reference?.kind === "reservation" && m.reference.reserveId === "reserve-e2e-1" && m.admittedAtMs !== null && m.claimed === 0 &&
    m.retryGeneration === before.metadata.retryGeneration + 1 && m.operatorRetryCount === before.metadata.operatorRetryCount + 1 &&
    m.totalAttempts === before.metadata.totalAttempts + 1 && m.generationAttempts === 1 && state.sessions.length === 1 &&
    state.sessions[0].occurrenceId === before.immutable.occurrenceId && state.sessions[0].providerMeetingId === before.immutable.providerMeetingId &&
    state.sessions[0].occurrenceStartedAt === before.immutable.occurrenceStartedAt, "admitted_projection");
  requireIngress(["reserve_active_meeting", "reserve_get", "contact_user_get"].every(route => a.requests.some(r => r.route === route && r.status === 200)), "metadata_requests");
  requireIngress(a.trace.filter(code => code === "occurrence_launched").length === 1 && a.outcomes.length === 1, "one_launch");
  const outcome = a.outcomes[0]; requireIngress(outcome.occurrenceId === before.immutable.occurrenceId, "launch_occurrence");
  assertIngressIsolation(state, a, false);
  if (missingLauncher) {
    requireIngress(outcome.phase === "settled" && outcome.failure === "runtime_startup_failed" && outcome.controlSessionId === null &&
      outcome.finalization === "none" && outcome.custody === "not_applicable" && state.sessions[0].state === "discovered" &&
      !a.trace.includes("occurrence_runtime_connected") && a.runtimePids.length === 0 && a.bridge === null &&
      state.counts.custody === 0 && state.counts.recording === 0 && a.files.recording === 0 && !a.files.key, "lazy_start_failure");
  } else {
    const b = a.bridge;
    requireIngress(outcome.phase === "live" && outcome.failure === null && /^[1-9][0-9]*$/.test(outcome.controlSessionId ?? "") &&
      a.trace.filter(code => code === "occurrence_runtime_connected").length === 1 && a.runtimePids.length === 1 && b?.joined && b.mediaConnected &&
      b.framesSent > 0 && b.bound && b.occurrenceId === outcome.occurrenceId && b.controlSessionId === outcome.controlSessionId &&
      Number.isSafeInteger(b.pid) && b.pid > 0 && state.counts.custody === 1 && forbiddenKeys.every(key => !b.envKeys.includes(key)), "actual_live_binding");
  }
}
export function assertIngressClose(close) {
  requireIngress(close?.standaloneExit === 0 && close.compositionClosed && close.peerClosed && close.lockClosedLast && close.cleanupFailures.length === 0, "owner_cleanup");
  requireIngress(close.outcomes.every(row => !["stop_failed", "finalize_failed", "transaction_failed"].includes(row.finalization) &&
    !["refused", "unpersisted"].includes(row.custody) && row.runtimeClose !== "failed" &&
    !["forced", "unconfirmed"].includes(row.runtimeCleanup)), "custody_cleanup");
}
export function assertIngressFinalReceiver(close, sends, commits) {
  requireIngress(close.observerFailure === false && close.overflow === false, "final_observer_failure");
  assertIngressReceiver(close.receiver, sends);
  assert.deepEqual(close.ackObservations, close.receiver.observations);
  assert.deepEqual(close.commitObservations, commits);
  requireIngress(close.commitObservations.length === sends.filter(s => s.expectedCode !== 500).length, "final_commit_count");
  let index = 0;
  for (const send of sends) {
    if (send.expectedCode === 500) { requireIngress(!close.commitObservations.some(c => c.wireMessageId === send.wireMessageId), "rejection_commit"); continue; }
    assertIngressAck(send, { commit: close.commitObservations[index], receiver: { ...close.receiver,
      observations: close.receiver.observations.filter(row => row.messageId === send.wireMessageId) } }, commits[index].immutable); index++;
  }
}

/** Real adapter and component tests retain identical bounded command facts.
 * Never retain process listings or arbitrary stderr/error text. */
export function observeIngressInventory(evidence, { result, rootPid, owner, stage, baseline = false }) {
  const inventory = evidence.inventory; inventory.outcomes ??= [];
  const stderr = typeof result?.stderr === "string" && Buffer.byteLength(result.stderr) <= 8192 ? result.stderr : "";
  const allowed = stderr.split("\n").find(line => /^ps: (Operation not permitted|Permission denied|Not supported|Operation not supported)$/.test(line.trim()));
  const outcome = { ordinal: inventory.outcomes.length + 1, stage: /^[a-z0-9-]{1,64}$/.test(stage) ? stage : "unknown",
    command: ["/bin/ps", "-eo", "pid=,ppid=,comm="], exit: Number.isInteger(result?.exit) ? result.exit : null,
    signal: /^SIG[A-Z0-9]{1,12}$/.test(result?.signal ?? "") ? result.signal : null,
    diagnostic: allowed?.trim() ?? (result?.exit === 0 && !result.error ? "none" : "inventory_command_failed"),
    durationMs: Number.isFinite(result?.durationMs) && result.durationMs >= 0 ? result.durationMs : null, classified: "pending" };
  if (inventory.outcomes.length === 256) {
    outcome.classified = "refused"; inventory.overflowOutcome ??= outcome;
    if (!inventory.failures.includes("inventory_history_overflow")) inventory.failures.push("inventory_history_overflow");
    throw new Error("ingress_inventory_history_overflow");
  }
  inventory.outcomes.push(outcome);
  try {
    requireIngress(typeof result?.stdout === "string" && Buffer.byteLength(result.stdout) <= 1048576, "inventory_output_extent");
    const rows = observeProcessSnapshot(evidence, { result, rootPid, owner, baseline }); outcome.classified = "observed";
    // Bounded parent edges for owner-rooted samples. Helper attribution needs every sighting to be
    // the owner's direct child with the role's fixed executable basename; raw comm is not retained.
    if (!baseline) for (const row of rows) {
      if (row.pid === rootPid) continue;
      const edges = evidence.directChildren ??= [], base = row.comm.slice(row.comm.lastIndexOf("/") + 1);
      const helper = ADMISSION_HELPER_BASENAMES.includes(base) ? base : null;
      if (edges.some(e => e.owner === owner && e.parentPid === row.ppid && e.pid === row.pid && e.helper === helper)) continue;
      if (edges.length < 256) edges.push({ owner, parentPid: row.ppid, pid: row.pid, helper });
      else evidence.directChildrenOverflow = true;
    }
    return rows;
  } catch {
    outcome.classified = "refused";
    if (!inventory.failures.includes("process_inventory_unavailable")) inventory.failures.push("process_inventory_unavailable");
    throw new Error("ingress_process_inventory_unavailable");
  }
}
export function ingressProcessProof(evidence, owner, probe) {
  const owned = owner === undefined ? evidence : { inventory: evidence.inventory,
    observed: evidence.observed.filter(row => row.origins.includes(owner)), children: evidence.children.filter(row => row.role === owner) };
  // Keep each boundary proof fixed while the campaign's sticky ledger grows.
  return globalThis.structuredClone(processCleanupProof({ evidence: owned, probe }));
}

/** Closed owner-side helper record; any extra field, order or shape refuses. */
export function ingressAdmissionHelperFact(value) {
  value = ingressData(value);
  ingressCloseRecord(value, ["schema", "ownerPid", "invalid", "helpers"], ["helpers"]);
  requireIngress(value.schema === ADMISSION_HELPER_SCHEMA && Number.isSafeInteger(value.ownerPid) && value.ownerPid > 0 && typeof value.invalid === "boolean" &&
    Array.isArray(value.helpers) && value.helpers.length <= ADMISSION_HELPER_ROLES.length, "admission_helper_record");
  ingressCloseRows(value.helpers, ["sequence", "role", "pid", "exitObserved", "closeObserved", "code", "signal"]);
  for (const [index, row] of value.helpers.entries()) requireIngress(row.sequence === index + 1 && row.role === ADMISSION_HELPER_ROLES[index] &&
    (row.pid === null || Number.isSafeInteger(row.pid) && row.pid > 0) && typeof row.exitObserved === "boolean" && typeof row.closeObserved === "boolean" &&
    (row.code === null || Number.isInteger(row.code)) && (row.signal === null || /^SIG[A-Z0-9]{1,12}$/.test(row.signal)), "admission_helper_record");
  requireIngress(new Set(value.helpers.map(row => row.pid)).size === value.helpers.length, "admission_helper_record");
  return value;
}
/** Registered helpers that settled cleanly and are not the owner itself. */
function settledAdmissionHelpers(helpers, ownerPid) {
  if (helpers === undefined) return [];
  const record = ingressAdmissionHelperFact(helpers);
  if (record.invalid || record.ownerPid !== ownerPid) return [];
  return record.helpers.filter(row => row.pid !== null && row.pid !== ownerPid && row.exitObserved && row.closeObserved && row.code === 0 && row.signal === null);
}
/** Tags an observed phase descendant only when the owner registered it as a settled
 * lock helper and a sample showed it as the owner's direct child. Never drops a PID. */
export function attributeIngressAdmissionHelpers(evidence, { role, ownerPid, helpers }) {
  requireIngress(typeof role === "string" && /^ingress-phase-[0-9]$/.test(role) && Number.isSafeInteger(ownerPid) && ownerPid > 0, "admission_helper_attribution");
  const tag = `${role}-admission-helper`; let attributed = 0;
  for (const helper of settledAdmissionHelpers(helpers, ownerPid)) {
    const row = evidence.observed.find(entry => entry.pid === helper.pid && entry.origins.includes(role));
    // A reused PID shows up as another parent or executable in some sample and is refused.
    const sightings = (evidence.directChildren ?? []).filter(edge => edge.owner === role && edge.pid === helper.pid);
    const basename = ADMISSION_HELPER_BASENAMES[ADMISSION_HELPER_ROLES.indexOf(helper.role)];
    if (!row || evidence.directChildrenOverflow || !sightings.length || !sightings.every(edge => edge.parentPid === ownerPid && edge.helper === basename)) continue;
    if (!row.origins.includes(tag)) row.origins.push(tag);
    attributed++;
  }
  return attributed;
}

/** Exactly one unattributed phase-3 origin, the owner. Any other phase-3 PID must
 * carry the helper tag and match a settled registered helper in the same record. */
/** Parent close-time owner proof: helper attribution and the origin oracle only for the reopen owner. */
export function ingressOwnerCloseProof(evidence, { phasePlan, role, ownerPid, result }, probe) {
  let failure = false;
  const reopenOwner = phasePlan?.closedGenerationReopen === true && phasePlan.phase === 3;
  if (reopenOwner && result?.admissionHelpers !== undefined) {
    try { attributeIngressAdmissionHelpers(evidence, { role, ownerPid, helpers: result.admissionHelpers }); } catch { failure = true; }
  }
  const ownerProcessProof = ingressProcessProof(evidence, role, probe);
  if (reopenOwner) {
    try { assertIngressReopenOrigins(ownerProcessProof, ownerPid, result?.admissionHelpers); } catch { failure = true; }
  }
  return { ownerProcessProof, failure };
}
export function assertIngressReopenOrigins(proof, ownerPid, helpers) {
  proof = ingressReopenProcessFact(proof);
  const role = "ingress-phase-3", tag = `${role}-admission-helper`;
  let registered = [];
  try { registered = settledAdmissionHelpers(helpers, ownerPid).map(row => row.pid); } catch { registered = []; }
  const owners = proof.pids.filter(row => !row.origins.includes(tag)), attributed = proof.pids.filter(row => row.origins.includes(tag));
  const samePids = (a, b) => JSON.stringify(a.map(row => row.pid).sort((x, y) => x - y)) === JSON.stringify(b.map(row => row.pid).sort((x, y) => x - y));
  requireIngress(Number.isSafeInteger(ownerPid) && ownerPid > 0 && proof.cleanupConfirmed === true && proof.processInventoryVerified === true &&
    proof.knownOwnedChildrenReaped === true && owners.length === 1 && owners[0].pid === ownerPid && owners[0].origins.includes(role) &&
    attributed.length <= ADMISSION_HELPER_ROLES.length && attributed.every(row => row.pid !== ownerPid && row.origins.includes(role) && registered.includes(row.pid)) &&
    proof.probes.length === proof.pids.length && samePids(proof.probes, proof.pids) &&
    proof.probes.every(row => row.status === "absent" && row.origins.includes(role) && row.origins.includes(tag) === (row.pid !== ownerPid)) &&
    proof.children.length === 1 &&
    proof.children[0].role === role && proof.children[0].pid === ownerPid && proof.children[0].outcome.exitObserved === true &&
    proof.children[0].outcome.code === 0 && proof.children[0].outcome.signal === null, "reopen_process_origins");
}
export function ingressReopenPhaseFact(value) {
  value = ingressData(value);
  ingressCloseRecord(value, ["success", "phase", "root", "databasePath", "state", "activity", "close", "removal", "observations", "failures", "ownerProcessProof", "child", "processBindingObserved", "admissionHelpers"],
    ["state", "activity", "close", "removal", "observations", "failures", "ownerProcessProof", "child", "admissionHelpers"]);
  requireIngress(typeof value.success === "boolean" && [1, 2, 3].includes(value.phase) && typeof value.root === "string" && typeof value.databasePath === "string", "reopen_report");
  if (value.state !== undefined) value.state = ingressReopenState(value.state);
  if (value.close !== undefined) {
    value.close = ingressCloseFact(value.close);
    for (const key of ["trace", "environmentKeys", "cleanupFailures"]) if (value.close[key]) requireIngress(value.close[key].every(v => /^[A-Za-z0-9_]{1,128}$/.test(v)), "reopen_report");
  }
  if (value.removal !== undefined) value.removal = ingressRemovalFact(value.removal);
  if (value.activity !== undefined) {
    const a = value.activity;
    ingressCloseRecord(a, ["trace", "requests", "messages", "runtimePids", "bridge", "outcomes", "receiver", "files", "history", "envKeys"],
      ["trace", "requests", "messages", "runtimePids", "bridge", "outcomes", "receiver", "files", "history", "envKeys"]);
    ingressCloseRows(a.requests, ["method", "route", "status"]);
    requireIngress(a.requests.every(r => ["ws_endpoint", "tenant_access_token", "reserve_active_meeting", "reserve_get", "contact_user_get", "unmatched"].includes(r.route) &&
      [200, 404].includes(r.status) && (r.method === undefined || ["GET", "POST"].includes(r.method))), "reopen_report");
    requireIngress(a.messages.length === 0 && a.runtimePids.length <= 1 && a.runtimePids.every(n => Number.isSafeInteger(n) && n > 0), "reopen_report");
    ingressCloseRecord(a.files, ["recording", "outbox", "receipt", "key"]);
    for (const name of ["trace", "envKeys"]) requireIngress(Array.isArray(a[name]) && a[name].every(n => typeof n === "string" && /^[A-Za-z0-9_]{1,128}$/.test(n)), "reopen_report");
    if (a.bridge !== null) {
      ingressCloseRecord(a.bridge, ["pid", "joined", "mediaConnected", "framesSent", "occurrenceId", "bridgeSessionId", "controlSessionId", "envKeys", "bound"], ["envKeys"]);
      requireIngress(a.bridge.envKeys.every(n => typeof n === "string" && /^[A-Za-z0-9_]{1,128}$/.test(n)), "reopen_report");
    }
    // Reuse the closed outcome and receiver contract before retaining activity.
    ingressCloseFact({ outcomes: a.outcomes, commitObservations: [], receiver: a.receiver });
    if (a.history !== undefined) ingressHistoryFact(a.history);
  }
  ingressCloseRows(value.observations, ["ordinal", "name"]);
  requireIngress(value.observations.every(o => Number.isSafeInteger(o.ordinal) && ["ready", "deliver", "blocked", "discover", "read", "retry", "launched", "activity", "remove", "settled"].includes(o.name)), "reopen_report");
  requireIngress(Array.isArray(value.failures) && value.failures.every(v => typeof v === "string" && /^ingress_[A-Za-z_]{1,120}$/.test(v)), "reopen_report");
  if (value.child !== undefined) ingressCloseRecord(value.child, ["exitObserved", "closeObserved", "code", "signal", "forced", "stdioSettled", "pid"]);
  if (value.ownerProcessProof !== undefined) value.ownerProcessProof = ingressReopenProcessFact(value.ownerProcessProof);
  if (value.admissionHelpers !== undefined) value.admissionHelpers = ingressAdmissionHelperFact(value.admissionHelpers);
  return value;
}
function ingressReopenProcessFact(value) {
  value = ingressData(value);
  const keys = ["pids", "probes", "orphans", "invalidPids", "inventory", "children", "knownOwnedChildrenReaped", "processInventoryVerified", "inventoryCoverage", "cleanupConfirmed"];
  ingressCloseRecord(value, keys, ["pids", "probes", "orphans", "invalidPids", "inventory", "children"]);
  for (const k of ["pids", "probes", "orphans"]) if (value[k] !== undefined) {
    ingressCloseRows(value[k], k === "pids" ? ["pid", "origins"] : ["pid", "origins", "status"], ["origins"]);
    for (const row of value[k]) requireIngress(Number.isSafeInteger(row.pid) && row.pid > 0 && row.origins.every(v => typeof v === "string" && /^[a-z0-9-]{1,64}$/.test(v)) &&
      (k === "pids" || ["absent", "present", "unverified"].includes(row.status)), "reopen_process");
  }
  if (value.invalidPids !== undefined) requireIngress(value.invalidPids.every(v => typeof v === "string" && /^[a-z0-9-]{1,64}$/.test(v)), "reopen_process");
  if (value.children !== undefined) {
    ingressCloseRows(value.children, ["role", "pid", "outcome"], ["outcome"]);
    for (const row of value.children) {
      ingressCloseRecord(row.outcome, ["exitObserved", "code", "signal"]);
      requireIngress(typeof row.role === "string" && /^[a-z0-9-]{1,64}$/.test(row.role) && Number.isSafeInteger(row.pid) && row.pid > 0 &&
        typeof row.outcome.exitObserved === "boolean" && (row.outcome.code === null || Number.isInteger(row.outcome.code)) &&
        (row.outcome.signal === null || /^SIG[A-Z0-9]{1,12}$/.test(row.outcome.signal)), "reopen_process");
    }
  }
  if (value.inventory !== undefined) {
    ingressCloseRecord(value.inventory, ["samples", "failures", "outcomes", "overflowOutcome"], ["failures", "outcomes", "overflowOutcome"]);
    requireIngress(value.inventory.failures.every(v => typeof v === "string" && /^[a-z_]{1,128}$/.test(v)), "reopen_process");
    for (const row of [...value.inventory.outcomes ?? [], ...value.inventory.overflowOutcome ? [value.inventory.overflowOutcome] : []]) {
      ingressCloseRecord(row, ["ordinal", "stage", "command", "exit", "signal", "diagnostic", "durationMs", "classified"], ["command"]);
      requireIngress(Number.isSafeInteger(row.ordinal) && row.ordinal > 0 && typeof row.stage === "string" && /^[a-z0-9-]{1,64}$/.test(row.stage) &&
        (row.exit === null || Number.isInteger(row.exit)) && (row.signal === null || /^SIG[A-Z0-9]{1,12}$/.test(row.signal)) &&
        (row.durationMs === null || typeof row.durationMs === "number" && row.durationMs >= 0) && ["pending", "observed", "refused"].includes(row.classified) &&
        JSON.stringify(row.command) === JSON.stringify(["/bin/ps", "-eo", "pid=,ppid=,comm="]) &&
        ["none", "inventory_command_failed", "ps: Operation not permitted", "ps: Permission denied", "ps: Not supported", "ps: Operation not supported"].includes(row.diagnostic), "reopen_process");
    }
  }
  return value;
}

/** Same parent transitions for the CLI and explicitly synthetic component facts. */
export async function runIngressCampaign(plan, effects, { signal, label = "component-facts" } = {}) {
  requireIngress(typeof label === "string" && ["component-facts", "attempted-application"].includes(label), "label");
  const controls = ingressData(plan); assertIngressSelection(controls);
  const phases = [], failures = [];
  const active = () => requireIngress(!signal?.aborted, "cancelled");
  try {
    active(); await effects.prepare(); active();
    // Preparation fills the real adapter's captured plan. Retain that alias
    // through prepare, then freeze the completed controls before any owner.
    plan = ingressData(plan); assertIngressSelection({ ...plan, phase: 1 });
    requireIngress(plan.missingLauncher === controls.missingLauncher && plan.conflictingReplay === controls.conflictingReplay && plan.closedGenerationReopen === controls.closedGenerationReopen &&
      plan.phase === controls.phase, "prepared_controls");
    for (const phase of controls.closedGenerationReopen ? [1, 2, 3] : [1, 2]) {
      active(); const previous = phases.at(-1);
      let result = await effects.runOwner({ ...plan, phase, original: phase === 3 ? previous.close.finalState : phases[0]?.state,
        ...(phase === 3 ? { history: previous.close.history, removal: previous.removal } : {}) }, signal);
      result = controls.closedGenerationReopen ? ingressReopenPhaseFact(result) : ingressData(result); phases.push(result); active();
      requireIngress(result.success && result.root === plan.root && result.databasePath === plan.databasePath, "phase_result");
      const c = result.child;
      requireIngress(c?.closeObserved && c.exitObserved && c.code === 0 && c.signal === null && c.stdioSettled && !c.forced, "child_close");
      requireIngress(result.ownerProcessProof?.cleanupConfirmed === true, "owner_process_cleanup");
      if (controls.closedGenerationReopen && phase === 3) assertIngressReopenOrigins(result.ownerProcessProof, c.pid, result.admissionHelpers);
      if (phase === 1 || controls.closedGenerationReopen) {
        let value;
        if (controls.closedGenerationReopen) {
          const deadline = process.hrtime.bigint() + 25000000000n; let timer;
          try {
            value = await Promise.race([effects.between(phase), new Promise((_, reject) => { timer = globalThis.setTimeout(() => reject(new Error("ingress_between_timeout")), 25000); })]);
            requireIngress(process.hrtime.bigint() < deadline, "between_timeout");
          } finally { globalThis.clearTimeout(timer); }
        } else value = await effects.between(phase);
        active();
        const state = controls.closedGenerationReopen ? ingressReopenState(value) : value;
        if (phase >= 2) { assertIngressClosedGeneration(result.close.finalState, result.removal); ingressHistoryFact(result.close.history); }
        assert.deepEqual(state, phase === 1 ? result.state : result.close.finalState);
      }
    }
  } catch (error) { failures.push(ingressFailure(error, "ingress_campaign_failed")); }
  let processProof;
  try { processProof = controls.closedGenerationReopen ? ingressReopenProcessFact(await effects.cleanup()) : ingressData(await effects.cleanup()); if (!processProof.cleanupConfirmed) failures.push("ingress_process_cleanup"); }
  catch { failures.push("ingress_cleanup_failed"); }
  return { schema: "meeting-ingress-evidence/v1", label, branch: controls.missingLauncher ? "missing-launcher" : "live",
    ...(controls.conflictingReplay ? { selectedCase: "conflicting-replay" } : {}),
    ...(controls.closedGenerationReopen ? { selectedCase: "closed-generation-reopen", phaseCount: phases.length,
      durableSessionState: phases.at(-1)?.close?.finalState?.sessions[0]?.state ?? phases.at(-1)?.state?.sessions[0]?.state ?? null, strictTerminalState: false } : {}),
    success: failures.length === 0 && phases.length === (controls.closedGenerationReopen ? 3 : 2), failures, phases, processProof, preserved: true };
}

async function realMain(argv) {
  const options = parseIngressArguments(argv);
  const [{ spawn }, stageModule, pins, { liveGatewayToml }, processRules] = await Promise.all([
    import("node:child_process"), import("./stage.mjs"), import("./pins.mjs"), import("./gateway-config.mjs"), import("./process-evidence.mjs"),
  ]);
  const { NODE24, RECORDING_KEY_ENV, PROVIDER_CREDENTIAL_ENV, run, stage } = stageModule;
  const evidence = processRules.createProcessEvidence(), controller = new globalThis.AbortController();
  const stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, stop);
  let staged, activeChild, plan = { missingLauncher: options.missingLauncher, ...(options.conflictingReplay ? { conflictingReplay: true } : {}), ...(options.closedGenerationReopen ? { closedGenerationReopen: true } : {}) };
  const inventory = (rootPid, owner, stage, baseline = false) => {
    requireIngress(!evidence.inventory.overflowOutcome, "inventory_history_overflow");
    let result; try { result = run("/bin/ps", ["-eo", "pid=,ppid=,comm="], { timeout: 1000, maxBuffer: 1048576 }); } catch { result = null; }
    return observeIngressInventory(evidence, { result, rootPid, owner, stage, baseline });
  };
  const effects = {
    async prepare() {
      noSymlinkAncestors(path.dirname(options.out));
      const parent = lstatSync(path.dirname(options.out)); requireIngress(parent.isDirectory() && !parent.isSymbolicLink(), "output_parent");
      mkdirSync(options.out, { mode: 0o700 });
      inventory(process.pid, "preflight", "preflight", true); await pins.verifyPins();
      staged = stage({ repository: path.resolve(import.meta.dirname, "..") });
      const meeting = { providerMeetingId: "meeting-ingress-e2e", meetingNo: "987654321", title: "First accepted title", startSeconds: Math.floor(Date.now() / 1000),
        eventId: "ingress-a", inviteSeconds: Math.floor(Date.now() / 1000), createTimeMs: Date.now() };
      const { inviteEnvelope, SCOPE } = await import("./feishu-peer.mjs");
      const { normalizeInvite } = await import("../dist/src/ports/feishu-ingress.js");
      const envelopes = [inviteEnvelope(meeting), inviteEnvelope({ ...meeting, eventId: "ingress-b", title: "Later observed title", inviteSeconds: meeting.inviteSeconds + 1, createTimeMs: meeting.createTimeMs + 1000 }),
        inviteEnvelope({ ...meeting, eventId: "ingress-c", title: "Earlier event delivered late", inviteSeconds: meeting.inviteSeconds - 1, createTimeMs: meeting.createTimeMs - 1000 })];
      const normalized = envelopes.map(raw => normalizeInvite(raw, SCOPE));
      const expected = normalized.map(n => ({ eventId: n.eventId, hash: n.normalizedSha256, title: n.title, createTime: n.createTime, inviteSeconds: n.inviteSeconds, startSeconds: n.startSeconds }));
      if (options.missingLauncher) {
        staged.standaloneConfig.runtime.launcherPath = path.join(staged.root, "unavailable-runtime-launcher");
        writeFileSync(staged.standaloneConfigPath, JSON.stringify(staged.standaloneConfig), { mode: 0o600 });
      }
      writeFileSync(staged.gatewayConfigPath, liveGatewayToml({ recordingsDir: staged.directories.recordingsDir, keyEnv: RECORDING_KEY_ENV, credentialEnv: PROVIDER_CREDENTIAL_ENV }), { mode: 0o600 });
      Object.assign(plan, { root: staged.root, databasePath: path.join(staged.directories.stateRoot, "orchestration.db"), meeting, expected,
        immutableExpected: Object.fromEntries(["occurrenceId", "region", "tenantKey", "appId", "providerMeetingId", "meetingNo", "occurrenceStartedAt", "title"].map(key => [key, normalized[0][key]])),
        occurrenceId: normalized[0].occurrenceId, sends: [0, 1, 2, 0].map((index, at) => ({ ...expected[index], occurrenceId: normalized[0].occurrenceId,
          wireMessageId: `phase1-${["a-1", "b-1", "c-1", "a-2"][at]}`, envelope: envelopes[index] })),
        standaloneConfigPath: staged.standaloneConfigPath, controlDir: staged.directories.control, runtimePidsPath: staged.gatewayPidsPath,
        keyPath: staged.keyPath, directories: staged.directories });
      if (options.conflictingReplay) {
        const envelope = inviteEnvelope({ ...meeting, title: "Conflicting replay title" }), n = normalizeInvite(envelope, SCOPE);
        plan.sends = selectIngressSends(plan.sends, { eventId: n.eventId, hash: n.normalizedSha256, title: n.title,
          createTime: n.createTime, inviteSeconds: n.inviteSeconds, startSeconds: n.startSeconds, occurrenceId: n.occurrenceId, envelope });
      }
      assertIngressSelection({ ...plan, phase: 1 });
      writeFileSync(path.join(options.out, "staged.json"), JSON.stringify({ root: staged.root, pins: await pins.verifyPins(),
        digests: await Promise.all([staged.gatewayPath, staged.launcherPath, staged.entryPath.replace("entry.mjs", "ingress-entry.mjs"),
          path.join(staged.directories.app, "e2e/ingress-run.mjs"), path.join(staged.directories.app, "e2e/feishu-peer.mjs"),
          path.join(staged.directories.app, "dist/src/main.js"), path.join(staged.directories.app, "dist/src/application-composition.js"),
          path.join(staged.directories.app, "dist/src/ports/feishu-ingress.js")].map(async filename => ({ filename, sha256: await pins.sha256File(filename) }))) }), { mode: 0o600 });
    },
    async runOwner(phasePlan, signal) {
      inventory(process.pid, "parent", `phase-${phasePlan.phase}-before`, true);
      // prepare populates the shared plan before the controller selects owners.
      Object.assign(phasePlan, plan);
      const phaseDir = path.join(options.out, `phase-${phasePlan.phase}`); mkdirSync(phaseDir, { mode: 0o700 });
      phasePlan.summaryPath = path.join(phaseDir, "summary.json");
      const planPath = path.join(phaseDir, "plan.json"); writeFileSync(planPath, JSON.stringify(phasePlan), { mode: 0o600 });
      const child = spawn(NODE24, [path.join(staged.directories.app, "e2e/ingress-entry.mjs"), "--plan", planPath], {
        stdio: ["ignore", "pipe", "pipe"], env: { HOME: process.env.HOME, PATH: "/opt/homebrew/opt/node@24/bin:/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "C.UTF-8" },
      }); activeChild = child;
      const record = { role: `ingress-phase-${phasePlan.phase}`, pid: child.pid, outcome: null }; evidence.children.push(record);
      let failure = false, forced = false, exitObserved = false, closeObserved = false, code = null, exitSignal = null;
      const streams = [[], []], lengths = [0, 0];
      child.stdout.on("data", bytes => collect(0, bytes)); child.stderr.on("data", bytes => collect(1, bytes));
      function collect(index, bytes) { lengths[index] += bytes.length; if (lengths[index] > 1048576) { failure = true; child.kill("SIGTERM"); } else streams[index].push(bytes); }
      child.on("error", () => { failure = true; });
      child.once("exit", (value, sig) => { exitObserved = true; code = value; exitSignal = sig; });
      child.once("close", () => { closeObserved = true; });
      const started = process.hrtime.bigint(); let cleanupAt = null, sampleAt = 0n;
      // No background drive survives settlement. The parent owns one 40s
      // cleanup window, 30s cooperative then at most 10s after exact-handle kill.
      while (!closeObserved) {
        const now = process.hrtime.bigint();
        if (now >= sampleAt) {
          try { inventory(child.pid, record.role, `phase-${phasePlan.phase}-running`); } catch { failure = true; }
          sampleAt = now + 100000000n;
        }
        if (signal?.aborted || now - started >= 120000000000n) failure = true;
        if (failure && cleanupAt === null) { cleanupAt = now; child.kill("SIGTERM"); }
        if (cleanupAt !== null && now - cleanupAt >= 30000000000n && !forced) { forced = true; child.kill("SIGKILL"); }
        if (cleanupAt !== null && now - cleanupAt >= 40000000000n) break;
        await delay(25);
      }
      activeChild = closeObserved ? null : child;
      record.outcome = { exitObserved, code, signal: exitSignal };
      for (const [index, name] of ["stdout", "stderr"].entries()) writeFileSync(path.join(phaseDir, name), Buffer.concat(streams[index]), { mode: 0o600 });
      let result; try { result = boundedJson(phasePlan.summaryPath); } catch { result = { success: false, failure: "ingress_summary_missing" }; }
      const ownedPids = [...(result.activity?.runtimePids ?? []), ...(result.activity?.bridge ? [result.activity.bridge.pid] : [])];
      if (!ownedPids.every(pid => evidence.observed.some(row => row.pid === pid && row.origins.includes(record.role)))) failure = true;
      result.processBindingObserved = ownedPids.length;
      try { inventory(process.pid, record.role, `phase-${phasePlan.phase}-close`, true); } catch { failure = true; }
      const closeProof = ingressOwnerCloseProof(evidence, { phasePlan, role: record.role, ownerPid: child.pid, result });
      const ownerProcessProof = closeProof.ownerProcessProof; if (closeProof.failure) failure = true;
      return { ...result, ownerProcessProof, success: result.success && !failure && ownerProcessProof.cleanupConfirmed,
        child: { exitObserved, closeObserved, code, signal: exitSignal, forced, ...(phasePlan.closedGenerationReopen ? { pid: child.pid } : {}),
        stdioSettled: closeObserved && child.stdout.destroyed && child.stderr.destroyed } };
    },
    async between() { return readIngressState({ databasePath: plan.databasePath, occurrenceId: plan.occurrenceId, ...(plan.closedGenerationReopen ? { closedGenerationReopen: true } : {}) }); },
    async cleanup() {
      if (activeChild) activeChild.kill("SIGTERM");
      try { inventory(process.pid, "final", "final", true); } catch { /* Refusal is sticky and preserved in the returned proof. */ }
      return ingressProcessProof(evidence);
    },
  };
  try {
    const result = await runIngressCampaign(plan, effects, { signal: controller.signal, label: "attempted-application" });
    if (existsSync(options.out)) writeFileSync(path.join(options.out, "evidence.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    process.exitCode = result.success ? 0 : 70;
  } finally { for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void realMain(process.argv.slice(2)).catch(() => { process.stderr.write("ingress_runner_refused\n"); process.exitCode = 70; });
}

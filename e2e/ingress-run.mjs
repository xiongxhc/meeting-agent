// Private two-owner ingress campaign. Imports have no application/SDK effects.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import Database from "better-sqlite3";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { observeProcessSnapshot, processCleanupProof } from "./process-evidence.mjs";

export function requireIngress(value, reason) { if (!value) throw new Error(`ingress_${reason}`); }
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
  const options = { out: null, missingLauncher: false };
  for (let at = 0; at < argv.length; at++) {
    if (argv[at] === "--out" && options.out === null) {
      const value = argv[++at];
      requireIngress(typeof value === "string" && path.isAbsolute(value) && value !== "/" && path.normalize(value) === value &&
        [...value].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) && !ingressPathExists(value), "output_path");
      options.out = value;
    } else if (argv[at] === "--missing-launcher" && !options.missingLauncher) options.missingLauncher = true;
    else throw new Error("ingress_argument");
  }
  requireIngress(options.out !== null, "output_required"); return options;
}

/** Only SELECT/readonly PRAGMAs. Guard the regular no-follow file/header before
 * SQLite can create WAL sidecars. The private parent protects readable DB bits. */
export function readIngressState({ databasePath, occurrenceId }) {
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
      requireIngress(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version === 29, "schema29_required");
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
      return { fileIdentity: `${parent.dev}:${parent.ino}:${parent.birthtimeMs}:${held.dev}:${held.ino}:${held.birthtimeMs}`, immutable, metadata, events, sessions, counts, custody, generations };
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
  const { commit, receiver } = delivery;
  requireIngress(commit && receiver && !receiver.invalid && !receiver.overflow, "ack_observation");
  requireIngress(commit.wireMessageId === send.wireMessageId && commit.eventId === send.eventId && commit.expectedHash === send.hash &&
    commit.persistedHash === send.hash && commit.immutable.occurrenceId === send.occurrenceId && Number.isSafeInteger(commit.ordinal) && commit.ordinal > 0, "commit_identity");
  if (immutable) assert.deepEqual(commit.immutable, immutable);
  const replies = receiver.observations;
  requireIngress(replies.length === 1 && replies[0].kind === "ack" && replies[0].messageId === send.wireMessageId &&
    replies[0].payload?.code === 200 && replies[0].ordinal > commit.ackFloor, "ack_identity_order");
}
export function assertIngressReceiver(receiver, expectedIds) {
  requireIngress(receiver && !receiver.invalid && !receiver.overflow && receiver.observations.length === expectedIds.length, "receiver_history");
  const seen = new Set();
  for (const row of receiver.observations) {
    requireIngress(row.kind === "ack" && row.payload?.code === 200 && expectedIds.includes(row.messageId) && !seen.has(row.messageId), "receiver_identity");
    seen.add(row.messageId);
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
  assertIngressReceiver(close.receiver, sends.map(send => send.wireMessageId));
  assert.deepEqual(close.ackObservations, close.receiver.observations);
  assert.deepEqual(close.commitObservations, commits);
  requireIngress(close.commitObservations.length === sends.length, "final_commit_count");
  for (const [index, send] of sends.entries()) assertIngressAck(send, { commit: close.commitObservations[index],
    receiver: { ...close.receiver, observations: close.receiver.observations.filter(row => row.messageId === send.wireMessageId) } }, commits[index].immutable);
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
    const rows = observeProcessSnapshot(evidence, { result, rootPid, owner, baseline }); outcome.classified = "observed"; return rows;
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

/** Same parent transitions for the CLI and explicitly synthetic component facts. */
export async function runIngressCampaign(plan, effects, { signal, label = "component-facts" } = {}) {
  const phases = [], failures = [];
  const active = () => requireIngress(!signal?.aborted, "cancelled");
  try {
    active(); await effects.prepare(); active();
    for (const phase of [1, 2]) {
      active(); const result = await effects.runOwner({ ...plan, phase, original: phases[0]?.state }, signal); phases.push(result); active();
      requireIngress(result.success && result.root === plan.root && result.databasePath === plan.databasePath, "phase_result");
      const c = result.child;
      requireIngress(c?.closeObserved && c.exitObserved && c.code === 0 && c.signal === null && c.stdioSettled && !c.forced, "child_close");
      requireIngress(result.ownerProcessProof?.cleanupConfirmed === true, "owner_process_cleanup");
      if (phase === 1) { const state = await effects.between(); active(); assert.deepEqual(state, result.state); }
    }
  } catch (error) { failures.push(/^ingress_[A-Za-z_]+$/.test(error?.message ?? "") ? error.message : "ingress_campaign_failed"); }
  let processProof;
  try { processProof = await effects.cleanup(); if (!processProof.cleanupConfirmed) failures.push("ingress_process_cleanup"); }
  catch { failures.push("ingress_cleanup_failed"); }
  return { schema: "meeting-ingress-evidence/v1", label, branch: plan.missingLauncher ? "missing-launcher" : "live",
    success: failures.length === 0 && phases.length === 2, failures, phases, processProof, preserved: true };
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
  let staged, activeChild, plan = { missingLauncher: options.missingLauncher };
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
      const ownerProcessProof = ingressProcessProof(evidence, record.role);
      return { ...result, ownerProcessProof, success: result.success && !failure && ownerProcessProof.cleanupConfirmed,
        child: { exitObserved, closeObserved, code, signal: exitSignal, forced,
        stdioSettled: closeObserved && child.stdout.destroyed && child.stderr.destroyed } };
    },
    async between() { return readIngressState({ databasePath: plan.databasePath, occurrenceId: plan.occurrenceId }); },
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

// Strict NOTIFIED replay over one independently reviewed, closed R2 root.
// Imports never create an application, SDK client, listener or process.
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { boundedBytes, boundedJson, ingressData, ingressPathExists, ingressReceiverFact } from "./ingress-run.mjs";
import { readR2BaselineState, measureR2Sources } from "./r2-baseline.mjs";
import { ARTIFACTS } from "./pins.mjs";

export const ACCEPTED_R2_BUNDLE = "8dca90932fe04c98c21f50346287eb13702f28832be3e0c5ef83985862705d81";
const ACCEPTED_R2_DATABASE = "1e98c702dfc328265fb9ced908ba94140bda3446d30650e63c2739af73f86489";
const REVIEW_PATH = path.join(ARTIFACTS, "../handoff/meeting-workspace-r2-baseline-review-20261007.md");
const REVIEW_HASH = "2aa22be3c9b7574d7610eb3f7d43d8b32f2875fb0079ce915bae775ebe23f014";
const ACCEPTED_ROOT_IDENTITY = { device: "16777230", inode: "66498747" };
const ACCEPTED_DATABASE_IDENTITY = { device: "16777230", inode: "66505036" };
// This selected command names one retained actual baseline, not arbitrary roots.
const ACCEPTED_FILES = {
  "config/standalone.json": "38c5a4b1a89c69824b0276b6c38ea9333e7fb36b0bed1f3d5e1789493f122381",
  "runtime-launcher": "1072383faf2d1f515db39aac42d5efa46f78b339bacfede03c6ba375b6cc2c4e",
  "bridge-control/summary.json": "2ff6cb40ef816a49224157aaa6beaf0c2749ca93a24e6a138b07a41fe68c2776",
  "bridge-control/state.json": "bdac587ac7b0a2064603add4009fcafeb75a390cb9bb1d11c8a5f037961b55b8",
  "bridge-control/events.ndjson": "2409a8e2fd2e89abc094064ad8c48423c7fcb1f4e8a4c4d91c686601ce927341",
  "bridge-control/end": "e87ba7a0b779d8b797f86d19604504496f23b4d1e31ed4721d9dc8634172b723",
  "bridge-control/teammem-done": "b04e5ea201bb040cae53f693f6a38a3e00b62da6039ca248fecd59b7fc842894",
  "runtime/gateway-pids.txt": "72f4c56b0946e904a653a52903ecdb8a7b4241abcf9aa4de26ba0513430e4ad0",
  "config/bridge-static.json": "a1cf2a43e7314b09b4b70b79f4a4eb5c2e0b31676ade1094f6db66bf4f8dbd9a",
  "runtime/gateway.toml": "069a0135cd80503dfb90669bb893630c3c1f85ba8168921e4ac90a11c74175c2",
  "runtime/launcher.stderr.log": "f4c287e4ccfbf3343c9e9e04e4b7e9b98b9d7b3d732be29d356203f8897a7062",
};
const ABSENT_FILES = ["bridge-control/runtime-events.ndjson"];
const TABLES = ["schema_migrations", "sessions", "transitions", "bridge_leases", "recordings", "recording_gaps", "bridge_recoveries", "bridge_recovery_gaps", "bridge_failure_recordings", "recording_runtime_gaps", "bridge_failure_recording_runtime_gaps", "reconciliation_generations", "reconciliation_bridge_events", "reconciliation_live_segments", "delivery_journal", "delivery_recording_owners", "delivery_recording_owners_v17", "notification_intents", "physical_client_custody", "feishu_invite_occurrences", "feishu_invite_events", "recording_recovery_bindings", "recording_alignment_attempts", "recording_alignment_pages", "recording_alignment_selected", "timed_evidence_owners", "timed_ui_evidence", "timed_live_evidence", "backfill_seeds", "backfill_seed_lifecycle", "backfill_jobs", "backfill_warning_intents", "unknown_end_custody", "recording_retention"].sort();
const CLOSE = ["shutdown_fenced", "shutdown_owned_work_settled", "shutdown_application_closed", "shutdown_runtime_owners_closed", "shutdown_transports_closed", "shutdown_store_closed"];
export function requireTerminal(value, code) { if (!value) throw new Error(`terminal_${code}`); }
export function terminalFailure(error, fallback = "terminal_failed") {
  const d = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "message") : null;
  return d && Object.hasOwn(d, "value") && typeof d.value === "string" && /^terminal_[a-z_]{1,80}$/.test(d.value) ? d.value : fallback;
}
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(ingressData(a)) === JSON.stringify(ingressData(b));
function physical(filename) {
  requireTerminal(typeof filename === "string" && path.isAbsolute(filename) && path.normalize(filename) === filename && realpathSync(filename) === filename, "physical_path");
  let current = path.parse(filename).root;
  for (const part of filename.slice(current.length).split(path.sep)) {
    current = path.join(current, part); const s = lstatSync(current); requireTerminal(!s.isSymbolicLink(), "symlink_path");
  }
}
function inside(root, filename) { const r = path.relative(root, filename); requireTerminal(r && !r.startsWith("..") && !path.isAbsolute(r), "root_binding"); physical(filename); }
function identity(filename) {
  physical(filename); const s = lstatSync(filename, { bigint: true });
  return { device: s.dev.toString(), inode: s.ino.toString() };
}
function fileFact(filename) {
  physical(filename); const before = lstatSync(filename, { bigint: true });
  requireTerminal(before.isFile() && before.nlink === 1n && before.size <= 1048576n, "retained_file");
  const bytes = boundedBytes(filename), after = lstatSync(filename, { bigint: true });
  requireTerminal(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs, "retained_file_changed");
  return { ...identity(filename), bytes: bytes.length, sha256: hash(bytes) };
}
function assertAcceptedFiles(root) {
  const originalFiles = terminalOriginalFiles(root);
  requireTerminal(originalFiles.every(row => !row.invalid && (Object.hasOwn(ACCEPTED_FILES, row.role)
    ? row.present && row.sha256 === ACCEPTED_FILES[row.role] : !row.present)), "accepted_file_changed");
  return originalFiles;
}
/** Closed twelve-role projection, shared by preflight, backup and after cut.
 * Missing/invalid originals remain bounded facts in adverse after evidence. */
export function terminalOriginalFiles(root) {
  physical(root);
  return [...Object.keys(ACCEPTED_FILES), ...ABSENT_FILES].map(role => {
    const filename = path.join(root, role);
    try {
      if (path.dirname(filename) !== root) inside(root, path.dirname(filename));
      if (!ingressPathExists(filename)) return { role, present: false };
      inside(root, filename); return { role, present: true, ...fileFact(filename) };
    } catch { return { role, present: true, invalid: true }; }
  });
}
export function assertTerminalClosed(fact) {
  fact = ingressData(fact);
  requireTerminal(fact?.exit === 0 && fact.compositionClosed === true && fact.ownerClosedLast === true && fact.peerClosed === true &&
    fact.httpClosed === true && fact.socketClosed === true && fact.connections === 0 && fact.outcomes === 0 && fact.failures?.length === 0, "close_receipts");
  let last = -1;
  for (const code of CLOSE) { const at = fact.trace.indexOf(code); requireTerminal(at > last && fact.trace.lastIndexOf(code) === at, "close_order"); last = at; }
  requireTerminal(last === fact.trace.length - 1, "after_store_close");
}
/** Specific readonly projection; never relax the existing finalizing reader. */
export function readTerminalState({ root, databasePath, occurrenceId }) {
  physical(root); inside(root, databasePath);
  const parent = lstatSync(path.dirname(databasePath)), before = lstatSync(databasePath, { bigint: true });
  requireTerminal((lstatSync(root).mode & 0o077) === 0 && (parent.mode & 0o077) === 0 && before.isFile() && before.nlink === 1n &&
    before.uid === BigInt(process.getuid()) && (before.mode & 0o022n) === 0n, "private_database");
  requireTerminal(!ingressPathExists(`${databasePath}-wal`) && !ingressPathExists(`${databasePath}-shm`), "database_sidecar");
  const fd = openSync(databasePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let db;
  const guard = () => {
    const now = lstatSync(databasePath, { bigint: true });
    requireTerminal(now.dev === before.dev && now.ino === before.ino && now.size === before.size && now.mtimeNs === before.mtimeNs &&
      !ingressPathExists(`${databasePath}-wal`) && !ingressPathExists(`${databasePath}-shm`), "database_changed");
  };
  try {
    const held = fstatSync(fd, { bigint: true }), header = Buffer.alloc(100);
    requireTerminal(held.dev === before.dev && held.ino === before.ino && readSync(fd, header, 0, 100, 0) === 100 &&
      header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")) && header[18] === 1 && header[19] === 1, "database_header");
    const r2 = readR2BaselineState({ databasePath, occurrenceId }); guard();
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    requireTerminal(db.readonly && db.pragma("journal_mode", { simple: true }) !== "wal", "database_readonly");
    const result = db.transaction(() => {
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
      requireTerminal(same(tables, TABLES), "schema_tables");
      requireTerminal(same(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map(row => row.version), Array.from({ length: 31 }, (_, i) => i + 1)), "schema_versions");
      const schemaSha256 = hash(JSON.stringify({ definitions: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
        migrations: db.prepare("SELECT * FROM schema_migrations ORDER BY version").all() }));
      const one = (table, sql) => { requireTerminal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n === 1, "cardinality"); const row = db.prepare(sql).get(occurrenceId); requireTerminal(row, "occurrence_binding"); return row; };
      const invite = one("feishu_invite_occurrences", `SELECT region,tenant_key AS tenantKey,app_id AS appId,provider_meeting_id AS providerMeetingId,meeting_no AS meetingNo,occurrence_id AS occurrenceId,occurrence_started_at AS occurrenceStartedAt,title,accepted_at_ms AS acceptedAtMs,state,total_attempts AS totalAttempts,generation_attempts AS generationAttempts FROM feishu_invite_occurrences WHERE occurrence_id=?`);
      const event = one("feishu_invite_events", `SELECT event_id AS eventId,create_time AS createTime,start_seconds AS startSeconds,end_seconds AS endSeconds,invite_seconds AS inviteSeconds,call_id AS callId,topic AS title,normalized_sha256 AS normalizedSha256,normalized_bytes AS normalizedBytes,accepted_at_ms AS acceptedAtMs FROM feishu_invite_events WHERE occurrence_id=?`);
      const session = one("sessions", "SELECT occurrence_id AS occurrenceId,state,terminal_reason AS terminalReason FROM sessions WHERE occurrence_id=?");
      const notification = one("notification_intents", `SELECT occurrence_id AS occurrenceId,revision,artifact_hash AS artifactHash,publication_url AS publicationUrl,vault_commit AS vaultCommit,recipient_id AS recipientId,request_uuid AS requestUuid,message_text AS messageText,state,terminal_reason AS terminalReason,attempt_count AS attemptCount,delivery_ambiguous AS ambiguous,claim_token IS NOT NULL AS claimed,provider_message_id AS providerMessageId,sent_at_ms AS sentAtMs FROM notification_intents WHERE occurrence_id=?`);
      const custody = one("physical_client_custody", `SELECT bridge_session_id AS bridgeSessionId,state,outcome_failure AS failure,outcome_recorded_at_ms AS recordedAtMs,cleared_at_ms AS clearedAtMs,clear_reason AS clearReason,json_extract(outcome_json,'$.outcome') AS outcome FROM physical_client_custody WHERE occurrence_id=?`);
      const generation = one("reconciliation_generations", "SELECT generation_id AS generationId,bridge_session_id AS bridgeSessionId,runtime_session_id AS runtimeSessionId,terminal_reason AS terminalReason,capture_complete AS captureComplete FROM reconciliation_generations WHERE occurrence_id=?");
      requireTerminal(db.prepare("SELECT count(*) AS n FROM timed_evidence_owners").get().n === 1, "timed_owner_count");
      const timedOwner = db.prepare("SELECT state FROM timed_evidence_owners WHERE generation_id=?").get(generation.generationId);
      const recording = one("recordings", "SELECT handle,capture_drain AS captureDrain FROM recordings WHERE occurrence_id=?");
      const organizer = db.prepare("SELECT organizer_person_id AS openId FROM backfill_seeds WHERE occurrence_id=?").get(occurrenceId);
      // Scoped durable row fingerprints preserve retry/attempt/deadline/source
      // authority without disclosing capabilities or alignment payloads. No
      // file byte equality or unrelated filesystem timestamps are required.
      const durable = {};
      for (const table of TABLES.filter(name => name !== "schema_migrations")) {
        const n = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n; requireTerminal(n <= 4096, "row_extent");
        const rows = db.prepare(`SELECT * FROM ${table}`).all().map(row => JSON.stringify(row)).sort();
        durable[table] = { count: n, sha256: hash(JSON.stringify(rows)) };
      }
      return { rootIdentity: identity(root), databaseIdentity: identity(databasePath), schemaSha256, occurrenceId, invite, event, session, notification,
        custody, generation, timedOwner, recording, organizer, r2, durable };
    })(); guard(); return ingressData(result);
  } finally { db?.close(); closeSync(fd); }
}
export function assertTerminalBaseline(baseline) {
  baseline = ingressData(baseline); const s = baseline.state, n = s?.notification, d = s?.r2?.delivery;
  requireTerminal(s?.session?.state === "notified" && s.session.occurrenceId === s.occurrenceId, "notified_required");
  requireTerminal(n?.state === "sent" && n.terminalReason === null && n.attemptCount === 1 && n.ambiguous === 0 && n.claimed === 0 &&
    typeof n.providerMessageId === "string" && n.providerMessageId.length > 0 && Number.isSafeInteger(n.sentAtMs), "sent_required");
  requireTerminal(d?.revision === 1 && d.transcriptComplete === 0 && d.deletedAtMs === null && Number.isSafeInteger(d.publishedAtMs) && d.sourceBound === 1 &&
    n.occurrenceId === s.occurrenceId && n.revision === d.revision && n.artifactHash === d.artifactHash && n.publicationUrl === d.publicationUrl && n.vaultCommit === d.vaultCommit &&
    n.recipientId === s.organizer?.openId, "notification_binding");
  requireTerminal(baseline.publication?.verified === true && baseline.publication.occurrenceId === s.occurrenceId && baseline.publication.revision === d.revision &&
    baseline.publication.artifactHash === d.artifactHash && baseline.publication.publicationUrl === d.publicationUrl && baseline.publication.vaultCommit === d.vaultCommit &&
    baseline.publication.requestUuid === n.requestUuid && baseline.publication.messageText === n.messageText && baseline.publication.recipientId === n.recipientId, "publication_binding");
  requireTerminal(s.invite.state === "admitted" && s.invite.totalAttempts === 1 && s.invite.generationAttempts === 1 && s.event.acceptedAtMs === s.invite.acceptedAtMs &&
    s.event.title === s.invite.title && baseline.inviteHash === s.event.normalizedSha256, "original_invite");
  requireTerminal(s.custody.state === "cleared" && s.custody.failure === null && s.custody.outcome === "departure_confirmed" && s.custody.clearReason === "departure_observed" &&
    Number.isSafeInteger(s.custody.recordedAtMs) && Number.isSafeInteger(s.custody.clearedAtMs) && s.custody.bridgeSessionId === s.generation.bridgeSessionId &&
    s.generation.captureComplete === 1 && s.generation.terminalReason === "ended" && s.timedOwner?.state === "closed" && s.recording.captureDrain === "confirmed", "first_recording_owner");
  const l = s.r2.lifecycle, j = s.r2.job;
  requireTerminal(s.r2.generationRetained && s.r2.source.retention === "retained" && s.r2.selectedAlignment?.state === "complete" && s.r2.selectedAlignment.coverageStatus === "available", "selected_recording");
  requireTerminal(l.owner === "delivery" && l.state === "pending" && l.initialBuildAttempts === 1 && !l.buildClaimed && !l.cleanupClaimed && !l.processOwned &&
    l.processCleanupState === null && l.deletedAtMs === null && j.state === "due" && j.attemptCount === 0 && !j.claimed && j.targetRevision === null && j.completionRevision === null &&
    s.r2.stopAtMs === s.r2.endedAtMs + 11 * 86400000 && s.r2.expiresAtMs === s.r2.endedAtMs + 14 * 86400000, "retry_authority");
  requireTerminal(baseline.firstOwner?.closed === true && baseline.firstOwner.cleanupConfirmed === true && baseline.firstOwner.afterStoreClose === 0, "first_owner_close");
  requireTerminal(baseline.source?.inventoryStable === true && baseline.source.sha256 === s.r2.source.sha256 && baseline.source.bytes === s.r2.source.bytes &&
    baseline.source.device === s.r2.source.device && baseline.source.inode === s.r2.source.inode && baseline.source.nlink === 1 && baseline.source.imported?.length === 2 &&
    baseline.source.imported.every(row => row.sha256 === baseline.source.sha256 && row.bytes === baseline.source.bytes && row.nlink === 2 &&
      (row.device !== baseline.source.device || row.inode !== baseline.source.inode)) &&
    new Set(baseline.source.imported.map(row => `${row.device}:${row.inode}`)).size === 1, "source_identity");
  return baseline;
}
export function assertTerminalActivity(fact, expectedAcks, wireId) {
  fact = ingressData(fact);
  requireTerminal(fact.outcomes === 0 && fact.messages === 0 && fact.runtimeStarts === 0 && fact.bridgeStarts === 0 && fact.metadataRequests === 0 && fact.notificationRequests === 0 &&
    !fact.trace.some(code => code.startsWith("occurrence_") || code === "invite_metadata_resolved"), "unexpected_work");
  const receiver = ingressReceiverFact(fact.receiver);
  requireTerminal(!receiver.invalid && !receiver.overflow && receiver.observations.length === expectedAcks && receiver.observations.every(row =>
    row.kind === "ack" && row.messageId === wireId && row.payload.code === 200), "receiver");
}
/** Same controller in C tests and actual entry; report cannot confer I. */
export async function runTerminalReplay(plan, effects, { budgetMs = 120000, cleanupMs = 30000 } = {}) {
  const failure = [], observations = []; let baseline, close;
  requireTerminal(Number.isFinite(budgetMs) && budgetMs > 0 && budgetMs <= 120000 && Number.isFinite(cleanupMs) && cleanupMs > 0 && cleanupMs <= 30000, "budget");
  const controller = new globalThis.AbortController(), deadline = process.hrtime.bigint() + BigInt(Math.ceil(budgetMs * 1000000));
  const timer = globalThis.setTimeout(() => controller.abort(), budgetMs);
  const step = async (name, ...args) => {
    requireTerminal(!controller.signal.aborted && process.hrtime.bigint() < deadline, "deadline");
    let abort;
    try {
      const result = await Promise.race([effects[name](...args, controller.signal), new Promise((_, reject) => {
        abort = () => reject(new Error("terminal_deadline")); controller.signal.addEventListener("abort", abort, { once: true });
      })]); requireTerminal(!controller.signal.aborted && process.hrtime.bigint() < deadline, "deadline");
      observations.push(name); return ingressData(result);
    } finally { if (abort) controller.signal.removeEventListener("abort", abort); }
  };
  try {
    plan = ingressData(plan); baseline = assertTerminalBaseline(await step("baseline"));
    requireTerminal(plan.wireMessageId !== plan.originalWireMessageId && /^[a-zA-Z0-9-]{1,128}$/.test(plan.wireMessageId) && plan.originalWireMessageId.length > 0, "fresh_wire");
    const ready = await step("ready"); requireTerminal(ready.admitted && ready.started && ready.connections === 1 && same(ready.state, baseline.state), "owner_admission");
    assertTerminalActivity(await step("activity"), 0, plan.wireMessageId);
    const discovery = await step("discover"); requireTerminal(discovery.resolved === 0 && discovery.launched === 0 && discovery.deferred === 0, "discovery");
    requireTerminal(same(await step("read"), baseline.state), "baseline_mutation");
    const delivered = await step("deliver", plan.wireMessageId);
    requireTerminal(delivered.commit?.eventId === baseline.state.event.eventId && delivered.commit.normalizedSha256 === baseline.inviteHash &&
      delivered.commit.wireMessageId === plan.wireMessageId && delivered.commit.beforeAck === true && delivered.commit.count === 1, "durable_commit");
    assertTerminalActivity(delivered.activity, 1, plan.wireMessageId); requireTerminal(same(delivered.state, baseline.state), "replay_mutation");
    const after = await step("discover"); requireTerminal(after.resolved === 0 && after.launched === 0 && after.deferred === 0, "discovery");
    requireTerminal(same(await step("read"), baseline.state), "replay_mutation"); assertTerminalActivity(await step("activity"), 1, plan.wireMessageId);
  } catch (error) { failure.push(terminalFailure(error)); }
  finally {
    controller.abort(); globalThis.clearTimeout(timer); let cleanupTimer;
    try {
      close = ingressData(await Promise.race([effects.close(), new Promise((_, reject) => { cleanupTimer = globalThis.setTimeout(() => reject(new Error("terminal_close_timeout")), cleanupMs); })]));
      assertTerminalClosed(close);
      if (baseline) { requireTerminal(same(close.state, baseline.state) && same(close.source, baseline.source) && same(close.files, baseline.files), "final_preservation");
        assertTerminalActivity(close.activity, failure.length === 0 ? 1 : close.activity.receiver.observations.length, plan.wireMessageId); }
    } catch (error) { failure.push(terminalFailure(error, "terminal_cleanup_failed")); }
    finally { globalThis.clearTimeout(cleanupTimer); }
  }
  const acks = close?.activity?.receiver?.observations;
  return { schema: "terminal-reopen-report/v1", provenance: "component_controller", success: failure.length === 0, failures: failure,
    observations, discoveryPasses: observations.filter(name => name === "discover").length,
    replayAcks: Array.isArray(acks) && acks.length <= 64 ? acks.filter(row => row.kind === "ack" && row.payload?.code === 200).length : 0,
    newMessages: Number.isSafeInteger(close?.activity?.messages) && close.activity.messages >= 0 && close.activity.messages <= 64 ? close.activity.messages : null,
    closed: !!close && failure.length === 0 };
}

export async function prepareTerminalBaseline(bundlePath, { verifyPublication } = {}) {
  requireTerminal(hash(boundedBytes(bundlePath)) === ACCEPTED_R2_BUNDLE, "accepted_baseline_hash");
  const bundle = boundedJson(bundlePath), root = bundle.privateRoot, databasePath = bundle.stateDatabase.filename;
  physical(root); inside(root, databasePath);
  requireTerminal(same(identity(root), ACCEPTED_ROOT_IDENTITY) && same(identity(databasePath), ACCEPTED_DATABASE_IDENTITY), "accepted_root_identity");
  const originalFiles = assertAcceptedFiles(root);
  requireTerminal(bundle.mode === "r2-baseline" && bundle.oracles.length === 38 && bundle.oracles.every(row => row.status === "pass") &&
    bundle.productDefects.length === 0 && bundle.outOfBandFindings.length === 0 && hash(boundedBytes(databasePath)) === ACCEPTED_R2_DATABASE, "accepted_baseline");
  const occurrenceId = bundle.r2Baseline.occurrenceId, state = readTerminalState({ root, databasePath, occurrenceId });
  const control = path.join(root, "bridge-control"), summary = boundedJson(path.join(control, "summary.json"));
  const notification = state.notification, message = summary.feishuMessages;
  requireTerminal(message.length === 1 && message[0].uuid === notification.requestUuid && message[0].receiveId === notification.recipientId && message[0].text === notification.messageText, "peer_acceptance");
  const receiptPath = bundle.receiptOracle.receipts[0]; inside(root, receiptPath);
  const receipt = boundedJson(receiptPath), delivery = state.r2.delivery;
  requireTerminal(receipt.schema === "teammem-meeting-receipt/v1" && receipt.occurrence_id === occurrenceId && receipt.revision === 1 &&
    receipt.artifact_hash === delivery.artifactHash && receipt.markdown_url === delivery.publicationUrl && receipt.vault_commit === delivery.vaultCommit, "receipt_binding");
  const db = new Database(databasePath, { readonly: true, fileMustExist: true }); let bundleDir;
  try { bundleDir = db.prepare("SELECT bundle_path AS path FROM delivery_journal WHERE occurrence_id=?").get(occurrenceId).path; } finally { db.close(); }
  inside(root, bundleDir); const meeting = boundedJson(path.join(bundleDir, "meeting.json")), manifest = boundedJson(path.join(bundleDir, "manifest.json"));
  const contracts = await import("../dist/src/contracts/teammem-meeting-v2.js"), canonical = await import("../dist/src/contracts/teammem-meeting-v1.js");
  const artifactHash = canonical.canonicalArtifactHash(contracts.parseSupportedTeamMemMeetingArtifact(meeting));
  requireTerminal(artifactHash === delivery.artifactHash && manifest.artifact_hash === artifactHash && meeting.transcript_complete === false && Date.parse(meeting.ended_at) === state.r2.endedAtMs && ingressPathExists(path.join(bundleDir, "READY")), "artifact_binding");
  requireTerminal(typeof verifyPublication === "function" && await verifyPublication({ root, bundleDir, artifactHash, occurrenceId, receipt, receiptPath }), "publication_proof");
  const source = await measureTerminalSources(root, state);
  const baseline = assertTerminalBaseline({ state, inviteHash: state.event.normalizedSha256, source, originalFiles,
    firstOwner: { closed: summary.exit === 0 && summary.driveFailure === null && bundle.events.some(row => row.name === "r2_live_cleanup_confirmed") &&
      bundle.events.some(row => row.name === "owned_peers_closed") && CLOSE.every((code, i) => bundle.trace.indexOf(code) >= 0 && (i === 0 || bundle.trace.indexOf(code) > bundle.trace.indexOf(CLOSE[i - 1]))),
      cleanupConfirmed: bundle.processCleanup.cleanupConfirmed && bundle.processCleanup.knownOwnedChildrenReaped && bundle.processCleanup.processInventoryVerified,
      afterStoreClose: bundle.negativeProofs.afterStoreClose.length },
    publication: { verified: true, occurrenceId, revision: 1, artifactHash, publicationUrl: receipt.markdown_url, vaultCommit: receipt.vault_commit,
      requestUuid: message[0].uuid, messageText: message[0].text, recipientId: message[0].receiveId },
    files: terminalFiles({ root, bundleDir, receiptPath }) });
  const i = state.invite, e = state.event, envelope = { schema: "2.0", header: { event_id: e.eventId, event_type: "vc.bot.meeting_invited_v1", app_id: i.appId, tenant_key: i.tenantKey, create_time: e.createTime },
    event: { meeting: { id: i.providerMeetingId, meeting_no: i.meetingNo, topic: e.title, start_time: e.startSeconds, end_time: e.endSeconds }, invite_time: e.inviteSeconds, call_id: e.callId } };
  const ingress = await import("../dist/src/ports/feishu-ingress.js");
  requireTerminal(ingress.normalizeInvite(envelope, i).normalizedSha256 === baseline.inviteHash, "normalized_identity");
  return { root, databasePath, occurrenceId, standaloneConfigPath: path.join(root, "config", "standalone.json"), envelope, baseline, bundleDir, receiptPath,
    originalWireMessageId: "e2e-message", wireMessageId: `terminal-reopen-${randomBytes(16).toString("hex")}` };
}
/** Exclusive private byte custody BEFORE reopen; originals are never restored. */
export async function preserveTerminalEvidence(plan, { directory, bundlePath, reviewPath = REVIEW_PATH }) {
  plan = ingressData(plan); physical(directory);
  const relative = path.relative(plan.root, directory);
  requireTerminal(relative.startsWith("..") && !path.isAbsolute(relative) && (lstatSync(directory).mode & 0o077) === 0, "backup_directory");
  requireTerminal(hash(boundedBytes(bundlePath)) === ACCEPTED_R2_BUNDLE && hash(boundedBytes(reviewPath)) === REVIEW_HASH, "backup_authority");
  requireTerminal(same(readTerminalState(plan), plan.baseline.state) && hash(boundedBytes(plan.databasePath)) === ACCEPTED_R2_DATABASE, "backup_baseline_changed");
  requireTerminal(same(assertAcceptedFiles(plan.root), plan.baseline.originalFiles), "backup_baseline_changed");
  requireTerminal(same(await measureTerminalSources(plan.root, plan.baseline.state), plan.baseline.source), "backup_baseline_changed");
  const beforePath = path.join(directory, "before"); mkdirSync(beforePath, { mode: 0o700 });
  const originals = [bundlePath, reviewPath, plan.databasePath, ...Object.keys(ACCEPTED_FILES).map(relative => path.join(plan.root, relative)),
    path.join(plan.bundleDir, "READY"), path.join(plan.bundleDir, "meeting.json"), path.join(plan.bundleDir, "manifest.json"), plan.receiptPath, plan.baseline.state.r2.source.path];
  const files = copyTerminalEvidenceFiles(originals, beforePath);
  requireTerminal(same(readTerminalState(plan), plan.baseline.state) && same(terminalFiles(plan), plan.baseline.files), "backup_baseline_changed");
  requireTerminal(same(assertAcceptedFiles(plan.root), plan.baseline.originalFiles), "backup_baseline_changed");
  requireTerminal(hash(boundedBytes(plan.databasePath)) === ACCEPTED_R2_DATABASE && same(await measureTerminalSources(plan.root, plan.baseline.state), plan.baseline.source), "backup_baseline_changed");
  const manifestPath = path.join(directory, "before.json"), manifest = { schema: "terminal-reopen-private-evidence/v1", phase: "before",
    originalRoot: plan.root, rootIdentity: plan.baseline.state.rootIdentity, databasePath: plan.databasePath, databaseIdentity: plan.baseline.state.databaseIdentity,
    stateSha256: hash(JSON.stringify(plan.baseline.state)), source: plan.baseline.source, originalFiles: plan.baseline.originalFiles, files };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return { manifestPath, sha256: fileFact(manifestPath).sha256 };
}
/** Same bounded byte copier exercised with owned synthetic files in C. */
export function copyTerminalEvidenceFiles(originals, beforePath) {
  originals = ingressData(originals); physical(beforePath);
  requireTerminal(originals.length > 0 && originals.length <= 32 && (lstatSync(beforePath).mode & 0o077) === 0, "backup_directory");
  return originals.map((sourcePath, index) => {
    const before = fileFact(sourcePath), bytes = boundedBytes(sourcePath); requireTerminal(hash(bytes) === before.sha256, "backup_changed");
    const copyPath = path.join(beforePath, `${index}.bin`); writeFileSync(copyPath, bytes, { mode: 0o600, flag: "wx" });
    requireTerminal(same(fileFact(sourcePath), before) && fileFact(copyPath).sha256 === before.sha256, "backup_changed");
    return { sourcePath, copyPath, ...before };
  });
}
export async function preserveTerminalAfter(plan, directory, before) {
  const state = readTerminalState(plan), manifestPath = path.join(directory, "after.json");
  const source = await measureTerminalSources(plan.root, state), files = terminalFiles(plan), originalFiles = terminalOriginalFiles(plan.root);
  const preservedOriginalFiles = same(originalFiles, plan.baseline.originalFiles);
  const preserved = same(state, plan.baseline.state) && same(source, plan.baseline.source) && same(files, plan.baseline.files) && preservedOriginalFiles;
  const manifest = { schema: "terminal-reopen-private-evidence/v1", phase: "after", before, originalRoot: plan.root, rootIdentity: state.rootIdentity,
    databasePath: plan.databasePath, databaseIdentity: state.databaseIdentity, database: fileFact(plan.databasePath), stateSha256: hash(JSON.stringify(state)),
    preservedDurableState: same(state, plan.baseline.state), source, files, originalFiles, preservedOriginalFiles, preserved };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return { manifestPath, sha256: fileFact(manifestPath).sha256, preserved };
}
export async function measureTerminalSources(root, state) {
  return measureR2Sources({ state: state.r2, recordingsDir: path.dirname(state.r2.source.path), audioStore: path.join(root, "teammem", "meeting-audio"), privateRoot: root });
}
export function terminalFiles({ root, bundleDir, receiptPath }) {
  const paths = [path.join(bundleDir, "READY"), path.join(bundleDir, "meeting.json"), path.join(bundleDir, "manifest.json"), receiptPath,
    path.join(root, "bridge-control", "state.json"), path.join(root, "runtime", "gateway-pids.txt")];
  return paths.map(filename => { inside(root, filename); return fileFact(filename); });
}
export function parseTerminalArguments(argv) {
  argv = ingressData(argv); const result = {};
  requireTerminal(argv.length === 4, "arguments");
  for (let i = 0; i < argv.length; i += 2) { const key = argv[i] === "--baseline" ? "baseline" : argv[i] === "--out" ? "out" : null;
    requireTerminal(key && !Object.hasOwn(result, key) && typeof argv[i + 1] === "string" && path.isAbsolute(argv[i + 1]) && path.normalize(argv[i + 1]) === argv[i + 1], "arguments"); result[key] = argv[i + 1]; }
  requireTerminal(result.baseline && result.out && !ingressPathExists(result.out), "arguments"); return result;
}
async function main() {
  const options = parseTerminalArguments(process.argv.slice(2)); physical(path.dirname(options.out));
  const directory = path.join(path.dirname(options.out), `terminal-reopen-${randomBytes(8).toString("hex")}`); mkdirSync(directory, { mode: 0o700 });
  const planPath = path.join(directory, "plan.json"), summaryPath = path.join(directory, "summary.json");
  writeFileSync(planPath, JSON.stringify({ bundlePath: options.baseline, summaryPath, evidenceDirectory: directory }), { mode: 0o600, flag: "wx" });
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "terminal-reopen-entry.mjs"), "--plan", planPath], { stdio: ["ignore", "ignore", "ignore"] });
  const result = await new Promise(resolve => {
    let timedOut = false, killTimer;
    const timer = globalThis.setTimeout(() => { timedOut = true; child.kill("SIGTERM"); killTimer = globalThis.setTimeout(() => child.kill("SIGKILL"), 10000); }, 200000);
    function settle(code, reaped) { globalThis.clearTimeout(timer); globalThis.clearTimeout(killTimer);
      resolve({ pid: Number.isSafeInteger(child.pid) ? child.pid : null, code, reaped, timedOut, stdio: "ignore" }); }
    child.once("error", () => settle(null, false)); child.once("close", code => settle(code, true));
  });
  const summary = boundedJson(summaryPath, true);
  const report = summary ? ingressData(summary) : { schema: "terminal-reopen-report/v1", provenance: "actual_entry", success: false, failures: ["terminal_entry_failed"] };
  report.ownerProcess = result; report.success = report.success === true && result.code === 0 && result.reaped && !result.timedOut;
  if (result.timedOut) { report.failures = [...(report.failures ?? []), "terminal_owner_process_timeout"]; report.closed = false; }
  writeFileSync(options.out, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" }); process.exitCode = report.success ? 0 : 70;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.stderr.write("terminal_run_failed\n"); process.exitCode = 70; });

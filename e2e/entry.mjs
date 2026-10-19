// Test-only entry for the built end-to-end spine (DECISIONS.md D028).
//
// It runs the SHIPPED admission -- the real `readStandaloneConfig`,
// `inspectStateRoot` and `acquireApplicationOwnerLock` behind the shipped
// `runStandalone` -- and the SHIPPED `runStandaloneComposition`. The repeated
// close fault cut alone exposes the built composeApplication handle through a
// labeled test-entry lifecycle wrapper after that same real admission. The only
// things it injects are EXTERNAL TRANSPORTS through option seams the
// composition already accepts:
//
//   feishu.http / feishu.connection  scripted Feishu origin and socket owner
//   organizerReferences              so the REAL metadata resolver is composed
//   maintenance.intervalsMs/random   test cadences only
//   log                              the redacted static-code trace
//
// `startRuntimeTransport` is NOT replaced: the real `StdioGatewayTransport`
// launches the packaged gateway through the private launcher. `bridgeSlots`
// are NOT replaced: the real `createChildBridgeSlot` launches the scripted
// child executable named by the standalone config. The store, workers, close
// order and exit code are the shipped ones.
//
// Everything this produces is "scripted local application test readiness".

import { clearInterval, setInterval } from "node:timers";
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { Agent as HttpAgent } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";

import { defaultHttpInstance } from "@larksuiteoapi/node-sdk";
import Database from "better-sqlite3";
import { readPublicationReceipt } from "../dist/src/adapters/receipt-inbox.js";
import { canonicalArtifactHash } from "../dist/src/contracts/teammem-meeting-v1.js";
import { parseSupportedTeamMemMeetingArtifact } from "../dist/src/contracts/teammem-meeting-v2.js";
import { receiptGateState } from "./l6-receipt-gate.mjs";

import { acquireApplicationOwnerLock } from "../dist/src/adapters/application-owner-lock.js";
import { createFeishuSdkHttp } from "../dist/src/adapters/feishu-sdk-http.js";
import { createFeishuSocketOwner } from "../dist/src/adapters/feishu-sdk-connection.js";
import { composeApplication, runStandaloneComposition } from "../dist/src/application-composition.js";
import { runStandalone } from "../dist/src/main.js";
import { inspectStateRoot, readStandaloneConfig } from "../dist/src/standalone-config.js";

import { startFixtureProvider } from "./fixture-provider.mjs";
import { readStateFile } from "./state-file.mjs";
import { interactiveGatewayToml, liveGatewayToml, postmeetingGatewayToml } from "./gateway-config.mjs";
import { startInteractiveProvider } from "./interactive-provider.mjs";
import { RESERVE_ID, SCOPE, inviteEnvelope, startFeishuPeer } from "./feishu-peer.mjs";
import { closeRepeatedly, runExposedComposition } from "./composition-lifecycle.mjs";
import { readKnownEndRecoveryState, readSeedOccurrenceId } from "./recovery-state.mjs";
import { initialRuntimeSettled } from "./recovery-run.mjs";
import { startR2Provider } from "./r2-provider.mjs";
import { r2GatewayToml } from "./r2-gateway-config.mjs";
import { assertR2Plan, runR2InitialBuild, withOwnedPeers } from "./r2-baseline.mjs";

import { closeL4Composition, driveL4Capture, l4Configuration } from "./l4-campaign.mjs";

import { mediaTimingConfiguration } from "./stage.mjs";
import { mediaTimingMetadata, tailOmissionMetadata, longTailOmissionMetadata, readDurableEvidence } from "./durable-oracles.mjs";

/** Read-only polling of the shipped backfill owner's durable selection. */
export async function waitForMediaTimingAlignment({ read, child, mode, budgetMs, signal }) {
  mediaTimingConfiguration({ mediaTiming: mode });
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error("invalid media timing deadline");
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (mode === "omit-final-pair-long" && signal?.aborted) throw new Error("long_tail_drive_cancelled");
    if (Date.now() >= deadline) throw new Error("e2e_timeout:media_timing_alignment");
    const snapshot = read(); // Missing schema/read errors fail immediately.
    if (mode === "omit-final-pair-long" && signal?.aborted) throw new Error("long_tail_drive_cancelled");
    if (Date.now() >= deadline) throw new Error("e2e_timeout:media_timing_alignment");
    if (snapshot.recordings.length && snapshot.bindings.some(row => row.recording_kind === "final") && snapshot.selected.length)
      return mode === "omit-final-pair-long" ? longTailOmissionMetadata(snapshot, child()) : mode === "omit-final-pair" ? tailOmissionMetadata(snapshot, child()) : mediaTimingMetadata(snapshot, child(), mode);
    await pause(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
export async function closeLongTailComposition({ getApplication, controller }) {
  try {
    const application = getApplication();
    if (!application || typeof application.close !== "function") throw new Error("long_tail_public_close_unavailable");
    try { await application.close(); } catch { throw new Error("long_tail_public_close_failed"); }
  } finally { controller.abort(); }
}
export async function settleLongTailDrive({ drive, getApplication, controller }) {
  let failure = null;
  try { await drive; } catch { failure = "long_tail_drive_prerequisite_failed"; }
  try { await closeLongTailComposition({ getApplication, controller }); }
  catch { failure ??= "long_tail_public_close_failed"; }
  return failure;
}
const plan = isMain ? JSON.parse(readFileSync(process.argv[process.argv.indexOf("--plan") + 1], "utf8")) : {};
const eventsPath = isMain ? path.join(plan.controlDir, "events.ndjson") : null;
const trace = [];

function event(name, detail = {}) {
  const line = { at: new Date().toISOString(), monotonicNs: process.hrtime.bigint().toString(), name, ...detail };
  appendFileSync(eventsPath, `${JSON.stringify(line)}\n`);
}
export function waitFor(check, { budgetMs, name, signal, pollMs = 25 }) {
  return new Promise((resolve, reject) => {
    if (![5, 25].includes(pollMs) || pollMs === 5 && (!Number.isFinite(budgetMs) || budgetMs <= 0)) throw new Error("l4_poll_refused");
    const deadline = Date.now() + budgetMs;
    const timer = setInterval(() => {
      if (signal?.aborted) { clearInterval(timer); reject(new Error("l4_drive_cancelled")); return; }
      if (pollMs === 5 && Date.now() >= deadline) { clearInterval(timer); reject(new Error(`e2e_timeout:${name}`)); return; }
      let value;
      try { value = check(); } catch { value = undefined; }
      if (pollMs === 5 && Date.now() >= deadline) { clearInterval(timer); reject(new Error(`e2e_timeout:${name}`)); return; }
      if (value) { clearInterval(timer); resolve(value); return; }
      if (Date.now() >= deadline) { clearInterval(timer); reject(new Error(`e2e_timeout:${name}`)); }
    }, pollMs);
  });
}
function readJson(filename) {
  return readStateFile(filename);
}
function controlFileExists(name) {
  try { readFileSync(path.join(plan.controlDir, name)); return true; } catch { return false; }
}

/** Selected-only, read-only projection. No claims, recovery bytes or SQL rows
 * cross the entry boundary; the shared gate oracle consumes the same fields
 * as the production store's pending()/notifications() read methods. */
export function l6ReadStore(database) {
  if (!database.readonly) throw new Error("l6_readonly_store_required");
  const camel = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
  return {
    pending: () => database.prepare(`SELECT occurrence_id,revision,artifact_hash,transcript_complete,retry_count,next_retry_at_ms,
      published_at_ms,deleted_at_ms,publication_url,vault_commit FROM delivery_journal WHERE deleted_at_ms IS NULL
      ORDER BY next_retry_at_ms,occurrence_id,revision`).all().map(row => ({ ...camel(row), transcriptComplete: row.transcript_complete === 1 })),
    notifications: () => database.prepare(`SELECT occurrence_id,revision,artifact_hash,publication_url,vault_commit,recipient_id,title,message_text,request_uuid,
      state,first_attempt_at_ms,last_attempt_at_ms,attempt_count,claim_token,provider_message_id,sent_at_ms FROM notification_intents ORDER BY occurrence_id,revision`).all().map(camel),
    getSession: id => database.prepare("SELECT state FROM sessions WHERE occurrence_id=?").get(id),
  };
}
export function assertL6HeldReceiptAbsence({ receiptsDir, remoteHead, seedCommit }) {
  if (remoteHead === seedCommit && readdirSync(receiptsDir).length !== 0) throw new Error("l6_held_receipt_directory_refused");
}
export function l6LaneStatus(status) {
  if (status.codes.length !== 0) throw new Error("l6_lane_status_refused");
  return { codes: [], lanes: ["outbox", "notification"].map(name => {
    const rows = status.lanes.filter(row => row.lane === name);
    if (rows.length !== 1 || rows[0].failures.length !== 0 || !Number.isSafeInteger(rows[0].ticks) || rows[0].ticks < 0)
      throw new Error("l6_lane_status_refused");
    const row = rows[0];
    if (row.lastOutcome !== null && row.lastOutcome !== "outbox_reconciled" && row.lastOutcome !== "notification_polled") throw new Error("l6_lane_status_refused");
    return { lane: name, ticks: row.ticks, failures: [], inFlight: row.inFlight, lastOutcome: row.lastOutcome };
  }) };
}
/** One finite selected channel; concurrent lane work occurs inside the actual
 * Promise.all before its acknowledgment. A prior/duplicate ACK is never reused. */
export async function answerL6Request({ request, previous, deadlineAtMs, observe, tick, status }) {
  if (!request || Object.getPrototypeOf(request) !== Object.prototype || Object.keys(request).sort().join() !== "names,op,remoteHead,sequence" ||
    Object.keys(request).some(name => !("value" in Object.getOwnPropertyDescriptor(request, name))) ||
    !Number.isSafeInteger(request.sequence) || request.sequence !== previous + 1 || request.sequence > 65536 || Date.now() >= deadlineAtMs ||
    !["observe", "poll"].includes(request.op) || !/^[0-9a-f]{40}$/.test(request.remoteHead) || !Array.isArray(request.names) ||
    (request.op === "observe" ? request.names.length !== 0 : request.names.length < 1 || request.names.length > 2 ||
      new Set(request.names).size !== request.names.length || request.names.some(name => !["outbox", "notification"].includes(name)))) throw new Error("l6_request_refused");
  const outcomes = request.op === "poll" ? await Promise.all(request.names.map(name => tick(name))) : [];
  if (Date.now() >= deadlineAtMs) throw new Error("l6_entry_deadline");
  return { sequence: request.sequence, outcomes, status: l6LaneStatus(status()), state: request.op === "observe" ? observe(request.remoteHead) : null };
}
export async function waitForL6Seed({ wait, seedReady, done, budgetMs }) {
  const state = await wait(() => done() ? "aborted" : seedReady() ? "ready" : false, { budgetMs, name: "l6_seed" });
  // waitFor deliberately swallows predicate exceptions. Refuse only after its
  // closed abort sentinel resolves, so parent failure cannot become a timeout.
  if (state !== "ready") throw new Error("l6_parent_aborted");
}
export async function serveL6Entry({ controlDir, deadlineAtMs, observe, tick, status, done, aborted = () => false }) {
  let previous = 0;
  for (;;) {
    if (aborted()) throw new Error("l6_parent_aborted");
    if (done()) return;
    if (Date.now() >= deadlineAtMs) throw new Error("l6_entry_deadline");
    const filename = path.join(controlDir, "l6-request.json");
    if (existsSync(filename)) {
      const bytes = readFileSync(filename);
      if (bytes.length > 1024) throw new Error("l6_request_refused");
      const request = JSON.parse(bytes);
      if (request.sequence !== previous) {
        const response = await answerL6Request({ request, previous, deadlineAtMs, observe, tick, status });
        if (aborted()) throw new Error("l6_parent_aborted");
        const temporary = path.join(controlDir, "l6-response.tmp");
        writeFileSync(temporary, JSON.stringify(response), { mode: 0o600 });
        renameSync(temporary, path.join(controlDir, "l6-response.json")); previous = request.sequence;
      }
    }
    await pause(10);
  }
}

/** Atomically swaps the gateway deployment configuration between lanes. A
 * running gateway read its configuration at start and never re-reads it, so
 * this is done while the live gateway is still up and strictly before any
 * finalization seed -- and therefore any backfill claim -- can exist. */
function selectPostmeetingGatewayConfig(fixtureEndpoint) {
  const next = `${plan.gatewayConfigPath}.postmeeting`;
  writeFileSync(next, postmeetingGatewayToml({
    recordingsDir: plan.runtimeRecordingsDir, keyEnv: plan.recordingKeyEnv,
    modelsDir: plan.runtimeModelsDir, fixtureEndpoint,
  }), { mode: 0o600 });
  renameSync(next, plan.gatewayConfigPath);
  event("gateway_config_postmeeting");
}

async function main() {
  l4Configuration(plan);
  mediaTimingConfiguration(plan);
  assertR2Plan(plan);
  if (plan.l6ReceiptGate && (!plan.r2Baseline || plan.interactive || plan.d2Cut || plan.l4Case !== undefined || plan.mediaTiming !== undefined || plan.initialR1))
    throw new Error("l6_selection_refused");
  writeFileSync(eventsPath, "");
  if (plan.initialR1) event("entry_environment", { keys: Object.keys(process.env).sort() });
  const result = await withOwnedPeers({
    interactive: async () => plan.interactive ? startInteractiveProvider() : null,
    provider: async () => plan.r2Baseline ? startR2Provider({ segmentText: "Scripted fixture R2 baseline segment.", segmentStartMs: 100, segmentEndMs: 200 }) : startFixtureProvider({ l4Case: plan.l4Case }),
    unusedVoice: async () => plan.r2Baseline ? startInteractiveProvider() : null,
    peer: async () => startFeishuPeer({ meeting: plan.meeting }),
  }, driveApplication);
  event("owned_peers_closed");
  writeFileSync(path.join(plan.controlDir, "summary.json"), JSON.stringify(result.summary));
  process.exit(result.summary.driveFailure === null ? result.exit : 70);
}

async function driveApplication({ interactive, provider, unusedVoice, peer }) {
  const liveConfig = plan.interactive ? interactiveGatewayToml : liveGatewayToml;
  writeFileSync(plan.gatewayConfigPath, liveConfig({
    recordingsDir: plan.runtimeRecordingsDir, keyEnv: plan.recordingKeyEnv, credentialEnv: plan.providerCredentialEnv,
    ...(interactive ? { endpoint: interactive.endpoint, recognitionEndpoint: interactive.recognitionEndpoint } : {}),
  }), { mode: 0o600 });

  event("peers_started", { feishuOrigin: peer.origin, providerEndpoint: provider.endpoint });

  const http = createFeishuSdkHttp({
    request: peer.rewriteRequest(defaultHttpInstance.request),
    connection: createFeishuSocketOwner(HttpAgent),
  });
  const connection = createFeishuSocketOwner(HttpAgent);

  const l4Controller = plan.l4Case === undefined ? null : new globalThis.AbortController();
  const longController = plan.mediaTiming === "omit-final-pair-long" ? new globalThis.AbortController() : null;
  let l4Drive = null;
  let shuttingDown = false;
  let compositionHandle = null;
  let r2Maintenance = null;
  const driveWaitFor = (check, options) => waitFor(check, { ...options, ...(l4Controller || longController ? { signal: (l4Controller ?? longController).signal } : {}) });
  const drive = (async () => {
    // 1. The long connection is ready once the shipped ingress reports started.
    await driveWaitFor(() => trace.includes("composition_started"), { budgetMs: plan.budgets.startMs, name: "composition_started" });
    await driveWaitFor(() => peer.connectionCount > 0, { budgetMs: plan.budgets.startMs, name: "long_connection" });
    event("long_connection_ready");

    // 2. One scheduled-meeting invite through the real dispatcher's accept().
    peer.deliverInvite(inviteEnvelope(plan.meeting), plan.meeting.eventId);
    event("invite_delivered");
    await driveWaitFor(() => peer.acknowledgements.some((value) => value?.code === 200), { budgetMs: plan.budgets.admitMs, name: "invite_ack" });
    event("invite_acknowledged");

    // Conflict recognition readiness precedes the generic capture threshold.
    // The actual capture check below and final recording oracles still apply.
    if (plan.l4Case === "sent-conflict") {
      l4Drive = await driveL4Capture({ l4Case: plan.l4Case, provider: interactive,
        child: () => readJson(path.join(plan.controlDir, "state.json")), runtimeEvents, waitFor: driveWaitFor, budgetMs: plan.budgets.captureMs });
    }

    // 3. The scripted client reports its own media stream.
    const child = await driveWaitFor(() => {
      const state = readJson(path.join(plan.controlDir, "state.json"));
      return state?.mediaConnected && state.framesSent >= plan.captureFrames ? state : null;
    }, { budgetMs: plan.budgets.captureMs, name: "media_capture" });
    event("media_capture", { framesSent: child.framesSent, endpoint: child.mediaEndpoint });

    if (plan.l4Case !== undefined) {
      if (plan.l4Case !== "sent-conflict") {
        l4Drive = await driveL4Capture({ l4Case: plan.l4Case, provider: interactive,
          child: () => readJson(path.join(plan.controlDir, "state.json")), runtimeEvents, waitFor: driveWaitFor, budgetMs: plan.budgets.captureMs });
      }
      const selectedChild = readJson(path.join(plan.controlDir, "state.json"));
      l4Drive.bridgeSessionId = selectedChild.l4.bridgeSessionId;
      l4Drive.disclosureCommandId = selectedChild.l4.disclosureCommandId;
      event("l4_capture_recognized", { case: plan.l4Case, segmentId: l4Drive.segmentId, runtimeSessionId: l4Drive.runtimeSessionId,
        planSha256: l4Drive.planSha256, rawRows: l4Drive.rawRows });
    } else if (interactive) await driveInteractive(interactive, () => compositionHandle);
    // This fault cut closes the active shipped owner; it does not pretend a
    // positive meeting end or wait for publication the closure never promised.
    if (plan.d2Cut === "repeated-close") return;

    // 4. Swap the gateway deployment configuration for the post-meeting lane,
    //    then end the meeting positively.
    if (plan.r2Baseline) {
      provider.setFinalAvailable(false);
      event("r2_final_unavailable");
      const next = `${plan.gatewayConfigPath}.postmeeting`;
      writeFileSync(next, r2GatewayToml({
        recordingsDir: plan.runtimeRecordingsDir, keyEnv: plan.recordingKeyEnv, credentialEnv: plan.providerCredentialEnv,
        languageEndpoint: "https://meeting-e2e.invalid/v1",
        recognitionEndpoint: "wss://meeting-e2e.invalid/v1/realtime?intent=transcription",
        speechEndpoint: "https://meeting-e2e.invalid/v1", diarizationEndpoint: "https://meeting-e2e.invalid/v1",
        scriptedProviders: { language: provider.endpoint, recognition: unusedVoice.recognitionEndpoint, speech: unusedVoice.endpoint, diarization: provider.endpoint },
      }), { mode: 0o600 });
      renameSync(next, plan.gatewayConfigPath);
      event("gateway_config_postmeeting", { mode: "r2-baseline", gateway: "scripted" });
    } else selectPostmeetingGatewayConfig(provider.endpoint);
    if (plan.initialR1) { provider.armNextChatFailure(); event("r1_initial_failure_armed"); }
    writeFileSync(path.join(plan.controlDir, "end"), "ended");
    event("meeting_ended_signalled");

    if (plan.mediaTiming !== undefined) {
      const databasePath = path.join(JSON.parse(readFileSync(plan.standaloneConfigPath, "utf8")).stateRoot, "orchestration.db");
      const occurrence = `${plan.meeting.providerMeetingId}@${new Date(plan.meeting.startSeconds * 1000).toISOString().replace(".000Z", "Z")}`;
      const summary = await waitForMediaTimingAlignment({ read: () => readDurableEvidence(databasePath, occurrence),
        child: () => readJson(path.join(plan.controlDir, "state.json")), mode: plan.mediaTiming, budgetMs: plan.budgets.buildMs,
        ...(longController ? { signal: longController.signal } : {}) });
      event("media_timing_alignment_ready", { summary });
      return;
    }

    if (plan.r2Baseline) r2Maintenance = await runR2InitialBuild({
      getComposition: () => compositionHandle,
      occurrenceId: `${plan.meeting.providerMeetingId}@${new Date(plan.meeting.startSeconds * 1000).toISOString().replace(".000Z", "Z")}`,
      waitFor, budgetMs: plan.budgets.buildMs, event,
    });

    if (plan.initialR1) {
      const databasePath = path.join(JSON.parse(readFileSync(plan.standaloneConfigPath, "utf8")).stateRoot, "orchestration.db");
      const occurrence = await driveWaitFor(() => compositionHandle?.occurrenceOutcomes().find(initialRuntimeSettled),
      { budgetMs: plan.budgets.buildMs, name: "r1_live_cleanup_confirmed" });
      event("r1_live_cleanup_confirmed", { occurrenceId: occurrence.occurrenceId });
      const outcome = await compositionHandle.maintenanceTick("backfill");
      if (outcome !== "backfill_rescheduled" || compositionHandle.maintenanceStatus().codes.length !== 0)
        throw new Error("r1_initial_worker_outcome_refused");
      const seed = await driveWaitFor(() => {
        const occurrenceId = readSeedOccurrenceId(databasePath);
        const state = readKnownEndRecoveryState({ databasePath, occurrenceId });
        return state.r1Preconditions.initialFailureRestartReady ? state : null;
      }, { budgetMs: plan.budgets.buildMs, name: "r1_initial_build_failed" });
      if (readdirSync(plan.outboxDir).length !== 0 || seed.occurrenceId !== occurrence.occurrenceId ||
        !provider.calls.some(call => call.route === "chat" && call.outcome === "armed_failure"))
        throw new Error("r1_initial_failure_cut_refused");
      event("r1_seed_failed", { occurrenceId: seed.occurrenceId, stopAtMs: seed.stopAtMs,
        expiresAtMs: seed.expiresAtMs, sourceSha256: seed.source.sha256, providerArmedFailure: true });
      // Parent owns the crash. Keep the admitted application alive; returning
      // here would trigger the normal graceful shutdown and invalidate R1.
      await new Promise(() => {});
    }

    // 5. The shipped outbox writes READY last; the harness then publishes.
    //    A bundle the shipped delivery lane cannot build is a recorded block,
    //    not a harness failure: the run still closes through the real order.
    let bundle = null;
    if (plan.l4Case !== undefined) {
      bundle = await driveWaitFor(() => findReadyBundle(), { budgetMs: plan.budgets.buildMs, name: "l4_artifact_ready" });
      event("artifact_ready", { bundle });
      return; // Explicit L6/L7 non-publication selection; READY is still mandatory.
    }
    try {
      bundle = await driveWaitFor(() => findReadyBundle(), { budgetMs: plan.budgets.buildMs, name: "artifact_bundle" });
      event("artifact_ready", { bundle });
    } catch (error) {
      event("artifact_blocked", { reason: String(error?.message ?? error) });
    }

    if (plan.l6ReceiptGate) {
      if (!bundle || peer.messages.length !== 0) throw new Error("l6_fresh_peer_required");
      const artifact = parseSupportedTeamMemMeetingArtifact(JSON.parse(readFileSync(path.join(bundle, "meeting.json"), "utf8")));
      if (artifact.revision !== 1 || artifact.transcript_complete !== false || !artifact.organizer) throw new Error("l6_artifact_refused");
      const databasePath = path.join(JSON.parse(readFileSync(plan.standaloneConfigPath, "utf8")).stateRoot, "orchestration.db");
      const database = new Database(databasePath, { readonly: true, fileMustExist: true });
      try {
        const store = l6ReadStore(database), artifactHash = canonicalArtifactHash(artifact);
        // The actual parent supplies only its measured seed/remote head. No
        // test receipt writer, sender or synthetic clock enters this adapter.
        await waitForL6Seed({ wait: driveWaitFor, seedReady: () => controlFileExists("l6-seed.json"),
          done: () => controlFileExists("teammem-done") || controlFileExists("l6-abort"), budgetMs: plan.budgets.teammemMs });
        const seed = readJson(path.join(plan.controlDir, "l6-seed.json"));
        if (!seed || Object.keys(seed).sort().join() !== "deadlineAtMs,seedCommit" || !/^[0-9a-f]{40}$/.test(seed.seedCommit) ||
          !Number.isSafeInteger(seed.deadlineAtMs) || seed.deadlineAtMs <= Date.now() || seed.deadlineAtMs > Date.now() + plan.budgets.teammemMs) throw new Error("l6_seed_refused");
        const receiptsDir = JSON.parse(readFileSync(plan.standaloneConfigPath, "utf8")).dataPaths.receiptsDir;
        const observe = remoteHead => {
          assertL6HeldReceiptAbsence({ receiptsDir, remoteHead, seedCommit: seed.seedCommit });
          return database.transaction(() => receiptGateState({ store, occurrenceId: artifact.occurrence_id,
          artifactHash, creatorId: artifact.organizer.person_id, title: artifact.title, seedCommit: seed.seedCommit, remoteHead,
          receipt: readPublicationReceipt({ receiptsDir, occurrenceId: artifact.occurrence_id, revision: 1, artifactHash }), messages: peer.messages, nowMs: Date.now() }))();
        };
        await serveL6Entry({ controlDir: plan.controlDir, deadlineAtMs: seed.deadlineAtMs, observe,
          tick: name => compositionHandle.maintenanceTick(name), status: () => compositionHandle.maintenanceStatus(),
          done: () => controlFileExists("teammem-done"), aborted: () => controlFileExists("l6-abort") });
        event("l6_public_controller_settled");
      } finally { database.close(); }
    }

    // 6. The harness runs the real TeamMem consumer; the shipped outbox worker
    //    journals its receipt and the notification lane delivers one DM.
    await driveWaitFor(() => controlFileExists("teammem-done"), { budgetMs: plan.budgets.teammemMs, name: "teammem_done" });
    event("teammem_done");
    if (bundle !== null) {
      try {
        await driveWaitFor(() => peer.messages.length > 0, { budgetMs: plan.budgets.notifyMs, name: "organizer_dm" });
        event("organizer_dm", { count: peer.messages.length });
      } catch (error) {
        event("organizer_dm_blocked", { reason: String(error?.message ?? error) });
      }
    }
  })();

  /** The shipped filesystem outbox writes READY last, so its presence is the
   * only proof the strict bundle is complete. Never written by the harness. */
  function findReadyBundle() {
    for (const entry of readdirSync(plan.outboxDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const occurrence = path.join(plan.outboxDir, entry.name);
      for (const revision of readdirSync(occurrence, { withFileTypes: true })) {
        if (!revision.isDirectory()) continue;
        const bundle = path.join(occurrence, revision.name);
        if (existsSync(path.join(bundle, "READY"))) return bundle;
      }
    }
    return null;
  }

  const compositionOptions = {
    feishu: { http, connection, readyTimeoutMs: plan.budgets.readyTimeoutMs, handshakeTimeoutMs: 5000, closeTimeoutMs: 7000 },
    organizerReferences: [{ ...SCOPE, meetingNo: plan.meeting.meetingNo, reference: { kind: "reservation", reserveId: RESERVE_ID } }],
    maintenance: { intervalsMs: plan.laneIntervalsMs, random: () => 0 },
    log: (code) => { trace.push(code); event("log", { code }); },
  };
  const dependencies = {
    readConfig: readStandaloneConfig,
    inspectStateRoot,
    acquireOwnerLock: acquireApplicationOwnerLock,
    composeAfterAdmission: (config, owner) => plan.d2Cut === "repeated-close" || plan.initialR1 || plan.r2Baseline || plan.l4Case !== undefined || longController
      ? runExposedComposition(composeApplication, config, owner, compositionOptions, (handle) => {
        compositionHandle = handle;
        event("test_entry_composition_exposed", { path: "built_composeApplication_after_shipped_admission" });
      }, ...(l4Controller || longController ? [l4Controller ?? longController] : []))
      : runStandaloneComposition(config, owner, compositionOptions),
    report(channel, line) { event("report", { channel, line }); process[channel === "stdout" ? "stdout" : "stderr"].write(`${line}\n`); },
  };

  const run = runStandalone(["--standalone-config", plan.standaloneConfigPath], dependencies);

  let driveFailure = null, l4Settlement = null, longSettlement = null;
  if (l4Controller) {
    l4Settlement = drive.then(() => undefined, error => {
      driveFailure = /^l4_[a-z_]+$/.test(error?.message ?? "") ? error.message : "l4_drive_prerequisite_failed";
      event("drive_failed", { reason: driveFailure });
    }).then(async () => {
      shuttingDown = true;
      try { await closeL4Composition({ getApplication: () => compositionHandle, controller: l4Controller }); }
      catch { driveFailure ??= "l4_public_close_failed"; event("drive_failed", { reason: driveFailure }); }
      event("l4_public_close_settled");
    });
  } else if (longController) {
    longSettlement = settleLongTailDrive({ drive, getApplication: () => compositionHandle, controller: longController }).then(failure => {
      shuttingDown = true;
      driveFailure ??= failure;
      if (driveFailure) event("drive_failed", { reason: driveFailure });
      event("long_tail_public_close_settled");
    });
  } else drive.then(() => undefined, (error) => { driveFailure = plan.l6ReceiptGate ? "l6_entry_prerequisite_failed" : String(error?.message ?? error); event("drive_failed", { reason: driveFailure }); })
    .then(() => {
      shuttingDown = true;
      event("shutdown_signalled");
      process.kill(process.pid, "SIGTERM");
    });

  let exit;
  try { exit = await run; }
  finally {
    // Close the admitted owner before external peers even on app failure.
    if (l4Controller) {
      if (!l4Controller.signal.aborted) {
        try { await closeL4Composition({ getApplication: () => compositionHandle, controller: l4Controller }); }
        catch { driveFailure ??= "l4_public_close_failed"; }
      }
      await l4Settlement;
    } else if (longController) {
      if (!longController.signal.aborted) {
        try { await closeLongTailComposition({ getApplication: () => compositionHandle, controller: longController }); }
        catch { driveFailure ??= "long_tail_public_close_failed"; }
      }
      await longSettlement;
    } else if (compositionHandle) await compositionHandle.close();
  }
  event("run_standalone_exit", { exit });
  if (plan.d2Cut === "repeated-close") {
    const released = await acquireApplicationOwnerLock(JSON.parse(readFileSync(plan.standaloneConfigPath, "utf8")).stateRoot);
    released.close();
    event("owner_lock_released", { released: true, via: "reacquire_after_runStandalone", afterStoreClosed: trace.includes("shutdown_store_closed") });
  }
  return { exit, summary: {
    exit, driveFailure, shuttingDown, trace,
    feishuRequests: peer.requests, feishuMessages: peer.messages, providerCalls: provider.calls,
    interactiveCalls: interactive?.calls ?? [], interactiveConnections: interactive?.connections ?? null, runtimeEvents: runtimeEvents(), vaultReads: vaultReads(), entryEnvKeys: Object.keys(process.env).sort(),
    ...(plan.l4Case === undefined ? {} : { l4Drive }),
    r2Maintenance: plan.r2Baseline ? compositionHandle?.maintenanceStatus() ?? r2Maintenance : null,
    unusedVoice: unusedVoice ? { calls: unusedVoice.calls, appended: unusedVoice.appended, ready: unusedVoice.ready } : null,
  } };
}

function runtimeEvents() {
  try { return readFileSync(path.join(plan.controlDir, "runtime-events.ndjson"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
}
function vaultReads() {
  try { return readFileSync(path.join(plan.controlDir, "vault-reads.ndjson"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
}

async function driveInteractive(provider, getComposition) {
  const state = () => readJson(path.join(plan.controlDir, "state.json"));
  await waitFor(() => provider.ready, { budgetMs: 15_000, name: "recognition_ready" });
  event("silent_capture", { frames: state().framesSent, disclosure: state().disclosure, languageCalls: provider.calls.length, playback: state().playback.length, authorizations: runtimeEvents().filter((entry) => entry.type === "response_authorized").length });
  async function turn(name, text, authorized, awaitCompletion = authorized) {
    const before = runtimeEvents().length;
    provider.transcript(text);
    const expected = authorized ? "response_authorized" : "response_skipped";
    const transcript = await waitFor(() => runtimeEvents().slice(before).find((entry) => entry.type === "voice_transcript_final"), { budgetMs: 15_000, name: "transcript_final" });
    const decision = await waitFor(() => runtimeEvents().slice(before).find((entry) => entry.type === expected && entry.segment_id === transcript.segment_id), { budgetMs: 15_000, name: expected });
    const binding = { sessionId: transcript.session_id, segment: transcript.segment_id, turn: decision.turn_id ?? null };
    event("transcript_tested", { testName: name, text, ...binding, authorized });
    if (awaitCompletion) await waitFor(() => runtimeEvents().slice(before).some((entry) => entry.event?.type === "turn_completed" && entry.event.turn_id === decision.turn_id), { budgetMs: 15_000, name: "turn_completed" });
    return binding;
  }
  await turn("current_fact", "Copper budget is seven. Copper budget is approved.", false);
  await turn("incidental_name", "Meetbot is useful.", false);
  await turn("near_name", "Meetbop, please summarize.", false);
  event("name_gate_negative", { languageCalls: provider.calls.filter((entry) => entry.route === "language").length, playback: state().playback.length });
  const revisionReads = () => vaultReads().filter((entry) => entry.type === "vault_revision_read").length;
  let before = revisionReads();
  const current = await turn("current", "Meetbot, what is copper budget?", true);
  event("current_question_answered", { ...current, vaultReadsBefore: before, vaultReadsAfter: revisionReads() });
  before = revisionReads();
  const vault = await turn("vault", "Meetbot, please explain Orion launch code history?", true);
  event("vault_question_answered", { ...vault, vaultReadsBefore: before, vaultReadsAfter: revisionReads() });
  renameSync(plan.teamVaultDir, `${plan.teamVaultDir}.unavailable`);
  try {
    const unavailable = await turn("unavailable", "Meetbot, please recall nebula archive password?", true);
    event("unavailable_question_answered", unavailable);
  } finally { renameSync(`${plan.teamVaultDir}.unavailable`, plan.teamVaultDir); }

  const hold = path.join(plan.controlDir, "hold-playback"), barge = path.join(plan.controlDir, "barge");
  writeFileSync(hold, "hold");
  const beforePlayback = state().playback.length, beforeEvents = runtimeEvents().length;
  provider.holdLanguage();
  const story = await turn("story", "Meetbot, please tell us a long story?", true, false);
  const frame = await waitFor(() => state().playback.slice(beforePlayback).find((entry) => entry.turn === story.turn && entry.held), { budgetMs: 15_000, name: "held_playback" });
  const accepted = await waitFor(() => runtimeEvents().slice(beforeEvents).find((row) => row.type === "voice_playback" &&
    row.state === "accepted" && row.session_id === story.sessionId && row.generation_id === frame.generation),
  { budgetMs: 15_000, name: "held_runtime_accepted" });
  event("held_playback_accepted", { ...story, generation: frame.generation, sequence: frame.sequence, acceptedMonotonicNs: accepted.monotonicNs });
  const captureBefore = state().framesSent;
  async function releaseRenderCallbacks(requests) {
    writeFileSync(path.join(plan.controlDir, "render-callbacks.json"), JSON.stringify(requests));
    return await waitFor(() => {
      const releases = state()?.renderReleases ?? [];
      const actual = requests.map((request) => releases.find((entry) => entry.requestId === request.id));
      return actual.every(Boolean) ? actual : null;
    }, { budgetMs: 5000, name: "render_callbacks" });
  }
  if (plan.d2Cut === "repeated-close") {
    const app = getComposition();
    const startedWhileHeld = frame.held && !runtimeEvents().some((entry) => entry.event?.turn_id === story.turn && ["turn_completed", "turn_cancelled", "turn_failed"].includes(entry.event.type));
    event("repeated_close_started", { ...story, generation: frame.generation, startedWhileHeld });
    const closed = await closeRepeatedly(app);
    event("repeated_close", { ...closed, startedWhileHeld, trace: [...trace] });
    provider.releaseLanguage();
    rmSync(hold, { force: true });
    return;
  }
  if (plan.d2Cut === "complete-wins") {
    rmSync(hold);
    const heldFrames = state().playback.slice(beforePlayback).filter((entry) => entry.turn === story.turn && entry.held);
    const rendered = await releaseRenderCallbacks(heldFrames.map((entry) => ({ id: `complete-${entry.sequence}`, sequence: entry.sequence, generation: entry.generation })));
    provider.releaseLanguage();
    await waitFor(() => runtimeEvents().slice(beforeEvents).some((entry) => entry.event?.type === "turn_completed" && entry.event.turn_id === story.turn), { budgetMs: 15_000, name: "completion_wins_terminal" });
    const activityIndex = provider.calls.length, captureAtCompletion = state().capturePosition;
    provider.armBargeOnSpeech();
    writeFileSync(barge, "late voiced capture");
    const activity = await waitFor(() => provider.calls.slice(activityIndex).find((entry) => entry.route === "barge_activity"), { budgetMs: 5000, name: "late_activity" });
    const runtimeActivity = await waitFor(() => runtimeEvents().slice(beforeEvents).find((row) => row.type === "voice_activity" &&
      row.session_id === story.sessionId && row.activity?.type === "speech_started" && BigInt(row.monotonicNs) >= BigInt(activity.monotonicNs)),
    { budgetMs: 5000, name: "late_runtime_activity" });
    const callbacks = await releaseRenderCallbacks([{ id: "completed-duplicate", sequence: frame.sequence, generation: frame.generation }]);
    await waitFor(() => BigInt(state().capturePosition.sequence) >= BigInt(captureAtCompletion.sequence) + 10n, { budgetMs: 5000, name: "capture_after_completion" });
    rmSync(barge);
    event("completion_ordered", { ...story, generation: frame.generation, lateActivityMonotonicNs: activity.monotonicNs,
      runtimeLateActivityMonotonicNs: runtimeActivity.monotonicNs,
      rendered, renderCallbacks: callbacks, captureAtCompletion, captureAfterCompletion: state().capturePosition });
    return;
  }
  provider.armBargeOnSpeech();
  writeFileSync(barge, "voiced capture");
  const flush = await waitFor(() => state().flushes.find((entry) => entry.generation === frame.generation), { budgetMs: 15_000, name: "barge_flush_ack" });
  await waitFor(() => runtimeEvents().slice(beforeEvents).some((entry) => entry.event?.type === "turn_cancelled" && entry.event.turn_id === story.turn), { budgetMs: 15_000, name: "turn_cancelled" });
  provider.releaseLanguage();
  rmSync(hold); rmSync(barge);
  await waitFor(() => BigInt(state().capturePosition.sequence) >= BigInt(flush.capturePosition.sequence) + 10n, { budgetMs: 5000, name: "capture_after_interrupt" });
  const callbacks = plan.d2Cut === "cancel-wins" ? await releaseRenderCallbacks([{ id: "cancelled-late-render", sequence: frame.sequence, generation: frame.generation }]) : [];
  const activity = provider.calls.find((entry) => entry.route === "barge_activity");
  const activityAt = activity?.at;
  event("interruption_acknowledged", { generation: frame.generation, turn: frame.turn, activityAt, flushAt: flush.at,
    scriptedLatencyMs: typeof activityAt === "number" ? flush.at - activityAt : null, captureBefore, captureAfter: state().framesSent,
    activityMonotonicNs: activity?.monotonicNs ?? null, flushMonotonicNs: flush.monotonicNs,
    scriptedMonotonicLatencyMs: activity ? Number(BigInt(flush.monotonicNs) - BigInt(activity.monotonicNs)) / 1_000_000 : null,
    latencyEndpoints: "provider_onset_send_to_peer_flush_ack_write_callback_shared_host",
    captureAtFlush: flush.capturePosition, captureAfterFlush: state().capturePosition, renderCallbacks: callbacks });
}

if (isMain) main().catch((error) => {
  const reason = plan.l6ReceiptGate ? "l6_entry_prerequisite_failed" : String(error?.message ?? error);
  event("entry_failed", { reason });
  writeFileSync(path.join(plan.controlDir, "summary.json"), JSON.stringify({ exit: null, driveFailure: reason, trace }));
  process.exit(71);
});

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

import { acquireApplicationOwnerLock } from "../dist/src/adapters/application-owner-lock.js";
import { createFeishuSdkHttp } from "../dist/src/adapters/feishu-sdk-http.js";
import { createFeishuSocketOwner } from "../dist/src/adapters/feishu-sdk-connection.js";
import { composeApplication, runStandaloneComposition } from "../dist/src/application-composition.js";
import { runStandalone } from "../dist/src/main.js";
import { inspectStateRoot, readStandaloneConfig } from "../dist/src/standalone-config.js";

import { startFixtureProvider } from "./fixture-provider.mjs";
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
import { mediaTimingMetadata, tailOmissionMetadata, readDurableEvidence } from "./durable-oracles.mjs";

/** Read-only polling of the shipped backfill owner's durable selection. */
export async function waitForMediaTimingAlignment({ read, child, mode, budgetMs }) {
  mediaTimingConfiguration({ mediaTiming: mode });
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error("invalid media timing deadline");
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (Date.now() >= deadline) throw new Error("e2e_timeout:media_timing_alignment");
    const snapshot = read(); // Missing schema/read errors fail immediately.
    if (Date.now() >= deadline) throw new Error("e2e_timeout:media_timing_alignment");
    if (snapshot.recordings.length && snapshot.bindings.some(row => row.recording_kind === "final") && snapshot.selected.length)
      return mode === "omit-final-pair" ? tailOmissionMetadata(snapshot, child()) : mediaTimingMetadata(snapshot, child(), mode);
    await pause(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const plan = isMain ? JSON.parse(readFileSync(process.argv[process.argv.indexOf("--plan") + 1], "utf8")) : {};
const eventsPath = isMain ? path.join(plan.controlDir, "events.ndjson") : null;
const trace = [];

function event(name, detail = {}) {
  const line = { at: new Date().toISOString(), monotonicNs: process.hrtime.bigint().toString(), name, ...detail };
  appendFileSync(eventsPath, `${JSON.stringify(line)}\n`);
}
export function waitFor(check, { budgetMs, name, signal }) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + budgetMs;
    const timer = setInterval(() => {
      if (signal?.aborted) { clearInterval(timer); reject(new Error("l4_drive_cancelled")); return; }
      let value;
      try { value = check(); } catch { value = undefined; }
      if (value) { clearInterval(timer); resolve(value); return; }
      if (Date.now() >= deadline) { clearInterval(timer); reject(new Error(`e2e_timeout:${name}`)); }
    }, 25);
  });
}
function readJson(filename) {
  try { return JSON.parse(readFileSync(filename, "utf8")); } catch { return null; }
}
function controlFileExists(name) {
  try { readFileSync(path.join(plan.controlDir, name)); return true; } catch { return false; }
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
  let l4Drive = null;
  let shuttingDown = false;
  let compositionHandle = null;
  let r2Maintenance = null;
  const driveWaitFor = (check, options) => waitFor(check, { ...options, ...(l4Controller ? { signal: l4Controller.signal } : {}) });
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

    // 3. The scripted client reports its own media stream.
    const child = await driveWaitFor(() => {
      const state = readJson(path.join(plan.controlDir, "state.json"));
      return state?.mediaConnected && state.framesSent >= plan.captureFrames ? state : null;
    }, { budgetMs: plan.budgets.captureMs, name: "media_capture" });
    event("media_capture", { framesSent: child.framesSent, endpoint: child.mediaEndpoint });

    if (plan.l4Case !== undefined) {
      l4Drive = await driveL4Capture({ l4Case: plan.l4Case, provider: interactive,
        child: () => readJson(path.join(plan.controlDir, "state.json")), runtimeEvents, waitFor: driveWaitFor, budgetMs: plan.budgets.captureMs });
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
        child: () => readJson(path.join(plan.controlDir, "state.json")), mode: plan.mediaTiming, budgetMs: plan.budgets.buildMs });
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
    composeAfterAdmission: (config, owner) => plan.d2Cut === "repeated-close" || plan.initialR1 || plan.r2Baseline || plan.l4Case !== undefined
      ? runExposedComposition(composeApplication, config, owner, compositionOptions, (handle) => {
        compositionHandle = handle;
        event("test_entry_composition_exposed", { path: "built_composeApplication_after_shipped_admission" });
      }, ...(l4Controller ? [l4Controller] : []))
      : runStandaloneComposition(config, owner, compositionOptions),
    report(channel, line) { event("report", { channel, line }); process[channel === "stdout" ? "stdout" : "stderr"].write(`${line}\n`); },
  };

  const run = runStandalone(["--standalone-config", plan.standaloneConfigPath], dependencies);

  let driveFailure = null, l4Settlement = null;
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
  } else drive.then(() => undefined, (error) => { driveFailure = String(error?.message ?? error); event("drive_failed", { reason: driveFailure }); })
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
    interactiveCalls: interactive?.calls ?? [], runtimeEvents: runtimeEvents(), vaultReads: vaultReads(), entryEnvKeys: Object.keys(process.env).sort(),
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
  event("entry_failed", { reason: String(error?.message ?? error) });
  writeFileSync(path.join(plan.controlDir, "summary.json"), JSON.stringify({ exit: null, driveFailure: String(error?.message ?? error), trace }));
  process.exit(71);
});

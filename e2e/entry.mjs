// Test-only entry for the built end-to-end spine (DECISIONS.md D028).
//
// It runs the SHIPPED admission -- the real `readStandaloneConfig`,
// `inspectStateRoot` and `acquireApplicationOwnerLock` behind the shipped
// `runStandalone` -- and the SHIPPED `runStandaloneComposition`. The only
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
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { Agent as HttpAgent } from "node:http";
import path from "node:path";
import process from "node:process";

import { defaultHttpInstance } from "@larksuiteoapi/node-sdk";

import { acquireApplicationOwnerLock } from "../dist/src/adapters/application-owner-lock.js";
import { createFeishuSdkHttp } from "../dist/src/adapters/feishu-sdk-http.js";
import { createFeishuSocketOwner } from "../dist/src/adapters/feishu-sdk-connection.js";
import { runStandaloneComposition } from "../dist/src/application-composition.js";
import { runStandalone } from "../dist/src/main.js";
import { inspectStateRoot, readStandaloneConfig } from "../dist/src/standalone-config.js";

import { startFixtureProvider } from "./fixture-provider.mjs";
import { liveGatewayToml, postmeetingGatewayToml } from "./gateway-config.mjs";
import { RESERVE_ID, SCOPE, inviteEnvelope, startFeishuPeer } from "./feishu-peer.mjs";

const plan = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--plan") + 1], "utf8"));
const eventsPath = path.join(plan.controlDir, "events.ndjson");
const trace = [];

function event(name, detail = {}) {
  const line = { at: new Date().toISOString(), name, ...detail };
  appendFileSync(eventsPath, `${JSON.stringify(line)}\n`);
}
function waitFor(check, { budgetMs, name }) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + budgetMs;
    const timer = setInterval(() => {
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
  writeFileSync(eventsPath, "");
  writeFileSync(plan.gatewayConfigPath, liveGatewayToml({
    recordingsDir: plan.runtimeRecordingsDir, keyEnv: plan.recordingKeyEnv, credentialEnv: plan.providerCredentialEnv,
  }), { mode: 0o600 });

  const provider = await startFixtureProvider();
  const peer = await startFeishuPeer({ meeting: plan.meeting });
  event("peers_started", { feishuOrigin: peer.origin, providerEndpoint: provider.endpoint });

  const http = createFeishuSdkHttp({
    request: peer.rewriteRequest(defaultHttpInstance.request),
    connection: createFeishuSocketOwner(HttpAgent),
  });
  const connection = createFeishuSocketOwner(HttpAgent);

  let shuttingDown = false;
  const drive = (async () => {
    // 1. The long connection is ready once the shipped ingress reports started.
    await waitFor(() => trace.includes("composition_started"), { budgetMs: plan.budgets.startMs, name: "composition_started" });
    await waitFor(() => peer.connectionCount > 0, { budgetMs: plan.budgets.startMs, name: "long_connection" });
    event("long_connection_ready");

    // 2. One scheduled-meeting invite through the real dispatcher's accept().
    peer.deliverInvite(inviteEnvelope(plan.meeting), plan.meeting.eventId);
    event("invite_delivered");
    await waitFor(() => peer.acknowledgements.some((value) => value?.code === 200), { budgetMs: plan.budgets.admitMs, name: "invite_ack" });
    event("invite_acknowledged");

    // 3. The scripted client reports its own media stream.
    const child = await waitFor(() => {
      const state = readJson(path.join(plan.controlDir, "state.json"));
      return state?.mediaConnected && state.framesSent >= plan.captureFrames ? state : null;
    }, { budgetMs: plan.budgets.captureMs, name: "media_capture" });
    event("media_capture", { framesSent: child.framesSent, endpoint: child.mediaEndpoint });

    // 4. Swap the gateway deployment configuration for the post-meeting lane,
    //    then end the meeting positively.
    selectPostmeetingGatewayConfig(provider.endpoint);
    writeFileSync(path.join(plan.controlDir, "end"), "ended");
    event("meeting_ended_signalled");

    // 5. The shipped outbox writes READY last; the harness then publishes.
    //    A bundle the shipped delivery lane cannot build is a recorded block,
    //    not a harness failure: the run still closes through the real order.
    let bundle = null;
    try {
      bundle = await waitFor(() => findReadyBundle(), { budgetMs: plan.budgets.buildMs, name: "artifact_bundle" });
      event("artifact_ready", { bundle });
    } catch (error) {
      event("artifact_blocked", { reason: String(error?.message ?? error) });
    }

    // 6. The harness runs the real TeamMem consumer; the shipped outbox worker
    //    journals its receipt and the notification lane delivers one DM.
    await waitFor(() => controlFileExists("teammem-done"), { budgetMs: plan.budgets.teammemMs, name: "teammem_done" });
    event("teammem_done");
    if (bundle !== null) {
      try {
        await waitFor(() => peer.messages.length > 0, { budgetMs: plan.budgets.notifyMs, name: "organizer_dm" });
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

  const dependencies = {
    readConfig: readStandaloneConfig,
    inspectStateRoot,
    acquireOwnerLock: acquireApplicationOwnerLock,
    composeAfterAdmission: (config, owner) => runStandaloneComposition(config, owner, {
      feishu: { http, connection, readyTimeoutMs: plan.budgets.readyTimeoutMs, handshakeTimeoutMs: 5000, closeTimeoutMs: 7000 },
      organizerReferences: [{ ...SCOPE, meetingNo: plan.meeting.meetingNo, reference: { kind: "reservation", reserveId: RESERVE_ID } }],
      maintenance: {
        intervalsMs: plan.laneIntervalsMs,
        random: () => 0,
      },
      log: (code) => { trace.push(code); event("log", { code }); },
    }),
    report(channel, line) { event("report", { channel, line }); process[channel === "stdout" ? "stdout" : "stderr"].write(`${line}\n`); },
  };

  const run = runStandalone(["--standalone-config", plan.standaloneConfigPath], dependencies);

  let driveFailure = null;
  drive.then(() => undefined, (error) => { driveFailure = String(error?.message ?? error); event("drive_failed", { reason: driveFailure }); })
    .then(() => {
      shuttingDown = true;
      event("shutdown_signalled");
      process.kill(process.pid, "SIGTERM");
    });

  const exit = await run;
  event("run_standalone_exit", { exit });
  await provider.close();
  await peer.close();
  writeFileSync(path.join(plan.controlDir, "summary.json"), JSON.stringify({
    exit, driveFailure, shuttingDown, trace,
    feishuRequests: peer.requests, feishuMessages: peer.messages, providerCalls: provider.calls,
  }));
  process.exit(driveFailure === null ? exit : 70);
}

main().catch((error) => {
  event("entry_failed", { reason: String(error?.message ?? error) });
  writeFileSync(path.join(plan.controlDir, "summary.json"), JSON.stringify({ exit: null, driveFailure: String(error?.message ?? error), trace }));
  process.exit(71);
});

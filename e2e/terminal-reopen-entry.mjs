// Actual owner adapter. Importing this file has no SDK/application effects.
import { Agent as HttpAgent } from "node:http";
import path from "node:path";
import process from "node:process";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { boundedJson, ingressReceiverFact } from "./ingress-run.mjs";
import { assertTerminalActivity, prepareTerminalBaseline, readTerminalState, measureTerminalSources, terminalFiles,
  runTerminalReplay, requireTerminal, terminalFailure } from "./terminal-reopen-run.mjs";
import { preserveTerminalEvidence, preserveTerminalAfter } from "./terminal-reopen-run.mjs";

// Shared actual-entry callback: runStandalone consumes this synchronously.
export function terminalConfigReader(plan, configApi) {
  return function readConfig(filename) {
    const config = configApi.readStandaloneConfig(filename);
    requireTerminal(config.stateRoot === path.dirname(plan.databasePath), "config_root"); return config;
  };
}

// Exact public static diagnostics only. Dynamic composition reasons and all
// unknown text are discarded, never copied or regex-sanitized into evidence.
const STATIC_DIAGNOSTICS = new Map([
  ["meeting-agent: invocation error in argv", "invocation_refusal"],
  ["meeting-agent: standalone config admission failed", "config_admission_failed"],
  ["meeting-agent: composition failed", "composition_failed"],
  ["meeting-agent: composition_closed", "composition_closed"],
]);
const GRAMMAR_FIELDS = ["config", "schema", "stateRoot", "feishu", "feishu.region", "feishu.tenantKey", "feishu.appId", "feishu.appSecretFile",
  "agentIdentity", "agentIdentity.aliases", "dataPaths", "dataPaths.recordingsDir", "dataPaths.outboxDir", "dataPaths.receiptsDir", "dataPaths.teamVaultDir",
  "runtime", "runtime.launcherPath", "runtime.gatewayConfigPath", "runtime.protocolVersion", "bridgeSlots", ...Array.from({ length: 8 }, (_, i) => `bridgeSlots[${i}]`),
  "admission", "admission.allowedInviterIds", "admission.allowedChatIds"];
for (const field of GRAMMAR_FIELDS) STATIC_DIAGNOSTICS.set(`meeting-agent: standalone config grammar error in ${field}`, "config_grammar_refusal");
for (const field of ["config", "stateRoot", "dataPaths.recordingsDir", "dataPaths.outboxDir", "dataPaths.receiptsDir", "dataPaths.teamVaultDir"])
  STATIC_DIAGNOSTICS.set(`meeting-agent: standalone config reference error in ${field}`, "config_reference_refusal");
for (const code of ["unsupported", "root_unsafe", "helper_unavailable", "held", "cleanup_unconfirmed", "failed"])
  STATIC_DIAGNOSTICS.set(`meeting-agent: application_owner_lock_${code}`, `owner_lock_${code}`);
const SHUTDOWN_CODES = ["shutdown_fenced", "shutdown_owned_work_settled", "shutdown_application_closed", "shutdown_runtime_owners_closed", "shutdown_transports_closed", "shutdown_store_closed"];
export function terminalStaticDiagnostic(channel, line) {
  return channel === "stderr" ? STATIC_DIAGNOSTICS.get(line) ?? null : null;
}
export function terminalStageFacts({ standaloneExit, ownerAttempted, admitted, compositionEntered, compositionResult, readiness, diagnostics, trace, close }) {
  return { standaloneExit: [0, 64, 65, 70, 75].includes(standaloneExit) ? standaloneExit : null,
    ownerAcquisition: admitted ? "acquired" : ownerAttempted ? "attempted" : "not_attempted",
    composition: compositionResult?.status === "composition_closed" ? "closed" : compositionResult?.status === "composition_unavailable" ? "unavailable" :
      diagnostics.includes("composition_failed") ? "failed" : compositionEntered ? "entered" : "not_entered",
    compositionClean: compositionResult?.status === "composition_closed" ? compositionResult.clean === true : null,
    readiness: ["not_started", "waiting", "ready", "failed"].includes(readiness) ? readiness : "failed",
    diagnostics: diagnostics.filter(code => [...STATIC_DIAGNOSTICS.values()].includes(code)).slice(0, 16),
    diagnosticOverflow: diagnostics.length > 16,
    shutdownCodes: trace.filter(code => SHUTDOWN_CODES.includes(code)).slice(0, 128),
    close: close ? { compositionClosed: close.compositionClosed === true, ownerClosedLast: close.ownerClosedLast === true,
      peerClosed: close.peerClosed === true, httpClosed: close.httpClosed === true, socketClosed: close.socketClosed === true } : null };
}

async function runActual(plan, shutdown) {
  let peer, http, socket, app, run, standaloneExit, compositionResult, admitted = false, ownerClosedLast = false;
  let peerClosed = false, httpClosed = false, socketClosed = false, pending = null, observerFailed = false, overflow = false, commit = null, closePromise;
  const trace = [], failures = [], diagnostics = [];
  let ownerAttempted = false, compositionEntered = false, readiness = "not_started", closeFact;
  const read = () => readTerminalState(plan);
  function log(code) {
    if (trace.length === 128) { overflow = true; shutdown.abort(); return; }
    trace.push(code);
    if (code === "invite_committed") {
      try {
        requireTerminal(pending && commit === null && peer.frameObservation.observations.length === 0, "commit_order");
        const state = read(); requireTerminal(state.event.normalizedSha256 === plan.baseline.inviteHash, "commit_identity");
        commit = { wireMessageId: pending, eventId: state.event.eventId, normalizedSha256: state.event.normalizedSha256, beforeAck: true, count: 1 };
      } catch { observerFailed = true; }
    }
  }
  const receiver = () => peer ? ingressReceiverFact({ invalid: peer.frameObservation.invalid, overflow: peer.frameObservation.overflow,
    observations: [...peer.frameObservation.observations] }) : { invalid: false, overflow: false, observations: [] };
  function activity() {
    requireTerminal(!observerFailed && !overflow && (!peer || peer.requests.length < 64), "observation_failed");
    const requests = peer?.requests ?? [];
    return { outcomes: app?.occurrenceOutcomes().length ?? 0, messages: peer?.messages.length ?? 0,
      runtimeStarts: trace.filter(code => code === "occurrence_runtime_connected" || code === "occurrence_launched").length,
      bridgeStarts: app?.occurrenceOutcomes().length ?? 0,
      metadataRequests: requests.filter(row => !["tenant_access_token", "ws_endpoint", "im_message"].includes(row.route)).length,
      notificationRequests: requests.filter(row => row.route === "im_message").length, trace: [...trace], receiver: receiver() };
  }
  async function wait(check, signal) {
    const end = process.hrtime.bigint() + 25000000000n;
    for (;;) {
      requireTerminal(!signal.aborted && !shutdown.signal.aborted && standaloneExit === undefined && process.hrtime.bigint() < end, "owner_wait");
      const result = check(); if (result) return result;
      await delay(25, undefined, { signal: shutdown.signal });
    }
  }
  const effects = {
    async baseline() { return plan.baseline; },
    async ready(signal) {
      readiness = "waiting";
      try {
        // Dynamic imports only after the shared controller's baseline gate.
        const [sdk, main, configApi, lockApi, composition, httpApi, sockets, peers, lifecycle] = await Promise.all([
          import("@larksuiteoapi/node-sdk"), import("../dist/src/main.js"), import("../dist/src/standalone-config.js"),
          import("../dist/src/adapters/application-owner-lock.js"), import("../dist/src/application-composition.js"),
          import("../dist/src/adapters/feishu-sdk-http.js"), import("../dist/src/adapters/feishu-sdk-connection.js"),
          import("./feishu-peer.mjs"), import("./composition-lifecycle.mjs"),
        ]);
        run = main.runStandalone(["--standalone-config", plan.standaloneConfigPath], {
          readConfig: terminalConfigReader(plan, configApi), inspectStateRoot: configApi.inspectStateRoot,
          async acquireOwnerLock(root) {
            requireTerminal(root === path.dirname(plan.databasePath), "owner_root");
            ownerAttempted = true;
            const owner = await lockApi.acquireApplicationOwnerLock(root); admitted = true;
            return { ...owner, close() {
              owner.close(); ownerClosedLast = peerClosed && httpClosed && socketClosed && trace.at(-1) === "shutdown_store_closed";
            } };
          },
          async composeAfterAdmission(config, owner) {
            compositionEntered = true;
            try {
              const i = plan.baseline.state.invite;
              peer = await peers.startFeishuPeer({ meeting: { providerMeetingId: i.providerMeetingId, meetingNo: i.meetingNo, title: i.title, startSeconds: plan.baseline.state.event.startSeconds } });
              http = httpApi.createFeishuSdkHttp({ request: peer.rewriteRequest(sdk.defaultHttpInstance.request), connection: sockets.createFeishuSocketOwner(HttpAgent) });
              socket = sockets.createFeishuSocketOwner(HttpAgent);
              compositionResult = await lifecycle.runExposedComposition(composition.composeApplication, config, owner, {
                feishu: { http, connection: socket }, organizerReferences: [{ ...peers.SCOPE, meetingNo: i.meetingNo, reference: { kind: "reservation", reserveId: peers.RESERVE_ID } }],
                maintenance: { intervalsMs: { backfill: 3600000, warning: 3600000, outbox: 3600000, notification: 3600000, discovery: 3600000, custody: 3600000 }, random: () => 0 },
                discoveryJitter: () => 0, log,
              }, handle => { app = handle; }, shutdown);
              return compositionResult;
            } finally {
              try { await http?.close(); httpClosed = !http || http.activeCount === 0; } catch { failures.push("terminal_http_close"); }
              try { socketClosed = !socket || await socket.close(); } catch { failures.push("terminal_socket_close"); }
              try { await peer?.close(); peerClosed = !peer || peer.connectionCount === 0; } catch { failures.push("terminal_peer_close"); }
            }
          }, report(channel, line) {
            const code = terminalStaticDiagnostic(channel, line);
            if (code && diagnostics.length < 17) diagnostics.push(code);
          },
        }).then(exit => { standaloneExit = exit; return exit; }, () => { standaloneExit = 70; return 70; });
        await wait(() => trace.includes("composition_started") && peer?.connectionCount === 1, signal);
        const ready = { admitted, started: true, connections: peer.connectionCount, state: read() };
        readiness = "ready"; return ready;
      } catch (error) { readiness = "failed"; throw error; }
    },
    async read() { return read(); },
    async activity() { return activity(); },
    async discover() { requireTerminal(app, "application_missing"); return app.discover(); },
    async deliver(wireMessageId, signal) {
      assertTerminalActivity(activity(), 0, wireMessageId); requireTerminal(pending === null && commit === null, "delivery_once"); pending = wireMessageId;
      peer.deliverInvite(plan.envelope, wireMessageId);
      await wait(() => peer.frameObservation.observations.length > 0, signal);
      const result = { state: read(), activity: activity(), commit }; pending = null; return result;
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        shutdown.abort(); if (run) await run;
        // If public admission failed before the seam, every existing external
        // owner is still settled. Never replace a lock or mutate the DB here.
        if (!run) { httpClosed = socketClosed = peerClosed = true; }
        let state, source, files, finalActivity;
        try { state = read(); source = await measureTerminalSources(plan.root, state); files = terminalFiles(plan); finalActivity = activity(); }
        catch { failures.push("terminal_final_read"); }
        closeFact = { exit: standaloneExit ?? 70, compositionClosed: compositionResult?.status === "composition_closed" && compositionResult.clean,
          ownerClosedLast, peerClosed, httpClosed, socketClosed, connections: peer?.connectionCount ?? 0, outcomes: app?.occurrenceOutcomes().length ?? 0,
          failures: [...failures], trace: [...trace], state, source, files, activity: finalActivity };
        return closeFact;
      })(); return closePromise;
    },
  };
  const result = await runTerminalReplay(plan, effects);
  result.stages = terminalStageFacts({ standaloneExit, ownerAttempted, admitted, compositionEntered, compositionResult, readiness, diagnostics, trace, close: closeFact });
  return result;
}
async function main() {
  requireTerminal(process.argv.length === 4 && process.argv[2] === "--plan" && path.isAbsolute(process.argv[3]), "entry_arguments");
  const input = boundedJson(process.argv[3]); let result, plan, before;
  const shutdown = new globalThis.AbortController(), stop = () => shutdown.abort(); process.once("SIGTERM", stop);
  try {
    const pins = await import("./pins.mjs"); await pins.verifyPins();
    plan = await prepareTerminalBaseline(input.bundlePath, { async verifyPublication({ root, bundleDir, artifactHash, occurrenceId, receipt, receiptPath }) {
      const { receiptOracle } = await import("./teammem.mjs");
      const checked = receiptOracle({ teammem: { paths: { bare: path.join(root, "teammem", "vault-remote.git") }, env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } },
        receiptsDir: path.dirname(receiptPath), artifact: { occurrenceId, revision: 1, hash: artifactHash, audioPath: path.join(bundleDir, "audio.enc") } });
      return checked.status === "present" && checked.checks.length === 1 && checked.checks.every(row => row.schema === "teammem-meeting-receipt/v1" &&
        row.commitExists && row.commitIsAncestorOfRef && row.noteBytes > 0 && row.occurrenceMatchesArtifact && row.revisionMatchesArtifact && row.artifactHashMatches &&
        row.noteNamesOccurrence && row.noteWithholdsAudioPath && row.urlNamesCommit && row.markdownUrl === receipt.markdown_url);
    } });
    requireTerminal(!shutdown.signal.aborted, "entry_cancelled");
    before = await preserveTerminalEvidence(plan, { directory: input.evidenceDirectory, bundlePath: input.bundlePath });
    requireTerminal(!shutdown.signal.aborted, "entry_cancelled");
    result = await runActual(plan, shutdown);
  } catch (error) { result = { schema: "terminal-reopen-report/v1", success: false, failures: [terminalFailure(error, "terminal_prerequisite_failed")] }; }
  finally { process.removeListener("SIGTERM", stop); }
  if (before) {
    result.evidenceBefore = before;
    try {
      result.evidenceAfter = await preserveTerminalAfter(plan, input.evidenceDirectory, before);
      requireTerminal(result.evidenceAfter.preserved, "after_preservation");
    }
    catch (error) { result.success = false; result.closed = false; result.failures.push(terminalFailure(error, "terminal_after_evidence_failed")); }
  }
  // Only this actual adapter can write this provenance. Component reports
  // remain explicitly C even when every synthetic predicate passes.
  result.provenance = "actual_entry"; writeFileSync(input.summaryPath, JSON.stringify(result), { mode: 0o600, flag: "wx" }); process.exitCode = result.success ? 0 : 70;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.stderr.write("terminal_entry_failed\n"); process.exitCode = 70; });

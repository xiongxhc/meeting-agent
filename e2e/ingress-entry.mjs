// Built-child adapter; imports of this module do not load the SDK/application.
import { lstatSync, readdirSync, writeFileSync } from "node:fs";
import { Agent as HttpAgent } from "node:http";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { assertIngressAck, assertIngressAudit, assertIngressClose, assertIngressFinalReceiver, assertIngressIsolation, assertIngressLaunch, assertIngressRetry, assertIngressReceiver,
  assertIngressConflict, assertIngressSelection, ingressData, ingressFact, ingressCloseFact, ingressFailure, ingressReceiverFact, boundedBytes, boundedJson, ingressPathExists, readIngressState, requireIngress } from "./ingress-run.mjs";

/** Only the selected rejected replay has an already-admitted durable baseline. */
export function readIngressConflictBaseline(send, read) {
  send = ingressData(send);
  return send.expectedCode === 500 ? read() : undefined;
}

/** One shared phase, with component fact factories in tests and actual public
 * composition/peer observations in the executable adapter below. */
export async function runIngressPhase(plan, effects, { signal, budgetMs = 120000, cleanupMs = 30000 } = {}) {
  plan = ingressData(plan); assertIngressSelection(plan);
  const controller = new globalThis.AbortController(), failure = [], observations = [];
  const abort = () => { controller.abort(); try { effects.cancel?.(); } catch { failure.push("ingress_cancel_failed"); } };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = globalThis.setTimeout(abort, budgetMs);
  const step = async (name, ...args) => {
    requireIngress(!controller.signal.aborted, "phase_cancelled");
    let onAbort;
    const stepTimer = globalThis.setTimeout(abort, ["ready", "launched"].includes(name) ? 30000 : 25000);
    try {
      const cancelled = new Promise((_, reject) => {
        onAbort = () => reject(new Error("ingress_phase_cancelled")); controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const value = await Promise.race([effects[name](...args, controller.signal), cancelled]);
      requireIngress(!controller.signal.aborted, "phase_cancelled");
      requireIngress(observations.length < 256, "history_overflow"); observations.push({ ordinal: observations.length + 1, name });
      return ingressFact(value);
    } finally { controller.signal.removeEventListener("abort", onAbort); globalThis.clearTimeout(stepTimer); }
  };
  let state, activity, close; const acceptedSends = [], acceptedCommits = [];
  try {
    const ready = await step("ready"); requireIngress(ready.admitted && ready.started && ready.connections === 1, "owner_admission");
    assertIngressReceiver(ready.receiver, []);
    if (plan.phase === 1) {
      let immutable, audits = []; const wireIds = [];
      assertIngressSelection(plan);
      for (const send of plan.sends) {
        const delivered = await step("deliver", send);
        acceptedSends.push(send);
        if (send.expectedCode === 500) {
          assertIngressConflict(send, delivered, state); wireIds.push(send);
          activity = await step("activity"); assertIngressReceiver(activity.receiver, wireIds); assertIngressIsolation(delivered.state, activity);
          continue;
        }
        assertIngressAck(send, delivered, immutable); acceptedCommits.push(delivered.commit);
        if (plan.conflictingReplay && acceptedSends.length === 3) {
          requireIngress(JSON.stringify(delivered.state) === JSON.stringify(state), "original_replay_mutation");
        }
        if (!immutable) {
          immutable = delivered.commit.immutable;
          requireIngress(Number.isSafeInteger(immutable.acceptedAtMs) && immutable.acceptedAtMs >= 0 &&
            Object.entries(plan.immutableExpected).every(([key, value]) => immutable[key] === value), "first_identity");
        }
        wireIds.push(send);
        if (!audits.some(row => row.eventId === send.eventId)) audits.push(plan.expected.find(row => row.eventId === send.eventId));
        assertIngressAudit(delivered.state, audits, immutable);
        // Exact replay must preserve the first persisted audit, including its acceptance time.
        if (state) for (const event of state.events) {
          const actual = delivered.state.events.find(row => row.eventId === event.eventId);
          requireIngress(JSON.stringify(actual) === JSON.stringify(event), "audit_replay_mutation");
        }
        const fact = await step("blocked"); state = fact.state; activity = fact.activity;
        assertIngressReceiver(activity.receiver, wireIds);
        assertIngressAudit(state, audits, immutable); assertIngressIsolation(state, activity);
        requireIngress(activity.requests.some(row => row.route === "unmatched" && row.status === 404), "actual_404");
      }
      const before = state; await step("discover"); state = await step("read");
      requireIngress(JSON.stringify(state) === JSON.stringify(before), "blocked_discovery_mutation");
      activity = await step("activity"); assertIngressIsolation(state, activity); assertIngressReceiver(activity.receiver, wireIds);
    } else {
      requireIngress(plan.phase === 2 && plan.original, "reopen_plan");
      state = await step("read"); requireIngress(JSON.stringify(state) === JSON.stringify(plan.original), "reopen_projection");
      activity = await step("activity"); assertIngressReceiver(activity.receiver, []);
      await step("discover"); state = await step("read"); activity = await step("activity");
      requireIngress(JSON.stringify(state) === JSON.stringify(plan.original), "automatic_retry"); assertIngressIsolation(state, activity);
      assertIngressReceiver(activity.receiver, []);
      const retried = await step("retry", plan.occurrenceId); assertIngressRetry(plan.original, retried);
      await step("discover"); const launched = await step("launched"); assertIngressLaunch(plan.original, launched, plan.missingLauncher);
      state = launched.state; activity = launched.activity;
      assertIngressReceiver(activity.receiver, []);
      if (!plan.missingLauncher) {
        const idle = await step("discover"); requireIngress(idle.launched === 0, "second_launch");
        const next = { state: await step("read"), activity: await step("activity") };
        assertIngressLaunch(plan.original, next, false);
        assertIngressReceiver(next.activity.receiver, []);
        requireIngress(next.activity.outcomes[0].controlSessionId === activity.outcomes[0].controlSessionId &&
          next.activity.bridge.pid === activity.bridge.pid && next.activity.bridge.bridgeSessionId === activity.bridge.bridgeSessionId, "live_binding_changed");
        state = next.state; activity = next.activity;
      }
    }
  } catch (error) { failure.push(ingressFailure(error, "ingress_phase_failed")); }
  finally {
    abort(); globalThis.clearTimeout(timer); signal?.removeEventListener("abort", abort);
    let closeTimer;
    try {
      close = ingressCloseFact(await Promise.race([effects.close(), new Promise((_, reject) => {
        closeTimer = globalThis.setTimeout(() => reject(new Error("ingress_close_timeout")), cleanupMs);
      })])); assertIngressClose(close); assertIngressFinalReceiver(close, acceptedSends, acceptedCommits);
      if (plan.conflictingReplay && plan.phase === 1 && failure.length === 0) {
        requireIngress(close.finalState && JSON.stringify(close.finalState) === JSON.stringify(state), "final_projection");
      }
    } catch (error) { failure.push(ingressFailure(error, "ingress_phase_cleanup")); }
    finally { globalThis.clearTimeout(closeTimer); }
  }
  return { success: failure.length === 0, phase: plan.phase, root: plan.root, databasePath: plan.databasePath, state, activity, close, observations, failures: failure };
}

async function runRealEntry(plan) {
  plan = ingressData(plan); assertIngressSelection(plan);
  // All actual SDK and built composition imports are behind guarded execution.
  const [sdk, main, configApi, lockApi, composition, httpApi, socketApi, peers, lifecycle] = await Promise.all([
    import("@larksuiteoapi/node-sdk"), import("../dist/src/main.js"), import("../dist/src/standalone-config.js"),
    import("../dist/src/adapters/application-owner-lock.js"), import("../dist/src/application-composition.js"),
    import("../dist/src/adapters/feishu-sdk-http.js"), import("../dist/src/adapters/feishu-sdk-connection.js"),
    import("./feishu-peer.mjs"), import("./composition-lifecycle.mjs"),
  ]);
  const shutdown = new globalThis.AbortController();
  const signal = () => shutdown.abort(); for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(name, signal);
  let peer, app, run, http, connection, standaloneExit, compositionResult, ownerClosed = false, admitted = false, observerFailure = false, overflow = false;
  const trace = [], commits = [], ackIds = new Set(), cleanupFailures = [];
  let pending = null, ordinal = 0, closePromise;
  const read = () => readIngressState({ databasePath: plan.databasePath, occurrenceId: plan.occurrenceId });
  function log(code) {
    if (trace.length === 256) { overflow = true; shutdown.abort(); return; }
    trace.push(code);
    if (code !== "invite_committed") return;
    try {
      requireIngress(pending && !commits.some(row => row.wireMessageId === pending.wireMessageId), "unexpected_commit");
      const state = read(), row = state.events.find(event => event.eventId === pending.eventId);
      requireIngress(row?.hash === pending.hash && state.immutable.occurrenceId === pending.occurrenceId, "commit_hash");
      commits.push({ ordinal: ++ordinal, wireMessageId: pending.wireMessageId, eventId: pending.eventId,
        expectedHash: pending.hash, persistedHash: row.hash, immutable: state.immutable,
        ackFloor: peer.frameObservation.observations.at(-1)?.ordinal ?? 0 });
    } catch { observerFailure = true; }
  }
  function check() {
    requireIngress(!shutdown.signal.aborted && !observerFailure && !overflow && standaloneExit === undefined, "owner_stopped");
    if (peer) requireIngress(!peer.frameObservation.invalid && !peer.frameObservation.overflow && peer.requests.length < 256 && peer.messages.length === 0, "peer_failure");
  }
  async function wait(checkFact, budgetMs, phaseSignal) {
    const end = process.hrtime.bigint() + BigInt(budgetMs) * 1000000n;
    for (;;) {
      check(); requireIngress(!phaseSignal?.aborted, "phase_cancelled");
      const fact = checkFact(); if (fact) return fact;
      requireIngress(process.hrtime.bigint() < end, "observation_timeout");
      await delay(25, undefined, { signal: shutdown.signal });
    }
  }
  const outcomes = () => (app?.occurrenceOutcomes() ?? []).map(row => ({ ...row, controlSessionId: row.controlSessionId?.toString() ?? null }));
  function fileCount(directory) { return readdirSync(directory).length; }
  function activity() {
    const runtimePids = ingressPathExists(plan.runtimePidsPath) ? readPrivateText(plan.runtimePidsPath).trim().split("\n").filter(Boolean).map(Number) : [];
    requireIngress(runtimePids.length <= 1 && runtimePids.every(n => Number.isSafeInteger(n) && n > 0), "runtime_pid_extent");
    const child = boundedJson(path.join(plan.controlDir, "state.json"), true), state = read();
    let bridge = null;
    if (child) {
      const config = boundedJson(child.configPath), binding = config.custody, generation = state.generations[0], custody = state.custody[0];
      bridge = { pid: child.pid, joined: child.joined, mediaConnected: child.mediaConnected, framesSent: child.framesSent,
        occurrenceId: binding.occurrenceId, bridgeSessionId: binding.bridgeSessionId, controlSessionId: generation?.controlSessionId ?? null,
        envKeys: child.envKeys, bound: state.generations.length === 1 && state.custody.length === 1 && binding.occurrenceId === plan.occurrenceId &&
          custody.physicalClientId === binding.physicalClientId && custody.physicalGenerationId === binding.physicalGenerationId &&
          custody.bridgeSessionId === binding.bridgeSessionId && generation.bridgeSessionId === binding.bridgeSessionId };
    }
    return { trace: [...trace], requests: [...peer.requests], messages: [...peer.messages], runtimePids, bridge, outcomes: outcomes(), receiver: receiver(),
      files: { recording: fileCount(plan.directories.recordingsDir), outbox: fileCount(plan.directories.outboxDir), receipt: fileCount(plan.directories.receiptsDir), key: ingressPathExists(plan.keyPath) },
      envKeys: Object.keys(process.env).sort() };
  }
  const effects = {
    cancel() { shutdown.abort(); },
    async ready(phaseSignal) {
      run = main.runStandalone(["--standalone-config", plan.standaloneConfigPath], {
        readConfig: configApi.readStandaloneConfig, inspectStateRoot: configApi.inspectStateRoot,
        async acquireOwnerLock(root) {
          const owner = await lockApi.acquireApplicationOwnerLock(root); admitted = true;
          return { ...owner, close() { owner.close(); ownerClosed = true; } };
        },
        async composeAfterAdmission(config, owner) {
          try {
            check(); peer = await peers.startFeishuPeer({ meeting: plan.meeting }); check();
            http = httpApi.createFeishuSdkHttp({ request: peer.rewriteRequest(sdk.defaultHttpInstance.request), connection: socketApi.createFeishuSocketOwner(HttpAgent) });
            connection = socketApi.createFeishuSocketOwner(HttpAgent);
            compositionResult = await lifecycle.runExposedComposition(composition.composeApplication, config, owner, {
              feishu: { http, connection }, organizerReferences: [{ ...peers.SCOPE, meetingNo: plan.meeting.meetingNo,
                reference: { kind: "reservation", reserveId: plan.phase === 1 ? "reserve-ingress-unavailable" : peers.RESERVE_ID } }],
              maintenance: { intervalsMs: { backfill: 3600000, warning: 3600000, outbox: 3600000, notification: 3600000, discovery: 3600000, custody: 3600000 }, random: () => 0 },
              discoveryJitter: () => 0, log,
            }, handle => { app = handle; }, shutdown);
            return compositionResult;
          } finally {
            const cleanup = await Promise.allSettled([http?.close(), connection?.close(), closePeer()]);
            for (const [index, result] of cleanup.entries()) if (result.status === "rejected" || result.value === false) cleanupFailures.push(["ingress_http_close", "ingress_socket_close", "ingress_peer_close"][index]);
          }
        }, report(channel, line) {
          // Shipped diagnostic is already static/redacted. No arbitrary error serialization.
          process[channel === "stdout" ? "stdout" : "stderr"].write(`${line}\n`);
        },
      }).then(value => { standaloneExit = value; return value; }, () => { standaloneExit = 70; return 70; });
      await wait(() => trace.includes("composition_started") && peer?.connectionCount === 1, 30000, phaseSignal);
      requireIngress(peer.frameObservation.observations.length === 0, "startup_unsolicited_ack");
      return { admitted, started: trace.includes("composition_started"), connections: peer.connectionCount, receiver: receiver() };
    },
    async deliver(send, phaseSignal) {
      check(); requireIngress(pending === null && peer.connectionCount === 1, "delivery_owner");
      // Fail on unsolicited, duplicate or stale replies before another delivery.
      requireIngress(peer.frameObservation.observations.length === ackIds.size &&
        peer.frameObservation.observations.every(row => row.kind === "ack" && ackIds.has(row.messageId)), "unsolicited_ack");
      const start = peer.frameObservation.observations.length, before = readIngressConflictBaseline(send, read); pending = send;
      peer.deliverInvite(send.envelope, send.wireMessageId);
      await wait(() => peer.frameObservation.observations.length > start, 25000, phaseSignal);
      const observations = receiver().observations.slice(start);
      const commit = commits.find(row => row.wireMessageId === send.wireMessageId);
      const result = { commit, receiver: { invalid: peer.frameObservation.invalid, overflow: peer.frameObservation.overflow, observations }, state: read() };
      if (send.expectedCode === 500) assertIngressConflict(send, result, before); else assertIngressAck(send, result); requireIngress(!ackIds.has(send.wireMessageId), "duplicate_ack");
      ackIds.add(send.wireMessageId); pending = null; return result;
    },
    async blocked(phaseSignal) {
      await app.discover();
      return wait(() => { const state = read(); return state.metadata.state === "metadata_blocked" ? { state, activity: activity() } : null; }, 25000, phaseSignal);
    },
    async read() { check(); return read(); },
    async discover() { check(); return app.discover(); },
    async retry(occurrenceId) { check(); const result = app.retryInviteMetadata(occurrenceId, "e2e-ingress-operator"); return { result, state: read() }; },
    async launched(phaseSignal) {
      return wait(() => {
        const rows = outcomes(), row = rows[0];
        if (plan.missingLauncher ? row?.phase === "settled" : row?.phase === "live") {
          const fact = { state: read(), activity: activity() };
          if (plan.missingLauncher || fact.activity.bridge?.mediaConnected && fact.activity.bridge.framesSent > 0) return fact;
        }
        return null;
      }, 30000, phaseSignal);
    },
    async activity() {
      check(); requireIngress(peer.frameObservation.observations.length === ackIds.size &&
        peer.frameObservation.observations.every(row => row.kind === "ack" && ackIds.has(row.messageId)), "late_duplicate_ack");
      return activity();
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        shutdown.abort();
        // runStandalone owns close ordering; external peer closes inside its
        // admitted seam, before runStandalone closes the owner lock last.
        if (run) await run;
        try { await closePeer(); } catch { cleanupFailures.push("ingress_peer_close"); }
        let finalState;
        let keyCustody = "not_created";
        if (trace.includes("shutdown_store_closed") && commits.length + (plan.phase === 2 ? 1 : 0) > 0) {
          try {
            finalState = read();
            requireIngress(finalState.counts.seed === 0 && finalState.counts.delivery === 0 && finalState.counts.notification === 0 &&
              fileCount(plan.directories.outboxDir) === 0 && fileCount(plan.directories.receiptsDir) === 0 && peer.messages.length === 0, "close_publication");
            if (plan.phase === 2 && !plan.missingLauncher) requireIngress(finalState.custody.length === 1 &&
              finalState.custody[0].recordedAtMs !== null && finalState.custody[0].failure === null, "close_custody_unconfirmed");
            if (ingressPathExists(plan.keyPath)) {
              const key = lstatSync(plan.keyPath), directory = lstatSync(path.dirname(plan.keyPath));
              requireIngress(key.isFile() && !key.isSymbolicLink() && key.nlink === 1 && key.uid === process.getuid() && (key.mode & 0o777) === 0o600 &&
                directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid() && (directory.mode & 0o777) === 0o700, "key_custody");
              keyCustody = "private_runtime_file";
            }
            requireIngress(!trace.includes("occurrence_recording_unpersisted") && !trace.includes("occurrence_custody_refused"), "close_recording_unpersisted");
          } catch { cleanupFailures.push("ingress_final_state"); }
        }
        return { standaloneExit: standaloneExit ?? 70, compositionClosed: compositionResult?.status === "composition_closed" && compositionResult.clean,
          peerClosed, lockClosedLast: ownerClosed && peerClosed && trace.includes("shutdown_store_closed"), cleanupFailures: [...cleanupFailures],
          finalState, keyCustody, outcomes: outcomes(), trace: [...trace], environmentKeys: Object.keys(process.env).sort(), commitObservations: [...commits],
          ackObservations: peer ? receiver().observations : [],
          receiver: peer ? receiver() : { invalid: false, overflow: false, observations: [] }, observerFailure, overflow };
      })(); return closePromise;
    },
  };
  let peerClosed = false, peerClosePromise;
  function receiver() { return ingressReceiverFact({ invalid: peer.frameObservation.invalid, overflow: peer.frameObservation.overflow, observations: [...peer.frameObservation.observations] }); }
  async function closePeer() {
    if (!peer) { peerClosed = true; return; }
    if (!peerClosePromise) peerClosePromise = peer.close().then(() => { peerClosed = true; });
    return peerClosePromise;
  }
  try { return await runIngressPhase(plan, effects, { signal: shutdown.signal }); }
  finally { for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(name, signal); }
}
function readPrivateText(filename) {
  // Same bounded/no-follow file discipline; PIDs are numeric evidence only.
  return boundedBytes(filename).toString("utf8");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void (async () => {
    requireIngress(process.argv.length === 4 && process.argv[2] === "--plan" && path.isAbsolute(process.argv[3]), "entry_arguments");
    const plan = boundedJson(process.argv[3]);
    const result = await runRealEntry(plan);
    writeFileSync(plan.summaryPath, JSON.stringify(result), { mode: 0o600, flag: "wx" });
    process.exitCode = result.success ? 0 : 70;
  })().catch(() => { process.stderr.write("ingress_entry_failed\n"); process.exitCode = 70; });
}

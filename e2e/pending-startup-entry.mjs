// In-process real admission adapter. No built application/SDK import or owned
// resources exist until runRealPendingStartup is explicitly called.
import { Agent as HttpAgent } from "node:http";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { assertPendingStartupEnvironment, closeHeldStartup, createStartupLog, observeStartupDiagnostic, readStartupEmptyFiles, readStartupEmptyState, runPendingStartupPhase, validatePendingStartupPlan } from "./pending-startup-run.mjs";

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {}); return { promise, resolve, reject }; }
function promiseStatus(promise) { return promise.then(() => true, () => false); }
function unchanged(before, after) { return JSON.stringify({ ...before, elapsedMs: 0 }) === JSON.stringify({ ...after, elapsedMs: 0 }); }

export async function runRealPendingStartup(plan) {
  assertPendingStartupEnvironment(globalThis.process.env);
  validatePendingStartupPlan(plan);
  const [sdk, main, configApi, lockApi, composition, httpApi, socketApi, peers, lifecycle] = await Promise.all([
    import("@larksuiteoapi/node-sdk"), import("../dist/src/main.js"), import("../dist/src/standalone-config.js"),
    import("../dist/src/adapters/application-owner-lock.js"), import("../dist/src/application-composition.js"),
    import("../dist/src/adapters/feishu-sdk-http.js"), import("../dist/src/adapters/feishu-sdk-connection.js"),
    import("./feishu-peer.mjs"), import("./composition-lifecycle.mjs"),
  ]);
  const shutdown = new globalThis.AbortController(), handle = deferred(), permitFixtureCleanup = deferred(), observed = createStartupLog();
  const pollAllowance = { remaining: 250 };
  const diagnostics = [], cleanupFailures = [];
  let app, peer, http, httpConnection, connection, holdId = null, handleAt = null, run, lifecyclePromise, compositionResult = null, standaloneExit = null;
  let admittedOwnerCount = 0, handleCount = 0, lifecycleSettled = false, invalidObservation = false, cancelled = false, fixtureCleanupStarted = false;
  let peerClosePromise, closeRequest, closeRequestedOrdinal = 0, publicCloseSettledOrdinal = 0, peerSettledOrdinal = 0, admittedReturnOrdinal = 0, ownerCloseBeginOrdinal = 0, ownerCloseEndOrdinal = 0;
  const mark = observed.mark;
  const failCleanup = code => { if (!cleanupFailures.includes(code) && cleanupFailures.length < 8) cleanupFailures.push(code); };
  function normalClose() {
    if (!app) return;
    try { const pending = app.close(); pending.catch(() => { invalidObservation = true; }); return pending; }
    catch { invalidObservation = true; }
  }
  function readPending() {
    const log = observed.snapshot();
    if (peer && peer.requests.length === 256) invalidObservation = true;
    return {
      holdId, hold: peer && holdId !== null ? peer.readPendingHold(holdId) : null,
      admittedOwnerCount, handleCount, elapsedMs: handleAt === null ? 0 : performance.now() - handleAt, lifecycleSettled,
      httpActive: http?.activeCount ?? null, httpSockets: httpConnection ? { active: httpConnection.activeCount, pending: httpConnection.pendingCount } : null,
      connectionSockets: connection ? { active: connection.activeCount, pending: connection.pendingCount } : null,
      peer: peer ? { connections: peer.connectionCount, ackCount: peer.frameObservation.observations.length, legacyAckCount: peer.acknowledgements.length,
        messageCount: peer.messages.length, invalid: peer.frameObservation.invalid, overflow: peer.frameObservation.overflow } : null,
      requests: peer ? peer.requests.map(row => ({ method: row.method, route: row.route, status: row.status })) : [], lifecycle: log.observations,
      invalidObservation: invalidObservation || log.invalid, historyOverflow: log.overflow,
      fixtureCleanupStarted, peerCloseOrdinal: peerSettledOrdinal, ownerCloseOrdinal: ownerCloseEndOrdinal,
    };
  }
  function closePeer() {
    if (!peer) return Promise.resolve();
    if (!peerClosePromise) peerClosePromise = peer.close().then(() => { peerSettledOrdinal = mark(); });
    peerClosePromise.catch(() => {}); return peerClosePromise;
  }
  async function observedRealOwnerAcquisition(root) {
    const actual = await lockApi.acquireApplicationOwnerLock(root); admittedOwnerCount++;
    let closed = false;
    return {
      assertCurrentOwnership: actual.assertCurrentOwnership,
      close() {
        if (closed) return; closed = true; ownerCloseBeginOrdinal = mark();
        actual.close(); ownerCloseEndOrdinal = mark();
      },
    };
  }
  async function runAdmittedPendingComposition(config, owner) {
    try {
      if (cancelled) return { status: "composition_unavailable", reason: "composition_aborted" };
      peer = await peers.startFeishuPeer({ meeting: { providerMeetingId: "meeting-pending-e2e", meetingNo: "123456789", startSeconds: 1, title: "Unused startup fixture" } });
      httpConnection = socketApi.createFeishuSocketOwner(HttpAgent);
      http = httpApi.createFeishuSdkHttp({ request: peer.rewriteRequest(sdk.defaultHttpInstance.request), connection: httpConnection });
      connection = socketApi.createFeishuSocketOwner(HttpAgent);
      holdId = peer.armNext({ route: "ws_endpoint", outcome: "hold" });
      lifecyclePromise = lifecycle.runExposedComposition(composition.composeApplication, config, owner, {
        feishu: { http, connection },
        maintenance: { intervalsMs: { backfill: 3600000, warning: 3600000, outbox: 3600000, notification: 3600000, discovery: 3600000, custody: 3600000 }, random: () => 0 },
        discoveryJitter: () => 0, log: observed.log,
      }, actualApp => {
        app = actualApp; handleCount++; handleAt = performance.now(); handle.resolve();
        if (cancelled) normalClose();
      }, shutdown);
      lifecyclePromise.then(value => { lifecycleSettled = true; compositionResult = value; }, () => { lifecycleSettled = true; invalidObservation = true; });
      const value = await lifecyclePromise;
      if (handleCount === 0) handle.reject(new Error("pending_startup_admission_refused"));
      return value;
    } finally {
      // The actual admitted seam retains ownership until lifecycle settlement;
      // this gate protects the controller's pre-peer/fallback snapshot only.
      await permitFixtureCleanup.promise;
      fixtureCleanupStarted = true;
      const results = await Promise.allSettled([http?.close(), httpConnection?.close(), connection?.close()]);
      for (const [at, result] of results.entries()) if (result.status === "rejected" || result.value === false) failCleanup(at === 0 ? "pending_startup_http_close_failed" : "pending_startup_socket_close_failed");
      try { await closePeer(); } catch { failCleanup("pending_startup_peer_close_failed"); }
      admittedReturnOrdinal = mark();
    }
  }
  function retainStandaloneDiagnostic(channel, line) {
    try {
      if (diagnostics.length === 16) { invalidObservation = true; return; }
      diagnostics.push(observeStartupDiagnostic(channel, line));
    } catch { invalidObservation = true; }
  }
  const effects = {
    begin(signal) {
      signal.addEventListener("abort", effects.cancel, { once: true });
      if (signal.aborted) effects.cancel();
      run = main.runStandalone(["--standalone-config", plan.standaloneConfigPath], {
        readConfig: configApi.readStandaloneConfig, inspectStateRoot: configApi.inspectStateRoot,
        acquireOwnerLock: observedRealOwnerAcquisition, composeAfterAdmission: runAdmittedPendingComposition, report: retainStandaloneDiagnostic,
      });
      run.then(value => {
        standaloneExit = value;
        if (handleCount === 0) handle.reject(new Error("pending_startup_admission_refused"));
      }, () => { invalidObservation = true; handle.reject(new Error("pending_startup_phase_failed")); });
      return handle.promise;
    },
    readPending,
    closeWhileHeld(expected) {
      closeRequest = closeHeldStartup(expected, readPending, app, () => closeRequestedOrdinal = mark());
      return closeRequest;
    },
    async settleBeforeFixtureCleanup() {
      const statuses = await Promise.all([promiseStatus(closeRequest.first), promiseStatus(closeRequest.second)]);
      publicCloseSettledOrdinal = mark();
      await lifecyclePromise;
      // Preserve the mandatory pre-cleanup snapshot, then use only the
      // remainder of the same 250-poll allowance as the held-arrival phase.
      let snapshot = readPending();
      while (snapshot.hold !== null && snapshot.elapsedMs < 4500 && pollAllowance.remaining > 0) {
        pollAllowance.remaining--; await delay(10); snapshot = readPending();
      }
      const third = app.close(); third.catch(() => {}); const thirdFulfilled = await promiseStatus(third);
      const after = readPending();
      return { snapshot, composition: compositionResult, close: { requestedOrdinal: closeRequestedOrdinal, settledOrdinal: publicCloseSettledOrdinal,
        firstFulfilled: statuses[0], secondFulfilled: statuses[1], promiseSame: closeRequest.first === closeRequest.second,
        thirdFulfilled, thirdPromiseSame: third === closeRequest.first, repeatUnchanged: unchanged(snapshot, after) } };
    },
    async finish() {
      // Success and failure both release this gate once. runStandalone then
      // awaits the real admitted seam and closes its actual owner last.
      permitFixtureCleanup.resolve();
      if (run) await run;
      let emptyState = null, files = null;
      try { emptyState = readStartupEmptyState({ databasePath: plan.databasePath }); } catch { failCleanup("pending_startup_reader_failed"); }
      try { files = readStartupEmptyFiles(plan); } catch { failCleanup("pending_startup_files_invalid"); }
      return { snapshot: readPending(), composition: compositionResult, standaloneExit, peerSettledOrdinal, admittedReturnOrdinal, ownerCloseBeginOrdinal, ownerCloseEndOrdinal,
        cleanupFailures: [...cleanupFailures], emptyState, files, liveCount: app?.liveOccurrenceIds().length ?? 0, outcomeCount: app?.occurrenceOutcomes().length ?? 0,
        diagnostics: diagnostics.map(row => ({ ...row })) };
    },
    cancel() {
      if (cancelled) return; cancelled = true;
      normalClose(); shutdown.abort(); permitFixtureCleanup.resolve();
    },
  };
  return runPendingStartupPhase(effects, { label: "attempted-application", pollAllowance });
}

// Actual public adapter. Loading this file does not load the SDK or app.
import { Buffer } from "node:buffer";
import { Agent as HttpAgent } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { URL } from "node:url";
import { assertPendingStartupEnvironment, createStartupLog, observeStartupDiagnostic, readStartupEmptyFiles, readStartupEmptyState, validatePendingStartupPlan } from "./pending-startup-run.mjs";
import { assertIngressAck, ingressData, ingressReceiverFact, readIngressState } from "./ingress-run.mjs";
import { captureTenantTokenSnapshot, closeHeldTenantToken, qualifyTenantTokenSources, requireTenant, runTenantTokenPhase, validateTenantTokenQualification, validateTenantTokenResult, writeValidatedTenantEvidence } from "./tenant-token-run.mjs";

let invoked = false;
const actualResults = new WeakMap();
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {}); return { promise, resolve, reject }; }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
export function classifyTenantTokenRequest(options) {
  if (!options || typeof options !== "object") return "invalid";
  const method = Object.getOwnPropertyDescriptor(options, "method"), url = Object.getOwnPropertyDescriptor(options, "url");
  if (!method || !url || !Object.hasOwn(method, "value") || !Object.hasOwn(url, "value") || !["POST", "post"].includes(method.value) || typeof url.value !== "string" || url.value.length > 2048) return "invalid";
  try {
    const parsed = new URL(url.value);
    if (parsed.origin !== "https://open.feishu.cn" || parsed.username || parsed.password || parsed.search || parsed.hash || url.value !== `https://open.feishu.cn${parsed.pathname}`) return "invalid";
    return parsed.pathname === "/callback/ws/endpoint" ? "ws_endpoint" : parsed.pathname === "/open-apis/auth/v3/tenant_access_token/internal" ? "tenant_token_internal" : "invalid";
  } catch { return "invalid"; }
}
// This observes the real injected public transport, before peer URL rewriting.
// It preserves options and original rejection, and never retains request data.
export function createTenantTokenRequestObserver(request, mark, now = () => performance.now()) {
  const operations = []; let invalid = false, overflow = false, tokenStartAt = null, tokenSettlement = 0;
  const observedRequest = options => {
    const kind = classifyTenantTokenRequest(options);
    if (kind === "invalid" || operations.some(row => row.kind === kind)) invalid = true;
    if (operations.length === 2) { invalid = true; overflow = true; return request(options); }
    const descriptor = options && typeof options === "object" ? Object.getOwnPropertyDescriptor(options, "timeout") : null;
    const timeout = descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null;
    if (timeout !== 5000) invalid = true;
    const row = { kind, method: kind === "invalid" ? "invalid" : "POST", startOrdinal: mark(), settleOrdinal: 0, outcome: "pending", timeoutMs: timeout === 5000 ? 5000 : 0 };
    operations.push(row); if (kind === "tenant_token_internal") tokenStartAt = now();
    function settled(outcome) { if (row.outcome !== "pending") invalid = true; row.outcome = outcome; row.settleOrdinal = mark(); if (kind === "tenant_token_internal") tokenSettlement = row.settleOrdinal; }
    try { return Promise.resolve(request(options)).then(value => { settled("fulfilled"); return value; }, error => { settled("rejected"); throw error; }); }
    catch (error) { settled("rejected"); throw error; }
  };
  return Object.freeze({ request: observedRequest, snapshot() { return Object.freeze({ operations: operations.map(row => Object.freeze({ ...row })), invalid, overflow, tokenStartAt, tokenSettlement }); } });
}
export function projectTenantTokenDurable(input, original) {
  const v = ingressData(input), baseline = ingressData(original), m = v.metadata;
  return { occurrences: 1, events: v.events.length, sessions: v.sessions.length, custody: v.custody.length, generations: v.generations.length, counts: { ...v.counts }, state: m.state, reason: m.reason, acceptedAtMs: v.immutable.acceptedAtMs, claimed: m.claimed, claimExpiresAtMs: m.claimExpiresAtMs,
    totalAttempts: m.totalAttempts, generationAttempts: m.generationAttempts, generationStartedAtMs: m.generationStartedAtMs, firstAttemptAtMs: m.firstAttemptAtMs, lastAttemptAtMs: m.lastAttemptAtMs, retryGeneration: m.retryGeneration, operatorRetryCount: m.operatorRetryCount,
    lastBlockedAtMs: m.lastBlockedAtMs, lastObservedAtMs: m.lastObservedAtMs, nextAttemptAtMs: m.nextAttemptAtMs,
    metadataNull: [m.organizerId, m.organizerSource, m.reference, m.admittedAtMs].every(n => n === null), operatorNull: m.lastOperator === null && m.lastOperatorRetryAtMs === null,
    auditEqual: same(v.immutable, baseline.immutable) && same(v.events, baseline.events), identityEqual: v.fileIdentity === baseline.fileIdentity };
}
// Receives the adapter's trusted public owner, rather than an external DTO.
export function projectTenantTokenReceiver(receiver) { return ingressReceiverFact({ invalid: receiver.invalid, overflow: receiver.overflow, observations: [...receiver.observations] }); }
export async function runRealTenantToken(input, inputQualification, campaignStartedAt = performance.now()) {
  requireTenant(!invoked, "entry_repeated"); invoked = true;
  requireTenant(typeof campaignStartedAt === "number" && Number.isFinite(campaignStartedAt) && campaignStartedAt >= 0 && campaignStartedAt <= performance.now(), "deadline");
  const deadline = campaignStartedAt + 60000, checkpoint = () => requireTenant(performance.now() < deadline, "deadline"); checkpoint();
  const plan = ingressData(input); validatePendingStartupPlan(plan); assertPendingStartupEnvironment(globalThis.process.env);
  const qualification = validateTenantTokenQualification(inputQualification);
  requireTenant(same(qualification, qualifyTenantTokenSources(path.resolve(import.meta.dirname, ".."))), "qualification_invalid"); checkpoint();
  const [sdk, main, configApi, lockApi, composition, httpApi, socketApi, peers, lifecycle, normalizer] = await Promise.all([
    import("@larksuiteoapi/node-sdk"), import("../dist/src/main.js"), import("../dist/src/standalone-config.js"), import("../dist/src/adapters/application-owner-lock.js"), import("../dist/src/application-composition.js"),
    import("../dist/src/adapters/feishu-sdk-http.js"), import("../dist/src/adapters/feishu-sdk-connection.js"), import("./feishu-peer.mjs"), import("./composition-lifecycle.mjs"), import("../dist/src/ports/feishu-ingress.js"),
  ]);
  checkpoint(); const observed = createStartupLog(), mark = observed.mark, handle = deferred(), fixtureGate = deferred(), wrapper = new globalThis.AbortController();
  const seconds = Math.floor(Date.now() / 1000), meeting = { providerMeetingId: "meeting-token-e2e", meetingNo: "987654321", title: "Tenant timeout fixture", startSeconds: seconds };
  const envelope = peers.inviteEnvelope({ ...meeting, eventId: "tenant-token-event", inviteSeconds: seconds + 1, createTimeMs: seconds * 1000 }), invite = normalizer.normalizeInvite(envelope, peers.SCOPE);
  const send = { envelope, wireMessageId: "tenant-token-original", eventId: invite.eventId, hash: invite.normalizedSha256, occurrenceId: invite.occurrenceId };
  const marks = Object.fromEntries(["admitted", "handle", "started", "initialDiscovery", "commit", "ack", "tokenStart", "tokenSettlement", "closeRequested", "closeSettled", "lifecycleSettled", "fixtureStarted", "peerClosed", "admittedReturned", "ownerCloseBegin", "ownerCloseEnd"].map(key => [key, 0]));
  let peer, app, http, httpConnection, connection, observer, standalone, lifecyclePromise, compositionResult = null, standaloneExit = null, original = null, commit = null, commitAt = null, holdId = null;
  let cancelled = false, invalid = false, fixtureCleanupStarted = false, admittedCount = 0, handleCount = 0, emptyState = false;
  const cleanupFailures = [], diagnostics = []; let peerClose;
  const fail = code => { if (!cleanupFailures.includes(code) && cleanupFailures.length < 8) cleanupFailures.push(code); };
  const read = () => readIngressState({ databasePath: plan.databasePath, occurrenceId: invite.occurrenceId });
  function log(code) {
    if (performance.now() >= deadline) invalid = true;
    observed.log(code);
    const last = observed.snapshot().observations.at(-1);
    if (code === "composition_started") marks.started = last?.ordinal ?? 0;
    if (code === "discovery_tick" && marks.started && marks.initialDiscovery === 0) marks.initialDiscovery = last?.ordinal ?? 0;
    if (code !== "invite_committed") return;
    try {
      requireTenant(commit === null && marks.initialDiscovery > marks.started && holdId !== null, "held_invalid");
      original = ingressData(read()); const event = original.events[0]; requireTenant(original.events.length === 1 && event.eventId === invite.eventId && event.hash === invite.normalizedSha256 && original.immutable.occurrenceId === invite.occurrenceId, "held_invalid");
      marks.commit = last.ordinal; commitAt = performance.now();
      commit = { ordinal: marks.commit, wireMessageId: send.wireMessageId, eventId: send.eventId, expectedHash: send.hash, persistedHash: event.hash, immutable: original.immutable, ackFloor: peer.frameObservation.observations.at(-1)?.ordinal ?? 0 };
      checkpoint();
    } catch { invalid = true; }
  }
  function snapshot() {
    const history = observed.snapshot(), transport = observer?.snapshot() ?? { operations: [], invalid: false, overflow: false, tokenStartAt: null, tokenSettlement: 0 };
    if (peer && (peer.requests.length >= 256 || peer.messages.length >= 256)) invalid = true;
    let matchingAck = false;
    if (peer && peer.frameObservation.observations.length) {
      try { assertIngressAck(send, { commit, receiver: projectTenantTokenReceiver(peer.frameObservation), state: read() }); matchingAck = true; if (marks.ack === 0) marks.ack = mark(); }
      catch { invalid = true; }
    }
    marks.tokenStart = transport.operations.find(row => row.kind === "tenant_token_internal")?.startOrdinal ?? 0; marks.tokenSettlement = transport.tokenSettlement;
    return captureTenantTokenSnapshot({ marks: { ...marks }, times: { commitAt, tokenStartAt: transport.tokenStartAt }, emptyState,
      operations: transport.operations.map(row => ({ ...row })), requests: peer ? peer.requests.map(row => ({ method: row.method, route: row.route, status: row.status })) : [], hold: holdId === null || !peer ? null : peer.readPendingHold(holdId),
      owners: { admitted: admittedCount, handles: handleCount, http: http?.activeCount ?? 0, httpSockets: httpConnection?.activeCount ?? 0, httpPending: httpConnection?.pendingCount ?? 0, wsSockets: connection?.activeCount ?? 0, wsPending: connection?.pendingCount ?? 0, connections: peer?.connectionCount ?? 0 },
      receiver: { ackCount: peer?.frameObservation.observations.length ?? 0, legacyAckCount: peer?.acknowledgements.length ?? 0, messageCount: peer?.messages.length ?? 0, matchingAck, invalid: peer?.frameObservation.invalid ?? false, overflow: peer?.frameObservation.overflow ?? false },
      lifecycle: history.observations, durable: original ? projectTenantTokenDurable(read(), original) : null, files: readStartupEmptyFiles(plan), liveCount: app?.liveOccurrenceIds().length ?? 0, outcomeCount: app?.occurrenceOutcomes().length ?? 0,
      fixtureCleanupStarted, invalid: invalid || history.invalid || transport.invalid, overflow: history.overflow || transport.overflow });
  }
  function ordinaryClose() { if (app) { try { const value = app.close(); value.catch(() => { invalid = true; }); return value; } catch { invalid = true; } } }
  function closePeer() { if (!peer) return Promise.resolve(); return peerClose ??= peer.close().then(() => { marks.peerClosed = mark(); }); }
  async function admitted(config, owner) {
    try {
      if (cancelled) return { status: "composition_unavailable", reason: "composition_aborted" };
      peer = await peers.startFeishuPeer({ meeting });
      httpConnection = socketApi.createFeishuSocketOwner(HttpAgent); connection = socketApi.createFeishuSocketOwner(HttpAgent);
      observer = createTenantTokenRequestObserver(peer.rewriteRequest(sdk.defaultHttpInstance.request), mark);
      http = httpApi.createFeishuSdkHttp({ request: observer.request, connection: httpConnection });
      lifecyclePromise = lifecycle.runExposedComposition(composition.composeApplication, config, owner, {
        feishu: { http, connection }, organizerReferences: [{ ...peers.SCOPE, meetingNo: meeting.meetingNo, reference: { kind: "reservation", reserveId: peers.RESERVE_ID } }],
        maintenance: { intervalsMs: { backfill: 3600000, warning: 3600000, outbox: 3600000, notification: 3600000, discovery: 3600000, custody: 3600000 }, random: () => 0 }, discoveryJitter: () => 0, log,
      }, value => { app = value; handleCount++; marks.handle = mark(); handle.resolve(); if (cancelled) ordinaryClose(); }, wrapper);
      lifecyclePromise.then(value => { compositionResult = value; marks.lifecycleSettled = mark(); }, () => { invalid = true; marks.lifecycleSettled = mark(); });
      const result = await lifecyclePromise; if (!app) handle.reject(new Error("tenant_token_ready_invalid")); return result;
    } finally {
      await fixtureGate.promise; fixtureCleanupStarted = true; marks.fixtureStarted = mark();
      const cleanup = await Promise.allSettled([http?.close(), httpConnection?.close(), connection?.close()]);
      for (const [i, result] of cleanup.entries()) if (result.status === "rejected" || result.value === false) fail(i === 0 ? "http_close" : "socket_close");
      try { await closePeer(); } catch { fail("peer_close"); }
      marks.admittedReturned = mark();
    }
  }
  const effects = Object.freeze({
    async begin(signal, phase, deadline) {
      signal.addEventListener("abort", effects.cancel, { once: true }); if (signal.aborted) effects.cancel();
      standalone = main.runStandalone(["--standalone-config", plan.standaloneConfigPath], {
        readConfig: configApi.readStandaloneConfig, inspectStateRoot: configApi.inspectStateRoot,
        async acquireOwnerLock(root) { const actual = await lockApi.acquireApplicationOwnerLock(root); admittedCount++; marks.admitted = mark(); let closed = false; return { assertCurrentOwnership: actual.assertCurrentOwnership, close() { if (closed) return; closed = true; marks.ownerCloseBegin = mark(); actual.close(); marks.ownerCloseEnd = mark(); } }; },
        composeAfterAdmission: admitted,
        report(channel, line) { try { requireTenant(diagnostics.length < 16); diagnostics.push(observeStartupDiagnostic(channel, line)); } catch { invalid = true; fail("diagnostic"); } },
      });
      standalone.then(value => { standaloneExit = value; if (!app) handle.reject(new Error("tenant_token_ready_invalid")); }, () => { invalid = true; handle.reject(new Error("tenant_token_ready_invalid")); });
      await phase.step(() => handle.promise, deadline);
      while (!marks.initialDiscovery || peer.connectionCount !== 1) { phase.check(deadline); requireTenant(!invalid && !cancelled, "ready_invalid"); await phase.step(() => new Promise(resolve => globalThis.setTimeout(resolve, 10)), deadline); }
      const tick = await phase.step(() => app.discover(), deadline); requireTenant(tick.resolved === 0 && tick.launched === 0 && tick.deferred === 0, "ready_invalid");
      while (http.activeCount || httpConnection.activeCount || httpConnection.pendingCount) { requireTenant(!invalid && !cancelled, "ready_invalid"); await phase.step(() => new Promise(resolve => globalThis.setTimeout(resolve, 10)), deadline); }
      readStartupEmptyState({ databasePath: plan.databasePath }); phase.check(deadline); emptyState = true; return snapshot();
    },
    send() { requireTenant(emptyState && commit === null && !cancelled, "held_invalid"); holdId = peer.armNext({ route: "tenant_access_token", outcome: "hold" }); emptyState = false; peer.deliverInvite(envelope, send.wireMessageId); },
    read: snapshot,
    closeHeld(expected, phase, deadline) { return closeHeldTenantToken(expected, () => { phase.check(deadline); const value = snapshot(); phase.check(deadline); return value; }, app, () => { phase.check(deadline); marks.closeRequested = mark(); }, () => phase.check(deadline)); },
    async settle(close, phase, deadline) {
      const statuses = await phase.step(() => Promise.allSettled([close.first, close.second]), deadline); marks.closeSettled = mark();
      requireTenant(statuses.every(row => row.status === "fulfilled"), "close_failed"); wrapper.abort(); await phase.step(() => lifecyclePromise, deadline);
      let before = phase.read(deadline);
      while (before.hold !== null || before.owners.http || before.owners.httpSockets || before.owners.httpPending || before.owners.wsSockets || before.owners.wsPending || before.owners.connections) { await phase.poll(deadline); before = phase.read(deadline); }
      const third = await phase.step(() => { const promise = app.close(); promise.catch(() => {}); return Promise.resolve({ promise }); }, deadline);
      const status = await phase.step(() => Promise.allSettled([third.promise]), deadline), repeated = phase.read(deadline);
      return { snapshot: before, repeated, close: { firstFulfilled: true, secondFulfilled: true, promiseSame: close.first === close.second, thirdFulfilled: status[0].status === "fulfilled", thirdPromiseSame: third.promise === close.first }, composition: compositionResult };
    },
    async finish() { fixtureGate.resolve(); if (standalone) await standalone; return { snapshot: snapshot(), composition: compositionResult, standaloneExit, cleanupFailures: [...cleanupFailures] }; },
    cancel() { if (cancelled) return; cancelled = true; ordinaryClose(); wrapper.abort(); fixtureGate.resolve(); },
  });
  const result = await runTenantTokenPhase(effects, qualification, { now: () => performance.now(), startedAt: campaignStartedAt });
  const actual = Object.freeze({ ...result, provenance: "attempted-application" }); validateTenantTokenResult(actual, "attempted-application"); actualResults.set(actual, deadline); return actual;
}
export function writeRealTenantTokenEvidence(out, result) {
  requireTenant(result && typeof result === "object" && actualResults.has(result), "actual_unqualified");
  const qualified = validateTenantTokenResult(result, "attempted-application"), bytes = Buffer.from(JSON.stringify(qualified, null, 2)); requireTenant(bytes.length <= 262144, "output_invalid"); requireTenant(performance.now() < actualResults.get(result), "deadline"); writeValidatedTenantEvidence(out, bytes);
}

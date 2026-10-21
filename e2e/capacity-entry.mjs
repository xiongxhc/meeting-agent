// Built actual-owner adapter. Static imports create no owner, SDK or listener.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fstatSync, openSync, closeSync, constants, readSync, readdirSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { Agent as HttpAgent } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { assertIngressAck, assertIngressClose, assertIngressFinalReceiver, assertIngressReceiver, ingressPathExists } from './ingress-run.mjs';
import { readStateFile } from './state-file.mjs';
import { requireCapacity, validateCapacityPlan, capacityPrivateBytes, capacityPrivateJson, noCapacitySymlinks, readCapacityState, createCapacityCaptureObserver, assertCapacityLive, assertCapacityDeferred, assertCapacityUnchanged, assertCapacityFailureIsolation, assertCapacityStopped } from './capacity-run.mjs';

export async function runCapacityOwner(plan, effects, { signal, budgetMs = 300000, cleanupMs = 45000 } = {}) {
  validateCapacityPlan(plan);
  const controller = new globalThis.AbortController(), failures = [], observations = [], accepted = [], commits = [];
  const observeCapture = createCapacityCaptureObserver(plan);
  requireCapacity(Number.isFinite(budgetMs) && budgetMs > 0 && budgetMs <= 300000 && Number.isFinite(cleanupMs) && cleanupMs > 0 && cleanupMs <= 45000, 'budget');
  const abort = () => { if (!controller.signal.aborted) { controller.abort(); try { effects.cancel(); } catch { failures.push('capacity_cancel_failed'); } } };
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = globalThis.setTimeout(abort, budgetMs);
  const step = async (name, ...args) => {
    requireCapacity(!controller.signal.aborted, 'owner_cancelled'); let listener;
    const timeout = globalThis.setTimeout(abort, ['ready', 'live', 'settled'].includes(name) ? 30000 : 25000);
    try {
      const cancelled = new Promise((_, reject) => { listener = () => reject(new Error('capacity_owner_cancelled')); controller.signal.addEventListener('abort', listener, { once: true }); });
      const value = await Promise.race([effects[name](...args, controller.signal), cancelled]); requireCapacity(!controller.signal.aborted, 'owner_cancelled');
      if (name === 'live' || name === 'snapshot') observeCapture(value);
      requireCapacity(observations.length < 256, 'history_overflow'); observations.push({ ordinal: observations.length + 1, name, occurrenceId: typeof args[0] === 'string' ? args[0] : args[0]?.occurrenceId ?? null }); return value;
    } finally { controller.signal.removeEventListener('abort', listener); globalThis.clearTimeout(timeout); }
  };
  const deliver = async send => { const value = await step('deliver', send); assertIngressAck(send, value);
    requireCapacity(Object.entries(send.immutableExpected).every(([k, v]) => value.commit.immutable[k] === v) && Number.isSafeInteger(value.commit.immutable.acceptedAtMs) && value.commit.ordinal === commits.length + 1, 'commit_immutable');
    accepted.push(send); commits.push(value.commit); };
  let baseline, final, close, victim;
  try {
    const ready = await step('ready'); requireCapacity(ready.admitted && ready.started && ready.connections === 1, 'owner_admission'); assertIngressReceiver(ready.receiver, []);
    for (const send of plan.sends.slice(0, plan.count)) {
      await deliver(send); await step('discover'); const fact = await step('live', send.occurrenceId); assertCapacityLive(plan, fact);
      requireCapacity(fact.activity.outcomes.length === accepted.length && fact.activity.outcomes.some(o => o.occurrenceId === send.occurrenceId), 'incremental_live');
      if (baseline) assertCapacityUnchanged(baseline, fact, baseline.activity.outcomes.map(o => o.occurrenceId)); baseline = fact;
    }
    await deliver(plan.sends.at(-1));
    for (let repeat = 0; repeat < 2; repeat++) { const discovery = await step('discover'), fact = await step('snapshot'); fact.discovery = discovery; assertCapacityDeferred(plan, baseline, fact); }
    const observed = baseline.activity.bridges.find(b => b.binding.physicalClientId === plan.slots[0].physicalClientId);
    requireCapacity(observed && plan.sends.slice(0, plan.count).some(s => s.occurrenceId === observed.occurrenceId) && plan.slots[0].staticConfig.physicalOutcomeScenario.mode === 'missing', 'victim_binding'); victim = observed.occurrenceId;
    await step('end', { occurrenceId: victim, reason: 'bridge_failure' }); await step('settled', victim);
    const discovery = await step('discover'), isolated = await step('snapshot'); isolated.discovery = discovery; isolated.victim = victim; assertCapacityFailureIsolation(plan, baseline, isolated);
    // Final discovery is above. No delivery/discovery after the first release.
    for (const outcome of [...baseline.activity.outcomes].reverse().filter(o => o.occurrenceId !== victim)) {
      await step('end', { occurrenceId: outcome.occurrenceId, reason: 'removed' }); await step('settled', outcome.occurrenceId);
    }
    final = await step('snapshot'); final.victim = victim; final.liveBaseline = baseline; final.failureBaseline = isolated; assertCapacityStopped(plan, final);
  } catch (error) { failures.push(/^capacity_[A-Za-z_]+$/.test(error?.message ?? '') ? error.message : /^ingress_[A-Za-z_]+$/.test(error?.message ?? '') ? error.message : 'capacity_owner_failed'); }
  finally {
    abort(); globalThis.clearTimeout(timer); signal?.removeEventListener('abort', abort); let timeout;
    try {
      close = await Promise.race([effects.close(), new Promise((_, reject) => { timeout = globalThis.setTimeout(() => reject(new Error('capacity_close_timeout')), cleanupMs); })]);
      assertIngressClose(close); assertIngressFinalReceiver(close, accepted, commits);
    } catch (error) { failures.push(/^(capacity|ingress)_[A-Za-z_]+$/.test(error?.message ?? '') ? error.message : 'capacity_close_failed'); }
    finally { globalThis.clearTimeout(timeout); }
  }
  return { success: failures.length === 0 && Boolean(final), root: plan.root, databasePath: plan.databasePath, count: plan.count, label: 'component-facts', state: final?.state,
    activity: final?.activity, baseline, victim, controls: plan.count === 1 ? 'not-applicable' : plan.count - 1, close, failures, observations, preserved: true };
}

async function realEntry(plan) {
  const [sdk, main, configApi, lockApi, composition, httpApi, socketApi, peers, lifecycle] = await Promise.all([
    import('@larksuiteoapi/node-sdk'), import('../dist/src/main.js'), import('../dist/src/standalone-config.js'), import('../dist/src/adapters/application-owner-lock.js'), import('../dist/src/application-composition.js'),
    import('../dist/src/adapters/feishu-sdk-http.js'), import('../dist/src/adapters/feishu-sdk-connection.js'), import('./feishu-peer.mjs'), import('./composition-lifecycle.mjs'),
  ]);
  validateCapacityPlan(plan);
  assert.deepEqual(configApi.parseStandaloneConfig(capacityPrivateBytes(plan.standaloneConfigPath, { mode: 0o600 })), plan.standaloneConfig);
  const codec = await import('../dist/src/ports/feishu-ingress.js');
  for (const send of plan.sends) { const n = codec.normalizeInvite(send.envelope, peers.SCOPE); requireCapacity(n.occurrenceId === send.occurrenceId && n.normalizedSha256 === send.hash && Object.entries(send.immutableExpected).every(([k, v]) => n[k] === v), 'entry_invite_identity'); }
  const shutdown = new globalThis.AbortController(), signal = () => shutdown.abort(); for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(name, signal);
  let peer, app, run, http, connection, standaloneExit, compositionResult, ownerClosed = false, admitted = false, observerFailure = false, overflow = false, pending = null, closePromise, peerClosePromise, peerClosed = false;
  const trace = [], commits = [], delivered = [], ackIds = new Set(), cleanupFailures = [], observed = new Map();
  const observeCapture = createCapacityCaptureObserver(plan);
  const read = () => readCapacityState({ databasePath: plan.databasePath, occurrenceIds: delivered.map(s => s.occurrenceId) });
  const receiver = () => peer ? { invalid: peer.frameObservation.invalid, overflow: peer.frameObservation.overflow, observations: [...peer.frameObservation.observations] } : { invalid: false, overflow: false, observations: [] };
  const outcomes = () => (app?.occurrenceOutcomes() ?? []).map(o => ({ ...o, controlSessionId: o.controlSessionId?.toString() ?? null }));
  function log(code) {
    if (trace.length === 256) { overflow = true; shutdown.abort(); return; } trace.push(code);
    if (code !== 'invite_committed') return;
    try { requireCapacity(pending && !commits.some(c => c.wireMessageId === pending.wireMessageId), 'unexpected_commit');
      const state = read(), event = state.events.find(e => e.eventId === pending.eventId), row = state.invites.find(r => r.occurrenceId === pending.occurrenceId);
      requireCapacity(event?.hash === pending.hash && row, 'commit_hash');
      const immutable = Object.fromEntries([...Object.keys(pending.immutableExpected), 'acceptedAtMs'].map(k => [k, row[k]]));
      commits.push({ ordinal: commits.length + 1, wireMessageId: pending.wireMessageId, eventId: pending.eventId, expectedHash: pending.hash, persistedHash: event.hash, immutable, ackFloor: receiver().observations.at(-1)?.ordinal ?? 0 });
    } catch { observerFailure = true; }
  }
  function check() { requireCapacity(!shutdown.signal.aborted && !observerFailure && !overflow && standaloneExit === undefined, 'owner_stopped'); if (peer) requireCapacity(!peer.frameObservation.invalid && !peer.frameObservation.overflow && peer.requests.length < 256 && peer.messages.length === 0, 'peer_failure'); }
  async function wait(observe, budget, ownerSignal) { const until = process.hrtime.bigint() + BigInt(budget) * 1000000n;
    for (;;) { check(); requireCapacity(!ownerSignal?.aborted, 'owner_cancelled'); const fact = observe(); if (fact) return fact; requireCapacity(process.hrtime.bigint() < until, 'observation_timeout'); await delay(25, undefined, { signal: shutdown.signal }); } }
  async function closePeer() { if (!peer) { peerClosed = true; return; } if (!peerClosePromise) peerClosePromise = peer.close().then(() => { peerClosed = true; }); return peerClosePromise; }
  function recordingFile(row) {
    noCapacitySymlinks(row.encryptedPath); requireCapacity(row.encryptedPath.startsWith(`${plan.directories.recordingsDir}/`), 'recording_path');
    const fd = openSync(row.encryptedPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const stat = fstatSync(fd); requireCapacity(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o077) === 0 && stat.size > 0 && stat.size <= 8589934592, 'recording_private');
      const hash = createHash('sha256'), bytes = new Uint8Array(65536); let offset = 0;
      // Finite source bound and deadline; ciphertext only, never key contents.
      const until = process.hrtime.bigint() + 1000000000n;
      while (offset < stat.size) { requireCapacity(process.hrtime.bigint() < until, 'recording_read_timeout'); const n = readSync(fd, bytes, 0, Math.min(bytes.length, stat.size - offset), offset); requireCapacity(n > 0, 'recording_read'); hash.update(bytes.subarray(0, n)); offset += n; }
      return { sha256: hash.digest('hex'), bytes: offset, device: String(stat.dev), inode: String(stat.ino) };
    } finally { closeSync(fd); }
  }
  function snapshot() {
    const state = read(), rows = outcomes(), bridges = [];
    const runtimePids = ingressPathExists(plan.runtimePidsPath) ? capacityPrivateBytes(plan.runtimePidsPath).toString('utf8').trim().split('\n').filter(Boolean).map(Number) : [];
    requireCapacity(runtimePids.length <= plan.count && runtimePids.every(pid => Number.isSafeInteger(pid) && pid > 0), 'runtime_pid_extent');
    for (const slot of plan.slots) {
      if (!ingressPathExists(slot.statePath)) continue; const raw = readStateFile(slot.statePath, { read: file => capacityPrivateBytes(file).toString('utf8') }); requireCapacity(raw !== null, 'bridge_state_unreadable'); let provenance = observed.get(slot.physicalClientId);
      if (!provenance) { const bytes = capacityPrivateBytes(raw.configPath, { mode: 0o600 }), config = JSON.parse(bytes.toString('utf8')), b = config.custody;
        requireCapacity(config.controlDir === slot.controlDir && b.physicalClientId === slot.physicalClientId && config.schema === 'feishu-bridge-config/v3' && typeof b.physicalGenerationId === 'string', 'generated_config');
        provenance = { configPath: raw.configPath, configSha256: createHash('sha256').update(bytes).digest('hex'), binding: { physicalClientId: b.physicalClientId, physicalGenerationId: b.physicalGenerationId, occurrenceId: b.occurrenceId, bridgeSessionId: b.bridgeSessionId } }; observed.set(slot.physicalClientId, provenance);
      } else { requireCapacity(raw.configPath === provenance.configPath, 'config_changed');
        if (ingressPathExists(raw.configPath)) requireCapacity(createHash('sha256').update(capacityPrivateBytes(raw.configPath, { mode: 0o600 })).digest('hex') === provenance.configSha256, 'config_changed');
        else requireCapacity(rows.some(o => o.occurrenceId === provenance.binding.occurrenceId && o.phase === 'settled'), 'live_config_missing');
      }
      const b = provenance.binding, custody = state.custody.find(c => c.occurrenceId === b.occurrenceId), generation = state.generations.find(g => g.occurrenceId === b.occurrenceId);
      const recording = [...state.recordings, ...state.failedRecordings].find(r => r.occurrenceId === b.occurrenceId);
      bridges.push({ ...copy(provenance), occurrenceId: b.occurrenceId, pid: raw.pid, envKeys: raw.envKeys, joined: raw.joined, mediaConnected: raw.mediaConnected, framesSent: raw.framesSent, mediaEndpoint: raw.mediaEndpoint,
        commands: raw.commands, left: raw.left, endObservation: raw.endObservation, capturePosition: raw.capturePosition, captureFinish: raw.captureFinish, captureDrain: raw.captureDrain,
        bound: Boolean(custody && generation && custody.physicalClientId === b.physicalClientId && custody.physicalGenerationId === b.physicalGenerationId && custody.bridgeSessionId === b.bridgeSessionId && generation.bridgeSessionId === b.bridgeSessionId), recordingFile: recording ? recordingFile(recording) : null });
    }
    const fact = { state, activity: { trace: [...trace], requests: [...peer.requests], messages: [...peer.messages], receiver: receiver(), outcomes: rows, bridges, runtimePids, envKeys: Object.keys(process.env).sort(), files: { outbox: readdirSync(plan.directories.outboxDir).length, receipt: readdirSync(plan.directories.receiptsDir).length } } };
    observeCapture(fact); return fact;
  }
  const effects = {
    cancel() { shutdown.abort(); },
    async ready(ownerSignal) {
      run = main.runStandalone(['--standalone-config', plan.standaloneConfigPath], { readConfig: configApi.readStandaloneConfig, inspectStateRoot: configApi.inspectStateRoot,
        async acquireOwnerLock(root) { const owner = await lockApi.acquireApplicationOwnerLock(root); admitted = true; return { ...owner, close() { owner.close(); ownerClosed = true; } }; },
        async composeAfterAdmission(config, owner) {
          try { check(); peer = await peers.startFeishuPeer({ reservations: plan.reservations }); check();
            http = httpApi.createFeishuSdkHttp({ request: peer.rewriteRequest(sdk.defaultHttpInstance.request), connection: socketApi.createFeishuSocketOwner(HttpAgent) }); connection = socketApi.createFeishuSocketOwner(HttpAgent);
            compositionResult = await lifecycle.runExposedComposition(composition.composeApplication, config, owner, { feishu: { http, connection }, organizerReferences: plan.organizerReferences,
              maintenance: { intervalsMs: { backfill: 3600000, warning: 3600000, outbox: 3600000, notification: 3600000, discovery: 3600000, custody: 3600000 }, random: () => 0 }, discoveryJitter: () => 0, log }, handle => { app = handle; }, shutdown); return compositionResult;
          } finally { const cleanup = await Promise.allSettled([http?.close(), connection?.close(), closePeer()]); for (const [i, result] of cleanup.entries()) if (result.status === 'rejected' || result.value === false) cleanupFailures.push(['capacity_http_close', 'capacity_socket_close', 'capacity_peer_close'][i]); }
        }, report(channel, line) { process[channel === 'stdout' ? 'stdout' : 'stderr'].write(`${line}\n`); },
      }).then(value => { standaloneExit = value; return value; }, () => { standaloneExit = 70; return 70; });
      await wait(() => trace.includes('composition_started') && peer?.connectionCount === 1, 30000, ownerSignal); return { admitted, started: true, connections: peer.connectionCount, receiver: receiver() };
    },
    async deliver(send, ownerSignal) {
      check(); requireCapacity(pending === null && peer.connectionCount === 1, 'delivery_owner'); assertIngressReceiver(receiver(), [...ackIds]);
      const start = receiver().observations.length; pending = send; delivered.push(send); peer.deliverInvite(send.envelope, send.wireMessageId);
      await wait(() => receiver().observations.length > start, 25000, ownerSignal);
      const result = { commit: commits.find(c => c.wireMessageId === send.wireMessageId), receiver: { ...receiver(), observations: receiver().observations.slice(start) } }; assertIngressAck(send, result); ackIds.add(send.wireMessageId); pending = null; return result;
    },
    async discover() { check(); return app.discover(); },
    async live(id, ownerSignal) { return wait(() => { if (!outcomes().some(o => o.occurrenceId === id && o.phase === 'live')) return null; const fact = snapshot(); return fact.activity.bridges.some(b => b.occurrenceId === id && b.joined && b.mediaConnected && b.framesSent > 0) ? fact : null; }, 30000, ownerSignal); },
    async snapshot() { check(); return snapshot(); },
    async end({ occurrenceId, reason }) { check(); requireCapacity(['removed', 'bridge_failure'].includes(reason), 'end_reason');
      const cached = [...observed.values()].filter(p => p.binding.occurrenceId === occurrenceId); requireCapacity(cached.length === 1, 'end_binding');
      const slot = plan.slots.find(s => s.physicalClientId === cached[0].binding.physicalClientId); requireCapacity(slot && !ingressPathExists(slot.endPath) && !ingressPathExists(`${slot.endPath}.new`), 'end_path');
      noCapacitySymlinks(slot.controlDir); writeFileSync(`${slot.endPath}.new`, `${reason}\n`, { mode: 0o600, flag: 'wx' }); renameSync(`${slot.endPath}.new`, slot.endPath);
    },
    async settled(id, ownerSignal) { check(); await app.awaitOccurrence(id); return wait(() => outcomes().some(o => o.occurrenceId === id && o.phase === 'settled'), 30000, ownerSignal); },
    close() { if (closePromise) return closePromise; closePromise = (async () => {
      shutdown.abort(); if (run) await run; try { await closePeer(); } catch { cleanupFailures.push('capacity_peer_close'); }
      let keyCustody = 'not_created';
      if (trace.includes('shutdown_store_closed') && delivered.length) try {
        requireCapacity(readdirSync(plan.directories.outboxDir).length === 0 && readdirSync(plan.directories.receiptsDir).length === 0 && peer.messages.length === 0, 'close_publication');
        if (ingressPathExists(plan.keyPath)) { noCapacitySymlinks(plan.keyPath); const s = lstatSync(plan.keyPath), dir = lstatSync(path.dirname(plan.keyPath)); requireCapacity(s.isFile() && s.nlink === 1 && s.uid === process.getuid() && (s.mode & 0o777) === 0o600 && dir.uid === process.getuid() && (dir.mode & 0o777) === 0o700, 'key_custody'); keyCustody = 'private_runtime_file'; }
      } catch { cleanupFailures.push('capacity_final_state'); }
      return { standaloneExit: standaloneExit ?? 70, compositionClosed: compositionResult?.status === 'composition_closed' && compositionResult.clean, peerClosed, lockClosedLast: ownerClosed && peerClosed && trace.includes('shutdown_store_closed'), cleanupFailures: [...cleanupFailures], keyCustody, outcomes: outcomes(), receiver: receiver(), ackObservations: receiver().observations, commitObservations: [...commits], observerFailure, overflow };
    })(); return closePromise; },
  };
  try { const result = await runCapacityOwner(plan, effects, { signal: shutdown.signal }); return { ...result, label: 'attempted-application' }; }
  finally { for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(name, signal); }
}
const copy = value => globalThis.structuredClone(value);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void (async () => {
  requireCapacity(process.argv.length === 4 && process.argv[2] === '--plan' && path.isAbsolute(process.argv[3]), 'entry_arguments'); const plan = capacityPrivateJson(process.argv[3]);
  const result = await realEntry(plan); requireCapacity(JSON.stringify(result).length <= 1048576, 'summary_extent'); writeFileSync(plan.summaryPath, JSON.stringify(result), { mode: 0o600, flag: 'wx' }); process.exitCode = result.success ? 0 : 70;
})().catch(() => { process.stderr.write('capacity_entry_failed\n'); process.exitCode = 70; });

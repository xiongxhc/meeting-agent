import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import process from 'node:process';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { normalizeInvite } from '../src/ports/feishu-ingress.ts';
import { parseStandaloneConfig } from '../src/standalone-config.ts';
const helpers = () => import(path.join(import.meta.dirname, 'capacity-run.mjs'));
function baseline() {
  const root = '/private/tmp/component-capacity';
  const names = ['configDir', 'control', 'stateRoot', 'recordingsDir', 'outboxDir', 'receiptsDir', 'teamVaultDir', 'app'] as const;
  const directories = Object.fromEntries(names.map(k => [k, path.join(root, k)])) as Record<typeof names[number], string>;
  const standaloneConfig = { schema: 'meeting-agent-standalone/v1', stateRoot: directories.stateRoot,
    feishu: { region: 'feishu', tenantKey: 'e2e-tenant', appId: 'cli_0123456789abcdef', appSecretFile: path.join(directories.configDir, 'secret') },
    agentIdentity: { aliases: ['Meetbot'] }, dataPaths: Object.fromEntries((['recordingsDir', 'outboxDir', 'receiptsDir', 'teamVaultDir'] as const).map(k => [k, directories[k]])),
    runtime: { launcherPath: path.join(root, 'launcher'), gatewayConfigPath: path.join(root, 'gateway.toml'), protocolVersion: 4 },
    bridgeSlots: [{ physicalClientId: 'old', bridgeId: 'old', executable: '/opt/homebrew/opt/node@24/bin/node', staticConfigPath: path.join(directories.configDir, 'bridge-static.json'), argv: [path.join(directories.app, 'e2e/fixtures/e2e-bridge-child.mjs')], cooperativeGraceMs: 5000 }] };
  return { root, directories, standaloneConfig, standaloneConfigPath: path.join(directories.configDir, 'standalone.json'), bridgeStaticConfigPath: standaloneConfig.bridgeSlots[0]!.staticConfigPath,
    bridgeStaticConfig: { schema: 'feishu-bridge-config/v1', bundleVersion: 'e2e-scripted', controlDir: directories.control, captureFrameLimit: 51, participants: [{ feishuUserId: 'old', displayName: 'Old' }], audio: { captureDisplayId: 1, outputDeviceUid: 'e2e-scripted-output' } },
    gatewayConfigPath: standaloneConfig.runtime.gatewayConfigPath, gatewayPidsPath: path.join(root, 'pids'), keyPath: path.join(root, 'key') };
}
test('actual constructor produces N slots and N+1 production-normalized distinct invites', async () => {
  const { buildCapacityConfiguration } = await helpers();
  for (const count of [1, 2, 4, 8]) {
    const staged = baseline(), before = structuredClone(staged);
    const plan = buildCapacityConfiguration({ staged, count, startSeconds: 1791280800, normalizeInvite, parseStandaloneConfig });
    assert.equal(plan.slots.length, count); assert.equal(plan.sends.length, count + 1);
    assert.equal(new Set(plan.sends.map((s: { occurrenceId: string }) => s.occurrenceId)).size, count + 1);
    assert.deepEqual(staged, before);
  }
});

const entry = () => import(path.join(import.meta.dirname, 'capacity-entry.mjs'));
async function makePlan(count = 2, staged = baseline()) { const h = await helpers(); return h.buildCapacityConfiguration({ staged, count, startSeconds: 1791280800, normalizeInvite, parseStandaloneConfig }); }
type ObjectFact = Record<string, unknown>;
function change(value: unknown, keys: (string | number)[], replacement: unknown) {
  let current = value as ObjectFact;
  for (const key of keys.slice(0, -1)) current = current[key] as ObjectFact;
  current[keys.at(-1)!] = replacement;
}

test('strict CLI count/options/path extents', async () => {
  const h = await helpers();
  for (const count of [1, 2, 4, 8]) assert.deepEqual(h.parseCapacityArguments(['--count', String(count), '--out', '/private/tmp/absent-capacity-result']), { count, out: '/private/tmp/absent-capacity-result' });
  for (const args of [[], ['--count', '0'], ['--count', '3'], ['--count', '9'], ['--count', '01'], ['--count', '2', '--count', '2'], ['--all'], ['--count', '1', '--out', 'relative'], ['--count', '1', '--out', '/'], ['--count', '1', '--out', '/private/tmp/a/../b'], ['--count', '1', '--out', '/private/tmp'], ['--count', '1', '--out', '/private/tmp/x', '--target-slot', '1']]) assert.throws(() => h.parseCapacityArguments(args));
});
function privateStage() {
  const staged = baseline(), root = mkdtempSync('/private/tmp/capacity-component-'); chmodSync(root, 0o700);
  const replace = (value: unknown): unknown => typeof value === 'string' ? value.replace(staged.root, root) : Array.isArray(value) ? value.map(replace) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)])) : value;
  const result = replace(staged) as ReturnType<typeof baseline>;
  for (const dir of Object.values(result.directories)) mkdirSync(dir, { mode: 0o700 });
  writeFileSync(result.standaloneConfigPath, JSON.stringify(result.standaloneConfig), { mode: 0o600 }); return result;
}
test('real materializer writes private unique files and production-parser N slots', async () => {
  const h = await helpers();
  for (const n of [1, 2, 4, 8]) { const staged = privateStage();
    try { const plan = await makePlan(n, staged); h.materializeCapacityConfiguration(plan);
      assert.equal(parseStandaloneConfig(readFileSync(staged.standaloneConfigPath)).bridgeSlots.length, n);
      for (const slot of plan.slots) { assert.equal(lstatSync(slot.controlDir).mode & 0o777, 0o700); assert.equal(lstatSync(slot.staticConfigPath).mode & 0o777, 0o600); assert.deepEqual(JSON.parse(readFileSync(slot.staticConfigPath, 'utf8')), slot.staticConfig); }
      assert.equal(lstatSync(staged.standaloneConfigPath).mode & 0o777, 0o600); assert.throws(() => h.materializeCapacityConfiguration(plan));
    } finally { rmSync(staged.root, { recursive: true, force: true }); }
  }
});
test('constructor refuses inherited custody/observation/scenario and invalid count', async () => {
  const h = await helpers();
  for (const key of ['custody', 'observationPlan', 'physicalOutcomeScenario']) { const staged = baseline(); change(staged, ['bridgeStaticConfig', key], {}); assert.throws(() => h.buildCapacityConfiguration({ staged, count: 2, startSeconds: 1, normalizeInvite, parseStandaloneConfig })); }
  for (const count of [0, 3, 9]) await assert.rejects(makePlan(count));
});
test('materializer refuses standalone/config locators escaping its returned stage before writes', async () => {
  const h = await helpers(), staged = privateStage();
  try { const p = structuredClone(await makePlan(2, staged)); p.standaloneConfig.runtime.gatewayConfigPath = '/private/tmp/foreign-gateway';
    assert.throws(() => h.materializeCapacityConfiguration(p), /plan_paths/); assert.equal(existsSync(p.slots[0].staticConfigPath), false);
  } finally { rmSync(staged.root, { recursive: true, force: true }); }
});
test('materializer validates last slot/collisions before any partial write', async () => {
  const h = await helpers();
  for (const keys of [['slots', 1, 'endPath'], ['slots', 1, 'physicalClientId'], ['reservations', 1, 'reserveId'], ['sends', 1, 'wireMessageId'], ['standaloneConfig', 'bridgeSlots', 1, 'staticConfigPath']]) {
    const staged = privateStage(); try { const plan = structuredClone(await makePlan(2, staged)); change(plan, keys, '/private/tmp/foreign');
      assert.throws(() => h.materializeCapacityConfiguration(plan)); assert.equal(readdirSync(staged.directories.control).length, 0); assert.equal(readdirSync(staged.directories.configDir).length, 1);
    } finally { rmSync(staged.root, { recursive: true, force: true }); }
  }
  for (const kind of ['residue', 'symlink', 'file']) { const staged = privateStage(); try { const plan = await makePlan(2, staged);
    if (kind === 'residue') writeFileSync(path.join(staged.directories.control, 'old'), 'old');
    else if (kind === 'symlink') symlinkSync(staged.root, plan.slots[1].controlDir);
    else writeFileSync(plan.slots[1].staticConfigPath, 'existing');
    assert.throws(() => h.materializeCapacityConfiguration(plan)); assert.equal(existsSync(plan.slots[0].staticConfigPath), false);
  } finally { rmSync(staged.root, { recursive: true, force: true }); } }
});

// Explicit isolated synthetic SQLite fixtures verify SELECT/projection only.
// They never become an application database or admission/acceptance evidence.
function syntheticDatabase(root: string) {
  const filename = path.join(root, 'synthetic.db'), db = new Database(filename), migrations = path.resolve(import.meta.dirname, '../migrations');
  for (const file of readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) { db.exec(readFileSync(path.join(migrations, file), 'utf8')); db.prepare('INSERT INTO schema_migrations VALUES(?,?,0)').run(Number(file.slice(0, 3)), file); }
  return { db, filename };
}
test('actual SELECT reader supports incremental/all N+1 projection and excludes secrets', async () => {
  const h = await helpers(), plan = await makePlan(8), root = mkdtempSync('/private/tmp/capacity-synthetic-sql-'); chmodSync(root, 0o700);
  try { const { db, filename } = syntheticDatabase(root);
    const insert = db.prepare(`INSERT INTO feishu_invite_occurrences(occurrence_id,region,tenant_key,app_id,provider_meeting_id,meeting_no,occurrence_started_at,title,state,accepted_at_ms,last_observed_at_ms,next_attempt_at_ms,claim_token,claim_expires_at_ms) VALUES(?,?,?,?,?,?,?,?,'pending_metadata',0,0,0,?,100)`);
    const first = plan.sends[0].immutableExpected; insert.run(first.occurrenceId, first.region, first.tenantKey, first.appId, first.providerMeetingId, first.meetingNo, first.occurrenceStartedAt, first.title, 'a'.repeat(32)); db.close(); chmodSync(filename, 0o600);
    const state = h.readCapacityState({ databasePath: filename, occurrenceIds: [first.occurrenceId] }); assert.equal(state.invites.length, 1); assert.equal(state.invites[0].claimed, 1); assert.equal(JSON.stringify(state).includes('a'.repeat(32)), false);
    const writer = new Database(filename); writer.prepare('UPDATE feishu_invite_occurrences SET claim_token=NULL,claim_expires_at_ms=NULL').run();
    for (const send of plan.sends.slice(1)) { const i = send.immutableExpected; writer.prepare(`INSERT INTO feishu_invite_occurrences(occurrence_id,region,tenant_key,app_id,provider_meeting_id,meeting_no,occurrence_started_at,title,state,accepted_at_ms,last_observed_at_ms,next_attempt_at_ms) VALUES(?,?,?,?,?,?,?,?,'pending_metadata',0,0,0)`).run(i.occurrenceId, i.region, i.tenantKey, i.appId, i.providerMeetingId, i.meetingNo, i.occurrenceStartedAt, i.title); } writer.close();
    assert.equal(h.readCapacityState({ databasePath: filename, occurrenceIds: plan.sends.map((s: { occurrenceId: string }) => s.occurrenceId) }).invites.length, 9);
    assert.throws(() => h.readCapacityState({ databasePath: filename, occurrenceIds: [first.occurrenceId] }), /reader_extent/);
    assert.throws(() => h.readCapacityState({ databasePath: filename, occurrenceIds: plan.sends.map((s: { occurrenceId: string }) => s.occurrenceId).map((s: string, i: number) => i === 8 ? 'foreign' : s) }), /foreign_occurrence/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('reader refuses header/WAL/symlinks/loose parent before SQL side effects', async () => {
  const h = await helpers(), root = mkdtempSync('/private/tmp/capacity-reader-'); chmodSync(root, 0o700); const filename = path.join(root, 'ordinary');
  try { writeFileSync(filename, Buffer.alloc(100), { mode: 0o600 }); const read = () => h.readCapacityState({ databasePath: filename, occurrenceIds: ['synthetic'] }); assert.throws(read, /header/); assert.equal(existsSync(filename + '-wal'), false);
    writeFileSync(filename + '-wal', ''); assert.throws(read, /WAL/); rmSync(filename + '-wal'); symlinkSync(filename, path.join(root, 'link')); assert.throws(() => h.readCapacityState({ databasePath: path.join(root, 'link'), occurrenceIds: ['synthetic'] }), /symlink/);
    chmodSync(root, 0o755); assert.throws(read, /private_database/); chmodSync(root, 0o700);
    const { db, filename: sql } = syntheticDatabase(root); db.prepare('DELETE FROM schema_migrations WHERE version=29').run(); db.close(); assert.throws(() => h.readCapacityState({ databasePath: sql, occurrenceIds: ['synthetic'] }), /schema29/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('synthetic SELECT reader projects actual recovery/unknown columns without capability authorization', async () => {
  const h = await helpers(), root = mkdtempSync('/private/tmp/capacity-synthetic-source-'); chmodSync(root, 0o700);
  try { const { db, filename } = syntheticDatabase(root), id = 'synthetic@2026-10-06T10:00:00Z', generation = id + '#bridge', handle = '1'.repeat(32), sha = '2'.repeat(64), key = '3'.repeat(16), authorization = '4'.repeat(64);
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?, 'listening',NULL,0,0)").run(id, 'synthetic-segment', 'synthetic', '2026-10-06T10:00:00Z');
    db.prepare("INSERT INTO reconciliation_generations(generation_id,occurrence_id,bridge_session_id,runtime_session_id,recording_handle,created_at_ms,terminal_at_ms,terminal_source,expires_at_ms,terminal_reason) VALUES(?,?,?,'41',?,0,300,'bridge_observed',1209600300,'bridge_failure')").run(generation, id, 'bridge', handle);
    db.prepare("INSERT INTO bridge_failure_recordings VALUES(?,1,?,?,?,100,'synthetic-encrypted',?,300)").run(id, handle, path.join(root, 'synthetic.crsr'), sha, key);
    db.prepare("INSERT INTO bridge_recoveries VALUES(?,1,300)").run(id);
    db.prepare("INSERT INTO recording_recovery_bindings(generation_id,occurrence_id,bridge_session_id,source_session_id,recording_handle,sha256,key_id,authorization,recording_kind,failure_attempt) VALUES(?,?,?,'41',?,?,?,?,'bridge_failure',1)").run(generation, id, 'bridge', handle, sha, key, authorization);
    db.prepare("INSERT INTO unknown_end_custody(occurrence_id,source_kind,failure_attempt,failure_occurrence_id,recording_handle,recording_path,recording_sha256,recording_key_id,recording_bytes,recording_device,recording_inode,unknown_end_detected_at_ms,unknown_end_deadline_ms,state,last_observed_at_ms) VALUES(?,'bridge_failure',1,?,?,?,?,?,10,'1','2',300,1209600300,'assigned',300)").run(id, id, handle, path.join(root, 'synthetic.crsr'), sha, key);
    db.close(); chmodSync(filename, 0o600); const state = h.readCapacityState({ databasePath: filename, occurrenceIds: [id] });
    assert.equal(state.bindings[0].controlSessionId, '41'); assert.equal(state.bindings[0].sourceKind, 'bridge_failure'); assert.equal(state.unknown[0].deadlineMs, 1209600300); assert.equal(state.failedRecordings[0].handle, handle); assert.equal(JSON.stringify(state).includes(authorization), false);
    const writer = new Database(filename); writer.prepare("INSERT INTO reconciliation_generations(generation_id,occurrence_id,bridge_session_id,created_at_ms) VALUES(?,?,?,0)").run(id + '#extra', id, 'extra'); writer.close(); assert.throws(() => h.readCapacityState({ databasePath: filename, occurrenceIds: [id] }), /reader_extent|extra_generation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

async function component(count = 2, mutate: (name: string, fact: unknown) => void = () => {}, swappedSlots = false) {
  const plan = await makePlan(count), calls: string[] = [], commits: ObjectFact[] = [], received: ObjectFact[] = [], stopped = new Map<string, string>(); let sent = 0, launched = 0, closed = 0;
  const fact = () => {
    const invites = plan.sends.slice(0, sent).map((send: { immutableExpected: ObjectFact }, i: number) => ({ ...send.immutableExpected, acceptedAtMs: 100 + i, state: 'admitted', organizerId: plan.reservations[i].organizer.openId, organizerName: plan.reservations[i].organizer.displayName, organizerSource: 'reservation', reference: { kind: 'reservation', reserveId: plan.reservations[i].reserveId }, admittedAtMs: 200 + i, claimed: 0 }));
    const events = plan.sends.slice(0, sent).map((s: ObjectFact, i: number) => Object.fromEntries(['occurrenceId', 'eventId', 'hash', 'title', 'createTime', 'inviteSeconds', 'startSeconds', 'acceptedAtMs'].map(k => [k, k === 'acceptedAtMs' ? 100 + i : s[k]])));
    const active = plan.sends.slice(0, launched), sessions = plan.sends.slice(0, sent).map((s: { occurrenceId: string; immutableExpected: ObjectFact }, i: number) => ({ occurrenceId: s.occurrenceId, providerMeetingId: s.immutableExpected.providerMeetingId, occurrenceStartedAt: s.immutableExpected.occurrenceStartedAt, state: i >= launched ? 'discovered' : stopped.has(s.occurrenceId) && stopped.get(s.occurrenceId) !== 'bridge_failure' ? 'finalizing' : 'listening', terminalReason: null }));
    const tuples = active.map((s: { occurrenceId: string }, i: number) => ({ id: s.occurrenceId, slot: plan.slots[swappedSlots ? (i + 1) % count : i], bridgeSessionId: 'synthetic-bridge-' + i, physicalGenerationId: String(i + 1).repeat(32), controlSessionId: String(i + 41), generationId: 'synthetic-generation-' + i, reason: stopped.get(s.occurrenceId), handle: String(i + 1).repeat(32), sha256: String(i + 1).repeat(64), keyId: 'a'.repeat(16), encryptedPath: path.join(plan.directories.recordingsDir, 'synthetic-' + i) }));
    const finished = tuples.filter((t: { reason: string | undefined }) => t.reason);
    const source = (t: typeof tuples[number]) => ({ occurrenceId: t.id, handle: t.handle, sha256: t.sha256, keyId: t.keyId, encryptedPath: t.encryptedPath, captureDrain: 'confirmed', captureDrainReason: null, captureEpoch: '1', lastFrameSequence: '1', outputEndSample: '480', finalClockPairSequence: '2' });
    const state = { fileIdentity: 'synthetic-private-db', invites, events, sessions, counts: { seed: 0, alignment: 0, jobs: 0, delivery: 0, notification: 0 },
      leases: tuples.map((t: typeof tuples[number]) => ({ occurrenceId: t.id, leaseId: 'lease-' + t.id, bridgeId: t.slot.bridgeId, bridgeSessionId: t.bridgeSessionId, acquiredAtMs: 100, expiresAtMs: 100000, releasedAtMs: t.reason ? 300 : null, releaseReason: t.reason ? t.reason === 'bridge_failure' ? 'bridge_failure' : 'left' : null })),
      generations: tuples.map((t: typeof tuples[number]) => ({ occurrenceId: t.id, generationId: t.generationId, bridgeSessionId: t.bridgeSessionId, controlSessionId: t.controlSessionId, handle: t.reason ? t.handle : null, terminalAtMs: t.reason ? 300 : null, terminalSource: t.reason ? 'bridge_observed' : null, terminalReason: t.reason ?? null, expiresAtMs: t.reason ? 300 + 1209600000 : null })),
      custody: tuples.map((t: typeof tuples[number]) => ({ occurrenceId: t.id, physicalClientId: t.slot.physicalClientId, physicalGenerationId: t.physicalGenerationId, bridgeSessionId: t.bridgeSessionId, state: t.reason && t.reason !== 'bridge_failure' ? 'cleared' : 'quarantined', failure: t.reason === 'bridge_failure' ? 'outcome_missing' : null, outcome: t.reason && t.reason !== 'bridge_failure' ? 'departure_confirmed' : null, reason: t.reason && t.reason !== 'bridge_failure' ? 'departure_observed' : null, recordedAtMs: t.reason ? 300 : null, clearedAtMs: t.reason && t.reason !== 'bridge_failure' ? 300 : null, clearReason: t.reason && t.reason !== 'bridge_failure' ? 'departure_observed' : null, clearOperator: null })),
      recoveries: finished.filter((t: typeof tuples[number]) => t.reason === 'bridge_failure').map((t: typeof tuples[number]) => ({ occurrenceId: t.id, failureCount: 1 })),
      recordings: finished.filter((t: typeof tuples[number]) => t.reason !== 'bridge_failure').map(source), failedRecordings: finished.filter((t: typeof tuples[number]) => t.reason === 'bridge_failure').map((t: typeof tuples[number]) => ({ ...source(t), attempt: 1 })),
      bindings: finished.map((t: typeof tuples[number]) => ({ ...source(t), generationId: t.generationId, bridgeSessionId: t.bridgeSessionId, controlSessionId: t.controlSessionId, sourceKind: t.reason === 'bridge_failure' ? 'bridge_failure' : 'final', attempt: t.reason === 'bridge_failure' ? 1 : null })),
      unknown: finished.map((t: typeof tuples[number]) => ({ ...source(t), sourceKind: t.reason === 'bridge_failure' ? 'bridge_failure' : 'final', attempt: t.reason === 'bridge_failure' ? 1 : 0, bytes: 10, device: '1', inode: String(t.controlSessionId), state: 'assigned', claimed: 0, failure: null, deletedAtMs: null, detectedAtMs: 300, deadlineMs: 300 + 1209600000 })) };
    const activity = { trace: tuples.map(() => 'occurrence_launched'), receiver: { invalid: false, overflow: false, observations: structuredClone(received) }, messages: [], files: { outbox: 0, receipt: 0 }, envKeys: ['PATH'], runtimePids: tuples.map((_: unknown, i: number) => 1000 + i),
      outcomes: tuples.map((t: typeof tuples[number]) => ({ occurrenceId: t.id, phase: t.reason ? 'settled' : 'live', failure: null, controlSessionId: t.controlSessionId, finalization: t.reason ? 'recorded' : 'none', custody: t.reason ? 'assigned' : 'not_applicable', runtimeClose: t.reason ? 'closed' : 'pending', runtimeCleanup: t.reason ? 'graceful' : null })),
      bridges: tuples.map((t: typeof tuples[number], i: number) => { const position = { captureEpoch: '1', sequence: '1', outputEndSample: '480' }, boundary = { captureEpoch: '1', lastFrameSequence: '1', outputEndSample: '480', finalClockPairSequence: '2' };
        return { occurrenceId: t.id, pid: 2000 + i, configPath: '/private/tmp/synthetic-generated-' + i + '/config.json', configSha256: 'b'.repeat(64), binding: { physicalClientId: t.slot.physicalClientId, physicalGenerationId: t.physicalGenerationId, occurrenceId: t.id, bridgeSessionId: t.bridgeSessionId }, bound: true, envKeys: ['PATH'], joined: true, mediaConnected: true, mediaEndpoint: '/private/tmp/synthetic-media-' + i, framesSent: 1, commands: ['join', 'connect_media'], left: t.reason ?? null, endObservation: t.reason ? { reason: t.reason } : null, capturePosition: position,
          captureFinish: t.reason ? { authenticated: true, sessionId: t.controlSessionId, bridgeSessionId: t.bridgeSessionId, requestedBoundary: boundary, acknowledgedBoundary: structuredClone(boundary), capturePosition: position } : null,
          captureDrain: t.reason ? { drain: 'confirmed', reason: null, boundary } : null, recordingFile: t.reason ? { sha256: t.sha256, bytes: 10, device: '1', inode: t.controlSessionId } : null }; }) };
    return { state, activity };
  };
  const value = <T>(name: string, v: T): T => { calls.push(name); const cloned = structuredClone(v); mutate(name, cloned); return cloned; };
  const effects = {
    async ready() { return value('ready', { admitted: true, started: true, connections: 1, receiver: { invalid: false, overflow: false, observations: [] } }); },
    async deliver(send: ObjectFact) { sent++; const i = sent - 1; received.push({ ordinal: sent, kind: 'ack', messageId: send.wireMessageId, payload: { code: 200 } });
      const commit = { ordinal: sent, ackFloor: sent - 1, wireMessageId: send.wireMessageId, eventId: send.eventId, expectedHash: send.hash, persistedHash: send.hash, immutable: { ...(send.immutableExpected as ObjectFact), acceptedAtMs: 100 + i } }; commits.push(commit);
      return value('deliver', { commit, receiver: { invalid: false, overflow: false, observations: [received.at(-1)] } }); },
    async discover() { launched = Math.min(sent, count); return value('discover', { launched: sent <= count ? 1 : 0, deferred: sent > count ? 1 : 0 }); },
    async live(id: string) { return value('live:' + id, fact()); }, async snapshot() { return value('snapshot', fact()); },
    async end(command: { occurrenceId: string; reason: string }) { calls.push('end:' + command.occurrenceId + ':' + command.reason); stopped.set(command.occurrenceId, command.reason); },
    async settled(id: string) { calls.push('settled:' + id); return true; }, cancel() { calls.push('cancel'); },
    async close() { closed++; return value('close', { standaloneExit: 0, compositionClosed: true, peerClosed: true, lockClosedLast: true, cleanupFailures: [], outcomes: fact().activity.outcomes,
      finalState: fact().state, receiver: { invalid: false, overflow: false, observations: received }, ackObservations: received, commitObservations: commits, observerFailure: false, overflow: false }); },
  };
  return { plan, effects, calls, fact, closed: () => closed };
}
test('same owner controller positives N1/2/4/8, serial live-before-invite, reverse drain and no discover after release', async () => {
  const { runCapacityOwner } = await entry();
  for (const n of [1, 2, 4, 8]) { const c = await component(n), result = await runCapacityOwner(c.plan, c.effects); assert.equal(result.success, true, JSON.stringify(result.failures)); assert.equal(result.label, 'component-facts'); assert.equal(c.closed(), 1);
    for (let i = 0; i < n - 1; i++) assert.ok(c.calls.indexOf('live:' + c.plan.sends[i].occurrenceId) < c.calls.indexOf('live:' + c.plan.sends[i + 1].occurrenceId));
    const drains = c.calls.filter(name => name.endsWith(':removed')); assert.deepEqual(drains, c.plan.sends.slice(1, n).reverse().map((s: { occurrenceId: string }) => 'end:' + s.occurrenceId + ':removed'));
    if (drains.length) assert.equal(c.calls.slice(c.calls.indexOf(drains[0]!)).includes('discover'), false);
    assert.equal(result.controls, n === 1 ? 'not-applicable' : n - 1);
  }
});
test('victim comes from observed slot1 custody rather than the first invite/launch ordinal', async () => {
  const { runCapacityOwner } = await entry(), c = await component(2, () => {}, true), result = await runCapacityOwner(c.plan, c.effects);
  assert.equal(result.success, true, JSON.stringify(result.failures)); assert.equal(result.victim, c.plan.sends[1].occurrenceId);
  assert.ok(c.calls.includes('end:' + c.plan.sends[1].occurrenceId + ':bridge_failure')); assert.ok(c.calls.includes('end:' + c.plan.sends[0].occurrenceId + ':removed'));
});
test('same oracles reject crosswired identities, extra queue work, PID/lease/raw binding/capture/source/deadline corruption', async () => {
  const { runCapacityOwner } = await entry();
  const cases: [(string | number)[], unknown][] = [
    [['state', 'invites', 0, 'organizerId'], 'ou_capacity_2'], [['state', 'invites', 0, 'reference', 'reserveId'], 'reserve-capacity-2'], [['state', 'events', 0, 'hash'], 'b'.repeat(64)],
    [['activity', 'bridges', 0, 'binding', 'physicalGenerationId'], '2'.repeat(32)], [['activity', 'bridges', 0, 'binding', 'bridgeSessionId'], 'synthetic-bridge-1'], [['activity', 'outcomes', 0, 'controlSessionId'], '42'],
    [['activity', 'bridges', 1, 'pid'], 2003], [['state', 'leases', 1, 'leaseId'], 'foreign'], [['state', 'unknown', 0, 'deadlineMs'], 300 + 1209600001], [['state', 'failedRecordings', 0, 'handle'], '2'.repeat(32)],
    [['activity', 'bridges', 0, 'captureFinish', 'sessionId'], '42'], [['activity', 'bridges', 0, 'captureFinish', 'bridgeSessionId'], 'synthetic-bridge-1'], [['activity', 'bridges', 0, 'captureFinish', 'authenticated'], false],
    [['activity', 'bridges', 0, 'captureFinish', 'acknowledgedBoundary', 'outputEndSample'], '960'], [['activity', 'bridges', 0, 'capturePosition', 'sequence'], '2'], [['state', 'custody', 0, 'failure'], null],
    [['activity', 'bridges', 0, 'captureDrain', 'boundary', 'outputEndSample'], '960'], [['state', 'generations', 0, 'terminalReason'], 'ended'],
  ];
  for (const [keys, replacement] of cases) {
    const c = await component(2, (name, f) => { if (name === 'snapshot' && (f as { state: { failedRecordings: unknown[] } }).state.failedRecordings.length) change(f, keys, replacement); });
    const result = await runCapacityOwner(c.plan, c.effects); assert.equal(result.success, false, keys.join('.')); assert.equal(c.closed(), 1);
  }
  for (const name of ['runtimePids', 'outcomes', 'bridges']) { const c = await component(2, (phase, f) => { if (phase === 'snapshot') { const fact = f as { activity: ObjectFact }; const rows = fact.activity[name] as unknown[]; rows.push(structuredClone(rows[0])); } }); assert.equal((await runCapacityOwner(c.plan, c.effects)).success, false); }
});
test('late ACK/observer/sticky receive corruption fails after early success', async () => {
  const { runCapacityOwner } = await entry();
  for (const kind of ['duplicate', 'unknown', 'invalid', 'overflow', 'observer', 'commit']) { const c = await component(2, (name, f) => {
    if (name !== 'close') return; const close = f as { receiver: { observations: ObjectFact[]; invalid: boolean; overflow: boolean }; observerFailure: boolean; commitObservations: ObjectFact[] };
    if (kind === 'duplicate') close.receiver.observations.push(structuredClone(close.receiver.observations[0]!));
    if (kind === 'unknown') change(close, ['receiver', 'observations', 0, 'messageId'], 'unknown');
    if (kind === 'invalid') close.receiver.invalid = true; if (kind === 'overflow') close.receiver.overflow = true; if (kind === 'observer') close.observerFailure = true;
    if (kind === 'commit') change(close, ['commitObservations', 0, 'persistedHash'], 'b'.repeat(64));
  }); assert.equal((await runCapacityOwner(c.plan, c.effects)).success, false, kind); }
});
test('drain preserves the earlier observed Runtime binding and first unknown-end detection even under coherent mutations', async () => {
  const { runCapacityOwner } = await entry();
  for (const kind of ['runtime', 'deadline']) { const c = await component(2, (name, value) => {
    const f = value as { state: { recordings: unknown[]; unknown: { detectedAtMs: number; deadlineMs: number }[] }; activity: ObjectFact };
    if (name !== 'snapshot' || !f.state.recordings.length) return;
    if (kind === 'runtime') for (const keys of [['activity', 'outcomes', 1, 'controlSessionId'], ['state', 'generations', 1, 'controlSessionId'], ['state', 'bindings', 1, 'controlSessionId'], ['activity', 'bridges', 1, 'captureFinish', 'sessionId']]) change(f, keys, '55');
    else { f.state.unknown[0]!.detectedAtMs++; f.state.unknown[0]!.deadlineMs++; }
  }); assert.equal((await runCapacityOwner(c.plan, c.effects)).success, false, kind); }
});
test('finite mock-clock cancellation reaches awaited close, preabort fences all useful effects', async t => {
  const { runCapacityOwner } = await entry(); t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = await component(1); c.effects.ready = () => new Promise(() => {});
  const pending = runCapacityOwner(c.plan, c.effects, { budgetMs: 100, cleanupMs: 50 }); await Promise.resolve(); t.mock.timers.tick(101); const result = await pending; assert.equal(result.success, false); assert.equal(c.closed(), 1);
  const before = await component(1), controller = new AbortController(); controller.abort(); assert.equal((await runCapacityOwner(before.plan, before.effects, { signal: controller.signal })).success, false); assert.equal(before.calls.includes('ready'), false); assert.equal(before.closed(), 1);
});
test('bounded close timeout/rejection and effect diagnostics are nonpassing', async t => {
  const { runCapacityOwner } = await entry(); t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = await component(1); c.effects.ready = async () => { throw new Error('secret-value-never-retained'); }; c.effects.close = () => new Promise(() => {});
  const pending = runCapacityOwner(c.plan, c.effects, { cleanupMs: 25 }); for (let i = 0; i < 10; i++) await Promise.resolve(); t.mock.timers.tick(26); const result = await pending; assert.equal(result.success, false); assert.ok(result.failures.includes('capacity_close_timeout')); assert.equal(JSON.stringify(result).includes('secret-value-never-retained'), false);
  const rejected = await component(1); rejected.effects.close = async () => { throw new Error('private-token'); }; assert.equal((await runCapacityOwner(rejected.plan, rejected.effects)).success, false);
});
test('actual registry handler returns complete interleaved A/B and ninth metadata from constructor records', async () => {
  const module = await import(path.join(import.meta.dirname, 'feishu-peer-controls.mjs')), plan = await makePlan(8), controls = module.createFeishuPeerControls({ reservations: plan.reservations, wsPath: () => 'ws://component.invalid/ws' });
  class Response extends Writable { statusCode = 200; chunks: Buffer[] = []; setHeader() {} _write(chunk: Buffer, _: string, done: () => void) { this.chunks.push(Buffer.from(chunk)); done(); } }
  try { for (const index of [0, 1, 8, 1, 0]) { const r = plan.reservations[index];
    const paths = ['/vc/v1/reserves/' + r.reserveId + '/get_active_meeting?with_participants=false&user_id_type=open_id', '/vc/v1/reserves/' + r.reserveId + '?user_id_type=open_id', '/contact/v3/users/' + r.organizer.openId + '?user_id_type=open_id'];
    const bodies = [{ code: 0, msg: 'ok', data: { meeting: { id: r.meeting.providerMeetingId, meeting_no: r.meeting.meetingNo, start_time: String(r.meeting.startSeconds), topic: r.meeting.title } } }, { code: 0, msg: 'ok', data: { reserve: { id: r.reserveId, meeting_no: r.meeting.meetingNo, reserve_user_id: r.organizer.openId } } }, { code: 0, msg: 'ok', data: { user: { open_id: r.organizer.openId, name: r.organizer.displayName } } }];
    for (let i = 0; i < paths.length; i++) { const req = Object.assign(new PassThrough(), { url: paths[i], method: 'GET', complete: false, aborted: false, headers: {} }), res = new Response(); controls.handler(req, res); req.complete = true; req.end(); await setImmediate(); assert.equal(res.statusCode, 200); assert.deepEqual(JSON.parse(Buffer.concat(res.chunks).toString()), bodies[i]); }
  } } finally { controls.close(); }
});
test('abort during delivery/live/failure/drain fences subsequent work and still closes once', async () => {
  const { runCapacityOwner } = await entry();
  for (const phase of ['deliver', 'live', 'failure', 'drain']) {
    const controller = new AbortController(), c = await component(2); let calls = 0;
    if (phase === 'deliver') { const original = c.effects.deliver; c.effects.deliver = async s => { const result = await original(s); controller.abort(); return result; }; }
    if (phase === 'live') { const original = c.effects.live; c.effects.live = async id => { const result = await original(id); controller.abort(); return result; }; }
    if (phase === 'failure' || phase === 'drain') { const original = c.effects.end; c.effects.end = async command => { await original(command); calls++; if (calls === (phase === 'failure' ? 1 : 2)) controller.abort(); }; }
    const r = await runCapacityOwner(c.plan, c.effects, { signal: controller.signal }); assert.equal(r.success, false, phase); assert.equal(c.closed(), 1);
    if (phase === 'failure') assert.equal(c.calls.some(n => n.endsWith(':removed')), false);
  }
});
test('per-step mock-clock deadline cancels a never-settling delivery before owner budget', async t => {
  const { runCapacityOwner } = await entry(); t.mock.timers.enable({ apis: ['setTimeout'] }); const c = await component(1); c.effects.deliver = () => new Promise(() => {});
  const pending = runCapacityOwner(c.plan, c.effects); for (let i = 0; i < 10; i++) await Promise.resolve(); t.mock.timers.tick(25001); const result = await pending; assert.equal(result.success, false); assert.equal(c.closed(), 1); assert.equal(c.calls.some(n => n.startsWith('live:')), false);
});
test('inventory refusal uses accepted bounded redaction and remains sticky in parent final proof', async () => {
  const h = await helpers(), ingress = await import(path.join(import.meta.dirname, 'ingress-run.mjs')), processes = await import(path.join(import.meta.dirname, 'process-evidence.mjs')), plan = await makePlan(1), evidence = processes.createProcessEvidence(); let owners = 0;
  const refusal = { stdout: '', stderr: 'ps: Operation not permitted\nBearer secret-token', exit: 1, signal: null, durationMs: 3 };
  const result = await h.runCapacityCampaign(plan, { async prepare() { ingress.observeIngressInventory(evidence, { result: refusal, rootPid: 100, owner: 'preflight', stage: 'preflight', baseline: true }); }, async runOwner() { owners++; }, async cleanup() { return ingress.ingressProcessProof(evidence, undefined, () => 'absent'); } });
  assert.equal(result.success, false); assert.equal(owners, 0); assert.equal(JSON.stringify(result).includes('secret-token'), false); assert.equal(result.processProof.inventory.outcomes[0].diagnostic, 'ps: Operation not permitted');
});
test('parent freezes failed first cleanup boundary and never postclose reads before confirmed owner descendants', async () => {
  const { runCapacityCampaign } = await helpers();
  for (const kind of ['owner', 'force', 'pipe', 'exit', 'label', 'state']) { const c = await component(1), calls: string[] = [];
    const effects = { async prepare() { calls.push('prepare'); }, async runOwner() { calls.push('owner'); return { success: true, label: kind === 'label' ? 'component-facts' : 'attempted-application', root: c.plan.root, databasePath: c.plan.databasePath, state: { identity: 'a' }, ownerProcessProof: { cleanupConfirmed: kind !== 'owner' }, child: { closeObserved: true, exitObserved: kind !== 'exit', code: 0, signal: null, stdioSettled: kind !== 'pipe', forced: kind === 'force' } }; },
      async postclose() { calls.push('postclose'); return { identity: kind === 'state' ? 'b' : 'a' }; }, async cleanup() { calls.push('cleanup'); return { cleanupConfirmed: true }; } };
    const r = await runCapacityCampaign(c.plan, effects, { label: 'attempted-application' }); assert.equal(r.success, false, kind); if (kind !== 'state') assert.equal(calls.includes('postclose'), false); assert.equal(calls.filter(n => n === 'owner').length, 1);
  }
});
test('same parent accepts a labeled component owner only after cleanup then matching readonly projection', async () => {
  const { runCapacityOwner } = await entry(), h = await helpers(), c = await component(2), owner = await runCapacityOwner(c.plan, c.effects), calls: string[] = [];
  const result = await h.runCapacityCampaign(c.plan, { async prepare() { calls.push('prepare'); }, async runOwner() { calls.push('owner'); return { ...owner, ownerProcessProof: { cleanupConfirmed: true }, child: { closeObserved: true, exitObserved: true, code: 0, signal: null, stdioSettled: true, forced: false } }; }, async postclose() { calls.push('postclose'); return structuredClone(owner.state); }, async cleanup() { calls.push('cleanup'); return { cleanupConfirmed: true }; } });
  assert.equal(result.success, true); assert.equal(result.label, 'component-facts'); assert.deepEqual(calls, ['prepare', 'owner', 'postclose', 'cleanup']);
});

test('repair pipe errors in the actual parent adapter stay nonthrowing, sticky and redacted through cleanup', async () => {
  const h = await helpers(), source = readFileSync(path.join(import.meta.dirname, 'capacity-run.mjs'), 'utf8');
  const body = source.slice(source.indexOf('    async runOwner(ownerPlan, signal) {'), source.indexOf('    async postclose()'));
  const observations = [];
  // Execute the actual method with exclusively in-memory handles; no spawn,
  // executable, inventory command, application or listener is used here.
  for (const pipe of ['stdout', 'stderr'] as const) for (const phase of ['running', 'cleanup', 'owner-close']) {
    const out = mkdtempSync('/private/tmp/capacity-pipe-repair-'); chmodSync(out, 0o700);
    const kills: string[] = [], fake = Object.assign(new EventEmitter(), { pid: 900001, stdout: new PassThrough(), stderr: new PassThrough(), kill: (name: string) => { kills.push(name); return true; } });
    let ticks = 0, escaped = false, listeners = 0;
    const emitFailure = () => { listeners = fake[pipe].listenerCount('error'); try { fake[pipe].emit('error', new Error('synthetic-secret-read-error')); } catch { escaped = true; } };
    const inventory = (_pid: number, _owner: string, stage: string) => { if (stage === 'owner-close' && phase === 'owner-close') emitFailure(); };
    const delay = async () => {
      ticks++;
      if (ticks === 1 && phase !== 'owner-close') { if (phase === 'cleanup') fake.emit('error', new Error('synthetic-secret-child-error')); else emitFailure(); return; }
      if (phase === 'cleanup') emitFailure();
      fake.stdout.destroy(); fake.stderr.destroy(); fake.emit('exit', 0, null); fake.emit('close');
    };
    try {
      writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ success: true, activity: { runtimePids: [], bridges: [] } }), { mode: 0o600 });
      const effects = new globalThis.Function('inventory', 'process', 'path', 'options', 'writeFileSync', 'spawn', 'stageApi', 'staged', 'evidence', 'delay', 'Buffer', 'capacityPrivateJson', 'ingressProcessProof',
        'let child, cleanupDeadline; return {' + body + '};')(inventory, process, path, { out }, writeFileSync, () => fake, { NODE24: '/synthetic/no-executable' }, { root: out, directories: { app: out } }, { children: [], observed: [], inventory: { outcomes: [] } }, delay, Buffer, h.capacityPrivateJson, () => ({ cleanupConfirmed: true }));
      const result = await effects.runOwner({}, undefined);
      observations.push({ pipe, phase, escaped, handled: listeners > 0, success: result.success, term: phase === 'owner-close' || kills.includes('SIGTERM'), settled: result.child.stdioSettled, redacted: !JSON.stringify(result).includes('synthetic-secret') });
    } finally { fake.stdout.destroy(); fake.stderr.destroy(); rmSync(out, { recursive: true, force: true }); }
  }
  assert.deepEqual(observations, observations.map(({ pipe, phase }) => ({ pipe, phase, escaped: false, handled: true, success: false, term: true, settled: true, redacted: true })));
});

test('repair queued admission and event projections survive drain and the matching postclose read', async () => {
  const { runCapacityOwner } = await entry(), h = await helpers();
  for (const kind of ['blocked', 'event', 'count', 'work']) {
    const c = await component(2, (name, value) => {
      const f = value as { state: { recordings: unknown[]; invites: ObjectFact[]; events: ObjectFact[]; leases: ObjectFact[] } };
      if (name !== 'snapshot' || !f.state.recordings.length) return;
      if (kind === 'blocked') Object.assign(f.state.invites.at(-1)!, { state: 'metadata_blocked', organizerId: null, organizerName: null, organizerSource: null, reference: null, admittedAtMs: null });
      if (kind === 'event') f.state.events.at(-1)!.acceptedAtMs = 999;
      if (kind === 'count') { f.state.invites.push(structuredClone(f.state.invites.at(-1)!)); f.state.events.push(structuredClone(f.state.events.at(-1)!)); }
      if (kind === 'work') f.state.leases.push({ occurrenceId: f.state.invites.at(-1)!.occurrenceId });
    });
    const owner = await runCapacityOwner(c.plan, c.effects);
    assert.equal(c.calls.filter(call => call === 'discover').length, 5, kind); assert.ok(c.calls.some(call => call.endsWith(':removed')), kind);
    const campaign = await h.runCapacityCampaign(c.plan, { async prepare() {}, async runOwner() { return { ...owner, ownerProcessProof: { cleanupConfirmed: true }, child: { exitObserved: true, closeObserved: true, code: 0, signal: null, forced: false, stdioSettled: true } }; }, async postclose() { return structuredClone(owner.state); }, async cleanup() { return { cleanupConfirmed: true }; } });
    assert.equal(campaign.success, false, kind);
  }
  const c = await component(2), owner = await runCapacityOwner(c.plan, c.effects);
  const result = await h.runCapacityCampaign(c.plan, { async prepare() {}, async runOwner() { return { ...owner, ownerProcessProof: { cleanupConfirmed: true }, child: { exitObserved: true, closeObserved: true, code: 0, signal: null, forced: false, stdioSettled: true } }; }, async postclose() { const state = structuredClone(owner.state); Object.assign(state.invites.at(-1), { state: 'metadata_blocked', organizerId: null, organizerName: null, organizerSource: null, reference: null, admittedAtMs: null }); return state; }, async cleanup() { return { cleanupConfirmed: true }; } });
  assert.equal(result.success, false);
});

test('repair custody requires actual healthy departure and null missing-victim outcome', async () => {
  const { runCapacityOwner } = await entry();
  for (const [index, key, replacement] of [[1, 'outcome', null], [1, 'reason', null], [1, 'outcome', 'departure_failed'], [1, 'reason', 'operator_clear'], [1, 'clearOperator', 'invented-clear'], [0, 'outcome', 'departure_confirmed'], [0, 'reason', 'departure_observed']] as const) {
    const c = await component(2, (name, value) => {
      const f = value as { state: { recordings: unknown[]; failedRecordings: unknown[] } };
      if (name === 'snapshot' && (index === 0 ? f.state.failedRecordings.length : f.state.recordings.length)) change(f, ['state', 'custody', index, key], replacement);
    });
    assert.equal((await runCapacityOwner(c.plan, c.effects)).success, false, index + ':' + key + ':' + replacement);
  }
});

function captureProgress(fact: unknown, index: number, frames: number, epoch: string, sequence: string, sample: string) {
  const f = fact as { state: { recordings: ObjectFact[] }; activity: { bridges: ObjectFact[] } }, bridge = f.activity.bridges[index]!;
  const position = { captureEpoch: epoch, sequence, outputEndSample: sample }, boundary = { captureEpoch: epoch, lastFrameSequence: sequence, outputEndSample: sample, finalClockPairSequence: '2' };
  bridge.framesSent = frames; bridge.capturePosition = position;
  if (bridge.captureFinish) { Object.assign(bridge.captureFinish, { capturePosition: position, requestedBoundary: boundary, acknowledgedBoundary: structuredClone(boundary) }); Object.assign(bridge.captureDrain as ObjectFact, { boundary }); Object.assign(f.state.recordings[0]!, boundary); }
}
test('repair capture rejects coherent zero and integer/epoch regressions below retained live progress', async () => {
  const { runCapacityOwner } = await entry();
  for (const kind of ['zero', 'fractional', 'epoch', 'noncanonical', 'overflow', 'rounded-sequence', 'rounded-sample']) {
    const c = await component(2, (name, value) => {
      const f = value as { state: { recordings: unknown[] }; activity: { bridges: unknown[] } };
      if (f.activity?.bridges.length !== 2) return;
      if (kind === 'rounded-sequence' || kind === 'rounded-sample') captureProgress(f, 1, 1, '1', kind === 'rounded-sequence' ? '9007199254740993' : '1', kind === 'rounded-sample' ? '9007199254740993' : '480');
      if (name !== 'snapshot' || !f.state.recordings.length) return;
      const values: Record<string, [number, string, string, string]> = { zero: [0, '1', '0', '0'], fractional: [1.5, '1', '1', '480'], epoch: [1, '2', '1', '480'], noncanonical: [1, '1', '01', '480'], overflow: [1, '1', '18446744073709551616', '480'], 'rounded-sequence': [1, '1', '9007199254740992', '480'], 'rounded-sample': [1, '1', '1', '9007199254740992'] };
      captureProgress(f, 1, ...values[kind]!);
    });
    assert.equal((await runCapacityOwner(c.plan, c.effects)).success, false, kind); assert.ok(c.calls.some(call => call.endsWith(':removed')), kind);
  }
});
test('repair capture accepts advancing raw ACK drain and persisted boundaries', async () => {
  const { runCapacityOwner } = await entry(), c = await component(2, (name, value) => { const f = value as { state: { recordings: unknown[] } }; if (name === 'snapshot' && f.state.recordings.length) captureProgress(f, 1, 2, '1', '2', '960'); });
  const result = await runCapacityOwner(c.plan, c.effects); assert.equal(result.success, true, JSON.stringify(result.failures)); assert.equal(result.activity.bridges[1].capturePosition.outputEndSample, '960');
});

test('v3 accepted isolation progress five cannot roll back to a coherent stop at two', async () => {
  const { runCapacityOwner } = await entry(); let snapshots = 0;
  const c = await component(2, (name, value) => { if (name !== 'snapshot') return; snapshots++; const frames = snapshots === 3 ? 5 : snapshots === 4 ? 2 : 1; captureProgress(value, 1, frames, '1', String(frames), String(frames * 480)); });
  const result = await runCapacityOwner(c.plan, c.effects); assert.equal(snapshots, 4); assert.ok(c.calls.some(call => call.endsWith(':removed'))); assert.equal(result.success, false); assert.ok(result.failures.includes('capacity_capture_regressed'));
});
test('v3 accepted first queue progress five cannot roll back in the repeated queue snapshot', async () => {
  const { runCapacityOwner } = await entry(); let snapshots = 0;
  const c = await component(2, (name, value) => { if (name !== 'snapshot') return; snapshots++; const frames = snapshots === 1 ? 5 : 2; captureProgress(value, 1, frames, '1', String(frames), String(frames * 480)); });
  const result = await runCapacityOwner(c.plan, c.effects); assert.equal(result.success, false); assert.ok(result.failures.includes('capacity_capture_regressed')); assert.equal(snapshots, 2); assert.equal(c.calls.some(call => call.startsWith('end:')), false);
});
test('v3 capture watermark accepts one to five to six without changing observation fields', async () => {
  const { runCapacityOwner } = await entry(); let snapshots = 0;
  const c = await component(2, (name, value) => { if (name !== 'snapshot') return; snapshots++; const frames = snapshots === 4 ? 6 : 5; captureProgress(value, 1, frames, '1', String(frames), String(frames * 480)); });
  const result = await runCapacityOwner(c.plan, c.effects); assert.equal(result.success, true, JSON.stringify(result.failures)); assert.equal(result.activity.bridges[1].framesSent, 6); assert.equal(result.activity.bridges[1].capturePosition.sequence, '6'); assert.equal(result.activity.bridges[1].capturePosition.outputEndSample, '2880');
});
test('v3 actual raw snapshot retains intermediate poll progress even before target readiness', async () => {
  const h = await helpers(), ingress = await import(path.join(import.meta.dirname, 'ingress-run.mjs'));
  const staged = privateStage();
  try {
    const plan = await makePlan(2, staged); h.materializeCapacityConfiguration(plan); const c = await component(2);
    for (const send of c.plan.sends.slice(0, 2)) { await c.effects.deliver(send); await c.effects.discover(); }
    const projected = JSON.parse(JSON.stringify(c.fact()).replaceAll(c.plan.root, plan.root));
    for (const [i, bridge] of projected.activity.bridges.entries()) {
      const dir = path.join(plan.root, 'generated-' + i); mkdirSync(dir, { mode: 0o700 }); bridge.configPath = path.join(dir, 'config.json');
      writeFileSync(bridge.configPath, JSON.stringify({ ...plan.slots[i].staticConfig, schema: 'feishu-bridge-config/v3', custody: bridge.binding }), { mode: 0o600 });
    }
    const persist = () => { for (const [i, bridge] of projected.activity.bridges.entries()) writeFileSync(plan.slots[i].statePath, JSON.stringify(bridge), { mode: 0o600 }); writeFileSync(plan.runtimePidsPath, projected.activity.runtimePids.join('\n'), { mode: 0o600 }); };
    const source = readFileSync(path.join(import.meta.dirname, 'capacity-entry.mjs'), 'utf8'), body = source.slice(source.indexOf('  function recordingFile(row) {'), source.indexOf('  const effects = {'));
    const snapshot = new globalThis.Function('noCapacitySymlinks', 'requireCapacity', 'openSync', 'constants', 'fstatSync', 'process', 'createHash', 'readSync', 'closeSync', 'read', 'outcomes', 'ingressPathExists', 'capacityPrivateBytes', 'capacityPrivateJson', 'plan', 'observed', 'copy', 'trace', 'peer', 'receiver', 'readdirSync', 'observeCapture', body + ';return snapshot;')(
      h.noCapacitySymlinks, h.requireCapacity, fs.openSync, fs.constants, fs.fstatSync, { getuid: process.getuid, hrtime: process.hrtime, env: { PATH: '/synthetic' } }, createHash, fs.readSync, fs.closeSync, () => structuredClone(projected.state), () => structuredClone(projected.activity.outcomes), ingress.ingressPathExists, h.capacityPrivateBytes, h.capacityPrivateJson, plan, new Map(), structuredClone, projected.activity.trace, { requests: [], messages: [] }, () => structuredClone(projected.activity.receiver), fs.readdirSync, h.createCapacityCaptureObserver?.(plan) ?? (() => {}));
    // Explicitly synthetic projections; real owned regular files and the actual
    // adapter read them. Target bridge is not ready, as in a live polling pass.
    projected.activity.bridges[0].joined = false; captureProgress(projected, 1, 5, '1', '5', '2400'); persist(); const first = snapshot();
    assert.equal(first.activity.bridges[0].joined, false); assert.equal(first.activity.bridges[1].framesSent, 5);
    captureProgress(projected, 1, 6, '1', '6', '2880'); persist(); assert.equal(snapshot().activity.bridges[1].framesSent, 6);
    captureProgress(projected, 1, 2, '1', '2', '960'); persist(); assert.throws(() => snapshot(), /capacity_capture_regressed/);
  } finally { rmSync(staged.root, { recursive: true, force: true }); }
});

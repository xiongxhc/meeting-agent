// Private capacity campaign. Imports have no application effects.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import Database from 'better-sqlite3';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { inviteEnvelope, SCOPE } from './feishu-peer.mjs';
import { createFeishuReservationRegistry } from './feishu-reservation-registry.mjs';
import { ingressPathExists, assertIngressReceiver, observeIngressInventory, ingressProcessProof } from './ingress-run.mjs';
export function requireCapacity(value, reason) { if (!value) throw new Error(`capacity_${reason}`); }
const copy = value => globalThis.structuredClone(value);
const canonical = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && value !== '/' && [...value].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
const within = (child, root) => canonical(child) && canonical(root) && child.startsWith(`${root}/`);
function freeze(value) { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); }
export function noCapacitySymlinks(filename) {
  requireCapacity(canonical(filename), 'path'); let current = path.parse(filename).root;
  for (const part of filename.slice(current.length).split('/')) { current = path.join(current, part); requireCapacity(!lstatSync(current).isSymbolicLink(), 'symlink_path'); }
}
export function capacityPrivateBytes(filename, { max = 1048576, mode } = {}) {
  noCapacitySymlinks(filename); const parent = lstatSync(path.dirname(filename));
  requireCapacity(parent.isDirectory() && parent.uid === process.getuid() && (parent.mode & 0o077) === 0, 'private_parent');
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const s = fstatSync(fd); requireCapacity(s.isFile() && s.uid === process.getuid() && s.nlink === 1 && (s.mode & 0o022) === 0 && (mode === undefined || (s.mode & 0o777) === mode) && s.size <= max, 'private_file');
    const bytes = readFileSync(fd); requireCapacity(bytes.length <= max, 'file_extent'); return bytes;
  } finally { closeSync(fd); }
}
export const capacityPrivateJson = filename => JSON.parse(capacityPrivateBytes(filename).toString('utf8'));
export function parseCapacityArguments(argv) {
  let count, out;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--count' && count === undefined && /^(1|2|4|8)$/.test(argv[i + 1] ?? '')) count = Number(argv[++i]);
    else if (argv[i] === '--out' && out === undefined) { out = argv[++i]; requireCapacity(canonical(out) && !ingressPathExists(out), 'output_path'); }
    else throw new Error('capacity_argument');
  }
  requireCapacity(count !== undefined && out !== undefined, 'arguments_required'); return { count, out };
}
export function validateCapacityPlan(plan) {
  requireCapacity([1, 2, 4, 8].includes(plan.count) && plan.slots.length === plan.count && plan.sends.length === plan.count + 1 && plan.reservations.length === plan.count + 1, 'count');
  requireCapacity(canonical(plan.root) && plan.standaloneConfigPath === path.join(plan.directories.configDir, 'standalone.json') && Object.values(plan.directories).every(dir => within(dir, plan.root)) &&
    within(plan.runtimePidsPath, plan.root) && within(plan.keyPath, plan.root) && plan.databasePath === path.join(plan.directories.stateRoot, 'orchestration.db') &&
    plan.standaloneConfig.stateRoot === plan.directories.stateRoot && plan.standaloneConfig.runtime.gatewayConfigPath === plan.gatewayConfigPath && within(plan.gatewayConfigPath, plan.root) &&
    within(plan.standaloneConfig.runtime.launcherPath, plan.root) && within(plan.standaloneConfig.feishu.appSecretFile, plan.directories.configDir) &&
    Object.keys(plan.standaloneConfig.dataPaths).length === 4 && Object.entries(plan.standaloneConfig.dataPaths).every(([k, v]) => v === plan.directories[k]), 'plan_paths');
  createFeishuReservationRegistry({ reservations: plan.reservations });
  const unique = values => requireCapacity(new Set(values).size === values.length, 'identity_collision');
  unique(plan.reservations.map(r => r.reserveId)); unique(plan.reservations.map(r => r.organizer.openId));
  for (const field of ['providerMeetingId', 'meetingNo']) unique(plan.reservations.map(r => r.meeting[field]));
  for (const field of ['wireMessageId', 'eventId', 'occurrenceId']) unique(plan.sends.map(s => s[field]));
  const paths = [];
  for (const [index, slot] of plan.slots.entries()) {
    const i = index + 1, dir = path.join(plan.directories.control, `capacity-slot-${i}`), filename = path.join(plan.directories.configDir, `capacity-slot-${i}.json`);
    requireCapacity(slot.physicalClientId === `capacity-physical-${i}` && slot.bridgeId === `capacity-bridge-${i}` && slot.controlDir === dir && slot.staticConfigPath === filename && slot.statePath === path.join(dir, 'state.json') && slot.endPath === path.join(dir, 'end'), 'slot_paths');
    const c = slot.staticConfig;
    requireCapacity(c.schema === 'feishu-bridge-config/v1' && c.bundleVersion === 'e2e-scripted' && c.controlDir === dir && c.captureFrameLimit === 51 && !Object.hasOwn(c, 'custody') && !Object.hasOwn(c, 'observationPlan'), 'slot_static');
    assert.deepEqual(c.participants, [{ feishuUserId: `ou_capacity_attendee_${i}`, displayName: `Capacity Attendee ${i}` }]);
    if (i === 1) assert.deepEqual(c.physicalOutcomeScenario, { schema: 'e2e-bridge-physical-outcome/v1', mode: 'missing' });
    else requireCapacity(!Object.hasOwn(c, 'physicalOutcomeScenario'), 'slot_scenario');
    paths.push(slot.controlDir, slot.staticConfigPath, slot.statePath, slot.endPath);
    const configured = plan.standaloneConfig.bridgeSlots[index];
    requireCapacity(configured?.staticConfigPath === filename && configured.physicalClientId === slot.physicalClientId && configured.bridgeId === slot.bridgeId && configured.cooperativeGraceMs === 5000 && configured.argv.length === 1 && configured.argv[0] === path.join(plan.directories.app, 'e2e/fixtures/e2e-bridge-child.mjs') && canonical(configured.executable), 'slot_config');
  }
  unique(paths); requireCapacity(plan.standaloneConfig.bridgeSlots.length === plan.count, 'slot_count');
  for (const [i, send] of plan.sends.entries()) {
    const r = plan.reservations[i], id = send.immutableExpected;
    requireCapacity(r.reserveId === `reserve-capacity-${i + 1}` && r.meeting.providerMeetingId === `meeting-capacity-${i + 1}` && r.meeting.meetingNo === String(100000001 + i) && r.organizer.openId === `ou_capacity_${i + 1}` &&
      r.meeting.startSeconds === plan.reservations[0].meeting.startSeconds + i && send.eventId === `capacity-invite-${i + 1}` && send.wireMessageId === `capacity-wire-${i + 1}` && id.occurrenceId === send.occurrenceId && id.providerMeetingId === r.meeting.providerMeetingId && id.meetingNo === r.meeting.meetingNo && id.title === r.meeting.title && send.startSeconds === String(r.meeting.startSeconds) && /^[a-f0-9]{64}$/.test(send.hash), 'send_identity');
    assert.deepEqual(send.envelope, inviteEnvelope({ ...r.meeting, eventId: send.eventId, inviteSeconds: Number(send.inviteSeconds), createTimeMs: Number(send.createTime) }));
  }
  assert.deepEqual(plan.organizerReferences, plan.reservations.map(r => ({ ...SCOPE, meetingNo: r.meeting.meetingNo, reference: { kind: 'reservation', reserveId: r.reserveId } })));
  requireCapacity(Buffer.byteLength(JSON.stringify(plan)) <= 1048576, 'plan_extent');
}
export function buildCapacityConfiguration({ staged, count, startSeconds, normalizeInvite, parseStandaloneConfig }) {
  requireCapacity([1, 2, 4, 8].includes(count) && Number.isInteger(startSeconds) && startSeconds >= 0 && startSeconds <= 253402300790, 'count_start');
  const baseline = copy(staged.bridgeStaticConfig), standaloneConfig = copy(staged.standaloneConfig);
  requireCapacity(baseline.schema === 'feishu-bridge-config/v1' && baseline.bundleVersion === 'e2e-scripted' && baseline.captureFrameLimit === 51 && !['custody', 'observationPlan', 'physicalOutcomeScenario'].some(k => Object.hasOwn(baseline, k)) && standaloneConfig.bridgeSlots.length === 1, 'baseline');
  const reservations = Array.from({ length: count + 1 }, (_, index) => { const i = index + 1;
    return { reserveId: `reserve-capacity-${i}`, meeting: { providerMeetingId: `meeting-capacity-${i}`, meetingNo: String(100000000 + i), startSeconds: startSeconds + i, title: `Capacity Meeting ${i}` }, organizer: { openId: `ou_capacity_${i}`, displayName: `Capacity Organizer ${i}` } }; });
  createFeishuReservationRegistry({ reservations });
  const sends = reservations.map((r, index) => {
    const envelope = inviteEnvelope({ ...r.meeting, eventId: `capacity-invite-${index + 1}`, inviteSeconds: startSeconds, createTimeMs: startSeconds * 1000 + index }), n = normalizeInvite(envelope, SCOPE);
    return { envelope, wireMessageId: `capacity-wire-${index + 1}`, occurrenceId: n.occurrenceId, eventId: n.eventId, hash: n.normalizedSha256, title: n.title, createTime: n.createTime, inviteSeconds: n.inviteSeconds, startSeconds: n.startSeconds,
      immutableExpected: Object.fromEntries(['occurrenceId', 'region', 'tenantKey', 'appId', 'providerMeetingId', 'meetingNo', 'occurrenceStartedAt', 'title'].map(k => [k, n[k]])) }; });
  const slots = Array.from({ length: count }, (_, index) => { const i = index + 1, controlDir = path.join(staged.directories.control, `capacity-slot-${i}`);
    const staticConfig = { ...copy(baseline), controlDir, participants: [{ feishuUserId: `ou_capacity_attendee_${i}`, displayName: `Capacity Attendee ${i}` }] };
    if (i === 1) staticConfig.physicalOutcomeScenario = { schema: 'e2e-bridge-physical-outcome/v1', mode: 'missing' };
    return { physicalClientId: `capacity-physical-${i}`, bridgeId: `capacity-bridge-${i}`, staticConfigPath: path.join(staged.directories.configDir, `capacity-slot-${i}.json`), controlDir, statePath: path.join(controlDir, 'state.json'), endPath: path.join(controlDir, 'end'), staticConfig }; });
  const old = standaloneConfig.bridgeSlots[0];
  standaloneConfig.bridgeSlots = slots.map(slot => ({ ...copy(old), physicalClientId: slot.physicalClientId, bridgeId: slot.bridgeId, staticConfigPath: slot.staticConfigPath }));
  parseStandaloneConfig(Buffer.from(JSON.stringify(standaloneConfig)));
  const plan = { root: staged.root, count, directories: copy(staged.directories), standaloneConfig, standaloneConfigPath: staged.standaloneConfigPath, gatewayConfigPath: staged.gatewayConfigPath, runtimePidsPath: staged.gatewayPidsPath, keyPath: staged.keyPath,
    databasePath: path.join(staged.directories.stateRoot, 'orchestration.db'), slots, reservations, sends, organizerReferences: reservations.map(r => ({ ...SCOPE, meetingNo: r.meeting.meetingNo, reference: { kind: 'reservation', reserveId: r.reserveId } })) };
  validateCapacityPlan(plan); return freeze(plan);
}
export function materializeCapacityConfiguration(plan) {
  validateCapacityPlan(plan);
  for (const dir of [plan.root, plan.directories.configDir, plan.directories.control]) { noCapacitySymlinks(dir); const s = lstatSync(dir); requireCapacity(s.isDirectory() && s.uid === process.getuid() && (s.mode & 0o777) === 0o700, 'private_directory'); }
  capacityPrivateBytes(plan.standaloneConfigPath); requireCapacity(readdirSync(plan.directories.control).length === 0, 'control_residue');
  const temporary = `${plan.standaloneConfigPath}.capacity-new`;
  requireCapacity(!ingressPathExists(temporary) && plan.slots.every(s => !ingressPathExists(s.controlDir) && !ingressPathExists(s.staticConfigPath)), 'preexisting_slot');
  for (const slot of plan.slots) { mkdirSync(slot.controlDir, { mode: 0o700 }); writeFileSync(slot.staticConfigPath, JSON.stringify(slot.staticConfig), { mode: 0o600, flag: 'wx' }); }
  writeFileSync(temporary, JSON.stringify(plan.standaloneConfig), { mode: 0o600, flag: 'wx' }); renameSync(temporary, plan.standaloneConfigPath);
}

// Explicit selected columns: never return claim tokens, authorization or text.
const projections = {
  invites: ['feishu_invite_occurrences', 'occurrence_id AS occurrenceId,region,tenant_key AS tenantKey,app_id AS appId,provider_meeting_id AS providerMeetingId,meeting_no AS meetingNo,occurrence_started_at AS occurrenceStartedAt,title,accepted_at_ms AS acceptedAtMs,state,organizer_open_id AS organizerId,organizer_display_name AS organizerName,organizer_source AS organizerSource,reference_json AS reference,admitted_at_ms AS admittedAtMs,claim_token IS NOT NULL AS claimed'],
  events: ['feishu_invite_events', 'occurrence_id AS occurrenceId,event_id AS eventId,normalized_sha256 AS hash,topic AS title,create_time AS createTime,invite_seconds AS inviteSeconds,start_seconds AS startSeconds,accepted_at_ms AS acceptedAtMs'],
  sessions: ['sessions', 'occurrence_id AS occurrenceId,provider_meeting_id AS providerMeetingId,occurrence_started_at AS occurrenceStartedAt,state,terminal_reason AS terminalReason'],
  leases: ['bridge_leases', 'occurrence_id AS occurrenceId,lease_id AS leaseId,bridge_id AS bridgeId,bridge_session_id AS bridgeSessionId,acquired_at_ms AS acquiredAtMs,expires_at_ms AS expiresAtMs,released_at_ms AS releasedAtMs,release_reason AS releaseReason'],
  custody: ['physical_client_custody', "occurrence_id AS occurrenceId,physical_client_id AS physicalClientId,physical_generation_id AS physicalGenerationId,bridge_session_id AS bridgeSessionId,state,claimed_at_ms AS claimedAtMs,outcome_failure AS failure,outcome_recorded_at_ms AS recordedAtMs,cleared_at_ms AS clearedAtMs,clear_reason AS clearReason,clear_operator AS clearOperator,json_extract(outcome_json,'$.outcome') AS outcome,json_extract(outcome_json,'$.reason') AS reason"],
  generations: ['reconciliation_generations', 'occurrence_id AS occurrenceId,generation_id AS generationId,bridge_session_id AS bridgeSessionId,runtime_session_id AS controlSessionId,recording_handle AS handle,terminal_at_ms AS terminalAtMs,terminal_source AS terminalSource,terminal_reason AS terminalReason,expires_at_ms AS expiresAtMs'],
  recoveries: ['bridge_recoveries', 'occurrence_id AS occurrenceId,failure_count AS failureCount,last_failed_at_ms AS lastFailedAtMs'],
  recordings: ['recordings', 'occurrence_id AS occurrenceId,handle,encrypted_path AS encryptedPath,sha256,key_id AS keyId,duration_ms AS durationMs,finalized_at_ms AS finalizedAtMs,capture_drain AS captureDrain,capture_drain_reason AS captureDrainReason,capture_drain_epoch AS captureEpoch,capture_drain_last_frame_sequence AS lastFrameSequence,capture_drain_output_end_sample AS outputEndSample,capture_drain_final_pair_sequence AS finalClockPairSequence'],
  failedRecordings: ['bridge_failure_recordings', 'occurrence_id AS occurrenceId,attempt,handle,encrypted_path AS encryptedPath,sha256,key_id AS keyId,duration_ms AS durationMs,finalized_at_ms AS finalizedAtMs'],
  bindings: ['recording_recovery_bindings', 'occurrence_id AS occurrenceId,generation_id AS generationId,bridge_session_id AS bridgeSessionId,source_session_id AS controlSessionId,recording_handle AS handle,sha256,key_id AS keyId,recording_kind AS sourceKind,failure_attempt AS attempt'],
  unknown: ['unknown_end_custody', 'occurrence_id AS occurrenceId,source_kind AS sourceKind,failure_attempt AS attempt,recording_handle AS handle,recording_path AS encryptedPath,recording_sha256 AS sha256,recording_key_id AS keyId,recording_bytes AS bytes,recording_device AS device,recording_inode AS inode,unknown_end_detected_at_ms AS detectedAtMs,unknown_end_deadline_ms AS deadlineMs,state,cleanup_claim_token IS NOT NULL AS claimed,cleanup_failure_reason AS failure,deleted_at_ms AS deletedAtMs'],
};
const zeroTables = ['backfill_seeds', 'backfill_jobs', 'backfill_warning_intents', 'recording_alignment_attempts', 'recording_alignment_pages', 'recording_alignment_selected', 'delivery_journal', 'delivery_recording_owners', 'notification_intents'];
export function readCapacityState({ databasePath, occurrenceIds }) {
  requireCapacity(canonical(databasePath) && Array.isArray(occurrenceIds) && occurrenceIds.length >= 1 && occurrenceIds.length <= 9 && new Set(occurrenceIds).size === occurrenceIds.length && occurrenceIds.every(id => typeof id === 'string' && id.length > 0 && Buffer.byteLength(id) <= 4096), 'reader_arguments');
  noCapacitySymlinks(databasePath); const parent = lstatSync(path.dirname(databasePath)), file = lstatSync(databasePath);
  requireCapacity(parent.isDirectory() && parent.uid === process.getuid() && (parent.mode & 0o077) === 0 && file.isFile() && file.nlink === 1 && file.uid === process.getuid() && (file.mode & 0o022) === 0, 'private_database');
  const sidecars = () => requireCapacity(!ingressPathExists(`${databasePath}-wal`) && !ingressPathExists(`${databasePath}-shm`), 'reader_WAL'); sidecars();
  const fd = openSync(databasePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let db;
  try {
    const held = fstatSync(fd), header = Buffer.alloc(100);
    requireCapacity(held.isFile() && held.dev === file.dev && held.ino === file.ino && readSync(fd, header, 0, 100, 0) === 100 && header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) && header[18] === 1 && header[19] === 1, 'database_header_nonWAL');
    const guard = () => { noCapacitySymlinks(databasePath); const now = lstatSync(databasePath), dir = lstatSync(path.dirname(databasePath));
      requireCapacity(dir.isDirectory() && dir.uid === process.getuid() && (dir.mode & 0o077) === 0 && dir.dev === parent.dev && dir.ino === parent.ino && now.isFile() && now.nlink === 1 && now.uid === held.uid && (now.mode & 0o022) === 0 && now.dev === held.dev && now.ino === held.ino, 'database_identity'); sidecars(); };
    guard(); db = new Database(databasePath, { readonly: true, fileMustExist: true }); guard();
    requireCapacity(db.readonly && db.pragma('journal_mode', { simple: true }) !== 'wal', 'reader_WAL');
    const state = db.transaction(() => {
      requireCapacity(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version === 29, 'schema29_required');
      const state = { fileIdentity: `${parent.dev}:${parent.ino}:${parent.birthtimeMs}:${held.dev}:${held.ino}:${held.birthtimeMs}`, counts: {} }, maximum = Math.min(8, occurrenceIds.length);
      for (const [name, [table, columns]] of Object.entries(projections)) {
        const limit = ['invites', 'events', 'sessions'].includes(name) ? occurrenceIds.length : ['recoveries', 'failedRecordings'].includes(name) ? 1 : maximum;
        const n = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n; requireCapacity(n <= limit, 'reader_extent');
        const rows = db.prepare(`SELECT ${columns} FROM ${table} ORDER BY occurrence_id LIMIT ${limit + 1}`).all();
        requireCapacity(rows.length === n && rows.every(row => occurrenceIds.includes(row.occurrenceId)), 'foreign_occurrence');
        requireCapacity(new Set(rows.map(row => row.occurrenceId)).size === rows.length, 'extra_generation');
        if (name === 'invites') for (const row of rows) row.reference = row.reference === null ? null : JSON.parse(row.reference);
        state[name] = rows;
      }
      requireCapacity(state.recordings.length + state.failedRecordings.length <= maximum, 'recording_extent');
      for (const table of zeroTables) { const n = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n; state.counts[table] = n; requireCapacity(n === 0, 'publication_isolation'); }
      return state;
    })(); guard(); return state;
  } finally { db?.close(); closeSync(fd); }
}
const rowFor = (rows, id) => { const found = rows.filter(r => r.occurrenceId === id); requireCapacity(found.length === 1, 'one_identity'); return found[0]; };
function capturePosition(position) {
  const values = ['captureEpoch', 'sequence', 'outputEndSample'].map(key => {
    const value = position?.[key];
    requireCapacity(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20, 'capture_integer');
    const integer = BigInt(value); requireCapacity(integer <= 18446744073709551615n, 'capture_integer'); return integer;
  });
  requireCapacity(values[0] > 0n, 'capture_epoch'); return values;
}
function captureProgress(before, next) {
  const previous = capturePosition(before.capturePosition), current = capturePosition(next.capturePosition);
  // This campaign retains one connected media client; its epoch is immutable.
  requireCapacity(Number.isSafeInteger(before.framesSent) && Number.isSafeInteger(next.framesSent) && before.framesSent >= 0 && next.framesSent >= before.framesSent && next.framesSent <= 51 && (before.framesSent === 0 || (previous[1] > 0n && previous[2] > 0n)) && current[0] === previous[0] && current[1] >= previous[1] && current[2] >= previous[2], 'capture_regressed');
}
export function createCapacityCaptureObserver(plan) {
  const watermarks = new Map(), ids = plan.sends.slice(0, plan.count).map(send => send.occurrenceId);
  return fact => {
    const bridges = fact.activity.bridges, pending = [];
    requireCapacity(bridges.length <= plan.count && new Set(bridges.map(b => b.occurrenceId)).size === bridges.length, 'capture_extent');
    for (const bridge of bridges) {
      requireCapacity(ids.includes(bridge.occurrenceId) && bridge.binding.occurrenceId === bridge.occurrenceId && Number.isSafeInteger(bridge.framesSent) && bridge.framesSent >= 0 && bridge.framesSent <= 51, 'capture_extent');
      const before = watermarks.get(bridge.occurrenceId);
      if (!bridge.capturePosition) { requireCapacity(!before && bridge.framesSent === 0, 'capture_regressed'); continue; }
      captureProgress(bridge, bridge);
      if (before) { assert.deepEqual(bridge.binding, before.binding); captureProgress(before, bridge); }
      pending.push([bridge.occurrenceId, { binding: copy(bridge.binding), framesSent: bridge.framesSent, capturePosition: copy(bridge.capturePosition) }]);
    }
    // Retain independent observations only after the complete snapshot passes.
    for (const [id, watermark] of pending) watermarks.set(id, watermark);
  };
}
function audit(plan, fact) {
  const s = fact.state, a = fact.activity;
  requireCapacity(s.invites.length === s.events.length && s.invites.every(row => plan.sends.some(send => send.occurrenceId === row.occurrenceId)) && Object.values(s.counts).every(n => n === 0) && a.messages.length === 0 && a.files.outbox === 0 && a.files.receipt === 0 && a.trace.filter(c => c === 'occurrence_launched').length === a.outcomes.length, 'extent_publication');
  for (const invite of s.invites) {
    const i = plan.sends.findIndex(send => send.occurrenceId === invite.occurrenceId), send = plan.sends[i], r = plan.reservations[i], event = rowFor(s.events, invite.occurrenceId);
    requireCapacity(Object.entries(send.immutableExpected).every(([k, v]) => invite[k] === v) && Number.isSafeInteger(invite.acceptedAtMs) && invite.acceptedAtMs >= 0, 'invite_identity');
    requireCapacity(['eventId', 'hash', 'title', 'createTime', 'inviteSeconds', 'startSeconds'].every(k => event[k] === send[k]), 'event_identity');
    if (invite.state === 'admitted') requireCapacity(invite.organizerId === r.organizer.openId && invite.organizerName === r.organizer.displayName && invite.organizerSource === 'reservation' && invite.reference?.kind === 'reservation' && invite.reference.reserveId === r.reserveId && invite.claimed === 0 && Number.isSafeInteger(invite.admittedAtMs), 'organizer_identity');
  }
  requireCapacity(a.runtimePids.length === a.outcomes.length && new Set(a.runtimePids).size === a.runtimePids.length && a.bridges.length === a.outcomes.length && new Set(a.bridges.map(b => b.pid)).size === a.bridges.length && a.runtimePids.every(pid => Number.isSafeInteger(pid) && pid > 0), 'process_extent');
  const forbidden = ['E2E_RUNTIME_RECORDING_KEY', 'E2E_RECORDING_KEY', 'E2E_PROVIDER_CREDENTIAL', 'FEISHU_APP_SECRET', 'RUNTIME_SECRET', 'NODE_OPTIONS'];
  requireCapacity([a.envKeys, ...a.bridges.map(b => b.envKeys)].every(keys => forbidden.every(key => !keys.includes(key))), 'environment');
  assertIngressReceiver(a.receiver, s.events.map(event => plan.sends.find(send => send.eventId === event.eventId).wireMessageId));
}
function activeBinding(plan, fact, id) {
  const s = fact.state, a = fact.activity, session = rowFor(s.sessions, id), invite = rowFor(s.invites, id), lease = rowFor(s.leases, id), g = rowFor(s.generations, id), c = rowFor(s.custody, id), b = rowFor(a.bridges, id), outcome = rowFor(a.outcomes, id);
  const slot = plan.slots.find(slot => slot.physicalClientId === b.binding.physicalClientId);
  requireCapacity(invite.state === 'admitted' && session.providerMeetingId === invite.providerMeetingId && session.occurrenceStartedAt === invite.occurrenceStartedAt && session.state === 'listening' && slot && b.bound && b.joined && b.mediaConnected && b.framesSent > 0 && b.framesSent <= 51 && Number.isSafeInteger(b.pid) && b.pid > 0 && canonical(b.configPath) && typeof b.configSha256 === 'string' && typeof b.mediaEndpoint === 'string' && b.mediaEndpoint.length > 0 && b.left === null && b.endObservation === null && b.captureFinish === null && b.binding.occurrenceId === id && b.binding.physicalGenerationId === c.physicalGenerationId && b.binding.bridgeSessionId === c.bridgeSessionId && b.binding.physicalClientId === c.physicalClientId && c.state === 'quarantined' && c.recordedAtMs === null && lease.releasedAtMs === null && lease.bridgeId === slot.bridgeId && lease.bridgeSessionId === b.binding.bridgeSessionId && g.bridgeSessionId === b.binding.bridgeSessionId && g.terminalAtMs === null && outcome.phase === 'live' && outcome.failure === null && outcome.controlSessionId === g.controlSessionId && /^[1-9][0-9]*$/.test(outcome.controlSessionId), 'live_binding');
  requireCapacity(!s.recordings.some(r => r.occurrenceId === id) && !s.failedRecordings.some(r => r.occurrenceId === id) && !s.unknown.some(r => r.occurrenceId === id), 'live_recording');
}
export function assertCapacityUnchanged(baseline, fact, ids) {
  requireCapacity(baseline.state.fileIdentity === fact.state.fileIdentity, 'database_changed');
  for (const id of ids) {
    for (const name of ['invites', 'events', 'sessions', 'leases', 'generations', 'custody']) assert.deepEqual(rowFor(fact.state[name], id), rowFor(baseline.state[name], id));
    assert.deepEqual(rowFor(fact.activity.outcomes, id), rowFor(baseline.activity.outcomes, id));
    const before = rowFor(baseline.activity.bridges, id), next = rowFor(fact.activity.bridges, id);
    for (const k of ['pid', 'configPath', 'configSha256', 'binding', 'mediaEndpoint', 'joined', 'mediaConnected', 'bound', 'envKeys', 'left', 'endObservation', 'captureFinish']) assert.deepEqual(next[k], before[k]);
    captureProgress(before, next);
    requireCapacity(next.commands.length >= before.commands.length && before.commands.every((command, i) => next.commands[i] === command), 'control_regressed');
  }
}
export function assertCapacityLive(plan, fact) {
  audit(plan, fact); const ids = fact.activity.outcomes.map(r => r.occurrenceId);
  requireCapacity(ids.length >= 1 && ids.length <= plan.count && new Set(ids).size === ids.length && ids.every(id => plan.sends.slice(0, plan.count).some(s => s.occurrenceId === id)) && fact.state.sessions.length === ids.length && fact.state.leases.length === ids.length && fact.state.generations.length === ids.length && fact.state.custody.length === ids.length, 'live_count');
  for (const id of ids) { activeBinding(plan, fact, id); const bridge = rowFor(fact.activity.bridges, id); captureProgress(bridge, bridge); }
}
export function assertCapacityDeferred(plan, baseline, fact) {
  audit(plan, fact); const queued = plan.sends.at(-1).occurrenceId, ids = plan.sends.slice(0, plan.count).map(s => s.occurrenceId), s = fact.state;
  requireCapacity(s.invites.length === plan.count + 1 && s.sessions.length === plan.count + 1 && rowFor(s.invites, queued).state === 'admitted' && rowFor(s.sessions, queued).state === 'discovered' && fact.activity.outcomes.length === plan.count && fact.activity.bridges.length === plan.count && fact.activity.runtimePids.length === plan.count && ['leases', 'generations', 'custody', 'recoveries', 'recordings', 'failedRecordings', 'bindings', 'unknown'].every(name => !s[name].some(r => r.occurrenceId === queued)) && !fact.activity.outcomes.some(r => r.occurrenceId === queued) && fact.discovery?.launched === 0 && fact.discovery.deferred >= 1, 'queue_spawn');
  assertCapacityUnchanged(baseline, fact, ids.filter(id => rowFor(fact.activity.outcomes, id).phase === 'live'));
  assert.deepEqual(fact.activity.runtimePids, baseline.activity.runtimePids);
  if (!fact.victim) requireCapacity(fact.activity.outcomes.every(o => o.phase === 'live'), 'premature_settlement');
}
function stoppedSource(plan, fact, id, failure) {
  const s = fact.state, b = rowFor(fact.activity.bridges, id), g = rowFor(s.generations, id), c = rowFor(s.custody, id), o = rowFor(fact.activity.outcomes, id), lease = rowFor(s.leases, id), finish = b.captureFinish;
  const r = rowFor(failure ? s.failedRecordings : s.recordings, id), binding = rowFor(s.bindings, id), unknown = rowFor(s.unknown, id), kind = failure ? 'bridge_failure' : 'final';
  requireCapacity(o.phase === 'settled' && o.runtimeClose === 'closed' && o.runtimeCleanup === 'graceful' && o.finalization === 'recorded' && o.custody === 'assigned' && o.controlSessionId === g.controlSessionId && b.bound && b.binding.occurrenceId === id && b.binding.physicalGenerationId === c.physicalGenerationId && b.binding.bridgeSessionId === g.bridgeSessionId && b.binding.bridgeSessionId === c.bridgeSessionId && b.binding.physicalClientId === c.physicalClientId && b.left === (failure ? 'bridge_failure' : 'removed') && b.endObservation?.reason === b.left && lease.releasedAtMs !== null && lease.releaseReason === (failure ? 'bridge_failure' : 'left') && g.terminalReason === b.left && g.terminalSource === 'bridge_observed' && Number.isSafeInteger(g.terminalAtMs) && g.expiresAtMs === g.terminalAtMs + 1209600000, 'stopped_binding');
  requireCapacity(finish?.authenticated === true && finish.sessionId === o.controlSessionId && finish.bridgeSessionId === b.binding.bridgeSessionId && finish.requestedBoundary && finish.acknowledgedBoundary, 'capture_finish');
  assert.deepEqual(finish.requestedBoundary, finish.acknowledgedBoundary);
  const boundary = finish.requestedBoundary;
  requireCapacity(boundary.captureEpoch === b.capturePosition.captureEpoch && boundary.lastFrameSequence === b.capturePosition.sequence && boundary.outputEndSample === b.capturePosition.outputEndSample && /^[1-9][0-9]*$/.test(boundary.finalClockPairSequence) && b.captureDrain?.drain === 'confirmed', 'capture_boundary');
  assert.deepEqual(finish.capturePosition, b.capturePosition);
  assert.deepEqual(b.captureDrain.boundary, boundary);
  requireCapacity(binding.generationId === g.generationId && binding.controlSessionId === o.controlSessionId && binding.bridgeSessionId === b.binding.bridgeSessionId && binding.sourceKind === kind && binding.attempt === (failure ? 1 : null) && unknown.sourceKind === kind && unknown.attempt === (failure ? 1 : 0) && unknown.state === 'assigned' && unknown.claimed === 0 && unknown.failure === null && unknown.deletedAtMs === null && Number.isSafeInteger(unknown.detectedAtMs) && unknown.deadlineMs === unknown.detectedAtMs + 1209600000 && unknown.bytes > 0, 'unknown_source');
  for (const key of ['handle', 'sha256', 'keyId']) requireCapacity(r[key] === binding[key] && r[key] === unknown[key], 'recording_identity');
  requireCapacity(r.handle === g.handle && r.encryptedPath === unknown.encryptedPath && within(r.encryptedPath, plan.directories.recordingsDir) && b.recordingFile?.sha256 === r.sha256 && b.recordingFile.bytes === unknown.bytes && b.recordingFile.device === unknown.device && b.recordingFile.inode === unknown.inode, 'recording_file');
  if (failure) requireCapacity(c.state === 'quarantined' && c.failure === 'outcome_missing' && c.outcome === null && c.reason === null && Number.isSafeInteger(c.recordedAtMs) && c.clearedAtMs === null && c.clearReason === null && c.clearOperator === null && r.attempt === 1 && rowFor(s.recoveries, id).failureCount === 1, 'missing_quarantine');
  else {
    requireCapacity(c.state === 'cleared' && c.failure === null && c.outcome === 'departure_confirmed' && c.reason === 'departure_observed' && c.clearOperator === null && c.clearReason === 'departure_observed' && Number.isSafeInteger(c.clearedAtMs) && Number.isSafeInteger(c.recordedAtMs), 'departure');
    requireCapacity(r.captureDrain === 'confirmed' && r.captureDrainReason === null && ['captureEpoch', 'lastFrameSequence', 'outputEndSample', 'finalClockPairSequence'].every(k => r[k] === boundary[k]), 'persisted_capture_boundary');
  }
}
export function assertCapacityFailureIsolation(plan, baseline, fact) {
  assertCapacityDeferred(plan, baseline, fact);
  const victim = baseline.activity.bridges.find(b => b.binding.physicalClientId === 'capacity-physical-1'); requireCapacity(victim && fact.victim === victim.occurrenceId, 'victim');
  requireCapacity(fact.state.failedRecordings.length === 1 && fact.state.recoveries.length === 1 && fact.state.recordings.length === 0 && fact.state.unknown.length === 1, 'one_failure');
  stoppedSource(plan, fact, victim.occurrenceId, true);
  const controls = plan.sends.slice(0, plan.count).map(s => s.occurrenceId).filter(id => id !== victim.occurrenceId);
  assertCapacityUnchanged(baseline, fact, controls); for (const id of controls) activeBinding(plan, fact, id);
}
export function assertCapacityStopped(plan, fact) {
  audit(plan, fact); const ids = plan.sends.slice(0, plan.count).map(s => s.occurrenceId), queued = plan.sends.at(-1).occurrenceId;
  requireCapacity(fact.liveBaseline && fact.failureBaseline && fact.state.fileIdentity === fact.liveBaseline.state.fileIdentity, 'stopped_observation_history');
  requireCapacity(fact.state.invites.length === plan.count + 1 && fact.state.events.length === plan.count + 1 && fact.state.sessions.length === plan.count + 1 && fact.failureBaseline.state.invites.every(invite => invite.state === 'admitted'), 'stopped_admission');
  for (const name of ['invites', 'events']) assert.deepEqual(fact.state[name], fact.failureBaseline.state[name]);
  assert.deepEqual(rowFor(fact.state.sessions, queued), rowFor(fact.failureBaseline.state.sessions, queued));
  requireCapacity(['leases', 'generations', 'custody', 'recoveries', 'recordings', 'failedRecordings', 'bindings', 'unknown'].every(name => !fact.state[name].some(row => row.occurrenceId === queued)), 'queue_spawn');
  requireCapacity(fact.state.recordings.length === plan.count - 1 && fact.state.failedRecordings.length === 1 && fact.state.unknown.length === plan.count && fact.state.bindings.length === plan.count && fact.state.generations.length === plan.count && fact.state.custody.length === plan.count && fact.activity.outcomes.length === plan.count && rowFor(fact.state.sessions, queued).state === 'discovered' && !fact.activity.outcomes.some(o => o.occurrenceId === queued) && !fact.state.generations.some(g => g.occurrenceId === queued), 'stopped_count');
  const handles = [], paths = [];
  for (const id of ids) {
    const before = rowFor(fact.liveBaseline.activity.bridges, id), next = rowFor(fact.activity.bridges, id);
    for (const key of ['pid', 'configPath', 'configSha256', 'binding', 'mediaEndpoint', 'envKeys']) assert.deepEqual(next[key], before[key]);
    captureProgress(before, next);
    requireCapacity(rowFor(fact.activity.outcomes, id).controlSessionId === rowFor(fact.liveBaseline.activity.outcomes, id).controlSessionId, 'stopped_runtime_changed');
    for (const [name, keys] of [['leases', ['leaseId', 'bridgeId', 'bridgeSessionId', 'acquiredAtMs', 'expiresAtMs']], ['custody', ['physicalClientId', 'physicalGenerationId', 'bridgeSessionId', 'claimedAtMs']], ['generations', ['generationId', 'bridgeSessionId', 'controlSessionId']]]) {
      const previous = rowFor(fact.liveBaseline.state[name], id), current = rowFor(fact.state[name], id); for (const key of keys) assert.deepEqual(current[key], previous[key]);
    }
    stoppedSource(plan, fact, id, id === fact.victim); const unknown = rowFor(fact.state.unknown, id); handles.push(unknown.handle); paths.push(unknown.encryptedPath);
  }
  for (const name of ['unknown', 'failedRecordings', 'bindings', 'generations', 'custody', 'recoveries']) assert.deepEqual(rowFor(fact.state[name], fact.victim), rowFor(fact.failureBaseline.state[name], fact.victim));
  requireCapacity(new Set(handles).size === plan.count && new Set(paths).size === plan.count, 'shared_recording');
}
export async function runCapacityCampaign(plan, effects, { signal, label = 'component-facts' } = {}) {
  const failures = []; let owner, processProof, finalState;
  const active = () => requireCapacity(!signal?.aborted, 'cancelled');
  try { active(); await effects.prepare(); active(); owner = await effects.runOwner(plan, signal); active();
    requireCapacity(owner?.success && owner.root === plan.root && owner.databasePath === plan.databasePath && (label !== 'attempted-application' || owner.label === label), 'owner_result');
    const c = owner.child; requireCapacity(c?.exitObserved && c.closeObserved && c.code === 0 && c.signal === null && c.stdioSettled && !c.forced, 'child_close');
    requireCapacity(owner.ownerProcessProof?.cleanupConfirmed === true, 'owner_process_cleanup');
    finalState = await effects.postclose(); active(); assert.deepEqual(finalState, owner.state);
  } catch (error) { failures.push(/^capacity_[A-Za-z_]+$/.test(error?.message ?? '') ? error.message : 'capacity_campaign_failed'); }
  try { processProof = await effects.cleanup(); if (!processProof.cleanupConfirmed) failures.push('capacity_process_cleanup'); } catch { failures.push('capacity_cleanup_failed'); }
  return { schema: 'meeting-capacity-evidence/v1', count: plan.count, label, success: failures.length === 0, failures, owner, finalState, processProof, preserved: true, unproved: ['publication', 'alignment', 'hardware_headroom', 'full_K1_K2'] };
}

async function realMain(argv) {
  const options = parseCapacityArguments(argv), [{ spawn }, stageApi, pins, gateway, processRules, codec, configApi] = await Promise.all([
    import('node:child_process'), import('./stage.mjs'), import('./pins.mjs'), import('./gateway-config.mjs'), import('./process-evidence.mjs'), import('../dist/src/ports/feishu-ingress.js'), import('../dist/src/standalone-config.js'),
  ]);
  const evidence = processRules.createProcessEvidence(), controller = new globalThis.AbortController(), stop = () => controller.abort();
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(name, stop);
  let staged, child, cleanupDeadline; const plan = { count: options.count };
  const inventory = (rootPid, owner, stage, baseline = false) => {
    requireCapacity(!evidence.inventory.overflowOutcome, 'inventory_overflow'); let result;
    try { result = stageApi.run('/bin/ps', ['-eo', 'pid=,ppid=,comm='], { timeout: 1000, maxBuffer: 1048576 }); } catch { result = null; }
    return observeIngressInventory(evidence, { result, rootPid, owner, stage, baseline });
  };
  const effects = {
    async prepare() {
      noCapacitySymlinks(path.dirname(options.out)); mkdirSync(options.out, { mode: 0o700 });
      inventory(process.pid, 'preflight', 'preflight', true); await pins.verifyPins();
      staged = stageApi.stage({ repository: path.resolve(import.meta.dirname, '..') });
      const built = buildCapacityConfiguration({ staged: { ...staged, bridgeStaticConfig: capacityPrivateJson(staged.bridgeStaticConfigPath) }, count: options.count, startSeconds: Math.floor(Date.now() / 1000), normalizeInvite: codec.normalizeInvite, parseStandaloneConfig: configApi.parseStandaloneConfig });
      materializeCapacityConfiguration(built); Object.assign(plan, copy(built));
      writeFileSync(staged.gatewayConfigPath, gateway.liveGatewayToml({ recordingsDir: staged.directories.recordingsDir, keyEnv: stageApi.RECORDING_KEY_ENV, credentialEnv: stageApi.PROVIDER_CREDENTIAL_ENV }), { mode: 0o600 });
      const files = [staged.gatewayPath, staged.sdkTarball, staged.launcherPath, staged.gatewayConfigPath, staged.standaloneConfigPath, ...plan.slots.map(s => s.staticConfigPath),
        ...['e2e/capacity-run.mjs', 'e2e/capacity-entry.mjs', 'e2e/ingress-run.mjs', 'e2e/feishu-peer.mjs', 'e2e/feishu-reservation-registry.mjs', 'dist/src/main.js', 'dist/src/application-composition.js', 'dist/src/standalone-config.js', 'dist/src/ports/feishu-ingress.js'].map(f => path.join(staged.directories.app, f))];
      writeFileSync(path.join(options.out, 'staged.json'), JSON.stringify({ root: staged.root, pins: await pins.verifyPins(), digests: await Promise.all(files.map(async filename => ({ filename, sha256: await pins.sha256File(filename) }))) }), { mode: 0o600, flag: 'wx' });
    },
    async runOwner(ownerPlan, signal) {
      inventory(process.pid, 'parent', 'owner-before', true); ownerPlan.summaryPath = path.join(options.out, 'summary.json');
      const planPath = path.join(options.out, 'plan.json'); writeFileSync(planPath, JSON.stringify(ownerPlan), { mode: 0o600, flag: 'wx' });
      child = spawn(stageApi.NODE24, [path.join(staged.directories.app, 'e2e/capacity-entry.mjs'), '--plan', planPath], { stdio: ['ignore', 'pipe', 'pipe'], env: { HOME: process.env.HOME, PATH: '/opt/homebrew/opt/node@24/bin:/usr/bin:/bin', TMPDIR: staged.root, LANG: 'C.UTF-8' } });
      const handle = child, record = { role: 'capacity-owner', pid: handle.pid, outcome: null }; evidence.children.push(record);
      let failure = false, forced = false, exitObserved = false, closeObserved = false, code = null, exitSignal = null;
      const streams = [[], []], lengths = [0, 0];
      for (const [i, stream] of [handle.stdout, handle.stderr].entries()) {
        // Keep the nonthrowing handler through close/destruction and late cleanup.
        stream.on('error', () => { failure = true; });
        stream.on('data', bytes => { lengths[i] += bytes.length; if (lengths[i] > 1048576) failure = true; else streams[i].push(bytes); });
      }
      handle.on('error', () => { failure = true; }); handle.once('exit', (value, sig) => { exitObserved = true; code = value; exitSignal = sig; }); handle.once('close', () => { closeObserved = true; });
      const started = process.hrtime.bigint(); let cleanupAt = null, nextSample = 0n;
      while (!closeObserved) {
        const now = process.hrtime.bigint();
        if (now >= nextSample) { try { inventory(handle.pid, record.role, 'owner-running'); } catch { failure = true; } nextSample = now + (evidence.inventory.outcomes.length < 128 ? 100000000n : 3000000000n); }
        if (signal?.aborted || now - started >= 300000000000n) failure = true;
        if (failure && cleanupAt === null) { cleanupAt = now; cleanupDeadline = now + 45000000000n; handle.kill('SIGTERM'); }
        if (cleanupAt !== null && now - cleanupAt >= 30000000000n && !forced) { forced = true; handle.kill('SIGKILL'); }
        if (cleanupAt !== null && now - cleanupAt >= 45000000000n) break;
        await delay(25);
      }
      child = closeObserved ? null : handle; record.outcome = { exitObserved, code, signal: exitSignal };
      for (const [i, name] of ['stdout', 'stderr'].entries()) writeFileSync(path.join(options.out, name), Buffer.concat(streams[i]), { mode: 0o600, flag: 'wx' });
      let result; try { result = capacityPrivateJson(ownerPlan.summaryPath); } catch { result = { success: false }; }
      const pids = [...(result.activity?.runtimePids ?? []), ...(result.activity?.bridges ?? []).map(b => b.pid)];
      if (!pids.every(pid => evidence.observed.some(row => row.pid === pid && row.origins.includes(record.role)))) failure = true;
      try { inventory(process.pid, record.role, 'owner-close', true); } catch { failure = true; }
      const ownerProcessProof = ingressProcessProof(evidence, record.role);
      return { ...result, ownerProcessProof, success: result.success && !failure && ownerProcessProof.cleanupConfirmed,
        child: { exitObserved, closeObserved, code, signal: exitSignal, forced, stdioSettled: closeObserved && handle.stdout.destroyed && handle.stderr.destroyed } };
    },
    async postclose() { return readCapacityState({ databasePath: plan.databasePath, occurrenceIds: plan.sends.map(s => s.occurrenceId) }); },
    async cleanup() {
      // Only the exact owned handle is signalled. A later disappearance cannot
      // repair the frozen owner boundary proof or a forced direct-child close.
      if (child) { const handle = child; handle.kill('SIGTERM'); const end = cleanupDeadline ?? process.hrtime.bigint() + 45000000000n; let killed = false, closed = false;
        handle.once('close', () => { closed = true; });
        while (!closed && process.hrtime.bigint() < end) { if (!killed && process.hrtime.bigint() >= end - 15000000000n) { handle.kill('SIGKILL'); killed = true; } await delay(25); }
        if (!closed) { handle.kill('SIGKILL'); handle.stdout.destroy(); handle.stderr.destroy(); handle.unref(); }
      }
      try { inventory(process.pid, 'final', 'final', true); } catch { /* sticky refusal retained */ }
      return ingressProcessProof(evidence);
    },
  };
  try { const result = await runCapacityCampaign(plan, effects, { signal: controller.signal, label: 'attempted-application' });
    if (ingressPathExists(options.out)) writeFileSync(path.join(options.out, 'evidence.json'), JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' }); process.exitCode = result.success ? 0 : 70;
  } finally { for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(name, stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void realMain(process.argv.slice(2)).catch(() => { process.stderr.write('capacity_runner_refused\n'); process.exitCode = 70; });

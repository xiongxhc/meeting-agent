// Actual SDK/composition/admission imports are behind explicit command execution.
// Merely importing this module constructs no client, application, owner or peer.
import Database from "better-sqlite3";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { Agent as HttpAgent } from "node:http";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { ingressData, ingressReceiverFact, ingressCloseFact, readIngressState } from "./ingress-run.mjs";
import { assertPendingStartupEnvironment, readStartupEmptyState, readStartupEmptyFiles } from "./pending-startup-run.mjs";
import { createInviteAdmissionAbortFault, registerInviteAbortFixture, INVITE_ABORT_TABLES, INVITE_ABORT_SCHEMA_SHA256 } from "./invite-admission-abort-fault.mjs";
import { ABORT_DEPENDENCY_SHA256, ABORT_DESIGN_SHA256, INVITE_ABORT_LIFECYCLE_CODES, inviteAbortNow, requireInviteAbort, runInviteAdmissionAbortCampaign, validateInviteAbortResult } from "./invite-admission-abort-run.mjs";
// Finite compiled graph from accepted0b722, including modules loaded even when
// the refused case never launches Runtime or a bridge.
const APPLICATION_GRAPH = Object.freeze(["dist/src/adapters/application-owner-lock.js", "dist/src/adapters/child-bridge-process.js", "dist/src/adapters/conversation-runtime-client.js", "dist/src/adapters/feishu-invite-ingress.js", "dist/src/adapters/feishu-organizer-metadata.js", "dist/src/adapters/feishu-organizer-sender.js", "dist/src/adapters/feishu-sdk-connection.js", "dist/src/adapters/feishu-sdk-http.js", "dist/src/adapters/filesystem-operator-warning.js", "dist/src/adapters/filesystem-outbox.js", "dist/src/adapters/receipt-inbox.js", "dist/src/adapters/sqlite-session-store.js", "dist/src/adapters/team-vault-index.js", "dist/src/application-composition.js", "dist/src/application-maintenance.js", "dist/src/application.js", "dist/src/config.js", "dist/src/contracts/bridge-process-outcome-v1.js", "dist/src/contracts/bridge-session-v1.js", "dist/src/contracts/bridge-session-v2.js", "dist/src/contracts/teammem-meeting-v1.js", "dist/src/contracts/teammem-meeting-v2.js", "dist/src/delivery/artifact-builder.js", "dist/src/delivery/backfill-worker.js", "dist/src/delivery/notification-worker.js", "dist/src/delivery/outbox-worker.js", "dist/src/domain/attribution-evidence.js", "dist/src/domain/meeting.js", "dist/src/domain/occurrence-id.js", "dist/src/domain/participants.js", "dist/src/domain/transcript.js", "dist/src/main.js", "dist/src/ports/bridge.js", "dist/src/ports/feishu-ingress.js", "dist/src/ports/feishu.js", "dist/src/ports/knowledge.js", "dist/src/ports/live-evidence-authority.js", "dist/src/ports/operator-warning.js", "dist/src/ports/recording-alignment-authority.js", "dist/src/ports/session-store.js", "dist/src/sessions/coordinator.js", "dist/src/sessions/invite-discovery.js", "dist/src/sessions/invocation-gate.js", "dist/src/sessions/live-evidence-codec.js", "dist/src/sessions/live-provisional.js", "dist/src/sessions/meeting-session.js", "dist/src/sessions/recording-alignment.js", "dist/src/sessions/retrieval-router.js", "dist/src/sessions/speaker-reconciler.js", "dist/src/sessions/timed-evidence-merge.js", "dist/src/standalone-config.js"]);
const attempted = new WeakSet();
export function isAttemptedInviteAbortResult(value) { return value !== null && typeof value === "object" && attempted.has(value); }
/** Trusted receiver owner is projected before the closed data validator. Its
 * getters and receive callback are never retained as a caller-supplied DTO. */
export function projectInviteAbortReceiver(owner) { return ingressReceiverFact({ invalid: owner.invalid, overflow: owner.overflow, observations: [...owner.observations] }); }
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const fileHash = filename => digest(readFileSync(filename));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
/** Same public-close observation in the real entry and synthetic lifecycle C.
 * A fulfilled promise alone cannot certify the selected current facts. */
export async function observeInviteAbortRepeatedClose(app, readSelected) {
  const first = app.close(), second = app.close();
  const settled = await Promise.allSettled([first, second]);
  const before = JSON.stringify(ingressData(readSelected()));
  const third = app.close(); const thirdSettled = await Promise.allSettled([third]);
  const after = JSON.stringify(ingressData(readSelected()));
  return { firstSecondSame: first === second, thirdSame: first === third, fulfilled: [...settled, ...thirdSettled].every(s => s.status === "fulfilled"), repeatUnchanged: before === after };
}
/** Exact accepted-source and actual clean-built-module dependency identities.
 * Root qualification binds these observed hashes separately from a live run. */
export function qualifyInviteAbortSources(repository) {
  const require = createRequire(path.join(repository, "e2e/invite-admission-abort-entry.mjs")), sdk = require.resolve("@larksuiteoapi/node-sdk"), sqlite = require.resolve("better-sqlite3"), ws = require.resolve("ws");
  // This installed version's actual default loader prefers its prebuild. Do
  // not report a guessed node-gyp Release file as the binary that will load.
  const native = require(path.join(path.dirname(sqlite), "binding.js")).getPrebuildPath(); requireInviteAbort(typeof native === "string", "sources");
  const relative = p => fileHash(path.join(repository, p));
  // Reviewed finite loaded dependency roles, including package identities.
  // Hashing these files never imports the SDK or WebSocket implementation.
  const dependency = (root, files) => digest(JSON.stringify(files.map(p => [p, fileHash(path.join(root, p))])));
  const sdkHash = dependency(path.dirname(path.dirname(sdk)), ["package.json", "lib/index.js"]);
  const wsHash = dependency(path.dirname(ws), ["package.json", "index.js", "lib/websocket.js", "lib/websocket-server.js"]);
  const sqliteHash = dependency(path.dirname(path.dirname(sqlite)), ["package.json", "lib/index.js", "lib/binding.js", "lib/database.js", "lib/util.js", "lib/sqlite-error.js", "lib/methods/transaction.js", "lib/methods/wrappers.js", "lib/methods/pragma.js"]);
  const migrations = readdirSync(path.join(repository, "migrations")).sort().map(name => [name, relative(`migrations/${name}`)]);
  return { design: ABORT_DESIGN_SHA256, originalDesignBase: "c4bb36116ac5580a566f5d120ead01b580d5265f7a7d9bffbd4ec4655655d4dd", dependencyManifest: ABORT_DEPENDENCY_SHA256,
    entry: relative("e2e/invite-admission-abort-entry.mjs"), runner: relative("e2e/invite-admission-abort-run.mjs"), fault: relative("e2e/invite-admission-abort-fault.mjs"), reader: relative("e2e/ingress-run.mjs"), emptyReader: relative("e2e/pending-startup-run.mjs"), normalizer: relative("dist/src/ports/feishu-ingress.js"), store: relative("dist/src/adapters/sqlite-session-store.js"), migrations: digest(JSON.stringify(migrations)), lifecycle: relative("e2e/composition-lifecycle.mjs"), owner: relative("dist/src/adapters/application-owner-lock.js"), http: relative("dist/src/adapters/feishu-sdk-http.js"), socket: relative("dist/src/adapters/feishu-sdk-connection.js"), peer: relative("e2e/feishu-peer.mjs"), applicationGraph: digest(JSON.stringify(APPLICATION_GRAPH.map(p => [p, relative(p)]))), stage: relative("e2e/stage.mjs"), pins: relative("e2e/pins.mjs"), l4Campaign: relative("e2e/l4-campaign.mjs"), mediaClient: relative("e2e/media-client.mjs"), peerControls: relative("e2e/feishu-peer-controls.mjs"), upgradeControls: relative("e2e/feishu-upgrade-controls.mjs"), reservationRegistry: relative("e2e/feishu-reservation-registry.mjs"), processRules: relative("e2e/process-evidence.mjs"), sdk: sdkHash, sqlite: sqliteHash, sqliteNative: fileHash(native), ws: wsHash };
}
const stableIdentity = file => { const s = lstatSync(file, { bigint: true }); return `${s.dev}:${s.ino}:${s.birthtimeNs}`; };
// Supplement the qualified fixed reader with complete private event/occurrence
// rows and global thirteen-table counts, all inside one guarded readonly txn.
export function readInviteAbortProjection(databasePath, occurrenceId) {
  const selected = ingressCloseFact({ finalState: readIngressState({ databasePath, occurrenceId }), outcomes: [], commitObservations: [] }).finalState;
  const before = lstatSync(databasePath), parent = lstatSync(path.dirname(databasePath)), fd = openSync(databasePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let db;
  try {
    const held = fstatSync(fd), header = Buffer.alloc(100); requireInviteAbort(held.dev === before.dev && held.ino === before.ino && held.isFile() && held.nlink === 1 && held.uid === process.getuid() && held.size <= 8388608 && readSync(fd, header, 0, 100, 0) === 100 && header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")) && header[18] === 1 && header[19] === 1, "fact");
    function guard() { const s = lstatSync(databasePath), p = lstatSync(path.dirname(databasePath)); requireInviteAbort(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.dev === held.dev && s.ino === held.ino && s.uid === held.uid && (s.mode & 0o022) === 0 && p.isDirectory() && !p.isSymbolicLink() && p.dev === parent.dev && p.ino === parent.ino && p.uid === held.uid && (p.mode & 0o077) === 0, "fact"); for (const suffix of ["-wal", "-shm"]) { try { lstatSync(databasePath + suffix); throw new Error("invite_abort_fact"); } catch (e) { if (e.code !== "ENOENT") throw e; } } }
    guard(); db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 0 }); guard();
    const projection = db.transaction(() => { requireInviteAbort(db.pragma("journal_mode", { simple: true }) !== "wal", "fact"); const occurrences = db.prepare("SELECT * FROM feishu_invite_occurrences ORDER BY occurrence_id LIMIT 2").all(), events = db.prepare("SELECT * FROM feishu_invite_events ORDER BY event_id LIMIT 2").all(), counts = Object.fromEntries(INVITE_ABORT_TABLES.map(t => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n])); const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name LIMIT 124").all(); requireInviteAbort(occurrences.length === 1 && events.length === 1 && counts.feishu_invite_occurrences === 1 && counts.feishu_invite_events === 1 && occurrences[0].occurrence_id === occurrenceId && events[0].occurrence_id === occurrenceId && events[0].normalized_sha256 === selected.events[0].hash && occurrences[0].accepted_at_ms === selected.immutable.acceptedAtMs && schema.length <= 123, "durable"); return ingressData({ selected, occurrences, events, counts, schema }); })(); guard(); return projection;
  } finally { try { db?.close(); } finally { closeSync(fd); } }
}
export async function runActualInviteAdmissionAbort() {
  assertPendingStartupEnvironment(process.env);
  // This guarded path is prepared source, never executed by component tests.
  const [stageApi, pins, sdk, main, configApi, lockApi, composition, httpApi, socketApi, peers, lifecycle, normalizer] = await Promise.all([
    import("./stage.mjs"), import("./pins.mjs"), import("@larksuiteoapi/node-sdk"), import("../dist/src/main.js"), import("../dist/src/standalone-config.js"), import("../dist/src/adapters/application-owner-lock.js"), import("../dist/src/application-composition.js"), import("../dist/src/adapters/feishu-sdk-http.js"), import("../dist/src/adapters/feishu-sdk-connection.js"), import("./feishu-peer.mjs"), import("./composition-lifecycle.mjs"), import("../dist/src/ports/feishu-ingress.js"),
  ]);
  await pins.verifyPins(); const repository = path.resolve(import.meta.dirname, ".."), sources = qualifyInviteAbortSources(repository), staged = stageApi.stage({ repository });
  // Empty allowlist: every invite is refused and recorded, and the start warns.
  staged.standaloneConfig.admission = { allowedInviterIds: [], allowedChatIds: [] }; writeFileSync(staged.standaloneConfigPath, JSON.stringify(staged.standaloneConfig), { mode: 0o600 });
  const freshRoot = registerInviteAbortFixture(staged.root);
  const meeting = { providerMeetingId: "meeting-abort-e2e", meetingNo: "987654321", title: "First accepted title", startSeconds: Math.floor(Date.now() / 1000), eventId: "abort-original", inviteSeconds: Math.floor(Date.now() / 1000), createTimeMs: Date.now() };
  const envelope = ingressData(peers.inviteEnvelope(meeting)), normalized = normalizer.normalizeInvite(envelope, peers.SCOPE), expectedHash = normalized.normalizedSha256, databasePath = path.join(staged.directories.stateRoot, "orchestration.db");
  const filesPlan = { standaloneConfigPath: staged.standaloneConfigPath, databasePath, directories: { recordingsDir: staged.directories.recordingsDir, outboxDir: staged.directories.outboxDir, receiptsDir: staged.directories.receiptsDir, control: staged.directories.control }, runtimePidsPath: staged.gatewayPidsPath, launcherLog: staged.launcherLog, keyPath: staged.keyPath };
  const rootIdentity = stableIdentity(staged.root), stateRootIdentity = stableIdentity(staged.directories.stateRoot);
  let fault, databaseIdentity, firstProjection, previousClosed = false, acquisitionCount = 0;
  const identitySame = () => stableIdentity(databasePath) === databaseIdentity && stableIdentity(staged.root) === rootIdentity && stableIdentity(staged.directories.stateRoot) === stateRootIdentity;
  const effects = {
    beginOwner(ownerNumber, phaseDeadline, overallDeadline) {
      requireInviteAbort(ownerNumber === 1 ? acquisitionCount === 0 : acquisitionCount === 1 && previousClosed, "close");
      const shutdown = new globalThis.AbortController(), permitFixtureCleanup = deferred(), history = [], commits = [], failures = []; let peer, app, admittedOwner, http, httpSockets, wsSockets, run, compositionResult, standaloneExit, pending = null, invalid = false, overflow = false, fixtureCleanupStarted = false, closePromise, closeFact, endpoint200 = false, discoveryEmpty = false;
      const mark = code => { if (history.length === 256) { overflow = true; return 0; } const ordinal = history.length + 1; history.push({ ordinal, code }); return ordinal; };
      const cleanupFail = code => { if (failures.length < 8 && !failures.includes(code)) failures.push(code); };
      const read = () => readInviteAbortProjection(databasePath, normalized.occurrenceId);
      const receiver = () => projectInviteAbortReceiver(peer.frameObservation);
      const cleanFiles = () => { readStartupEmptyFiles(filesPlan); return true; };
      function assertSideEffects() { cleanFiles(); requireInviteAbort(peer.messages.length === 0 && app.liveOccurrenceIds().length === 0 && app.occurrenceOutcomes().length === 0 && peer.requests.length < 256 && peer.requests.every(r => r.route === "ws_endpoint" && r.status === 200), "durable"); }
      function assertCurrent() { admittedOwner.assertCurrentOwnership(); requireInviteAbort(!invalid && !overflow && standaloneExit === undefined && peer.connectionCount === 1 && !peer.frameObservation.invalid && !peer.frameObservation.overflow, "effect"); }
      async function wait(predicate, deadline) { for (let ticks = 0; ticks < 1600; ticks++) { requireInviteAbort(inviteAbortNow() < Math.min(deadline, phaseDeadline, overallDeadline) && !invalid && !overflow, "deadline"); const value = predicate(); requireInviteAbort(inviteAbortNow() < deadline, "deadline"); if (value) return value; await delay(Math.min(25, Math.max(1, deadline - inviteAbortNow()))); } throw new Error("invite_abort_deadline"); }
      function log(code) {
        if (typeof code !== "string" || !INVITE_ABORT_LIFECYCLE_CODES.includes(code)) { invalid = true; return; } mark(code);
        if (code !== "invite_committed") return;
        try { requireInviteAbort(pending && commits.length < 2 && !commits.some(c => c.wireId === pending), "history"); const state = read(); requireInviteAbort(state.events[0].normalized_sha256 === expectedHash && state.events[0].event_id === normalized.eventId && state.occurrences[0].title === normalized.title, "acceptance"); commits.push({ wireId: pending, ordinal: commits.length + 1, persistedHash: expectedHash, ackFloor: receiver().observations.at(-1)?.ordinal ?? 0 }); } catch { invalid = true; }
      }
      const factFault = () => ownerNumber === 1 ? fault.inspect() : { ...fault.fact(), ownerCurrent: (() => { admittedOwner.assertCurrentOwnership(); return true; })() };
      const durable = () => { assertSideEffects(); const projection = read(); if (!firstProjection) firstProjection = projection; const row = projection.occurrences[0], event = projection.events[0]; const sameImmutable = JSON.stringify(projection.selected.immutable) === JSON.stringify(firstProjection.selected.immutable) && JSON.stringify(projection.events) === JSON.stringify(firstProjection.events); const sameMetadata = JSON.stringify(projection.occurrences) === JSON.stringify(firstProjection.occurrences); return { databaseIdentitySame: identitySame() && projection.selected.fileIdentity === firstProjection.selected.fileIdentity, immutableSame: sameImmutable, eventHash: event.normalized_sha256, eventRows: projection.counts.feishu_invite_events, occurrenceRows: projection.counts.feishu_invite_occurrences, acceptedAtMs: row.accepted_at_ms, state: row.state, reason: row.last_blocked_reason, claimed: row.claim_token !== null, claimExpiresAtMs: row.claim_expires_at_ms, organizerNull: ["organizer_source", "organizer_id_type", "organizer_open_id", "organizer_display_name"].every(k => row[k] === null), referenceNull: row.reference_kind === null && row.reference_json === null, admittedAtMs: row.admitted_at_ms, totalAttempts: row.total_attempts, generationAttempts: row.generation_attempts, retryGeneration: row.retry_generation, operatorRetryCount: row.operator_retry_count, metadataSame: sameMetadata, downstreamZero: INVITE_ABORT_TABLES.filter(t => !["feishu_invite_events", "feishu_invite_occurrences"].includes(t)).every(t => projection.counts[t] === 0), triggerAbsent: !projection.schema.some(r => r.name === "e2e_invite_admission_abort"), schemaRestored: digest(JSON.stringify(projection.schema)) === INVITE_ABORT_SCHEMA_SHA256 }; };
      const close = deadline => {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          let firstSecondSame = false, thirdSame = false, fulfilled = false, repeatUnchanged = false, preFixtureObserved = false, publicCloseOrdinal = 0, preFixtureOrdinal = 0;
          try {
            if (fault && ownerNumber === 1 && fault.fact().phase === "installed" && !fault.failureCleanup()) cleanupFail("controller_clear");
            requireInviteAbort(app, "close"); publicCloseOrdinal = mark("public_close");
            ({ firstSecondSame, thirdSame, fulfilled, repeatUnchanged } = await observeInviteAbortRepeatedClose(app, () => ({ receiver: receiver(), commits, projection: firstProjection ? read() : null })));
            shutdown.abort(); await wait(() => http.activeCount === 0 && httpSockets.activeCount === 0 && httpSockets.pendingCount === 0 && wsSockets.activeCount === 0 && wsSockets.pendingCount === 0 && peer.connectionCount === 0, deadline);
            assertSideEffects(); requireInviteAbort(!fixtureCleanupStarted && !invalid && !overflow, "close"); preFixtureObserved = true; preFixtureOrdinal = mark("pre_fixture");
          } catch { cleanupFail("public_close"); }
          finally { shutdown.abort(); permitFixtureCleanup.resolve(); }
          if (run) await run;
          let finalDurable = null; try { if (firstProjection) finalDurable = durable(); } catch { cleanupFail("late_history"); }
          const storeClosedOrdinal = history.find(r => r.code === "shutdown_store_closed")?.ordinal ?? 0;
          closeFact = { owner: ownerNumber, firstSecondSame, thirdSame, fulfilled, repeatUnchanged, clean: compositionResult?.status === "composition_closed" && compositionResult.clean === true, httpActive: http?.activeCount ?? 1, httpSockets: { active: httpSockets?.activeCount ?? 1, pending: httpSockets?.pendingCount ?? 1 }, wsSockets: { active: wsSockets?.activeCount ?? 1, pending: wsSockets?.pendingCount ?? 1 }, peerConnections: peer?.connectionCount ?? 1, preFixtureObserved, fixtureCleanupStarted, publicCloseOrdinal, storeClosedOrdinal, preFixtureOrdinal, peerClosedOrdinal: history.find(r => r.code === "peer_closed")?.ordinal ?? 0, admittedReturnOrdinal: history.find(r => r.code === "admitted_return")?.ordinal ?? 0, ownerCloseBeginOrdinal: history.find(r => r.code === "owner_close_begin")?.ordinal ?? 0, ownerCloseEndOrdinal: history.find(r => r.code === "owner_close_end")?.ordinal ?? 0, standaloneExit: standaloneExit ?? 70, invalid: invalid || (peer?.frameObservation.invalid ?? true), overflow: overflow || (peer?.frameObservation.overflow ?? true), cleanupFailures: [...failures] };
          previousClosed = fulfilled && preFixtureObserved && closeFact.clean && closeFact.standaloneExit === 0 && !closeFact.invalid && !closeFact.overflow && failures.length === 0;
          const observed = peer ? receiver().observations : []; return { close: closeFact, durable: finalDurable, history: { owner: ownerNumber, acks: observed.map(r => ({ wireId: r.messageId, code: r.payload.code, receiverOrdinal: r.ordinal })), commits: [...commits], lifecycle: [...history], invalid, overflow } };
        })(); return closePromise;
      };
      run = main.runStandalone(["--standalone-config", staged.standaloneConfigPath], {
        readConfig: configApi.readStandaloneConfig, inspectStateRoot: configApi.inspectStateRoot,
        async acquireOwnerLock(root) { const actual = await lockApi.acquireApplicationOwnerLock(root); acquisitionCount++; mark("owner_acquired"); admittedOwner = { assertCurrentOwnership: actual.assertCurrentOwnership, close() { mark("owner_close_begin"); actual.close(); mark("owner_close_end"); } }; return admittedOwner; },
        async composeAfterAdmission(config, owner) {
          try {
            peer = await peers.startFeishuPeer({ meeting }); httpSockets = socketApi.createFeishuSocketOwner(HttpAgent); wsSockets = socketApi.createFeishuSocketOwner(HttpAgent); http = httpApi.createFeishuSdkHttp({ request: peer.rewriteRequest(sdk.defaultHttpInstance.request), connection: httpSockets });
            compositionResult = await lifecycle.runExposedComposition(composition.composeApplication, config, owner, { feishu: { http, connection: wsSockets }, organizerReferences: [], maintenance: { intervalsMs: { backfill: 3600000, warning: 3600000, outbox: 3600000, notification: 3600000, discovery: 3600000, custody: 3600000 }, random: () => 0 }, discoveryJitter: () => 0, log }, handle => { app = handle; requireInviteAbort(handle.stateDatabasePath === composition.stateDatabasePath(config) && handle.stateDatabasePath === databasePath, "fact"); }, shutdown);
            return compositionResult;
          } finally {
            await permitFixtureCleanup.promise; fixtureCleanupStarted = true; const settled = await Promise.allSettled([http?.close(), httpSockets?.close(), wsSockets?.close()]); if (settled.some(s => s.status === "rejected" || s.value === false)) cleanupFail("transport_close"); try { await peer?.close(); mark("peer_closed"); } catch { cleanupFail("fixture_close"); } mark("admitted_return");
          }
        }, report() { /* runStandalone exit is observed; no diagnostic retained. */ },
      }).then(value => { standaloneExit = value; return value; }, () => { standaloneExit = 70; return 70; });
      return {
        async ready(deadline) { await wait(() => app && history.some(r => r.code === "composition_started") && peer?.connectionCount === 1, deadline); assertCurrent(); const discovery = await app.discover(); requireInviteAbort(discovery.launched === 0 && discovery.deferred === 0 && discovery.resolved === 0, "ready"); discoveryEmpty = true;
          const warnings = history.filter(r => r.code === "invite_admission_no_inviters_configured"), started = history.find(r => r.code === "composition_started");
          const admissionWarned = warnings.length === 1 && warnings[0].ordinal < started.ordinal && app.maintenanceStatus().inviteAdmission === "no_inviters_configured"; endpoint200 = peer.requests.some(r => r.route === "ws_endpoint" && r.status === 200); assertSideEffects(); if (ownerNumber === 1) { const empty = readStartupEmptyState({ databasePath }); databaseIdentity = stableIdentity(databasePath); requireInviteAbort(empty.counts.feishu_invite_events === 0, "empty"); } else requireInviteAbort(stableIdentity(databasePath) === databaseIdentity, "durable"); return { admitted: acquisitionCount === ownerNumber, started: true, endpoint200, connections: peer.connectionCount, receiverEmpty: receiver().observations.length === 0, commitEmpty: commits.length === 0, discoveryEmpty, sideEffectsZero: true, admissionWarned }; },
        empty() { assertCurrent(); assertSideEffects(); const empty = readStartupEmptyState({ databasePath }); return { databaseIdentitySame: identitySame(), counts: empty.counts, filesEmpty: cleanFiles() }; },
        install() { assertCurrent(); fault = createInviteAdmissionAbortFault({ root: staged.root, databasePath, appDatabasePath: app.stateDatabasePath, configDatabasePath: composition.stateDatabasePath(staged.standaloneConfig), freshRoot, owner: admittedOwner, envelope, scope: peers.SCOPE }); return fault.install(); }, inspectFault: factFault,
        clear() { assertCurrent(); return fault.clear(); },
        async deliver(wireId, deadline) {
          assertCurrent(); const allBefore = receiver().observations; requireInviteAbort(pending === null && allBefore.length === (ownerNumber === 1 ? wireId === "abort-first" ? 0 : 1 : 0), "history"); const original = normalizer.normalizeInvite(envelope, peers.SCOPE); requireInviteAbort(JSON.stringify(original) === JSON.stringify(normalized), "delivery"); const selectedFault = factFault(); requireInviteAbort(selectedFault.phase === (wireId === "abort-first" ? "installed" : "cleared"), "fault"); if (ownerNumber === 1) fault.assertTarget();
          const refusals = () => history.filter(r => r.code === "invite_admission_inviter_not_allowed").length;
          const discoveryBefore = history.filter(r => r.code === "discovery_tick").length, commitsBefore = commits.length, refusalsBefore = refusals(); pending = wireId;
          // Complete synchronous recheck and send have no intervening await.
          admittedOwner.assertCurrentOwnership(); if (wireId === "abort-first") readStartupEmptyState({ databasePath }); peer.deliverInvite(envelope, wireId);
          await wait(() => receiver().observations.length > allBefore.length, deadline); const observations = receiver().observations; requireInviteAbort(observations.length === allBefore.length + 1, "history"); const ack = observations.at(-1); requireInviteAbort(ack.kind === "ack" && ack.messageId === wireId, "delivery"); const commit = commits.find(c => c.wireId === wireId) ?? null;
          let auditRows, occurrenceRows;
          if (wireId === "abort-first") { const empty = readStartupEmptyState({ databasePath }); auditRows = empty.counts.feishu_invite_events; occurrenceRows = empty.counts.feishu_invite_occurrences; requireInviteAbort(commits.length === commitsBefore && history.filter(r => r.code === "discovery_tick").length === discoveryBefore, "rollback"); } else { const projection = read(); auditRows = projection.counts.feishu_invite_events; occurrenceRows = projection.counts.feishu_invite_occurrences; requireInviteAbort(commits.length === commitsBefore + 1, "acceptance"); }
          assertSideEffects(); pending = null; return { owner: ownerNumber, wireId, expectedHash: original.normalizedSha256, ack: { code: ack.payload.code, receiverOrdinal: ack.ordinal, matchingWire: ack.messageId === wireId }, commit: commit && { ordinal: commit.ordinal, persistedHash: commit.persistedHash, ackFloor: commit.ackFloor }, auditRows, occurrenceRows, refusalLogs: refusals() - refusalsBefore, fault: selectedFault, receiverInvalid: peer.frameObservation.invalid, receiverOverflow: peer.frameObservation.overflow };
        },
        async blocked(deadline) { assertCurrent(); await app.discover(); await wait(() => read().occurrences[0].state === "metadata_blocked", deadline); return durable(); }, durable, close,
      };
    },
  };
  const component = await runInviteAdmissionAbortCampaign(effects, { expectedHash, sources }); const result = { ...component, label: "attempted-application" }; attempted.add(result); validateInviteAbortResult(result); return result;
}

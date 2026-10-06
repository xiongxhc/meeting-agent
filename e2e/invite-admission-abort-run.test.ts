import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { normalizeInvite } from "../src/ports/feishu-ingress.ts";
const modulePath = path.resolve(import.meta.dirname, "invite-admission-abort-run.mjs");
async function runner() { assert.ok(existsSync(modulePath), "the selected finite rollback campaign must exist"); return import(modulePath); }
const H = "a".repeat(64);
const shutdownCodes = ["public_close", "shutdown_fenced", "maintenance_fenced", "maintenance_closed", "shutdown_owned_work_settled", "shutdown_application_closed", "shutdown_runtime_owners_closed", "shutdown_transports_closed", "shutdown_store_closed", "pre_fixture", "peer_closed", "admitted_return", "owner_close_begin", "owner_close_end"];
export function goodFacts() {
  const fault = (phase: string) => ({ phase, trigger: "e2e_invite_admission_abort", templateSha256: H, targetHash: H, ownerCurrent: true, databaseBound: true, schemaExact: true, helperHandles: 0, installOrdinal: 1, clearOrdinal: phase === "cleared" ? 2 : null, invalid: false });
  const counts = Object.fromEntries(["feishu_invite_occurrences", "feishu_invite_events", "sessions", "bridge_leases", "physical_client_custody", "reconciliation_generations", "recordings", "bridge_failure_recordings", "recording_recovery_bindings", "unknown_end_custody", "backfill_seeds", "delivery_journal", "notification_intents"].map(t => [t, 0]));
  const empty = { databaseIdentitySame: true, counts, filesEmpty: true };
  const durable = { databaseIdentitySame: true, immutableSame: true, eventHash: H, eventRows: 1, occurrenceRows: 1, acceptedAtMs: 1700000000002, state: "metadata_blocked", reason: "reference_missing", claimed: false, claimExpiresAtMs: null, organizerNull: true, referenceNull: true, admittedAtMs: null, totalAttempts: 1, generationAttempts: 1, retryGeneration: 0, operatorRetryCount: 0, metadataSame: true, downstreamZero: true, triggerAbsent: true, schemaRestored: true };
  const delivery = (owner: number, wireId: string, code: number, ordinal: number) => ({ owner, wireId, expectedHash: H, ack: { code, receiverOrdinal: ordinal, matchingWire: true }, commit: code === 500 ? null : { ordinal: 1, persistedHash: H, ackFloor: ordinal - 1 }, auditRows: code === 500 ? 0 : 1, occurrenceRows: code === 500 ? 0 : 1, fault: fault(code === 500 ? "installed" : "cleared"), receiverInvalid: false, receiverOverflow: false });
  const deliveries = [delivery(1, "abort-first", 500, 1), delivery(1, "abort-recover", 200, 2), delivery(2, "abort-reopened", 200, 1)];
  const close = (owner: number) => ({ owner, firstSecondSame: true, thirdSame: true, fulfilled: true, repeatUnchanged: true, clean: true, httpActive: 0, httpSockets: { active: 0, pending: 0 }, wsSockets: { active: 0, pending: 0 }, peerConnections: 0, preFixtureObserved: true, fixtureCleanupStarted: true, publicCloseOrdinal: 1, storeClosedOrdinal: 9, preFixtureOrdinal: 10, peerClosedOrdinal: 11, admittedReturnOrdinal: 12, ownerCloseBeginOrdinal: 13, ownerCloseEndOrdinal: 14, standaloneExit: 0, invalid: false, overflow: false, cleanupFailures: [] });
  const history = (owner: number) => ({ owner, acks: deliveries.filter(d => d.owner === owner).map(d => ({ wireId: d.wireId, code: d.ack.code, receiverOrdinal: d.ack.receiverOrdinal })), commits: deliveries.filter(d => d.owner === owner && d.commit).map(d => ({ wireId: d.wireId, ...d.commit! })), lifecycle: shutdownCodes.map((code, i) => ({ ordinal: i + 1, code })), invalid: false, overflow: false });
  return { fault, empty, durable, deliveries, close, history };
}
export function syntheticEffects(f = goodFacts()) {
  const calls: string[] = [];
  const effects = { async beginOwner(owner: number) { calls.push(`owner${owner}`); return {
    async ready() { return { admitted: true, started: true, endpoint200: true, connections: 1, receiverEmpty: true, commitEmpty: true, discoveryEmpty: true, sideEffectsZero: true }; },
    empty() { return f.empty; }, install() { calls.push("install"); return f.fault("installed"); }, inspectFault() { return f.fault("installed"); }, clear() { calls.push("clear"); return f.fault("cleared"); },
    async deliver(wireId: string) { calls.push(wireId); return f.deliveries.find(d => d.wireId === wireId); }, async blocked() { return f.durable; }, durable() { return f.durable; },
    async close() { calls.push(`close${owner}`); return { close: f.close(owner), history: f.history(owner), durable: f.durable }; },
  }; } };
  return { effects, calls };
}
test("finite campaign requires rollback then first acceptance then replay, with two ordinary clean owners", async () => {
  const r = await runner(), f = syntheticEffects(); const result = await r.runInviteAdmissionAbortCampaign(f.effects, { expectedHash: H, sources: r.componentSourceIds() });
  assert.equal(result.success, true); assert.equal(result.label, "component-facts"); assert.deepEqual(f.calls, ["owner1", "install", "abort-first", "clear", "abort-recover", "close1", "owner2", "abort-reopened", "close2"]); assert.equal(result.deliveries.length, 3); assert.equal(result.closes.length, 2);
});
const negatives = ["partial_occurrence", "partial_event", "first200", "reject_commit", "early_clear", "changed_hash", "recover500", "missing_commit", "commit_ack_order", "wrong_wire", "reused_wire", "durable_identity", "metadata_admitted", "metadata_attempt", "trigger_survives", "extra_row", "close_rejected", "memoized_identity", "cleanup_before_snapshot", "stale_socket", "close_order", "duplicate_ack", "late_commit", "history_overflow"] as const;
for (const kind of negatives) test(`coherent campaign refuses ${kind}`, async () => {
  const r = await runner(), f = goodFacts();
  if (kind === "partial_occurrence") f.deliveries[0]!.occurrenceRows = 1;
  if (kind === "partial_event") f.deliveries[0]!.auditRows = 1;
  if (kind === "first200") f.deliveries[0]!.ack.code = 200;
  if (kind === "reject_commit") f.deliveries[0]!.commit = { ordinal: 1, persistedHash: H, ackFloor: 0 };
  if (kind === "early_clear") f.deliveries[0]!.fault = f.fault("cleared");
  if (kind === "changed_hash") f.deliveries[1]!.expectedHash = "b".repeat(64);
  if (kind === "recover500") f.deliveries[1]!.ack.code = 500;
  if (kind === "missing_commit") f.deliveries[1]!.commit = null;
  if (kind === "commit_ack_order") f.deliveries[1]!.commit!.ackFloor = 2;
  if (kind === "wrong_wire") f.deliveries[1]!.wireId = "wrong";
  if (kind === "reused_wire") f.deliveries[1]!.wireId = "abort-first";
  if (kind === "durable_identity") f.durable.immutableSame = false;
  if (kind === "metadata_admitted") f.durable.state = "admitted";
  if (kind === "metadata_attempt") f.durable.totalAttempts = 2;
  if (kind === "trigger_survives") f.durable.triggerAbsent = false;
  if (kind === "extra_row") f.durable.eventRows = 2;
  const originalClose = f.close, originalHistory = f.history;
  f.close = owner => { const c = originalClose(owner); if (kind === "close_rejected") c.fulfilled = false; if (kind === "memoized_identity") c.thirdSame = false; if (kind === "cleanup_before_snapshot") c.preFixtureObserved = false; if (kind === "stale_socket") c.wsSockets.active = 1; if (kind === "close_order") { c.ownerCloseBeginOrdinal = 11; c.ownerCloseEndOrdinal = 12; c.peerClosedOrdinal = 13; c.admittedReturnOrdinal = 14; } return c; };
  f.history = owner => { const h = originalHistory(owner); if (kind === "duplicate_ack") h.acks.push({ ...h.acks[0]! }); if (kind === "late_commit") h.commits.push({ wireId: "abort-first", ordinal: 2, persistedHash: H, ackFloor: 2 }); if (kind === "history_overflow") h.overflow = true; if (kind === "close_order") h.lifecycle = [...shutdownCodes.slice(0, 10), "owner_close_begin", "owner_close_end", "peer_closed", "admitted_return"].map((code, i) => ({ ordinal: i + 1, code })); return h; };
  const component = syntheticEffects(f), result = await r.runInviteAdmissionAbortCampaign(component.effects, { expectedHash: H, sources: r.componentSourceIds() }); assert.equal(result.success, false); assert.ok(result.failures.length > 0); if (kind !== "wrong_wire" && kind !== "reused_wire" && kind !== "history_overflow") assert.ok(component.calls.includes("close1")); assert.ok(!component.calls.includes("owner2"));
});
test("getter/private diagnostics, custom arrays and component provenance cannot pass output validation", async () => {
  const r = await runner(), c = syntheticEffects(), result = await r.runInviteAdmissionAbortCampaign(c.effects, { expectedHash: H, sources: r.componentSourceIds() }); let calls = 0;
  const getter = { ...result }; Object.defineProperty(getter, "failures", { enumerable: true, get() { calls++; return []; } }); assert.throws(() => r.validateInviteAbortResult(getter)); assert.equal(calls, 0);
  assert.throws(() => r.validateInviteAbortResult({ ...result, diagnostic: "private" })); assert.throws(() => r.validateInviteAbortResult({ ...result, label: "attempted-application" }));
  const a = [...result.deliveries]; Object.setPrototypeOf(a, Object.create(Array.prototype, { toJSON: { value() { calls++; } } })); assert.throws(() => r.validateInviteAbortResult({ ...result, deliveries: a })); assert.equal(calls, 0);
  assert.throws(() => r.validateInviteAbortResult({ ...result, sources: {} }));
});
for (const field of ["firstDurable", "finalDurable"] as const) for (const property of ["state", "reason"] as const) test(`failure evidence refuses private ${field}.${property} before writing`, async () => {
  const r = await runner(), c = syntheticEffects(), result = await r.runInviteAdmissionAbortCampaign(c.effects, { expectedHash: H, sources: r.componentSourceIds() });
  const root = mkdtempSync(path.join(tmpdir(), "meeting-abort-output-component-")), out = path.join(root, "evidence.json");
  try { const poisoned = { ...result, success: false, failures: ["invite_abort_effect"], [field]: { ...result[field], [property]: "private arbitrary diagnostic" } }; assert.throws(() => r.writeInviteAbortEvidence(out, poisoned)); assert.equal(existsSync(out), false); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
for (const code of shutdownCodes.slice(1, 9)) for (const variant of ["omitted", "duplicated", "reordered"] as const) test(`coherent shutdown history refuses ${variant} ${code}`, async () => {
  const r = await runner(), f = goodFacts(), originalHistory = f.history, originalClose = f.close;
  function codes() { const list = [...shutdownCodes], index = list.indexOf(code); if (variant === "omitted") list.splice(index, 1); if (variant === "duplicated") list.splice(index, 0, code); if (variant === "reordered") [list[index], list[index + 1]] = [list[index + 1]!, list[index]!]; return list; }
  f.history = owner => ({ ...originalHistory(owner), lifecycle: codes().map((code, i) => ({ ordinal: i + 1, code })) });
  f.close = owner => { const value = originalClose(owner), list = codes(); for (const [key, name] of [["publicCloseOrdinal", "public_close"], ["storeClosedOrdinal", "shutdown_store_closed"], ["preFixtureOrdinal", "pre_fixture"], ["peerClosedOrdinal", "peer_closed"], ["admittedReturnOrdinal", "admitted_return"], ["ownerCloseBeginOrdinal", "owner_close_begin"], ["ownerCloseEndOrdinal", "owner_close_end"]] as const) value[key] = list.indexOf(name) + 1; return value; };
  const c = syntheticEffects(f), result = await r.runInviteAdmissionAbortCampaign(c.effects, { expectedHash: H, sources: r.componentSourceIds() }); assert.equal(result.success, false); assert.ok(!c.calls.includes("owner2"));
});
test("deadline refuses before invoking an expired effect and preserves synchronous overrun and rejected-effect overrun", async () => {
  const r = await runner(); let now = 0, calls = 0;
  await assert.rejects(r.inviteAbortDeadline(() => { calls++; }, 0, 5, () => now)); assert.equal(calls, 0);
  await assert.rejects(r.inviteAbortDeadline(() => { now = 6; calls++; return {}; }, 5, 5, () => now)); assert.equal(calls, 1);
  now = 0; await assert.rejects(r.inviteAbortDeadline(() => { now = 6; throw new Error("private"); }, 5, 5, () => now), /invite_abort_deadline/);
});
test("real first-empty store/controller and real shared ACK decoder feed the finite consumer with explicitly synthetic wire status", async () => {
  const r = await runner(), faultApi = await import(path.resolve(import.meta.dirname, "invite-admission-abort-fault.mjs")), entry = await import(path.resolve(import.meta.dirname, "invite-admission-abort-entry.mjs")), peers = await import(path.resolve(import.meta.dirname, "feishu-peer.mjs"));
  const root = realpathSync(mkdtempSync(path.join(realpathSync(tmpdir()), "meeting-abort-wire-component-"))); chmodSync(root, 0o700); mkdirSync(path.join(root, "state"), { mode: 0o700 }); const databasePath = path.join(root, "state", "orchestration.db");
  const envelope = peers.inviteEnvelope({ eventId: "abort-original", providerMeetingId: "meeting-abort", meetingNo: "987654321", title: "Original title", startSeconds: 1700000000, inviteSeconds: 1700000000, createTimeMs: 1700000000000 }), n = normalizeInvite(envelope, peers.SCOPE), expectedHash = n.normalizedSha256;
  const open = () => openSessionStore({ filename: databasePath, migrationsDir: path.resolve(import.meta.dirname, "../migrations"), nowMs: 1700000000000 }); let store = open(), baseline: unknown, fault: ReturnType<typeof faultApi.createInviteAdmissionAbortFault>;
  const owners: number[] = [], statuses: string[] = [], facts = goodFacts();
  function durable() {
    const projection = entry.readInviteAbortProjection(databasePath, n.occurrenceId), row = projection.occurrences[0]; if (!baseline) baseline = projection;
    return { ...facts.durable, eventHash: n.normalizedSha256, acceptedAtMs: row.accepted_at_ms, state: row.state, reason: row.last_blocked_reason, totalAttempts: row.total_attempts, generationAttempts: row.generation_attempts, immutableSame: JSON.stringify(projection) === JSON.stringify(baseline), metadataSame: JSON.stringify(projection) === JSON.stringify(baseline) };
  }
  try {
    fault = faultApi.createInviteAdmissionAbortFault({ root, databasePath, appDatabasePath: databasePath, configDatabasePath: databasePath, freshRoot: faultApi.registerInviteAbortFixture(root), owner: { assertCurrentOwnership() { /* finite synthetic ownership only */ } }, envelope, scope: peers.SCOPE });
    const effects = { async beginOwner(owner: number) {
      owners.push(owner); if (owner === 2) store = open(); const receiver = peers.createFeishuFrameReceiver(), deliveries: ReturnType<typeof facts.deliveries.slice> = [];
      return { async ready() { return { admitted: true, started: true, endpoint200: true, connections: 1, receiverEmpty: true, commitEmpty: true, discoveryEmpty: true, sideEffectsZero: true }; }, empty() { return facts.empty; }, install() { return fault.install(); }, inspectFault() { return fault.inspect(); }, clear() { return fault.clear(); },
        async deliver(wireId: string) {
          const armed = fault.inspect(); let status: string;
          if (wireId === "abort-first") { assert.throws(() => store.acceptInvite(n, 1700000000001), { code: "SQLITE_CONSTRAINT_TRIGGER", message: "e2e_invite_admission_abort" }); assert.equal(store.getInviteOccurrence(n.occurrenceId), null); status = "rollback"; }
          else { status = store.acceptInvite(n, 1700000000002); assert.equal(status, wireId === "abort-recover" ? "accepted" : "replay"); }
          statuses.push(status);
          // Synthetic wire input is explicit and independent of the store throw.
          receiver.receive(peers.eventFrame({ code: wireId === "abort-first" ? 500 : 200 }, wireId)); const projected = entry.projectInviteAbortReceiver(receiver), observed = projected.observations.at(-1); assert.equal(observed.kind, "ack"); assert.equal(projected.invalid, false); assert.equal(projected.overflow, false);
          const fact = { owner, wireId, expectedHash, ack: { code: observed.payload.code, receiverOrdinal: observed.ordinal, matchingWire: observed.messageId === wireId }, commit: wireId === "abort-first" ? null : { ordinal: 1, persistedHash: n.normalizedSha256, ackFloor: observed.ordinal - 1 }, auditRows: wireId === "abort-first" ? 0 : entry.readInviteAbortProjection(databasePath, n.occurrenceId).counts.feishu_invite_events, occurrenceRows: store.listInviteOccurrences().length, fault: armed, receiverInvalid: receiver.invalid, receiverOverflow: receiver.overflow }; deliveries.push(fact); return fact;
        },
        async blocked() { const claim = store.claimInviteMetadata(1700000000003); if (claim) store.failInviteClaim(claim, { status: "blocked", reason: "reference_missing", retryable: false }, 1700000000003, 1000); return durable(); }, durable,
        async close() { store.close(); const history = facts.history(owner); history.acks = deliveries.map(d => ({ wireId: d.wireId, code: d.ack.code, receiverOrdinal: d.ack.receiverOrdinal })); history.commits = deliveries.filter(d => d.commit).map(d => ({ wireId: d.wireId, ...d.commit! })); return { close: facts.close(owner), history, durable: durable() }; },
      };
    } };
    const result = await r.runInviteAdmissionAbortCampaign(effects, { expectedHash, sources: r.componentSourceIds() }); assert.equal(result.success, true, JSON.stringify(result.failures)); assert.deepEqual(owners, [1, 2]); assert.deepEqual(statuses, ["rollback", "accepted", "replay"]); assert.equal(result.label, "component-facts");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
test("opaque thrown diagnostic getters are never evaluated or retained", async () => {
  const r = await runner(), c = syntheticEffects(); let reads = 0; c.effects.beginOwner = async () => { const error = new Error(); Object.defineProperty(error, "message", { get() { reads++; return "secret"; } }); throw error; }; const result = await r.runInviteAdmissionAbortCampaign(c.effects, { expectedHash: H, sources: r.componentSourceIds() }); assert.equal(reads, 0); assert.equal(result.success, false); assert.ok(!JSON.stringify(result).includes("secret"));
});
for (const variant of ["ordinary", "different_promise", "rejected", "late_change"] as const) test(`shared public close observes ${variant} with a fresh post-fulfillment snapshot`, async () => {
  const entry = await import(path.resolve(import.meta.dirname, "invite-admission-abort-entry.mjs")); let calls = 0, state = 0;
  const promise = variant === "rejected" ? Promise.reject(new Error("private")) : Promise.resolve(); promise.catch(() => {});
  const app = { close() { calls++; if (variant === "late_change" && calls === 3) state++; return variant === "different_promise" ? Promise.resolve() : promise; } };
  const fact = await entry.observeInviteAbortRepeatedClose(app, () => ({ selected: state })); assert.equal(calls, 3);
  assert.equal(fact.firstSecondSame, variant !== "different_promise"); assert.equal(fact.thirdSame, variant !== "different_promise"); assert.equal(fact.fulfilled, variant !== "rejected"); assert.equal(fact.repeatUnchanged, variant !== "late_change");
});
test("expired selected phase still invokes retained ordinary cleanup once and never begins owner two", async () => {
  const r = await runner(), c = syntheticEffects(); let now = 0;
  const begin = c.effects.beginOwner; c.effects.beginOwner = async owner => { const effects = await begin(owner); effects.install = () => { now = 40001; return goodFacts().fault("installed"); }; return effects; };
  const result = await r.runInviteAdmissionAbortCampaign(c.effects, { expectedHash: H, sources: r.componentSourceIds(), now: () => now }); assert.equal(result.success, false); assert.equal(c.calls.filter(s => s === "close1").length, 1); assert.ok(!c.calls.includes("owner2")); assert.ok(result.failures.includes("invite_abort_deadline"));
});
test("finite actual qualifier binds changed or missing stage-loaded L4 and media helpers without running stage", async () => {
  const entry = await import(path.resolve(import.meta.dirname, "invite-admission-abort-entry.mjs")), root = mkdtempSync(path.join(tmpdir(), "meeting-abort-qualification-component-")), repository = path.resolve(import.meta.dirname, "..");
  try {
    // Copy only this already qualified private compiler context, never a moving
    // candidate or original installation. No copied executable is invoked.
    for (const name of ["e2e", "dist", "migrations"]) cpSync(path.join(repository, name), path.join(root, name), { recursive: true });
    symlinkSync(path.join(repository, "node_modules"), path.join(root, "node_modules"), "dir");
    const original = entry.qualifyInviteAbortSources(root);
    for (const [role, file] of [["l4Campaign", "l4-campaign.mjs"], ["mediaClient", "media-client.mjs"]]) {
      const filename = path.join(root, "e2e", file!), bytes = readFileSync(filename);
      chmodSync(filename, 0o600); // Only this case's fresh private copy is mutated.
      writeFileSync(filename, Buffer.concat([bytes, Buffer.from("\n// qualification component change\n")]));
      assert.notEqual(entry.qualifyInviteAbortSources(root)[role!], original[role!], `changing the loaded ${file} must change its bound role`); writeFileSync(filename, bytes); renameSync(filename, filename + ".missing"); assert.throws(() => entry.qualifyInviteAbortSources(root)); renameSync(filename + ".missing", filename);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
const dependencyFiles = [
  ["sdk", "@larksuiteoapi/node-sdk", "package.json"], ["sdk", "@larksuiteoapi/node-sdk", "lib/index.js"],
  ["ws", "ws", "package.json"], ["ws", "ws", "index.js"], ["ws", "ws", "lib/websocket.js"], ["ws", "ws", "lib/websocket-server.js"],
  ...["package.json", "lib/index.js", "lib/binding.js", "lib/database.js", "lib/util.js", "lib/sqlite-error.js", "lib/methods/transaction.js", "lib/methods/wrappers.js", "lib/methods/pragma.js"].map(file => ["sqlite", "better-sqlite3", file]),
] as const;
for (const [role, dependency, file] of dependencyFiles) test(`finite dependency qualifier binds changed and missing ${dependency}/${file}`, async () => {
  const entry = await import(path.resolve(import.meta.dirname, "invite-admission-abort-entry.mjs")), repository = path.resolve(import.meta.dirname, ".."), require = createRequire(import.meta.url);
  const roots = { "@larksuiteoapi/node-sdk": path.dirname(path.dirname(require.resolve("@larksuiteoapi/node-sdk"))), ws: path.dirname(require.resolve("ws")), "better-sqlite3": path.dirname(path.dirname(require.resolve("better-sqlite3"))) };
  const root = mkdtempSync(path.join(tmpdir(), "meeting-abort-dependency-component-"));
  try {
    for (const name of ["e2e", "dist", "migrations"]) cpSync(path.join(repository, name), path.join(root, name), { recursive: true });
    // Only the named dependency bytes are copied; no SDK or WebSocket module
    // is executed. Private copies are writable without changing dependencies.
    for (const [, name, relative] of dependencyFiles) { const target = path.join(root, "node_modules", name!, relative!); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, readFileSync(path.join(roots[name as keyof typeof roots], relative!)), { mode: 0o600 }); }
    const native = require(path.join(roots["better-sqlite3"], "lib/binding.js")).getPrebuildPath();
    assert.equal(typeof native, "string"); const copiedNative = path.join(root, "node_modules/better-sqlite3", path.relative(roots["better-sqlite3"], native)); mkdirSync(path.dirname(copiedNative), { recursive: true }); writeFileSync(copiedNative, readFileSync(native), { mode: 0o600 });
    const original = entry.qualifyInviteAbortSources(root), filename = path.join(root, "node_modules", dependency!, file!), bytes = readFileSync(filename);
    writeFileSync(filename, Buffer.concat([bytes, Buffer.from("\n ")]));
    assert.notEqual(entry.qualifyInviteAbortSources(root)[role!], original[role!], `changing ${dependency}/${file} must change its fixed dependency role`);
    writeFileSync(filename, bytes); renameSync(filename, filename + ".missing"); assert.throws(() => entry.qualifyInviteAbortSources(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

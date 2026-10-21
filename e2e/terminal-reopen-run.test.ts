import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { StandaloneDependencies } from "../src/main.ts";
import type { StandaloneConfigV1 } from "../src/standalone-config.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { normalizeInvite } from "../src/ports/feishu-ingress.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { canonicalArtifactHash, canonicalArtifactJson } from "../src/contracts/teammem-meeting-v1.ts";
import { parseSupportedTeamMemMeetingArtifact } from "../src/contracts/teammem-meeting-v2.ts";
import { notificationRequestUuid } from "../src/delivery/notification-worker.ts";
const { SCOPE, inviteEnvelope, createFeishuFrameReceiver, eventFrame } = await import(path.join(import.meta.dirname, "feishu-peer.mjs"));
const { assertTerminalBaseline, readTerminalState, measureTerminalSources, runTerminalReplay, parseTerminalArguments, terminalFailure, copyTerminalEvidenceFiles, preserveTerminalAfter, terminalFiles } = await import(path.join(import.meta.dirname, "terminal-reopen-run.mjs"));

const END = Date.parse("2026-09-02T14:01:00Z"), commit = "f".repeat(40), url = `https://fixture.invalid/vault/blob/${commit}/Meetings/note.md`;
// C only: real normalizer/migrations/store APIs and synthetic recording,
// capability, provider result, publication and lifecycle facts. No SDK client.
async function fixture() {
  const root = mkdtempSync("/private/tmp/terminal-component-"), databasePath = path.join(root, "state.db"), recordings = path.join(root, "recordings");
  mkdirSync(recordings, { mode: 0o700 }); mkdirSync(path.join(root, "teammem"), { mode: 0o700 }); const audioStore = path.join(root, "teammem", "meeting-audio"); mkdirSync(audioStore, { mode: 0o700 });
  const handle = "a".repeat(32), recordingPath = path.join(recordings, `${handle}.crsr`), bytes = Buffer.from("component-only ciphertext"); writeFileSync(recordingPath, bytes, { mode: 0o600 });
  copyFileSync(recordingPath, path.join(audioStore, "first.enc")); linkSync(path.join(audioStore, "first.enc"), path.join(audioStore, "second.enc"));
  const sha256 = createHash("sha256").update(bytes).digest("hex"), capability = { sourceSessionId: 41n, recordingHandle: handle, sha256, keyId: "c".repeat(16), authorization: "d".repeat(64) };
  const envelope = inviteEnvelope({ eventId: "original-event", providerMeetingId: "component-meeting", meetingNo: "000000001", title: "Component", startSeconds: String((END - 60000) / 1000), inviteSeconds: String((END - 60000) / 1000), createTimeMs: END - 60000 });
  const invite = normalizeInvite(envelope, SCOPE), store = openSessionStore({ filename: databasePath, nowMs: END });
  store.acceptInvite(invite, END - 1000); const claim = store.claimInviteMetadata(END - 1000)!;
  store.completeInviteClaim(claim, { status: "resolved", reference: { kind: "reservation", reserveId: "synthetic" }, organizer: { ...SCOPE, idType: "open_id", id: "ou_owner", displayName: "Owner", source: "reservation" } }, END - 999);
  assert.equal(store.admitInviteJoin(invite.occurrenceId, END - 999), "admitted");
  const identity = buildMeetingIdentity({ providerMeetingId: invite.providerMeetingId, meetingNo: invite.meetingNo, occurrenceStartedAt: invite.occurrenceStartedAt,
    title: invite.title, organizer: { feishuUserId: "ou_owner", displayName: "Owner", source: "reservation" } });
  const coordinator = createCoordinator({ store, clock: { now: () => END }, bridgeLeaseTtlMs: 30000, maxConcurrentSessions: 1 });
  coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening");
  store.beginReconciliationGeneration(identity.occurrenceId, "component-bridge", END - 1000); store.setReconciliationRuntimeSession(identity.occurrenceId, "component-bridge", 41n);
  const owner = store.beginTimedEvidence({ occurrenceId: identity.occurrenceId, bridgeSessionId: "component-bridge", runtimeSessionId: 41n }, END - 1000); store.closeTimedEvidence(owner, END);
  coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, {
    recovery: { bridgeSessionId: "component-bridge", capability }, handle, encryptedPath: recordingPath, sha256, durationMs: 20, format: "pcm_s16le/24000/1/20ms", keyId: capability.keyId,
    gaps: [], runtimeGaps: [], captureDrain: { drain: "confirmed", reason: null, boundary: { captureEpoch: "1", lastFrameSequence: "1", outputEndSample: "480", finalClockPairSequence: "2" } },
  }, "component-bridge", END, "bridge_observed", { terminalReason: "ended", terminalSource: "bridge_observed", endedAt: new Date(END).toISOString(), identity, provider: "feishu", encryption: "aes-256-gcm", processingWarnings: [],
    provenance: { runtimeProfile: "online", sttProvider: "synthetic", sttModel: "synthetic", liveStreamModel: "synthetic", finalBatchModel: "synthetic", textProvider: "synthetic", textModel: "synthetic", agentVersion: "component" } });
  coordinator.completeReconciliationGeneration(identity.occurrenceId, "component-bridge", END, "bridge_observed", "ended");
  const recovery = store.getRecordingRecovery(identity.occurrenceId, "component-bridge", handle)!;
  const alignment = store.beginRecordingAlignment(recovery.generationId, "component-alignment"); assert.equal(alignment.kind, "claimed");
  if (alignment.kind !== "claimed") throw new Error("component alignment claim missing");
  store.completeRecordingAlignment(alignment.attempt, { type: "recording_alignment_complete", source: { sourceSessionId: 41n, recordingHandle: handle, sha256 },
    pageCount: 0n, coverageStatus: "available", warnings: [], traversalSucceeded: true });
  const seed = store.getBackfillSeed(identity.occurrenceId)!;
  const artifact = parseSupportedTeamMemMeetingArtifact({ schema: "teammem-meeting/v1", occurrence_id: seed.occurrenceId, revision: 1, provider: seed.provider, provider_meeting_id: seed.providerMeetingId,
    title: seed.title, started_at: seed.occurrenceStartedAt, ended_at: seed.endedAt, organizer: { person_id: "ou_owner", display_name: "Owner" }, organizer_source: "reservation", organizer_unresolved_reason: null,
    transcript_complete: false, summary: "Synthetic", participants: [{ person_id: "ou_owner", display_name: "Owner", attendance: [{ joined_at: seed.occurrenceStartedAt, left_at: seed.endedAt }] }], transcript: [], projects: [], decisions: [], action_items: [], discussion_points: [], person_summaries: [], recording_gaps: [], processing_warnings: [],
    provenance: { runtime_profile: "online", stt_provider: "synthetic", stt_model: "synthetic", text_provider: "synthetic", text_model: "synthetic", agent_version: "component", processed_at: new Date(END + 1).toISOString() },
    audio: { filename: "audio.enc", format: seed.recordingFormat, encryption: seed.recordingEncryption, duration_seconds: seed.recordingDurationMs / 1000, bytes: seed.recordingBytes, sha256: `sha256:${seed.recordingSha256}`, expires_at: new Date(seed.expiresAtMs).toISOString() } });
  const artifactHash = canonicalArtifactHash(artifact), build = store.claimBackfillSeedBuild({ nowMs: END + 1, claimToken: "1".repeat(32), operationBudgetMs: 1000 })!;
  store.savePending({ occurrenceId: seed.occurrenceId, revision: 1, artifactHash, recordingPath, bundlePath: path.join(root, "outbox"), endedAtMs: END, transcriptComplete: false,
    retryCount: 0, nextRetryAtMs: END + 1, retryReason: null, publishedAtMs: null, deletedAtMs: null, publicationUrl: null, vaultCommit: null, recoveryArtifact: canonicalArtifactJson(artifact), stageToken: "e".repeat(32), recordingHandle: handle },
  { kind: "initial", claimToken: build.claimToken, nowMs: END + 1 });
  const requestUuid = notificationRequestUuid({ occurrenceId: seed.occurrenceId, revision: 1, artifactHash, publicationUrl: url, vaultCommit: commit }), messageText = `Notes\n${url}`;
  store.acceptPublication({ occurrenceId: seed.occurrenceId, revision: 1, artifactHash, publicationUrl: url, vaultCommit: commit, publishedAtMs: END + 2,
    notification: { recipientId: "ou_owner", title: seed.title, messageText, requestUuid } });
  const notification = store.claimNotification({ nowMs: END + 3, claimToken: "2".repeat(32), claimTtlMs: 10000, requestTimeoutMs: 5000, dedupWindowMs: 3600000, dedupSafetyMarginMs: 60000 })!;
  store.completeNotification({ occurrenceId: seed.occurrenceId, revision: 1, claimToken: notification.claimToken!, providerMessageId: "synthetic-message", sentAtMs: END + 4 });
  const binding = { physicalClientId: "slot", physicalGenerationId: "3".repeat(32), occurrenceId: seed.occurrenceId, bridgeSessionId: "component-bridge" };
  store.claimPhysicalClient(binding, END - 1000); store.recordPhysicalOutcome(binding, { reaped: true, exitDiagnostic: null, failure: null,
    outcome: { schema: "bridge-process-outcome/v1", ...binding, outcome: "departure_confirmed", reason: "departure_observed", observedAt: new Date(END).toISOString() } }, END + 4);
  store.close(); const read = () => readTerminalState({ root, databasePath, occurrenceId: seed.occurrenceId });
  const state = read(), source = await measureTerminalSources(root, state);
  const baseline = { state, source, inviteHash: invite.normalizedSha256, files: [{ bytes: 1, sha256: "f".repeat(64) }], originalFiles: [] as unknown[],
    firstOwner: { closed: true, cleanupConfirmed: true, afterStoreClose: 0 }, publication: { verified: true, occurrenceId: seed.occurrenceId, revision: 1, artifactHash, publicationUrl: url, vaultCommit: commit, requestUuid, messageText, recipientId: "ou_owner" } };
  return { root, databasePath, invite, read, baseline, open: () => openSessionStore({ filename: databasePath, nowMs: END + 10 }), close: () => rmSync(root, { recursive: true, force: true }) };
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
type F = Awaited<ReturnType<typeof fixture>>;
function effects(f: F) {
  const receiver = createFeishuFrameReceiver(), calls: string[] = [];
  const activity = () => ({ outcomes: 0, messages: 0, runtimeStarts: 0, bridgeStarts: 0, metadataRequests: 0, notificationRequests: 0, trace: [],
    receiver: { invalid: receiver.invalid, overflow: receiver.overflow, observations: [...receiver.observations] } });
  return { calls, receiver, async baseline() { calls.push("baseline"); return f.baseline; }, async ready() { calls.push("ready"); return { admitted: true, started: true, connections: 1, state: f.read() }; },
    async activity() { return activity(); }, async read() { return f.read(); }, async discover() { calls.push("discover"); return { resolved: 0, launched: 0, deferred: 0 }; },
    async deliver(wireMessageId: string) { calls.push("deliver"); const store = f.open(); try { assert.equal(store.acceptInvite(f.invite, END + 10), "replay"); } finally { store.close(); }
      const state = f.read(), commit = { wireMessageId, eventId: state.event.eventId, normalizedSha256: state.event.normalizedSha256, beforeAck: receiver.observations.length === 0, count: 1 };
      receiver.receive(eventFrame({ code: 200 }, wireMessageId)); return { state, commit, activity: activity() }; },
    async close() { calls.push("close"); return { exit: 0, compositionClosed: true, ownerClosedLast: true, peerClosed: true, httpClosed: true, socketClosed: true, connections: 0, outcomes: 0, failures: [],
      trace: ["shutdown_fenced", "shutdown_owned_work_settled", "shutdown_application_closed", "shutdown_runtime_owners_closed", "shutdown_transports_closed", "shutdown_store_closed"],
      state: f.read(), source: f.baseline.source, files: f.baseline.files, activity: activity() }; } };
}
const plan = { wireMessageId: "fresh-wire", originalWireMessageId: "original-wire" };
const protectedRoles = ["config/standalone.json", "runtime-launcher", "bridge-control/summary.json", "bridge-control/state.json", "bridge-control/events.ndjson", "bridge-control/end",
  "bridge-control/teammem-done", "runtime/gateway-pids.txt", "config/bridge-static.json", "runtime/gateway.toml", "runtime/launcher.stderr.log", "bridge-control/runtime-events.ndjson"];
function originalFixture(f: F) {
  const bundleDir = path.join(f.root, "bundle"), receiptPath = path.join(f.root, "receipt.json"); mkdirSync(bundleDir, { mode: 0o700 });
  for (const directory of ["bridge-control", "runtime", "config"]) mkdirSync(path.join(f.root, directory), { mode: 0o700 });
  for (const filename of [path.join(bundleDir, "READY"), path.join(bundleDir, "meeting.json"), path.join(bundleDir, "manifest.json"), receiptPath,
    ...protectedRoles.filter(role => role !== "bridge-control/runtime-events.ndjson").map(role => path.join(f.root, role))]) writeFileSync(filename, "C synthetic retained bytes", { mode: 0o600 });
  // Independent observed-before DTO from owned files; not accepted actual hashes.
  f.baseline.originalFiles = protectedRoles.map(role => {
    const filename = path.join(f.root, role); if (!existsSync(filename)) return { role, present: false };
    const stat = lstatSync(filename), bytes = readFileSync(filename);
    return { role, present: true, device: String(stat.dev), inode: String(stat.ino), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const selected = { root: f.root, databasePath: f.databasePath, occurrenceId: f.invite.occurrenceId, bundleDir, receiptPath, baseline: f.baseline };
  f.baseline.files = terminalFiles(selected); return selected;
}
test("C: genuine notified store replays exact normalized invite with decoded ACK and two discovery passes", async () => {
  const f = await fixture(); try { assertTerminalBaseline(f.baseline); const e = effects(f), before = f.read(); const result = await runTerminalReplay(plan, e);
    assert.equal(result.success, true); assert.equal(result.provenance, "component_controller"); assert.equal(result.discoveryPasses, 2); assert.equal(result.replayAcks, 1); assert.equal(result.newMessages, 0);
    assert.deepEqual(e.calls, ["baseline", "ready", "discover", "deliver", "discover", "close"]); assert.deepEqual(f.read(), before);
    assert.doesNotMatch(JSON.stringify(result), /authorization|credential|capability|ou_owner|sourceSessionId|fixture.invalid/);
  } finally { f.close(); }
});
for (const [name, mutate, expected] of [
  ["finalizing", (b: F["baseline"]) => { b.state.session.state = "finalizing"; }, "terminal_notified_required"],
  ["published", (b: F["baseline"]) => { b.state.session.state = "published"; }, "terminal_notified_required"],
  ["unsent", (b: F["baseline"]) => { b.state.notification.state = "pending"; }, "terminal_sent_required"],
  ["uncertain", (b: F["baseline"]) => { b.state.notification.ambiguous = 1; }, "terminal_sent_required"],
  ["recipient mismatch", (b: F["baseline"]) => { b.state.notification.recipientId = "foreign"; }, "terminal_notification_binding"],
  ["receipt mismatch", (b: F["baseline"]) => { b.publication.artifactHash = "sha256:" + "0".repeat(64); }, "terminal_publication_binding"],
  ["unverified receipt", (b: F["baseline"]) => { b.publication.verified = false; }, "terminal_publication_binding"],
  ["changed original invite", (b: F["baseline"]) => { b.inviteHash = "0".repeat(64); }, "terminal_original_invite"],
  ["changed original title", (b: F["baseline"]) => { b.state.invite.title = "changed"; }, "terminal_original_invite"],
  ["changed acceptance clock", (b: F["baseline"]) => { b.state.invite.acceptedAtMs++; }, "terminal_original_invite"],
  ["notification claimed", (b: F["baseline"]) => { b.state.notification.claimed = 1; }, "terminal_sent_required"],
  ["wrong generation", (b: F["baseline"]) => { b.state.custody.bridgeSessionId = "foreign"; }, "terminal_first_recording_owner"],
  ["timed owner active", (b: F["baseline"]) => { b.state.timedOwner.state = "active"; }, "terminal_first_recording_owner"],
  ["first owner unclosed", (b: F["baseline"]) => { b.firstOwner.closed = false; }, "terminal_first_owner_close"],
  ["first reap absent", (b: F["baseline"]) => { b.firstOwner.cleanupConfirmed = false; }, "terminal_first_owner_close"],
  ["second notification attempt", (b: F["baseline"]) => { b.state.notification.attemptCount = 2; }, "terminal_sent_required"],
  ["retry cleared", (b: F["baseline"]) => { b.state.r2.job.state = "complete"; }, "terminal_retry_authority"],
  ["source replaced", (b: F["baseline"]) => { b.source.inode = "foreign"; }, "terminal_source_identity"],
] as const) test(`C prerequisite refuses ${name} before admission`, async () => {
  const f = await fixture(); try { const original = f.baseline; f.baseline = clone(original); mutate(f.baseline); const e = effects(f), result = await runTerminalReplay(plan, e);
    assert.equal(result.success, false); assert.equal(result.failures[0], expected); assert.equal(e.calls.includes("ready"), false);
  } finally { f.close(); }
});
for (const [name, field] of [["resolved", "resolved"], ["launched", "launched"], ["deferred", "deferred"]] as const) test(`C awaited discovery rejects ${name}`, async () => {
  const f = await fixture(); try { const e = effects(f); e.discover = async () => ({ resolved: 0, launched: 0, deferred: 0, [field]: 1 });
    const result = await runTerminalReplay(plan, e); assert.equal(result.failures[0], "terminal_discovery"); assert.equal(e.calls.includes("deliver"), false); assert.ok(e.calls.includes("close"));
  } finally { f.close(); }
});
for (const variant of ["ack-before-commit", "duplicate-commit", "wrong-event", "second-notification-attempt", "schema-mutated"] as const) test(`C replay rejects ${variant}`, async () => {
  const f = await fixture(); try { const e = effects(f), deliver = e.deliver;
    e.deliver = async wire => { const d = await deliver(wire);
      if (variant === "ack-before-commit") d.commit.beforeAck = false;
      else if (variant === "duplicate-commit") d.commit.count = 2;
      else if (variant === "wrong-event") d.commit.eventId = "wrong-event";
      else if (variant === "second-notification-attempt") d.state.notification.attemptCount = 2;
      else d.state.schemaSha256 = "f".repeat(64);
      return d; };
    const result = await runTerminalReplay(plan, e); assert.equal(result.failures[0], ["second-notification-attempt", "schema-mutated"].includes(variant) ? "terminal_replay_mutation" : "terminal_durable_commit");
    assert.ok(e.calls.includes("close"));
  } finally { f.close(); }
});
test("C rejects reused wire before owner admission and invalid budget before effects", async () => {
  const f = await fixture(); try { const e = effects(f), result = await runTerminalReplay({ ...plan, wireMessageId: plan.originalWireMessageId }, e);
    assert.equal(result.failures[0], "terminal_fresh_wire"); assert.equal(e.calls.includes("ready"), false);
    await assert.rejects(runTerminalReplay(plan, e, { budgetMs: NaN }), /terminal_budget/);
  } finally { f.close(); }
});
test("C byte custody copies exclusively with private modes and stable original identities", () => {
  const root = mkdtempSync("/private/tmp/terminal-backup-component-"); try {
    const original = path.join(root, "original"), before = path.join(root, "before"); mkdirSync(before, { mode: 0o700 });
    const bytes = Buffer.from("synthetic-private-bytes"); writeFileSync(original, bytes, { mode: 0o600 }); const inode = lstatSync(original).ino;
    const copied = copyTerminalEvidenceFiles([original], before); assert.deepEqual(readFileSync(copied[0].copyPath), bytes); assert.equal(lstatSync(original).ino, inode);
    assert.equal(lstatSync(copied[0].copyPath).mode & 0o077, 0); assert.notEqual(lstatSync(copied[0].copyPath).ino, inode);
    assert.equal(copied[0].sha256, createHash("sha256").update(bytes).digest("hex")); assert.doesNotMatch(JSON.stringify(copied), /synthetic-private-bytes/);
    assert.throws(() => copyTerminalEvidenceFiles([original], before), /EEXIST/); chmodSync(before, 0o755); assert.throws(() => copyTerminalEvidenceFiles([original], before), /terminal_backup_directory/);
    let invoked = 0; const bad = Object.defineProperty([], "0", { get() { invoked++; return original; } });
    assert.throws(() => copyTerminalEvidenceFiles(bad, root), /ingress_data_descriptor/); assert.equal(invoked, 0);
    const symlink = path.join(root, "symlink"); symlinkSync(original, symlink); assert.throws(() => copyTerminalEvidenceFiles([symlink], root), /terminal_physical_path/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("C before bytes remain distinct from same-inode after evidence with exact durable preservation", async () => {
  const f = await fixture(), output = mkdtempSync("/private/tmp/terminal-after-component-"); try {
    const selected = originalFixture(f), beforeDir = path.join(output, "before"); mkdirSync(beforeDir, { mode: 0o700 });
    const copies = copyTerminalEvidenceFiles([f.databasePath], beforeDir), originalBytes = readFileSync(f.databasePath), originalInode = lstatSync(f.databasePath).ino;
    const store = f.open(); assert.equal(store.acceptInvite(f.invite, END + 10), "replay"); store.close();
    const after = await preserveTerminalAfter(selected, output, { manifestPath: "C-before-manifest", sha256: copies[0].sha256 });
    assert.equal(after.preserved, true); assert.equal(lstatSync(f.databasePath).ino, originalInode); assert.deepEqual(readFileSync(copies[0].copyPath), originalBytes);
    assert.deepEqual(f.read(), f.baseline.state); const manifest = JSON.parse(readFileSync(after.manifestPath, "utf8")); assert.equal(manifest.phase, "after"); assert.equal(manifest.preservedDurableState, true);
    assert.doesNotMatch(JSON.stringify(manifest), /authorization|credential|ou_owner|synthetic-private-bytes/);
  } finally { f.close(); rmSync(output, { recursive: true, force: true }); }
});
for (const role of ["config/standalone.json", "bridge-control/events.ndjson", "runtime/launcher.stderr.log", "bridge-control/runtime-events.ndjson"]) test(`C original-role after evidence rejects changed or created ${role}`, async () => {
  const f = await fixture(), output = mkdtempSync("/private/tmp/terminal-role-component-"); try {
    const selected = originalFixture(f), beforeState = f.read(), beforeFiles = clone(f.baseline.files), beforeOriginal = clone(f.baseline.originalFiles);
    const filename = path.join(f.root, role); writeFileSync(filename, "C changed or newly created bytes", { mode: 0o600 });
    const after = await preserveTerminalAfter(selected, output, { manifestPath: "C-before-manifest", sha256: "f".repeat(64) });
    assert.equal(after.preserved, false); const manifest = JSON.parse(readFileSync(after.manifestPath, "utf8"));
    assert.equal(manifest.preservedOriginalFiles, false); assert.equal(manifest.preservedDurableState, true); assert.equal(manifest.originalFiles.length, 12);
    assert.equal(manifest.originalFiles.find((row: { role: string }) => row.role === role).present, true);
    assert.deepEqual(f.read(), beforeState); assert.deepEqual(terminalFiles(selected), beforeFiles); assert.deepEqual(f.baseline.originalFiles, beforeOriginal);
    assert.doesNotMatch(JSON.stringify(after), /changed or newly created bytes/);
  } finally { f.close(); rmSync(output, { recursive: true, force: true }); }
});
for (const variant of ["launch", "metadata", "message", "custody", "duplicate-ack", "wrong-wire", "late-ack", "close-order", "wrong-root", "late-source", "deadline"] as const) test(`C controller refuses ${variant} without hiding cleanup`, async () => {
  const f = await fixture(); try {
    const e = effects(f), originalActivity = e.activity, originalDeliver = e.deliver, originalClose = e.close, originalRead = e.read;
    if (variant === "launch" || variant === "metadata" || variant === "message") e.activity = async () => { const a = await originalActivity(); if (variant === "launch") a.outcomes = 1; if (variant === "metadata") a.metadataRequests = 1; if (variant === "message") a.messages = 1; return a; };
    if (variant === "custody" || variant === "wrong-root") e.read = async () => { const s = await originalRead(); if (variant === "custody") s.durable.physical_client_custody.count = 2; else s.rootIdentity.inode = "foreign"; return s; };
    if (variant === "duplicate-ack" || variant === "wrong-wire") e.deliver = async wire => { const d = await originalDeliver(wire); if (variant === "duplicate-ack") e.receiver.receive(eventFrame({ code: 200 }, wire)); else { d.activity.receiver.observations[0]!.messageId = "stale-wire"; } if (variant === "duplicate-ack") d.activity = await e.activity(); return d; };
    if (variant === "deadline") e.discover = async () => new Promise(() => undefined);
    e.close = async () => { const c = await originalClose(); if (variant === "close-order") [c.trace[2], c.trace[5]] = [c.trace[5]!, c.trace[2]!];
      if (variant === "late-ack") { e.receiver.receive(eventFrame({ code: 200 }, "fresh-wire")); c.activity = await originalActivity(); }
      if (variant === "late-source") { c.source = clone(c.source); c.source.bytes++; } return c; };
    const result = await runTerminalReplay(plan, e, variant === "deadline" ? { budgetMs: 20, cleanupMs: 100 } : {});
    assert.equal(result.success, false); assert.ok(e.calls.includes("close"));
    const expected = ["launch", "metadata", "message"].includes(variant) ? "terminal_unexpected_work" : ["custody", "wrong-root"].includes(variant) ? "terminal_baseline_mutation" :
      ["duplicate-ack", "wrong-wire", "late-ack"].includes(variant) ? "terminal_receiver" : variant === "close-order" ? "terminal_close_order" : variant === "late-source" ? "terminal_final_preservation" : "terminal_deadline";
    assert.equal(result.failures[0], expected);
  } finally { f.close(); }
});
test("C guarded readonly reader rejects foreign root, sidecar, symlink and schema drift without repair", async () => {
  const f = await fixture(); try {
    const before = readFileSync(f.databasePath); assert.deepEqual(f.read(), f.baseline.state); assert.deepEqual(readFileSync(f.databasePath), before);
    assert.throws(() => readTerminalState({ root: path.join(f.root, "recordings"), databasePath: f.databasePath, occurrenceId: f.invite.occurrenceId }), /terminal_root_binding/);
    writeFileSync(f.databasePath + "-wal", "synthetic"); assert.throws(f.read, /terminal_database_sidecar/); rmSync(f.databasePath + "-wal");
    const linked = path.join(f.root, "linked.db"); symlinkSync(f.databasePath, linked); assert.throws(() => readTerminalState({ root: f.root, databasePath: linked, occurrenceId: f.invite.occurrenceId }), /terminal_physical_path/);
    const db = new Database(f.databasePath); db.exec("CREATE TABLE unexpected(value TEXT)"); db.close(); assert.throws(f.read, /terminal_schema_tables/);
  } finally { f.close(); }
});
test("C argument/public failure projections are literal, bounded and getter-free", () => {
  assert.deepEqual(parseTerminalArguments(["--baseline", "/private/tmp/baseline.json", "--out", "/private/tmp/new-terminal-report.json"]), { baseline: "/private/tmp/baseline.json", out: "/private/tmp/new-terminal-report.json" });
  assert.throws(() => parseTerminalArguments(["--out", "relative", "--baseline", "/private/tmp/x"]), /terminal_arguments/);
  let invoked = 0; const error = Object.defineProperty({}, "message", { get() { invoked++; return "secret"; } }); assert.equal(terminalFailure(error), "terminal_failed"); assert.equal(invoked, 0);
});

// Finite standalone/actual-adapter contract control. No real owner, app, SDK,
// listener, Runtime, native device or original accepted root is opened.
test("C actual config callback admits synchronous config through standalone lifecycle", async () => {
  const { runStandalone } = await import("../src/main.ts");
  const { inspectStateRoot, STANDALONE_SCHEMA } = await import("../src/standalone-config.ts");
  const { terminalConfigReader } = await import(path.join(import.meta.dirname, "terminal-reopen-entry.mjs"));
  const { runExposedComposition } = await import(path.join(import.meta.dirname, "composition-lifecycle.mjs"));
  const root = mkdtempSync("/private/tmp/terminal-admission-component-");
  try {
    const stateRoot = path.join(root, "state"); mkdirSync(stateRoot, { mode: 0o700 });
    const config = { schema: STANDALONE_SCHEMA, stateRoot,
      feishu: { region: "feishu" as const, tenantKey: "synthetic", appId: "cli_synthetic", appSecretFile: path.join(root, "secret") },
      agentIdentity: { aliases: ["Synthetic"] },
      dataPaths: { recordingsDir: path.join(root, "recordings"), outboxDir: path.join(root, "outbox"), receiptsDir: path.join(root, "receipts"), teamVaultDir: path.join(root, "vault") },
      runtime: { launcherPath: path.join(root, "launcher"), gatewayConfigPath: path.join(root, "gateway"), protocolVersion: 4 as const }, bridgeSlots: [] };
    const order: string[] = [], controller = new globalThis.AbortController();
    const owner = { assertCurrentOwnership() {}, close() { order.push("owner_close"); } };
    const store = { closed: false, close() { assert.equal(this.closed, false); this.closed = true; order.push("store_close"); } };
    const reader = terminalConfigReader({ databasePath: path.join(stateRoot, "state.db") }, {
      readStandaloneConfig(filename: string) { assert.equal(filename, path.join(root, "config.json")); order.push("read"); return config; },
    });
    const exit = await runStandalone(["--standalone-config", path.join(root, "config.json")], {
      readConfig: reader,
      inspectStateRoot(value) { order.push("inspect"); inspectStateRoot(value); assert.equal(value, config); },
      async acquireOwnerLock(value) { assert.equal(value, stateRoot); order.push("lock"); return owner; },
      async composeAfterAdmission(value, lock) {
        assert.equal(value, config); assert.equal(lock, owner); order.push("compose");
        return runExposedComposition(async (sameConfig: unknown, sameOwner: unknown) => {
          assert.equal(sameConfig, config); assert.equal(sameOwner, owner);
          return { async start() { order.push("start"); }, async discover() { order.push("discover"); controller.abort(); }, async close() { store.close(); } };
        }, value, lock, {}, () => { order.push("handle"); }, controller);
      }, report() { order.push("report"); },
    });
    assert.equal(exit, 0); assert.equal(store.closed, true);
    assert.deepEqual(order, ["read", "inspect", "lock", "compose", "handle", "start", "discover", "store_close", "report", "owner_close"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("C shared config reader returns exact object synchronously and throws root/read refusals synchronously", async () => {
  const { terminalConfigReader } = await import(path.join(import.meta.dirname, "terminal-reopen-entry.mjs"));
  const config = { stateRoot: "/private/tmp/synthetic-state" }, selected = { databasePath: "/private/tmp/synthetic-state/state.db" };
  assert.equal(terminalConfigReader(selected, { readStandaloneConfig: () => config })("/private/tmp/config.json"), config);
  assert.throws(() => terminalConfigReader(selected, { readStandaloneConfig: () => ({ stateRoot: "/private/tmp/wrong-state" }) })("/private/tmp/config.json"), /terminal_config_root/);
  const refusal = new Error("synthetic private read refusal");
  assert.throws(() => terminalConfigReader(selected, { readStandaloneConfig() { throw refusal; } })("/private/tmp/config.json"), error => error === refusal);
});

for (const variant of ["promise-regression", "root-binding", "read-reference", "read-failure", "inspect-reference", "lock-held", "composition-unavailable", "composition-failed"] as const)
  test(`C standalone stages distinguish ${variant} without private error text`, async () => {
    const { runStandalone } = await import("../src/main.ts");
    const { StandaloneConfigError, inspectStateRoot } = await import("../src/standalone-config.ts");
    const { terminalConfigReader, terminalStaticDiagnostic, terminalStageFacts } = await import(path.join(import.meta.dirname, "terminal-reopen-entry.mjs"));
    const config = { stateRoot: "/private/tmp/synthetic-state" } as StandaloneConfigV1;
    const diagnostics: string[] = [], order: string[] = [];
    let ownerAttempted = false, admitted = false, compositionEntered = false, compositionResult;
    const owner = { assertCurrentOwnership() {}, close() { order.push("owner_close"); } };
    const readConfig = terminalConfigReader({ databasePath: "/private/tmp/synthetic-state/state.db" }, { readStandaloneConfig() {
      order.push("read");
      if (variant === "read-reference") throw new StandaloneConfigError("reference", "config");
      if (variant === "read-failure") throw new Error("secret private path/config/wire payload");
      return variant === "root-binding" ? { ...config, stateRoot: "/private/tmp/wrong-state" } : config;
    } });
    // Deliberate historical async adapter control; this Promise is fulfilled.
    // It is rejected by real inspectStateRoot before any owner can be taken.
    const reader = variant === "promise-regression" ? (async (filename: string) => readConfig(filename)) as unknown as StandaloneDependencies["readConfig"] : readConfig;
    const exit = await runStandalone(["--standalone-config", "/private/tmp/config.json"], {
      readConfig: reader,
      inspectStateRoot(value) { order.push("inspect");
        if (variant === "promise-regression") inspectStateRoot(value);
        else if (variant === "inspect-reference") throw new StandaloneConfigError("reference", "stateRoot");
        else assert.equal(value, config);
      },
      async acquireOwnerLock() { ownerAttempted = true; order.push("lock");
        if (variant === "lock-held") throw new Error("application_owner_lock_held");
        admitted = true; return owner;
      },
      async composeAfterAdmission() { compositionEntered = true; order.push("compose");
        if (variant === "composition-failed") throw new Error("secret private composition reason");
        compositionResult = { status: "composition_unavailable" as const, reason: "secret_private_reason" }; return compositionResult;
      },
      report(channel, line) { const code = terminalStaticDiagnostic(channel, line); if (code) diagnostics.push(code); },
    });
    const facts = terminalStageFacts({ standaloneExit: exit, ownerAttempted, admitted, compositionEntered, compositionResult, readiness: "failed", diagnostics, trace: [], close: null });
    if (variant.startsWith("composition-")) {
      assert.equal(exit, 70); assert.equal(facts.ownerAcquisition, "acquired"); assert.equal(facts.composition, variant === "composition-failed" ? "failed" : "unavailable");
      assert.deepEqual(order, ["read", "inspect", "lock", "compose", "owner_close"]);
    } else if (variant === "lock-held") {
      assert.equal(exit, 75); assert.equal(facts.ownerAcquisition, "attempted"); assert.equal(facts.composition, "not_entered"); assert.deepEqual(diagnostics, ["owner_lock_held"]);
    } else {
      assert.equal(exit, ["root-binding", "read-failure"].includes(variant) ? 70 : 65);
      assert.equal(facts.ownerAcquisition, "not_attempted"); assert.equal(facts.composition, "not_entered");
      assert.equal(order.includes("lock"), false); assert.equal(order.includes("compose"), false); assert.equal(order.includes("owner_close"), false);
      assert.deepEqual(diagnostics, [["root-binding", "read-failure"].includes(variant) ? "config_admission_failed" : "config_reference_refusal"]);
      assert.equal(order.includes("inspect"), ["promise-regression", "inspect-reference"].includes(variant));
    }
    assert.doesNotMatch(JSON.stringify(facts), /secret|private_reason|payload|wrong-state|config\.json/);
  });

test("C exact diagnostic allowlist and bounded stage projection discard unknown text and retain close facts", async () => {
  const { terminalStaticDiagnostic, terminalStageFacts } = await import(path.join(import.meta.dirname, "terminal-reopen-entry.mjs"));
  for (const line of ["meeting-agent: standalone config grammar error in privateField", "meeting-agent: standalone config reference error in secret",
    "meeting-agent: application_owner_lock_private", "meeting-agent: composition_unavailable private_secret_reason", "raw payload", "meeting-agent: composition failed\nprivate"])
    assert.equal(terminalStaticDiagnostic("stderr", line), null);
  assert.equal(terminalStaticDiagnostic("stdout", "meeting-agent: composition failed"), null);
  assert.equal(terminalStaticDiagnostic("stderr", "meeting-agent: standalone config grammar error in bridgeSlots[7]"), "config_grammar_refusal");
  assert.equal(terminalStaticDiagnostic("stderr", "meeting-agent: standalone config grammar error in bridgeSlots[8]"), null);
  const trace = ["shutdown_fenced", "private wire", "shutdown_owned_work_settled", "shutdown_application_closed", "shutdown_runtime_owners_closed", "shutdown_transports_closed", "shutdown_store_closed"];
  const facts = terminalStageFacts({ standaloneExit: 0, ownerAttempted: true, admitted: true, compositionEntered: true, compositionResult: { status: "composition_closed", clean: true }, readiness: "ready",
    diagnostics: [...Array(17).fill("composition_closed"), "private diagnostic"], trace, close: { compositionClosed: true, ownerClosedLast: true, peerClosed: true, httpClosed: false, socketClosed: true, raw: "private payload" } });
  assert.equal(facts.standaloneExit, 0); assert.equal(facts.ownerAcquisition, "acquired"); assert.equal(facts.composition, "closed"); assert.equal(facts.compositionClean, true); assert.equal(facts.readiness, "ready");
  assert.equal(facts.diagnosticOverflow, true); assert.equal(facts.diagnostics.length, 16); assert.deepEqual(facts.shutdownCodes, trace.filter(code => code !== "private wire"));
  assert.deepEqual(facts.close, { compositionClosed: true, ownerClosedLast: true, peerClosed: true, httpClosed: false, socketClosed: true });
  assert.doesNotMatch(JSON.stringify(facts), /private|wire|payload/);
});

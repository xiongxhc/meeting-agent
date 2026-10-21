// Retention for encrypted recordings that no delivery, backfill seed or
// unknown-end custody row covers (stop/finalize failures, a failed finalize
// transaction, a crash mid-meeting), and for capture rows a crash left open.
//
// Every store is a real SQLite file in a private temp root; recordings are
// synthetic bytes, never audio. The sweep runs at composition start and on
// every custody-lane tick.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";

import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { composeApplication, type ComposedApplication } from "../src/application-composition.ts";
import { createApplicationMaintenance, type MaintenanceOwner, type MaintenanceSupervisor } from "../src/application-maintenance.ts";
import type { BackfillGatewayTransport } from "../src/delivery/backfill-worker.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import type { SessionStore } from "../src/ports/session-store.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { STANDALONE_SCHEMA, type StandaloneConfigV1 } from "../src/standalone-config.ts";
import { testCapability } from "./lib/runtime-sdk.ts";
import { scope } from "./lib/feishu-fixtures.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 14 * DAY_MS;
const GRACE_MS = 72 * 60 * 60 * 1000;
const START_MS = Date.parse("2026-09-02T14:00:00.000Z");
const PROVENANCE = { runtimeProfile: "online", sttProvider: "stt", sttModel: "stt-v1", liveStreamModel: "live-v1",
  finalBatchModel: "final-v1", textProvider: "text", textModel: "text-v1", agentVersion: "test" } as const;

type Roots = { dir: string; recordingsDir: string; outboxDir: string; receiptsDir: string; filename: string; close(): void };

function roots(): Roots {
  const dir = realpathSync(mkdtempSync(path.join(realpathSync(tmpdir()), "meeting-retention-")));
  const recordingsDir = path.join(dir, "recordings"), outboxDir = path.join(dir, "outbox"), receiptsDir = path.join(dir, "receipts");
  for (const name of [recordingsDir, outboxDir, receiptsDir]) { mkdirSync(name, { mode: 0o700 }); chmodSync(name, 0o700); }
  return { dir, recordingsDir, outboxDir, receiptsDir, filename: path.join(dir, "state.db"), close: () => rmSync(dir, { recursive: true, force: true }) };
}

function handleOf(label: string): string {
  return createHash("sha256").update(label).digest("hex").slice(0, 32);
}

/** A Runtime-named encrypted file nothing in the store references, last written at `lastWriteMs`. */
function orphan(r: Roots, label: string, lastWriteMs: number): { handle: string; file: string } {
  const handle = handleOf(label);
  const file = path.join(r.recordingsDir, `${handle}.crsr`);
  writeFileSync(file, Buffer.from(`synthetic-ciphertext-${label}`), { mode: 0o600 });
  utimesSync(file, lastWriteMs / 1000, lastWriteMs / 1000);
  return { handle, file };
}

function retentionRow(filename: string, handle: string): { state: string; deadline_ms: number; settled_at_ms: number | null } | undefined {
  const db = new Database(filename, { readonly: true });
  try {
    return db.prepare("SELECT state, deadline_ms, settled_at_ms FROM recording_retention WHERE recording_handle = ?").get(handle) as
      { state: string; deadline_ms: number; settled_at_ms: number | null } | undefined;
  } finally { db.close(); }
}

type Supervisor = MaintenanceSupervisor & { live: Set<string> };
function supervisor(): Supervisor {
  const live = new Set<string>();
  return { live, assertOwnership() {}, occurrenceIsLive: (id) => live.has(id), holdsFinalizedRecording: () => false, anyOccurrenceLive: () => live.size > 0 };
}

function gracefulTransport(): BackfillGatewayTransport {
  return { cleanupOutcome: { status: "graceful" as const }, messages: { async *[Symbol.asyncIterator]() { /* scripted */ } }, async send() {}, async close() {} } as BackfillGatewayTransport;
}

function maintenance(store: SessionStore, r: Roots, wall: () => number, sup: MaintenanceSupervisor, log: string[] = []): MaintenanceOwner {
  return createApplicationMaintenance({
    store, clock: { now: wall }, dataPaths: { recordingsDir: r.recordingsDir, outboxDir: r.outboxDir, receiptsDir: r.receiptsDir, teamVaultDir: path.join(r.dir, "vault") },
    runtime: { launcherPath: path.join(r.dir, "launcher"), gatewayConfigPath: path.join(r.dir, "gateway.toml") }, env: { PATH: "/usr/bin:/bin" },
    supervisor: sup, discover: async () => undefined, log: (code) => log.push(code),
    notificationSender: { async sendText() { return { messageId: "om_1" }; } },
    options: { random: () => 0, intervalsMs: { backfill: 3_600_000, warning: 3_600_000, outbox: 3_600_000, notification: 3_600_000, discovery: 3_600_000, custody: 3_600_000 },
      backfill: { operationBudgetMs: 1_000, cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 }, startTransport: async () => gracefulTransport() } },
  });
}

/** A stale capture a crash left behind: session listening, generation admitted to the Runtime and never terminated. */
function staleCapture(store: SessionStore, wall: () => number, suffix = "") {
  const identity = buildMeetingIdentity({ providerMeetingId: `stale${suffix}`, meetingNo: `77700${suffix.length}`, occurrenceStartedAt: "2026-09-02T14:00:00Z",
    title: `Stale${suffix}`, organizer: null });
  const coordinator = createCoordinator({ store, clock: { now: wall }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 1 });
  coordinator.discover(identity); coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening");
  store.beginReconciliationGeneration(identity.occurrenceId, `bridge${suffix}`, START_MS);
  store.setReconciliationRuntimeSession(identity.occurrenceId, `bridge${suffix}`, 41n);
  return identity.occurrenceId;
}

function generationTerminal(filename: string, occurrenceId: string): { terminal_at_ms: number | null; terminal_source: string | null; expires_at_ms: number | null } {
  const db = new Database(filename, { readonly: true });
  try {
    return db.prepare("SELECT terminal_at_ms, terminal_source, expires_at_ms FROM reconciliation_generations WHERE occurrence_id = ?").get(occurrenceId) as
      { terminal_at_ms: number | null; terminal_source: string | null; expires_at_ms: number | null };
  } finally { db.close(); }
}

/** A known-ended recording owned by its backfill seed (the delivery policy path). */
function seeded(store: SessionStore, r: Roots, wall: () => number) {
  const handle = handleOf("seeded");
  const recordingPath = path.join(r.recordingsDir, `${handle}.crsr`);
  const bytes = Buffer.from("synthetic-encrypted-recording-seeded");
  writeFileSync(recordingPath, bytes);
  utimesSync(recordingPath, (START_MS - DAY_MS) / 1000, (START_MS - DAY_MS) / 1000);
  const capability = { ...testCapability, recordingHandle: handle, sha256: createHash("sha256").update(bytes).digest("hex") };
  const identity = buildMeetingIdentity({ providerMeetingId: "seeded", meetingNo: "42420", occurrenceStartedAt: "2026-09-02T14:00:00Z",
    title: "Seeded", organizer: { feishuUserId: "ou_owner", displayName: "Owner", source: "reservation" } });
  const coordinator = createCoordinator({ store, clock: { now: wall }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 1 });
  coordinator.discover(identity); coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening");
  const binding = { occurrenceId: identity.occurrenceId, bridgeSessionId: "bridge-seeded", runtimeSessionId: 41n };
  store.beginReconciliationGeneration(identity.occurrenceId, "bridge-seeded", START_MS);
  store.setReconciliationRuntimeSession(identity.occurrenceId, "bridge-seeded", 41n);
  const timed = store.beginTimedEvidence(binding, START_MS);
  store.appendTimedUi(timed, { schema: "bridge-session/v2", sessionId: "bridge-seeded", sequence: 1, observedAt: "2026-09-02T14:00:00Z",
    type: "participant_joined", feishuUserId: "ou_owner", displayName: "Owner", observationTiming: null, observationTimingReason: "timing_unavailable" }, START_MS + 1);
  store.closeTimedEvidence(timed, START_MS + 600_000);
  coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, {
    recovery: { bridgeSessionId: "bridge-seeded", capability }, handle, encryptedPath: recordingPath, sha256: capability.sha256, durationMs: 20,
    format: "pcm_s16le/24000/1/20ms", keyId: capability.keyId, gaps: [], runtimeGaps: [],
  }, "bridge-seeded", START_MS + 600_000, "bridge_observed", { terminalReason: "ended", terminalSource: "bridge_observed", endedAt: new Date(START_MS + 600_000).toISOString(),
    identity, provider: "feishu", encryption: "aes-256-gcm", processingWarnings: [], provenance: PROVENANCE });
  assert.notEqual(store.getBackfillSeed(identity.occurrenceId), null);
  return { handle, recordingPath };
}

test("an unowned recording (failed stop, finalize or finalize transaction) gets a 14-day deadline and is deleted at it, not before", async () => {
  const r = roots();
  let wall = START_MS;
  const store = openSessionStore({ filename: r.filename, nowMs: START_MS });
  const log: string[] = [];
  const owner = maintenance(store, r, () => wall, supervisor(), log);
  try {
    const { handle, file } = orphan(r, "stop-failed", START_MS);
    assert.equal(await owner.tick("custody"), "custody_idle");
    assert.equal(existsSync(file), true);
    const adopted = retentionRow(r.filename, handle);
    assert.equal(adopted?.state, "assigned");
    assert.equal(adopted?.deadline_ms, START_MS + RETENTION_MS, "deadline is the last write plus 14 days");
    wall = START_MS + RETENTION_MS - 1;
    await owner.tick("custody");
    assert.equal(existsSync(file), true, "not one millisecond early");
    wall = START_MS + RETENTION_MS;
    await owner.tick("custody");
    assert.equal(existsSync(file), false, "deleted at the deadline");
    assert.equal(retentionRow(r.filename, handle)?.state, "deleted");
    assert.ok(log.includes("retention_recording_adopted") && log.includes("retention_recording_deleted"));
    assert.ok(log.every((code) => /^[a-z_]+$/.test(code)), "static codes only");
    await owner.close();
  } finally { store.close(); r.close(); }
});

test("a recording found already past last write + 14 days gets a 72-hour grace and one counted warning, then is deleted", async () => {
  const r = roots();
  const found = START_MS + 20 * DAY_MS;
  let wall = found;
  const store = openSessionStore({ filename: r.filename, nowMs: START_MS });
  const log: string[] = [];
  const owner = maintenance(store, r, () => wall, supervisor(), log);
  try {
    const { handle, file } = orphan(r, "crash", START_MS);
    orphan(r, "crash-two", START_MS + DAY_MS);
    await owner.tick("custody");
    assert.equal(existsSync(file), true, "never deleted by the sweep that first finds it");
    assert.equal(retentionRow(r.filename, handle)?.deadline_ms, found + GRACE_MS);
    assert.deepEqual(owner.status().warnings, [{ code: "retention_grace_applied", count: 2 }]);
    assert.equal(log.filter((code) => code === "maintenance_retention_grace_applied").length, 1);
    wall = found + GRACE_MS - 1;
    await owner.tick("custody");
    assert.equal(existsSync(file), true);
    assert.equal(owner.status().warnings.length, 1, "the warning is raised once, at adoption");
    wall = found + GRACE_MS;
    await owner.tick("custody");
    assert.equal(existsSync(file), false);
    await owner.close();
  } finally { store.close(); r.close(); }
});

test("a finalized recording no policy covers yet is kept while its own occurrence is live and deleted once it is not, even if another is live", async () => {
  const r = roots();
  let wall = START_MS;
  const store = openSessionStore({ filename: r.filename, nowMs: START_MS });
  const sup = supervisor();
  const owner = maintenance(store, r, () => wall, sup);
  try {
    const bytes = Buffer.from("synthetic-ciphertext-referenced");
    const capability = { ...testCapability, sourceSessionId: 160n, recordingHandle: handleOf("referenced"), sha256: createHash("sha256").update(bytes).digest("hex") };
    const file = path.join(r.recordingsDir, `${capability.recordingHandle}.crsr`);
    writeFileSync(file, bytes);
    utimesSync(file, START_MS / 1000, START_MS / 1000);
    const identity = buildMeetingIdentity({ providerMeetingId: "referenced", meetingNo: "555000222", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Referenced", organizer: null });
    const coordinator = createCoordinator({ store, clock: { now: () => wall }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 1 });
    coordinator.discover(identity); coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening");
    store.beginReconciliationGeneration(identity.occurrenceId, "bridge-ref", START_MS);
    store.setReconciliationRuntimeSession(identity.occurrenceId, "bridge-ref", capability.sourceSessionId);
    coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, {
      recovery: { bridgeSessionId: "bridge-ref", capability }, handle: capability.recordingHandle, encryptedPath: file, sha256: capability.sha256,
      durationMs: 600_000, format: "pcm_s16le/24000/1/20ms", keyId: capability.keyId, gaps: [], runtimeGaps: [] }, "bridge-ref", START_MS, "local_clock");
    assert.equal(store.getBackfillSeed(identity.occurrenceId), null, "no seed: only the referencing occurrence protects this file");
    sup.live.add(identity.occurrenceId);
    await owner.tick("custody");
    assert.equal(retentionRow(r.filename, capability.recordingHandle)?.state, "assigned");
    wall = START_MS + RETENTION_MS;
    await owner.tick("custody");
    assert.equal(existsSync(file), true, "its own occurrence is still live");
    sup.live.delete(identity.occurrenceId);
    sup.live.add("another-live-occurrence");
    await owner.tick("custody");
    assert.equal(existsSync(file), false, "another live occurrence does not hold a referenced file");
    await owner.close();
  } finally { store.close(); r.close(); }
});

test("a recording still awaiting delivery under its seed policy is never adopted or deleted by the sweep", async () => {
  const r = roots();
  const wall = START_MS + 13 * DAY_MS;
  const store = openSessionStore({ filename: r.filename, nowMs: START_MS });
  const owner = maintenance(store, r, () => wall, supervisor());
  try {
    const { handle, recordingPath } = seeded(store, r, () => START_MS + 600_000);
    await owner.tick("custody");
    assert.equal(existsSync(recordingPath), true, "the seed's own deadline (ended + 14 days) governs this file");
    assert.equal(retentionRow(r.filename, handle), undefined);
    await owner.close();
  } finally { store.close(); r.close(); }
});

test("while a session is live an unreferenced recording is never deleted, even past its deadline; it is deleted once nothing is live", async () => {
  const r = roots();
  let wall = START_MS;
  const store = openSessionStore({ filename: r.filename, nowMs: START_MS });
  const sup = supervisor();
  sup.live.add("live-occurrence");
  const owner = maintenance(store, r, () => wall, sup);
  try {
    const { file } = orphan(r, "maybe-live", START_MS);
    await owner.tick("custody");
    wall = START_MS + 15 * DAY_MS;
    await owner.tick("custody");
    assert.equal(existsSync(file), true, "a live Runtime may still be writing an unreferenced file");
    sup.live.clear();
    await owner.tick("custody");
    assert.equal(existsSync(file), false);
    await owner.close();
  } finally { store.close(); r.close(); }
});

test("a deletion interrupted after detach completes from its tombstone on the next sweep", async () => {
  const r = roots();
  let wall = START_MS;
  const store = openSessionStore({ filename: r.filename, nowMs: START_MS });
  const owner = maintenance(store, r, () => wall, supervisor());
  try {
    const { handle, file } = orphan(r, "interrupted", START_MS);
    await owner.tick("custody");
    const stat = lstatSync(file, { bigint: true });
    const tombstone = path.join(r.recordingsDir, `.recording-delete-seed-${handle}-${stat.dev}-${stat.ino}`);
    renameSync(file, tombstone);
    wall = START_MS + RETENTION_MS;
    await owner.tick("custody");
    assert.equal(existsSync(tombstone), false);
    assert.equal(retentionRow(r.filename, handle)?.state, "deleted");
    await owner.close();
  } finally { store.close(); r.close(); }
});

test("a stale listening session and its open capture generation are adopted into retention when no live entry owns them", async () => {
  const r = roots();
  const wall = START_MS + 60_000;
  const store = openSessionStore({ filename: r.filename, nowMs: START_MS });
  const sup = supervisor();
  const owner = maintenance(store, r, () => wall, sup);
  try {
    const stale = staleCapture(store, () => START_MS, "-a");
    const live = staleCapture(store, () => START_MS, "-bb");
    sup.live.add(live);
    await owner.tick("custody");
    assert.equal(store.getSession(stale)?.state, "failed");
    assert.deepEqual(generationTerminal(r.filename, stale), { terminal_at_ms: wall, terminal_source: "local_clock", expires_at_ms: wall + RETENTION_MS });
    assert.equal(store.getSession(live)?.state, "listening", "a live entry's rows are never touched");
    assert.equal(generationTerminal(r.filename, live).terminal_at_ms, null);
    await owner.close();
  } finally { store.close(); r.close(); }
});

test("composition start sweeps before any lane tick: an old unowned recording is adopted under the grace with a counted warning and a stale listening row is failed", async () => {
  const dir = realpathSync(mkdtempSync(path.join(realpathSync(tmpdir()), "meeting-retention-composition-")));
  const stateRoot = path.join(dir, "state");
  mkdirSync(stateRoot, { mode: 0o700 }); chmodSync(stateRoot, 0o700);
  for (const name of ["recordings", "outbox", "receipts", "vault"]) { mkdirSync(path.join(dir, name), { mode: 0o700 }); chmodSync(path.join(dir, name), 0o700); }
  writeFileSync(path.join(dir, "app-secret"), "synthetic-app-secret\n", { mode: 0o600 });
  const config: StandaloneConfigV1 = {
    schema: STANDALONE_SCHEMA, stateRoot,
    feishu: { region: "feishu", tenantKey: scope.tenantKey, appId: scope.appId, appSecretFile: path.join(dir, "app-secret") },
    agentIdentity: { aliases: ["Meetbot"] },
    dataPaths: { recordingsDir: path.join(dir, "recordings"), outboxDir: path.join(dir, "outbox"), receiptsDir: path.join(dir, "receipts"), teamVaultDir: path.join(dir, "vault") },
    runtime: { launcherPath: path.join(dir, "runtime-launcher"), gatewayConfigPath: path.join(dir, "gateway.toml"), protocolVersion: 4 },
    bridgeSlots: [{ physicalClientId: "mac-1", bridgeId: "bridge-1", executable: "/usr/bin/true", staticConfigPath: path.join(dir, "bridge-static.json"), argv: [], cooperativeGraceMs: 1000 }],
  };
  const wall = START_MS + 15 * DAY_MS;
  const seedStore = openSessionStore({ filename: path.join(stateRoot, "orchestration.db"), nowMs: START_MS });
  const stale = staleCapture(seedStore, () => START_MS);
  seedStore.close();
  const r: Roots = { dir, recordingsDir: config.dataPaths.recordingsDir, outboxDir: config.dataPaths.outboxDir, receiptsDir: config.dataPaths.receiptsDir, filename: "", close() {} };
  const { file } = orphan(r, "before-restart", START_MS);
  let app: ComposedApplication | undefined;
  try {
    app = await composeApplication(config, { assertCurrentOwnership() {}, close() {} }, { inviteIngress: false, clock: { now: () => wall },
      bridgeSlots: [{ physicalClientId: "mac-1", bridgeId: "bridge-1", async launch() { throw new Error("no live occurrence in this test"); } }],
      metadata: { async resolve() { return { status: "blocked", reason: "reference_missing", retryable: false }; } },
      maintenance: { notificationSender: { async sendText() { return { messageId: "om_1" }; } }, random: () => 0,
        intervalsMs: { outbox: 3_600_000, notification: 3_600_000, discovery: 3_600_000, warning: 3_600_000, custody: 3_600_000, backfill: 3_600_000 } } });
    assert.equal(existsSync(file), true, "construction sweeps nothing");
    await app.start();
    assert.equal(app.maintenanceStatus().lanes.find((entry) => entry.lane === "custody")?.ticks, 0);
    assert.equal(existsSync(file), true, "the first sweep after deploy never deletes");
    assert.deepEqual(app.maintenanceStatus().warnings, [{ code: "retention_grace_applied", count: 1 }]);
    await app.close();
    const reopened = openSessionStore({ filename: path.join(stateRoot, "orchestration.db"), nowMs: wall });
    try { assert.equal(reopened.getSession(stale)?.state, "failed"); } finally { reopened.close(); }
  } finally { await app?.close().catch(() => undefined); rmSync(dir, { recursive: true, force: true }); }
});

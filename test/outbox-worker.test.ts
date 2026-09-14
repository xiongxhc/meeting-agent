import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import Database from "better-sqlite3";

import { parseTeamMemMeetingArtifact, canonicalArtifactHash, canonicalArtifactJson } from "../src/contracts/teammem-meeting-v1.ts";
import { deleteDeliveredEvidence, writeMeetingBundle } from "../src/adapters/filesystem-outbox.ts";
import { readPublicationReceipt } from "../src/adapters/receipt-inbox.ts";
import { occurrencePathSegment, type OccurrenceId } from "../src/domain/occurrence-id.ts";
import { createOutboxWorker, type DeliveryJournal, type DeliveryRow } from "../src/delivery/outbox-worker.ts";
import { createNotificationWorker } from "../src/delivery/notification-worker.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import type { AcceptPublicationInput } from "../src/ports/session-store.ts";

const FIXTURES = new URL("../fixtures/contracts/", import.meta.url);
const SHA = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const NOOP_PURGE = { purgeExpiredReconciliationEvidence: () => 0 };
const MIGRATIONS = path.resolve(import.meta.dirname, "..", "migrations");

function harness(): { root: string; recordings: string; outbox: string; receipts: string; cleanup(): void } {
  const root = mkdtempSync(path.join(tmpdir(), "meeting-outbox-test-"));
  const recordings = path.join(root, "recordings");
  const outbox = path.join(root, "outbox");
  const receipts = path.join(root, "receipts");
  mkdirSync(recordings);
  mkdirSync(receipts);
  return { root, recordings, outbox, receipts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runtimeRecordingPath(h: ReturnType<typeof harness>, digit = "a"): string {
  return path.join(h.recordings, `${digit.repeat(32)}.crsr`);
}

function artifactAndAudio(fixture = "teammem-meeting-v1.complete.json"): { artifact: ReturnType<typeof parseTeamMemMeetingArtifact>; bytes: Buffer; serialized: string; hash: string } {
  const artifact = structuredClone(JSON.parse(readFileSync(new URL(fixture, FIXTURES), "utf8"))) as Record<string, unknown>;
  const bytes = Buffer.from("synthetic encrypted audio bytes; never a container header", "utf8");
  const audio = artifact.audio as Record<string, unknown>;
  audio.bytes = bytes.length;
  audio.sha256 = SHA(bytes);
  const parsed = parseTeamMemMeetingArtifact(artifact);
  return { artifact: parsed, bytes, serialized: canonicalArtifactJson(parsed), hash: canonicalArtifactHash(parsed) };
}

class FakeJournal implements DeliveryJournal {
  readonly rows = new Map<string, DeliveryRow>();
  readonly notificationIntents = new Map<string, AcceptPublicationInput["notification"]>();
  failSave = false;
  private readonly onFirstPublication: (occurrenceId: string) => void;

  constructor(onFirstPublication: (occurrenceId: string) => void = () => undefined) {
    this.onFirstPublication = onFirstPublication;
  }

  savePending(row: DeliveryRow): void {
    if (this.failSave) throw new Error("synthetic journal failure");
    this.rows.set(`${row.occurrenceId}:${row.revision}`, row);
  }
  pending(): readonly DeliveryRow[] { return [...this.rows.values()].filter((row) => row.deletedAtMs === null); }
  update(row: DeliveryRow): void { this.savePending(row); }
  acceptPublication(input: AcceptPublicationInput): void {
    const row = this.rows.get(`${input.occurrenceId}:${input.revision}`);
    if (row === undefined) throw new Error("unknown delivery");
    this.update({ ...row, publishedAtMs: input.publishedAtMs, publicationUrl: input.publicationUrl, vaultCommit: input.vaultCommit, retryReason: null });
    this.notificationIntents.set(`${input.occurrenceId}:${input.revision}`, input.notification);
    if (row.publishedAtMs === null) this.onFirstPublication(input.occurrenceId);
  }
}

function publishedReceipt(artifact: ReturnType<typeof parseTeamMemMeetingArtifact>, hash: string): Record<string, unknown> {
  const commit = "a".repeat(40);
  return {
    artifact_hash: hash,
    markdown_path: "Meetings/2026-W36/[meeting].md",
    markdown_url: `https://example.test/group/vault/-/blob/${commit}/Meetings/2026-W36/%5Bmeeting%5D.md`,
    occurrence_id: artifact.occurrence_id,
    revision: artifact.revision,
    schema: "teammem-meeting-receipt/v1",
    status: "published",
    vault_commit: commit,
  };
}

function durableWorker(h: ReturnType<typeof harness>, built = artifactAndAudio()) {
  const filename = path.join(h.root, "orchestration.db");
  const source = runtimeRecordingPath(h);
  writeFileSync(source, built.bytes);
  let now = Date.parse(built.artifact.ended_at) + 1_000;
  let store = openSessionStore({ filename, nowMs: now });
  store.createSession({ occurrenceId: built.artifact.occurrence_id, providerMeetingId: built.artifact.provider_meeting_id, occurrenceStartedAt: built.artifact.started_at, nowMs: now });
  store.finalizeSession({
    transition: { occurrenceId: built.artifact.occurrence_id, fromState: "discovered", toState: "awaiting_teammem", reason: "test", terminalReason: null, nowMs: now },
    recording: { handle: "a".repeat(32), encryptedPath: source, sha256: SHA(built.bytes).slice(7), durationMs: 1, format: "opus", keyId: "fake-key", gaps: [], runtimeGaps: [] },
  });
  const worker = () => createOutboxWorker({
    outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal: store,
    clock: { now: () => now }, random: () => 0, reconciliationEvidence: store,
    session: {
      state: (id) => store.getSession(id)?.state ?? null,
      publish: (id) => { store.transition({ occurrenceId: id, fromState: "awaiting_teammem", toState: "published", reason: "receipt", terminalReason: null, nowMs: now }); },
    },
  });
  const bundle = worker().enqueue({ artifact: built.artifact, serializedArtifact: built.serialized, artifactHash: built.hash, recordingPath: source });
  return {
    filename, source, bundle, worker,
    store: () => store,
    now: () => now,
    advance: (value: number) => { now = value; },
    receipt: () => writeFileSync(path.join(h.receipts, `${occurrencePathSegment(built.artifact.occurrence_id as OccurrenceId)}.json`), `${JSON.stringify(publishedReceipt(built.artifact, built.hash))}\n`),
    reopen: () => { store.close(); store = openSessionStore({ filename, nowMs: now }); },
    close: () => store.close(),
  };
}

for (const legacyMarker of [false, true]) {
  test(`SQLite reopen converges after deletion commit failure (legacy marker: ${legacyMarker})`, () => {
    const h = harness();
    const built = artifactAndAudio();
    const d = durableWorker(h, built);
    const raw = new Database(d.filename);
    try {
      d.receipt();
      raw.exec("CREATE TRIGGER fail_deletion BEFORE UPDATE ON delivery_journal WHEN NEW.deleted_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT, 'deletion_update_before_commit'); END");
      d.worker().reconcile();
      const acceptedAt = d.now();
      assert.equal(d.store().getSession(built.artifact.occurrence_id)?.state, "published");
      assert.equal(d.store().pending()[0]!.publishedAtMs, acceptedAt);
      assert.equal(d.store().pending()[0]!.deletedAtMs, null);
      assert.equal(d.store().pending()[0]!.recoveryArtifact, built.serialized);
      assert.deepEqual(d.store().notifications().map((row) => [row.revision, row.state, row.recipientId]), [[built.artifact.revision, "pending", built.artifact.organizer!.person_id]]);
      assert.equal(existsSync(d.source), false);
      assert.equal(existsSync(d.bundle), false);
      raw.exec("DROP TRIGGER fail_deletion");
      if (legacyMarker) raw.exec("UPDATE delivery_journal SET retry_reason = 'recovery_unavailable'");
      d.advance(acceptedAt + 1_000);
      d.reopen();
      const reopened = d.store().pending()[0]!;
      assert.equal(reopened.retryReason, null, "a missing published source is cleanup progress, not recovery failure");
      d.worker().reconcile();
      const deleted = raw.prepare("SELECT published_at_ms, publication_url, vault_commit, deleted_at_ms, retry_reason, recovery_artifact FROM delivery_journal").get();
      assert.deepEqual(deleted, {
        published_at_ms: acceptedAt, publication_url: publishedReceipt(built.artifact, built.hash).markdown_url,
        vault_commit: "a".repeat(40), deleted_at_ms: acceptedAt + 1_000, retry_reason: null, recovery_artifact: null,
      });
      for (let replay = 0; replay < 2; replay += 1) {
        d.advance(d.now() + 1_000);
        d.reopen();
        d.worker().reconcile();
        assert.deepEqual(raw.prepare("SELECT published_at_ms, publication_url, vault_commit, deleted_at_ms, retry_reason, recovery_artifact FROM delivery_journal").get(), deleted);
        assert.deepEqual(d.store().pending(), []);
        assert.equal(existsSync(d.source), false);
        assert.equal(existsSync(d.bundle), false);
      }
      assert.equal(d.store().listTransitions(built.artifact.occurrence_id).filter((row) => row.toState === "published").length, 1);
    } finally { raw.close(); d.close(); h.cleanup(); }
  });
}

test("publication and session transition roll back when durable notification intent cannot commit", () => {
  const h = harness();
  const built = artifactAndAudio();
  const d = durableWorker(h, built);
  const raw = new Database(d.filename);
  try {
    d.worker().reconcile();
    assert.equal(d.store().pending()[0]!.publishedAtMs, null);
    assert.deepEqual(d.store().notifications(), []);
    d.advance(d.store().pending()[0]!.nextRetryAtMs);
    d.receipt();
    raw.exec("CREATE TRIGGER fail_notification BEFORE INSERT ON notification_intents BEGIN SELECT RAISE(ABORT, 'notification_insert_before_commit'); END");
    d.worker().reconcile();
    assert.equal(d.store().getSession(built.artifact.occurrence_id)?.state, "awaiting_teammem");
    assert.equal(d.store().pending()[0]!.publishedAtMs, null);
    assert.deepEqual(d.store().notifications(), []);
    assert.equal(existsSync(d.source), true);
    assert.equal(existsSync(d.bundle), true);
    raw.exec("DROP TRIGGER fail_notification");
    d.worker().reconcile();
    assert.equal(d.store().getSession(built.artifact.occurrence_id)?.state, "published");
    assert.equal(d.store().notifications().length, 1);
  } finally { raw.close(); d.close(); h.cleanup(); }
});

test("schema-17 publication with retained canonical metadata derives its intent before cleanup", () => {
  const h = harness();
  const built = artifactAndAudio();
  const legacyMigrations = path.join(h.root, "migrations-17");
  mkdirSync(legacyMigrations);
  for (const name of readdirSync(MIGRATIONS).filter((candidate) => Number.parseInt(candidate, 10) <= 17)) {
    copyFileSync(path.join(MIGRATIONS, name), path.join(legacyMigrations, name));
  }
  const filename = path.join(h.root, "legacy.db");
  const source = runtimeRecordingPath(h);
  writeFileSync(source, built.bytes);
  let store = openSessionStore({ filename, migrationsDir: legacyMigrations, nowMs: 1 });
  try {
    store.createSession({ occurrenceId: built.artifact.occurrence_id, providerMeetingId: built.artifact.provider_meeting_id, occurrenceStartedAt: built.artifact.started_at, nowMs: 1 });
    store.finalizeSession({
      transition: { occurrenceId: built.artifact.occurrence_id, fromState: "discovered", toState: "awaiting_teammem", reason: "test", terminalReason: null, nowMs: 2 },
      recording: { handle: "a".repeat(32), encryptedPath: source, sha256: SHA(built.bytes).slice(7), durationMs: 1, format: "opus", keyId: "fake", gaps: [], runtimeGaps: [] },
    });
    const worker = () => createOutboxWorker({ outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal: store, clock: { now: () => 10 }, random: () => 0, session: { state: (id) => store.getSession(id)?.state ?? null, publish: () => assert.fail("atomic store owns publication") }, reconciliationEvidence: store });
    const bundle = worker().enqueue({ artifact: built.artifact, serializedArtifact: built.serialized, artifactHash: built.hash, recordingPath: source });
    store.transition({ occurrenceId: built.artifact.occurrence_id, fromState: "awaiting_teammem", toState: "published", reason: "legacy", terminalReason: null, nowMs: 3 });
    store.update({ ...store.pending()[0]!, publishedAtMs: 3, publicationUrl: publishedReceipt(built.artifact, built.hash).markdown_url as string, vaultCommit: "a".repeat(40) });

    const malformedArtifact = parseTeamMemMeetingArtifact({ ...built.artifact, occurrence_id: "vc:legacy-malformed@2026-09-02T14:00:00Z", provider_meeting_id: "vc:legacy-malformed" });
    const malformedHash = canonicalArtifactHash(malformedArtifact);
    const malformedSource = runtimeRecordingPath(h, "b");
    writeFileSync(malformedSource, built.bytes);
    store.createSession({ occurrenceId: malformedArtifact.occurrence_id, providerMeetingId: malformedArtifact.provider_meeting_id, occurrenceStartedAt: malformedArtifact.started_at, nowMs: 1 });
    store.finalizeSession({
      transition: { occurrenceId: malformedArtifact.occurrence_id, fromState: "discovered", toState: "awaiting_teammem", reason: "test", terminalReason: null, nowMs: 2 },
      recording: { handle: "b".repeat(32), encryptedPath: malformedSource, sha256: SHA(built.bytes).slice(7), durationMs: 1, format: "opus", keyId: "fake", gaps: [], runtimeGaps: [] },
    });
    worker().enqueue({ artifact: malformedArtifact, serializedArtifact: canonicalArtifactJson(malformedArtifact), artifactHash: malformedHash, recordingPath: malformedSource });
    store.transition({ occurrenceId: malformedArtifact.occurrence_id, fromState: "awaiting_teammem", toState: "published", reason: "legacy", terminalReason: null, nowMs: 3 });
    const malformedRow = store.pending().find((row) => row.occurrenceId === malformedArtifact.occurrence_id)!;
    store.update({ ...malformedRow, publishedAtMs: 3, publicationUrl: publishedReceipt(malformedArtifact, malformedHash).markdown_url as string, vaultCommit: "a".repeat(40), recoveryArtifact: "{malformed" });
    store.close();

    store = openSessionStore({ filename, nowMs: 4 });
    assert.deepEqual(store.notifications(), [], "retained canonical metadata must not be blanket-classified unavailable");
    const oldTask10 = new Database(filename);
    try {
      oldTask10.prepare(
        `INSERT INTO notification_intents
          (occurrence_id, revision, artifact_hash, publication_url, vault_commit, state, terminal_reason, next_attempt_at_ms)
         SELECT occurrence_id, revision, artifact_hash, publication_url, vault_commit,
                'terminal', 'notification_inputs_unavailable', published_at_ms
           FROM delivery_journal WHERE occurrence_id = ?`,
      ).run(built.artifact.occurrence_id);
    } finally { oldTask10.close(); }
    worker().reconcile();
    assert.deepEqual(store.notifications().map((row) => [row.occurrenceId, row.state, row.recipientId, row.title, row.terminalReason]), [
      [built.artifact.occurrence_id, "pending", built.artifact.organizer!.person_id, built.artifact.title, null],
      [malformedArtifact.occurrence_id, "terminal", null, null, "notification_inputs_unavailable"],
    ]);
    assert.equal(existsSync(source), false);
    assert.equal(existsSync(bundle), false);
  } finally { store.close(); h.cleanup(); }
});

test("real SQLite rejects negative receipts and sends nothing before authoritative publication", async () => {
  const h = harness();
  const built = artifactAndAudio();
  const d = durableWorker(h, built);
  try {
    let sends = 0;
    const notificationWorker = createNotificationWorker({
      store: d.store(),
      sender: { sendText: async () => { sends += 1; return { messageId: "impossible" }; } },
      clock: { now: d.now }, random: () => 0, requestTimeoutMs: 5, claimTtlMs: 10, dedupSafetyMarginMs: 60_000,
    });
    d.worker().reconcile();
    assert.equal(d.store().getSession(built.artifact.occurrence_id)?.state, "awaiting_teammem");
    assert.deepEqual(d.store().notifications(), []);
    await notificationWorker.poll();
    assert.equal(sends, 0);

    const receiptFile = path.join(h.receipts, `${occurrencePathSegment(built.artifact.occurrence_id as OccurrenceId)}.json`);
    const invalidReceipts = [
      { ...publishedReceipt(built.artifact, built.hash), revision: built.artifact.revision + 1 },
      { ...publishedReceipt(built.artifact, built.hash), artifact_hash: `sha256:${"f".repeat(64)}` },
      { ...publishedReceipt(built.artifact, built.hash), status: "failed" },
    ];
    for (const receipt of invalidReceipts) {
      writeFileSync(receiptFile, `${JSON.stringify(receipt)}\n`);
      d.worker().reconcile();
      assert.equal(d.store().getSession(built.artifact.occurrence_id)?.state, "awaiting_teammem");
      assert.deepEqual(d.store().notifications(), []);
      d.advance(d.store().pending()[0]!.nextRetryAtMs);
    }
    await notificationWorker.poll();
    assert.equal(sends, 0);
  } finally { d.close(); h.cleanup(); }
});

test("null-organizer artifact never derives its attendee as recipient and sends nothing", async () => {
  const h = harness();
  const built = artifactAndAudio("teammem-meeting-v1.minimal.json");
  const d = durableWorker(h, built);
  try {
    assert.equal(built.artifact.organizer, null);
    assert.equal(built.artifact.participants[0]!.person_id, "ou_ada", "legitimate attendee remains tempting but unrelated");
    d.receipt();
    d.worker().reconcile();
    const intent = d.store().notifications()[0]!;
    assert.equal(intent.terminalReason, "organizer_unresolved");
    assert.equal(intent.recipientId, null);
    assert.notEqual(intent.recipientId, built.artifact.participants[0]!.person_id);
    let sends = 0;
    await createNotificationWorker({ store: d.store(), sender: { sendText: async () => { sends += 1; return { messageId: "impossible" }; } }, clock: { now: d.now }, random: () => 0, requestTimeoutMs: 5, claimTtlMs: 10, dedupSafetyMarginMs: 60_000 }).poll();
    assert.equal(sends, 0);
  } finally { d.close(); h.cleanup(); }
});

test("a complete higher revision accepted after notified cleans retained evidence without replaying published", () => {
  const h = harness();
  const first = artifactAndAudio();
  const incomplete = parseTeamMemMeetingArtifact({ ...first.artifact, transcript_complete: false });
  const incompleteSerialized = canonicalArtifactJson(incomplete);
  const incompleteHash = canonicalArtifactHash(incomplete);
  const d = durableWorker(h, { ...first, artifact: incomplete, serialized: incompleteSerialized, hash: incompleteHash });
  try {
    d.receipt();
    d.worker().reconcile();
    const claim = d.store().claimNotification({ nowMs: d.now(), claimToken: "f".repeat(32), claimTtlMs: 1_000, requestTimeoutMs: 100, dedupWindowMs: 3_600_000, dedupSafetyMarginMs: 60_000 })!;
    d.store().completeNotification({ occurrenceId: incomplete.occurrence_id, revision: incomplete.revision, claimToken: claim.claimToken!, providerMessageId: "om_first", sentAtMs: d.now() });
    assert.equal(d.store().getSession(incomplete.occurrence_id)?.state, "notified");

    const complete = parseTeamMemMeetingArtifact({ ...incomplete, revision: incomplete.revision + 1, transcript_complete: true });
    const completeSerialized = canonicalArtifactJson(complete);
    const completeHash = canonicalArtifactHash(complete);
    const completeBundle = d.worker().enqueue({ artifact: complete, serializedArtifact: completeSerialized, artifactHash: completeHash, recordingPath: d.source });
    writeFileSync(path.join(h.receipts, `${occurrencePathSegment(complete.occurrence_id as OccurrenceId)}.json`), `${JSON.stringify(publishedReceipt(complete, completeHash))}\n`);
    d.worker().reconcile();

    assert.equal(d.store().getSession(complete.occurrence_id)?.state, "notified");
    assert.equal(d.store().listTransitions(complete.occurrence_id).filter((row) => row.toState === "published").length, 1);
    assert.deepEqual(d.store().notifications().map((row) => [row.revision, row.state]), [[incomplete.revision, "sent"], [complete.revision, "pending"]]);
    assert.deepEqual(d.store().pending(), []);
    assert.equal(existsSync(d.source), false);
    assert.equal(existsSync(completeBundle), false);
  } finally { d.close(); h.cleanup(); }
});

test("SQLite reopen keeps an unpublished missing source fail-closed", () => {
  const h = harness();
  const d = durableWorker(h);
  try {
    d.receipt();
    unlinkSync(d.source);
    d.reopen();
    const pending = d.store().pending()[0]!;
    assert.equal(pending.retryReason, "recovery_unavailable");
    d.worker().reconcile();
    d.reopen();
    d.worker().reconcile();
    assert.deepEqual(d.store().pending(), [pending]);
    assert.equal(d.store().getSession(pending.occurrenceId)?.state, "awaiting_teammem");
    assert.equal(existsSync(d.bundle), true);
    assert.equal(existsSync(d.source), false);
  } finally { d.close(); h.cleanup(); }
});

test("SQLite reopened incomplete publication retains evidence until its original deadline", () => {
  const h = harness();
  const built = artifactAndAudio();
  const artifact = { ...built.artifact, transcript_complete: false };
  const serialized = canonicalArtifactJson(artifact);
  const d = durableWorker(h, { ...built, artifact, serialized, hash: canonicalArtifactHash(artifact) });
  try {
    d.receipt();
    d.worker().reconcile();
    const accepted = d.store().pending()[0]!;
    const deadline = Date.parse(artifact.ended_at) + 14 * 24 * 60 * 60 * 1_000;
    for (const at of [d.now() + 1_000, deadline - 1]) {
      d.advance(at);
      d.reopen();
      d.worker().reconcile();
      assert.deepEqual(d.store().pending(), [accepted]);
      assert.equal(readFileSync(d.source).equals(built.bytes), true);
      assert.equal(readFileSync(path.join(d.bundle, "meeting.json"), "utf8"), serialized);
    }
    d.advance(deadline);
    d.worker().reconcile();
    d.reopen();
    assert.deepEqual(d.store().pending(), []);
    assert.equal(existsSync(d.source), false);
    assert.equal(existsSync(d.bundle), false);
  } finally { d.close(); h.cleanup(); }
});

test("SQLite published replay cannot delete a replacement inode owned by another occurrence", () => {
  const h = harness();
  const built = artifactAndAudio();
  const d = durableWorker(h, built);
  const raw = new Database(d.filename);
  try {
    d.receipt();
    raw.exec("CREATE TRIGGER fail_deletion BEFORE UPDATE ON delivery_journal WHEN NEW.deleted_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT, 'deletion_update_before_commit'); END");
    d.worker().reconcile();
    raw.exec("DROP TRIGGER fail_deletion");
    const other = { ...built.artifact, occurrence_id: "vc:other@2026-09-02T14:00:00Z", provider_meeting_id: "vc:other" };
    const otherSource = runtimeRecordingPath(h, "b");
    writeFileSync(otherSource, built.bytes);
    d.store().createSession({ occurrenceId: other.occurrence_id, providerMeetingId: other.provider_meeting_id, occurrenceStartedAt: other.started_at, nowMs: d.now() });
    d.store().finalizeSession({
      transition: { occurrenceId: other.occurrence_id, fromState: "discovered", toState: "awaiting_teammem", reason: "test", terminalReason: null, nowMs: d.now() },
      recording: { handle: "b".repeat(32), encryptedPath: otherSource, sha256: SHA(built.bytes).slice(7), durationMs: 1, format: "opus", keyId: "fake-key", gaps: [], runtimeGaps: [] },
    });
    const otherBundle = d.worker().enqueue({ artifact: other, serializedArtifact: canonicalArtifactJson(other), artifactHash: canonicalArtifactHash(other), recordingPath: otherSource });
    linkSync(otherSource, d.source);
    for (let replay = 0; replay < 2; replay += 1) {
      d.reopen();
      d.worker().reconcile();
      const conflict = d.store().pending().find((row) => row.occurrenceId === built.artifact.occurrence_id)!;
      assert.equal(conflict.retryReason, "recovery_unavailable");
      assert.equal(conflict.deletedAtMs, null);
      assert.equal(conflict.publishedAtMs, d.now());
      assert.equal(conflict.recoveryArtifact, built.serialized);
      assert.deepEqual(readFileSync(d.source), built.bytes);
      assert.deepEqual(readFileSync(otherSource), built.bytes);
      assert.equal(existsSync(otherBundle), true);
    }
  } finally { raw.close(); d.close(); h.cleanup(); }
});

test("writes the exact four-file TeamMem bundle atomically from a verified encrypted recording", () => {
  const h = harness();
  try {
    const { artifact, bytes, serialized, hash } = artifactAndAudio();
    const source = runtimeRecordingPath(h);
    writeFileSync(source, bytes, { mode: 0o600 });

    const bundle = writeMeetingBundle({
      recordingsDir: h.recordings,
      outboxDir: h.outbox,
      artifact,
      serializedArtifact: serialized,
      artifactHash: hash,
      recordingPath: source,
    });

    assert.deepEqual(readdirSync(bundle).sort(), ["READY", "audio.enc", "manifest.json", "meeting.json"]);
    assert.equal(readFileSync(path.join(bundle, "meeting.json"), "utf8"), serialized);
    assert.deepEqual(readFileSync(path.join(bundle, "audio.enc")), bytes);
    assert.deepEqual(readFileSync(path.join(bundle, "READY")), Buffer.alloc(0));
    assert.equal(statSync(bundle).isSymbolicLink(), false);
    for (const name of readdirSync(bundle)) assert.equal(statSync(path.join(bundle, name)).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(bundle, "manifest.json"), "utf8"),
      `${JSON.stringify({ artifact_hash: hash, audio_bytes: bytes.length, audio_sha256: SHA(bytes), occurrence_id: artifact.occurrence_id, revision: artifact.revision, schema: "teammem-meeting-manifest/v1" })}\n`);

    const replay = writeMeetingBundle({ recordingsDir: h.recordings, outboxDir: h.outbox, artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source });
    assert.equal(replay, bundle);
  } finally {
    h.cleanup();
  }
});

test("refuses untrusted audio paths and mismatched audio or artifact integrity claims without publishing a bundle", () => {
  const h = harness();
  try {
    const { artifact, bytes, serialized, hash } = artifactAndAudio();
    const source = runtimeRecordingPath(h);
    writeFileSync(source, bytes);
    for (const input of [
      { recordingPath: path.join(h.root, "outside.enc") },
      { artifact: { ...artifact, audio: { ...artifact.audio, bytes: bytes.length + 1 } } },
      { artifactHash: `sha256:${"0".repeat(64)}` },
    ]) {
      assert.throws(() => writeMeetingBundle({ recordingsDir: h.recordings, outboxDir: h.outbox, artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source, ...input }), /audio|artifact|recording|hash|path/i);
    }
    const linked = path.join(h.recordings, "linked.enc");
    symlinkSync(source, linked);
    assert.throws(() => writeMeetingBundle({ recordingsDir: h.recordings, outboxDir: h.outbox, artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: linked }), /regular|symlink|recording/i);
    const directory = path.join(h.recordings, "not-a-file");
    mkdirSync(directory);
    assert.throws(() => writeMeetingBundle({ recordingsDir: h.recordings, outboxDir: h.outbox, artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: directory }), /regular|recording/i);
    assert.equal(readdirSync(h.outbox, { withFileTypes: true }).length, 0);
  } finally {
    h.cleanup();
  }
});

test("accepts only the canonical producer receipt for the matching known artifact", () => {
  const h = harness();
  try {
    const { artifact, hash } = artifactAndAudio();
    const segment = occurrencePathSegment(artifact.occurrence_id as OccurrenceId);
    const receipt = publishedReceipt(artifact, hash);
    const file = path.join(h.receipts, `${segment}.json`);
    writeFileSync(file, `${JSON.stringify(receipt)}\n`);
    assert.deepEqual(readPublicationReceipt({ receiptsDir: h.receipts, occurrenceId: artifact.occurrence_id, revision: artifact.revision, artifactHash: hash }), receipt);
    writeFileSync(file, `${JSON.stringify({ ...receipt, markdown_url: "https://example.test/group/vault/-/blob/main/Meetings/x.md" })}\n`);
    assert.equal(readPublicationReceipt({ receiptsDir: h.receipts, occurrenceId: artifact.occurrence_id, revision: artifact.revision, artifactHash: hash }), null);
  } finally {
    h.cleanup();
  }
});

test("worker retries with injected bounded jitter and publishes only after a matching producer receipt", () => {
  const h = harness();
  try {
    const { artifact, bytes, serialized, hash } = artifactAndAudio();
    const source = runtimeRecordingPath(h);
    writeFileSync(source, bytes);
    let state = "awaiting_teammem";
    const journal = new FakeJournal(() => { state = "published"; });
    let now = Date.parse("2026-09-02T14:00:00Z");
    const worker = createOutboxWorker({
      outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal,
      clock: { now: () => now }, random: () => 0.5,
      session: { state: () => state, publish: () => { state = "published"; } }, reconciliationEvidence: NOOP_PURGE,
    });
    worker.enqueue({ artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source });
    worker.reconcile();
    const pending = journal.pending()[0]!;
    assert.equal(pending.retryReason, "receipt_unavailable");
    assert.equal(pending.nextRetryAtMs, now + 1_500);
    assert.equal(state, "awaiting_teammem");
    const receiptFile = path.join(h.receipts, `${occurrencePathSegment(artifact.occurrence_id as OccurrenceId)}.json`);
    writeFileSync(receiptFile, `${JSON.stringify(publishedReceipt(artifact, hash))}\n`);
    now = pending.nextRetryAtMs;
    worker.reconcile();
    assert.equal(state, "published");
    assert.equal(journal.rows.get(`${artifact.occurrence_id}:${artifact.revision}`)?.publishedAtMs, now);
  } finally {
    h.cleanup();
  }
});

test("worker deletes only a complete-receipt bundle or evidence due at the exact retention deadline", () => {
  const h = harness();
  try {
    const built = artifactAndAudio();
    const artifact = structuredClone(built.artifact) as typeof built.artifact;
    artifact.transcript_complete = false;
    const bytes = built.bytes;
    const serialized = canonicalArtifactJson(artifact);
    const hash = canonicalArtifactHash(artifact);
    const source = runtimeRecordingPath(h);
    writeFileSync(source, bytes);
    const journal = new FakeJournal();
    const now = Date.parse("2026-09-02T14:00:00Z");
    const worker = createOutboxWorker({
      outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal,
      clock: { now: () => now }, random: () => 0,
      session: { state: () => "awaiting_teammem", publish: () => undefined }, reconciliationEvidence: NOOP_PURGE,
    });
    const bundle = worker.enqueue({ artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source });
    const receiptFile = path.join(h.receipts, `${occurrencePathSegment(artifact.occurrence_id as OccurrenceId)}.json`);
    writeFileSync(receiptFile, `${JSON.stringify(publishedReceipt(artifact, hash))}\n`);
    worker.reconcile();
    assert.equal(statSync(source).isFile(), true);
    assert.equal(statSync(bundle).isDirectory(), true);

    const complete = structuredClone(artifact) as typeof artifact;
    complete.transcript_complete = true;
    complete.revision = artifact.revision + 1;
    const completeHash = canonicalArtifactHash(complete);
    const completeSerialized = canonicalArtifactJson(complete);
    const completeSource = runtimeRecordingPath(h, "b");
    writeFileSync(completeSource, bytes);
    const completeBundle = worker.enqueue({ artifact: complete, serializedArtifact: completeSerialized, artifactHash: completeHash, recordingPath: completeSource });
    writeFileSync(receiptFile, `${JSON.stringify(publishedReceipt(complete, completeHash))}\n`);
    worker.reconcile();
    assert.equal(statSync(completeSource, { throwIfNoEntry: false }), undefined);
    assert.equal(statSync(completeBundle, { throwIfNoEntry: false }), undefined);

    assert.equal(statSync(source, { throwIfNoEntry: false }), undefined);
    assert.equal(statSync(bundle, { throwIfNoEntry: false }), undefined);
  } finally {
    h.cleanup();
  }
});

test("every injected outbox crash boundary recovers on restart without exposing a partial READY bundle", () => {
  const points = [
    "before_meeting_write", "after_meeting_write", "before_audio_write", "after_audio_write",
    "before_manifest_write", "after_manifest_write", "before_staging_fsync", "after_staging_fsync",
    "before_rename", "after_rename", "before_ready_write", "after_ready_write",
    "before_bundle_fsync", "after_bundle_fsync",
  ] as const;
  for (const point of points) {
    const h = harness();
    try {
      const { artifact, bytes, serialized, hash } = artifactAndAudio();
      const source = runtimeRecordingPath(h);
      writeFileSync(source, bytes);
      const input = {
        recordingsDir: h.recordings, outboxDir: h.outbox, artifact,
        serializedArtifact: serialized, artifactHash: hash, recordingPath: source,
        fault: (candidate: string) => { if (candidate === point) throw new Error(`synthetic crash at ${point}`); },
      };
      assert.throws(() => writeMeetingBundle(input as Parameters<typeof writeMeetingBundle>[0]), /synthetic crash/);
      const segmentDir = path.join(h.outbox, occurrencePathSegment(artifact.occurrence_id as OccurrenceId));
      if (statSync(segmentDir, { throwIfNoEntry: false }) !== undefined) {
        for (const entry of readdirSync(segmentDir)) {
          const candidate = path.join(segmentDir, entry);
          if (statSync(path.join(candidate, "READY"), { throwIfNoEntry: false }) !== undefined) {
            assert.deepEqual(readdirSync(candidate).sort(), ["READY", "audio.enc", "manifest.json", "meeting.json"]);
          }
        }
      }
      const { fault: ignoredFault, ...recoveryInput } = input;
      void ignoredFault;
      const recovered = writeMeetingBundle(recoveryInput);
      assert.deepEqual(readdirSync(recovered).sort(), ["READY", "audio.enc", "manifest.json", "meeting.json"]);
    } finally {
      h.cleanup();
    }
  }
});

test("receipt reader rejects stale, malformed, noncanonical, and non-publication claims without advancing", () => {
  const h = harness();
  try {
    const { artifact, hash } = artifactAndAudio();
    const file = path.join(h.receipts, `${occurrencePathSegment(artifact.occurrence_id as OccurrenceId)}.json`);
    const valid = publishedReceipt(artifact, hash);
    const variants: readonly (string | Buffer)[] = [
      JSON.stringify({ ...valid, revision: artifact.revision - 1 }) + "\n",
      JSON.stringify({ ...valid, revision: artifact.revision + 1 }) + "\n",
      JSON.stringify({ ...valid, occurrence_id: "other@2026-09-02T14:00:00Z" }) + "\n",
      JSON.stringify({ ...valid, artifact_hash: `sha256:${"b".repeat(64)}` }) + "\n",
      JSON.stringify({ ...valid, status: "rejected" }) + "\n",
      JSON.stringify({ ...valid, vault_commit: "A".repeat(40) }) + "\n",
      JSON.stringify({ ...valid, markdown_path: "../secret.md" }) + "\n",
      JSON.stringify({ ...valid, markdown_url: "file:///tmp/meeting.md" }) + "\n",
      JSON.stringify({ ...valid, markdown_url: "http://example.test/-/blob/" + "a".repeat(40) + "/Meetings/x.md" }) + "\n",
      JSON.stringify({ ...valid, markdown_url: "https://example.test/-/blob/main/Meetings/x.md" }) + "\n",
      JSON.stringify({ ...valid, extra: true }) + "\n",
      JSON.stringify(Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "status"))) + "\n",
      `{${JSON.stringify("schema")}:${JSON.stringify("teammem-meeting-receipt/v1")},${JSON.stringify("schema")}:${JSON.stringify("teammem-meeting-receipt/v1")}}\n`,
      JSON.stringify(valid, null, 2) + "\n",
      JSON.stringify(valid) + "\ntrailing",
      Buffer.from([0xff, 0xfe, 0x7b, 0x7d]),
    ];
    for (const raw of variants) {
      writeFileSync(file, raw);
      assert.equal(readPublicationReceipt({ receiptsDir: h.receipts, occurrenceId: artifact.occurrence_id, revision: artifact.revision, artifactHash: hash }), null);
    }
    const external = path.join(h.root, "external-receipt.json");
    writeFileSync(external, `${JSON.stringify(valid)}\n`);
    rmSync(file);
    symlinkSync(external, file);
    assert.equal(readPublicationReceipt({ receiptsDir: h.receipts, occurrenceId: artifact.occurrence_id, revision: artifact.revision, artifactHash: hash }), null);
  } finally {
    h.cleanup();
  }
});

test("the SQLite delivery journal survives reopen with redacted retry and publication evidence", () => {
  const h = harness();
  const now = Date.parse("2026-09-02T14:00:00Z");
  const { artifact, hash } = artifactAndAudio();
  const row: DeliveryRow = {
    occurrenceId: artifact.occurrence_id, revision: artifact.revision, artifactHash: hash,
    recordingPath: runtimeRecordingPath(h), bundlePath: path.join(h.outbox, "segment", String(artifact.revision)),
    endedAtMs: Date.parse(artifact.ended_at), transcriptComplete: false, retryCount: 2,
    nextRetryAtMs: now + 4_000, retryReason: "receipt_unavailable", publishedAtMs: null,
    deletedAtMs: null, publicationUrl: null, vaultCommit: null,
    recoveryArtifact: null, stageToken: null,
  };
  writeFileSync(row.recordingPath, "synthetic encrypted journal source");
  const first = openSessionStore({ filename: path.join(h.root, "orchestration.db"), nowMs: now });
  try {
    first.createSession({ occurrenceId: artifact.occurrence_id, providerMeetingId: artifact.provider_meeting_id, occurrenceStartedAt: artifact.started_at, nowMs: now });
    first.finalizeSession({
      transition: { occurrenceId: artifact.occurrence_id, fromState: "discovered", toState: "awaiting_teammem", reason: "test", terminalReason: null, nowMs: now },
      recording: { handle: "a".repeat(32), encryptedPath: row.recordingPath, sha256: "a".repeat(64), durationMs: 1, format: "opus", keyId: "key", gaps: [], runtimeGaps: [] },
    });
    first.savePending(row);
    first.savePending({ ...row, revision: row.revision + 1, artifactHash: `sha256:${"b".repeat(64)}`, bundlePath: `${row.bundlePath}-next` });
    const otherOccurrence = "vc:second@2026-09-02T14:00:00Z";
    first.createSession({ occurrenceId: otherOccurrence, providerMeetingId: "vc:second", occurrenceStartedAt: artifact.started_at, nowMs: now });
    first.finalizeSession({
      transition: { occurrenceId: otherOccurrence, fromState: "discovered", toState: "awaiting_teammem", reason: "test", terminalReason: null, nowMs: now },
      recording: { handle: "b".repeat(32), encryptedPath: row.recordingPath, sha256: "b".repeat(64), durationMs: 1, format: "opus", keyId: "key", gaps: [], runtimeGaps: [] },
    });
    assert.throws(() => first.savePending({ ...row, occurrenceId: otherOccurrence, artifactHash: `sha256:${"c".repeat(64)}`, bundlePath: `${row.bundlePath}-other` }), /another occurrence|Runtime handle/i);
  } finally {
    first.close();
  }
  const second = openSessionStore({ filename: path.join(h.root, "orchestration.db"), nowMs: now + 1 });
  try {
    assert.equal(second.pending().length, 2);
    assert.deepEqual(second.pending().find((pending) => pending.revision === row.revision), { ...row, recordingHandle: "a".repeat(32) });
    const published: DeliveryRow = { ...row, retryReason: null, publishedAtMs: now + 2, publicationUrl: "https://example.test/-/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Meetings/note.md", vaultCommit: "a".repeat(40) };
    second.update(published);
  } finally {
    second.close();
  }
  const third = openSessionStore({ filename: path.join(h.root, "orchestration.db"), nowMs: now + 3 });
  try {
    assert.equal(third.pending().length, 2);
    assert.deepEqual(third.pending().find((pending) => pending.revision === row.revision), { ...row, recordingHandle: "a".repeat(32), retryReason: null, publishedAtMs: now + 2, publicationUrl: "https://example.test/-/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Meetings/note.md", vaultCommit: "a".repeat(40) });
  } finally {
    third.close();
    h.cleanup();
  }
});

test("a corrupted journal row cannot delete a sibling outbox directory", () => {
  const h = harness();
  try {
    const { artifact, bytes, serialized, hash } = artifactAndAudio();
    const source = runtimeRecordingPath(h);
    writeFileSync(source, bytes);
    const journal = new FakeJournal();
    const now = Date.parse("2026-09-02T14:00:00Z");
    const worker = createOutboxWorker({
      outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal,
      clock: { now: () => now }, random: () => 0,
      session: { state: () => "awaiting_teammem", publish: () => undefined }, reconciliationEvidence: NOOP_PURGE,
    });
    const ownBundle = worker.enqueue({ artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source });
    const sibling = path.join(h.outbox, "unrelated_20260902T140000Z", "1");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(path.join(sibling, "sentinel"), "do not delete", { flag: "w" });
    journal.rows.set(`${artifact.occurrence_id}:${artifact.revision}`, {
      ...journal.rows.get(`${artifact.occurrence_id}:${artifact.revision}`)!, bundlePath: sibling, transcriptComplete: true,
    });
    writeFileSync(path.join(h.receipts, `${occurrencePathSegment(artifact.occurrence_id as OccurrenceId)}.json`), `${JSON.stringify(publishedReceipt(artifact, hash))}\n`);
    assert.doesNotThrow(() => worker.reconcile());
    assert.equal(journal.rows.get(`${artifact.occurrence_id}:${artifact.revision}`)?.retryReason, "recovery_unavailable");
    assert.equal(readFileSync(path.join(sibling, "sentinel"), "utf8"), "do not delete");
    assert.equal(statSync(ownBundle).isDirectory(), true);
    assert.equal(statSync(source).isFile(), true);
  } finally {
    h.cleanup();
  }
});

test("a real process exit leaves an owned stage which restart cleanup removes with the delivered revision", () => {
  const h = harness();
  try {
    const { artifact, bytes, serialized, hash } = artifactAndAudio();
    const source = runtimeRecordingPath(h);
    writeFileSync(source, bytes);
    const child = path.join(h.root, "crash-writer.ts");
    writeFileSync(child, `import { writeMeetingBundle } from ${JSON.stringify(new URL("../src/adapters/filesystem-outbox.ts", import.meta.url).href)};
const input = JSON.parse(process.argv[2]);
writeMeetingBundle({...input, fault: (step) => { if (step === "after_audio_write") process.exit(77); }});\n`);
    const stageToken = "a".repeat(32);
    const result = spawnSync(process.execPath, [child, JSON.stringify({ recordingsDir: h.recordings, outboxDir: h.outbox, artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source, stageToken })]);
    assert.equal(result.status, 77);
    const occurrence = path.join(h.outbox, occurrencePathSegment(artifact.occurrence_id as OccurrenceId));
    const stages = readdirSync(occurrence).filter((name) => name.startsWith(`.${artifact.revision}.staging-`));
    assert.equal(stages.length, 1);
    assert.equal(existsSync(path.join(occurrence, stages[0]!, "audio.enc")), true);

    const bundle = writeMeetingBundle({ recordingsDir: h.recordings, outboxDir: h.outbox, artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source });
    deleteDeliveredEvidence({ recordingsDir: h.recordings, outboxDir: h.outbox, occurrenceId: artifact.occurrence_id, revision: artifact.revision, recordingPath: source, bundlePath: bundle, stageToken });
    assert.equal(existsSync(occurrence), false, "atomic occurrence detach clears canonical and private evidence together");
  } finally { h.cleanup(); }
});

test("intermediate recording and outbox symlinks cannot escape deletion roots", () => {
  const h = harness();
  try {
    const { artifact } = artifactAndAudio();
    const outside = path.join(h.root, "outside");
    const outsideBundle = path.join(outside, "bundle");
    mkdirSync(outsideBundle, { recursive: true });
    const victim = path.join(outside, "victim.enc");
    writeFileSync(victim, "outside bytes");
    const nested = path.join(h.recordings, "nested");
    symlinkSync(outside, nested);
    const segment = occurrencePathSegment(artifact.occurrence_id as OccurrenceId);
    mkdirSync(h.outbox);
    symlinkSync(outside, path.join(h.outbox, segment));
    assert.throws(() => deleteDeliveredEvidence({
      recordingsDir: h.recordings,
      outboxDir: h.outbox,
      occurrenceId: artifact.occurrence_id,
      revision: artifact.revision,
      recordingPath: path.join(nested, "victim.enc"),
      bundlePath: path.join(h.outbox, segment, String(artifact.revision)),
    }), /symlink|outside|containment|basename/i);
    assert.equal(readFileSync(victim, "utf8"), "outside bytes");
    assert.equal(statSync(outsideBundle).isDirectory(), true);
  } finally { h.cleanup(); }
});

test("refuses every plaintext container magic before READY without copying it", () => {
  const magics = [Buffer.from("RIFF"), Buffer.from("OggS"), Buffer.from("fLaC"), Buffer.from("ID3"), Buffer.from("xxxxftyp"), Buffer.from([0xff, 0xe0])];
  for (const magic of magics) {
    const h = harness();
    try {
      const built = artifactAndAudio();
      const bytes = Buffer.concat([magic, Buffer.from(" definitely plaintext")]);
      const raw = structuredClone(built.artifact) as typeof built.artifact;
      raw.audio = { ...raw.audio, bytes: bytes.length, sha256: SHA(bytes) };
      const artifact = parseTeamMemMeetingArtifact(raw);
      const source = runtimeRecordingPath(h);
      writeFileSync(source, bytes);
      assert.throws(() => writeMeetingBundle({ recordingsDir: h.recordings, outboxDir: h.outbox, artifact, serializedArtifact: canonicalArtifactJson(artifact), artifactHash: canonicalArtifactHash(artifact), recordingPath: source }), /plaintext|encrypted/i);
      assert.equal(existsSync(path.join(h.outbox, occurrencePathSegment(artifact.occurrence_id as OccurrenceId), String(artifact.revision), "audio.enc")), false);
    } finally { h.cleanup(); }
  }
});

test("persists delivery intent before exposing READY when the journal save fails", () => {
  const h = harness();
  try {
    const { artifact, bytes, serialized, hash } = artifactAndAudio();
    const source = runtimeRecordingPath(h);
    writeFileSync(source, bytes);
    const journal = new FakeJournal();
    journal.failSave = true;
    const worker = createOutboxWorker({ outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal, clock: { now: () => 1 }, random: () => 0, session: { state: () => "awaiting_teammem", publish: () => undefined }, reconciliationEvidence: NOOP_PURGE });
    assert.throws(() => worker.enqueue({ artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source }), /journal/);
    assert.equal(existsSync(path.join(h.outbox, occurrencePathSegment(artifact.occurrence_id as OccurrenceId), String(artifact.revision), "READY")), false);
    assert.deepEqual(journal.pending(), []);
  } finally { h.cleanup(); }
});

test("a complete higher revision deletes every retained copy for its occurrence and no other", () => {
  const h = harness();
  try {
    const first = artifactAndAudio();
    const incomplete = structuredClone(first.artifact) as typeof first.artifact;
    incomplete.transcript_complete = false;
    const oldArtifact = parseTeamMemMeetingArtifact(incomplete);
    const oldSource = runtimeRecordingPath(h, "b");
    writeFileSync(oldSource, first.bytes);
    const complete = structuredClone(oldArtifact) as typeof oldArtifact;
    complete.transcript_complete = true;
    complete.revision += 1;
    const newArtifact = parseTeamMemMeetingArtifact(complete);
    const newSource = runtimeRecordingPath(h, "c");
    writeFileSync(newSource, first.bytes);
    const journal = new FakeJournal();
    let state = "awaiting_teammem";
    const worker = createOutboxWorker({ outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal, clock: { now: () => 1234 }, random: () => 0, session: { state: () => state, publish: () => { state = "published"; } }, reconciliationEvidence: NOOP_PURGE });
    const oldBundle = worker.enqueue({ artifact: oldArtifact, serializedArtifact: canonicalArtifactJson(oldArtifact), artifactHash: canonicalArtifactHash(oldArtifact), recordingPath: oldSource });
    const newHash = canonicalArtifactHash(newArtifact);
    const newBundle = worker.enqueue({ artifact: newArtifact, serializedArtifact: canonicalArtifactJson(newArtifact), artifactHash: newHash, recordingPath: newSource });
    writeFileSync(path.join(h.receipts, `${occurrencePathSegment(newArtifact.occurrence_id as OccurrenceId)}.json`), `${JSON.stringify(publishedReceipt(newArtifact, newHash))}\n`);
    worker.reconcile();
    for (const evidence of [oldSource, oldBundle, newSource, newBundle]) assert.equal(existsSync(evidence), false);
    for (const revision of [oldArtifact.revision, newArtifact.revision]) assert.equal(journal.rows.get(`${newArtifact.occurrence_id}:${revision}`)?.deletedAtMs, 1234);
  } finally { h.cleanup(); }
});

test("matching receipts do nothing in every state except awaiting_teammem, published, or notified replay", () => {
  for (const state of [null, "listening", "finalizing", "failed", "discovered"]) {
    const h = harness();
    try {
      const { artifact, bytes, serialized, hash } = artifactAndAudio();
      const source = runtimeRecordingPath(h);
      writeFileSync(source, bytes);
      const journal = new FakeJournal();
      const worker = createOutboxWorker({ outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal, clock: { now: () => 2 }, random: () => 0, session: { state: () => state, publish: () => assert.fail("illegal state transition") }, reconciliationEvidence: NOOP_PURGE });
      const bundle = worker.enqueue({ artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source });
      writeFileSync(path.join(h.receipts, `${occurrencePathSegment(artifact.occurrence_id as OccurrenceId)}.json`), `${JSON.stringify(publishedReceipt(artifact, hash))}\n`);
      worker.reconcile();
      const row = journal.rows.get(`${artifact.occurrence_id}:${artifact.revision}`)!;
      assert.equal(row.publishedAtMs, null);
      assert.equal(row.deletedAtMs, null);
      assert.equal(existsSync(source), true);
      assert.equal(existsSync(bundle), true);
    } finally { h.cleanup(); }
  }
});

test("unpaired surrogates in receipt path or URL fields return null and cannot abort a later valid delivery", () => {
  const h = harness();
  try {
    const { artifact, hash } = artifactAndAudio();
    const file = path.join(h.receipts, `${occurrencePathSegment(artifact.occurrence_id as OccurrenceId)}.json`);
    for (const field of ["markdown_path", "markdown_url"] as const) for (const surrogate of ["\ud800", "\udc00"]) {
      writeFileSync(file, `${JSON.stringify({ ...publishedReceipt(artifact, hash), [field]: surrogate })}\n`);
      assert.doesNotThrow(() => assert.equal(readPublicationReceipt({ receiptsDir: h.receipts, occurrenceId: artifact.occurrence_id, revision: artifact.revision, artifactHash: hash }), null));
    }
  } finally { h.cleanup(); }
});

test("a malformed receipt for one occurrence cannot block a valid second occurrence in the same poll", () => {
  const h = harness();
  try {
    const first = artifactAndAudio();
    const secondRaw = structuredClone(first.artifact) as typeof first.artifact;
    secondRaw.occurrence_id = "vc:second@2026-09-02T14:00:00Z";
    secondRaw.provider_meeting_id = "vc:second";
    const second = parseTeamMemMeetingArtifact(secondRaw);
    const secondHash = canonicalArtifactHash(second);
    const firstSource = runtimeRecordingPath(h, "b");
    const secondSource = runtimeRecordingPath(h, "c");
    writeFileSync(firstSource, first.bytes);
    writeFileSync(secondSource, first.bytes);
    const published: string[] = [];
    const journal = new FakeJournal((occurrenceId) => published.push(occurrenceId));
    const worker = createOutboxWorker({ outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal, clock: { now: () => 5 }, random: () => 0, session: { state: () => "awaiting_teammem", publish: (id) => published.push(id) }, reconciliationEvidence: NOOP_PURGE });
    worker.enqueue({ artifact: first.artifact, serializedArtifact: first.serialized, artifactHash: first.hash, recordingPath: firstSource });
    worker.enqueue({ artifact: second, serializedArtifact: canonicalArtifactJson(second), artifactHash: secondHash, recordingPath: secondSource });
    writeFileSync(path.join(h.receipts, `${occurrencePathSegment(first.artifact.occurrence_id as OccurrenceId)}.json`), `${JSON.stringify({ ...publishedReceipt(first.artifact, first.hash), markdown_path: "\ud800" })}\n`);
    writeFileSync(path.join(h.receipts, `${occurrencePathSegment(second.occurrence_id as OccurrenceId)}.json`), `${JSON.stringify(publishedReceipt(second, secondHash))}\n`);
    assert.doesNotThrow(() => worker.reconcile());
    assert.deepEqual(published, [second.occurrence_id]);
  } finally { h.cleanup(); }
});

test("reconcile invokes the injected purge at its single clock instant and confines a purge failure", () => {
  const h = harness();
  try {
    const journal = new FakeJournal();
    const calls: number[] = [];
    const errors: string[] = [];
    const worker = createOutboxWorker({
      outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal,
      clock: { now: () => 9876 }, random: () => 0, session: { state: () => null, publish: () => undefined },
      reconciliationEvidence: { purgeExpiredReconciliationEvidence: (now) => { calls.push(now); throw new Error("sensitive path"); } },
      onMaintenanceFailure: (reason) => errors.push(reason),
    });
    assert.doesNotThrow(() => worker.reconcile());
    assert.deepEqual(calls, [9876]);
    assert.deepEqual(errors, ["reconciliation_evidence_purge_failed"]);
    assert.deepEqual(journal.pending(), []);
  } finally { h.cleanup(); }
});

test("new outbox and occurrence names are fsynced through their parents before READY", () => {
  const h = harness();
  try {
    const { artifact, bytes, serialized, hash } = artifactAndAudio();
    const source = runtimeRecordingPath(h);
    writeFileSync(source, bytes);
    const calls: string[] = [];
    const bundle = writeMeetingBundle({ recordingsDir: h.recordings, outboxDir: h.outbox, artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source, directoryFsync: (directory) => calls.push(path.resolve(directory)) });
    const occurrence = path.dirname(bundle);
    assert.ok(calls.indexOf(path.dirname(h.outbox)) >= 0);
    assert.ok(calls.indexOf(h.outbox) >= 0);
    assert.ok(calls.lastIndexOf(occurrence) > calls.indexOf(h.outbox));
  } finally { h.cleanup(); }
});

test("reconcile reconstructs a durable delivery and removes its stage by durable token", () => {
  const h = harness();
  try {
    const { artifact, bytes, serialized, hash } = artifactAndAudio();
    const source = runtimeRecordingPath(h);
    writeFileSync(source, bytes);
    const journal = new FakeJournal();
    let now = 1;
    const worker = createOutboxWorker({
      outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal,
      clock: { now: () => now }, random: () => 0,
      session: { state: () => "awaiting_teammem", publish: () => undefined }, reconciliationEvidence: NOOP_PURGE,
    });
    const bundle = worker.enqueue({ artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source });
    rmSync(bundle, { recursive: true });
    const occurrence = path.dirname(bundle);
    const stageToken = journal.pending()[0]!.stageToken!;
    const stage = path.join(occurrence, `.${artifact.revision}.staging-${stageToken}`);
    mkdirSync(stage);
    writeFileSync(path.join(stage, "OWNER"), stageToken);
    writeFileSync(path.join(stage, "audio.enc"), bytes);

    worker.reconcile();
    assert.equal(existsSync(path.join(bundle, "READY")), true, "durable journal input must recreate the missing READY bundle");
    now = journal.pending()[0]!.nextRetryAtMs;
    writeFileSync(path.join(h.receipts, `${occurrencePathSegment(artifact.occurrence_id as OccurrenceId)}.json`), `${JSON.stringify(publishedReceipt(artifact, hash))}\n`);
    worker.reconcile();
    assert.equal(existsSync(source), false);
    assert.equal(existsSync(stage), false, "the durable journal token owns its abandoned stage");
  } finally { h.cleanup(); }
});

test("a recording path must be a direct child of the configured recordings root", () => {
  const h = harness();
  try {
    const { artifact, bytes, serialized, hash } = artifactAndAudio();
    const nested = path.join(h.recordings, "nested");
    mkdirSync(nested);
    const source = path.join(nested, "final.enc");
    writeFileSync(source, bytes);
    assert.throws(() => writeMeetingBundle({
      recordingsDir: h.recordings, outboxDir: h.outbox, artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source,
    }), /direct child|recording/i);
  } finally { h.cleanup(); }
});

test("repeated direct-child symlink swaps never delete an outside recording sentinel", () => {
  const h = harness();
  let toggler: ReturnType<typeof spawn> | undefined;
  try {
    const { artifact } = artifactAndAudio();
    const source = runtimeRecordingPath(h, "b");
    const outside = path.join(h.root, "outside.enc");
    writeFileSync(outside, "outside sentinel");
    const script = `const fs=require('node:fs'); const [source,outside]=process.argv.slice(1); setInterval(()=>{ try { fs.rmSync(source,{force:true}); fs.writeFileSync(source,'owned'); fs.rmSync(source,{force:true}); fs.symlinkSync(outside,source); } catch {} },0);`;
    toggler = spawn(process.execPath, ["-e", script, source, outside], { stdio: "ignore" });
    const bundle = path.join(h.outbox, occurrencePathSegment(artifact.occurrence_id as OccurrenceId), String(artifact.revision));
    for (let attempt = 0; attempt < 300; attempt += 1) {
      mkdirSync(bundle, { recursive: true });
      try {
        deleteDeliveredEvidence({ recordingsDir: h.recordings, outboxDir: h.outbox, occurrenceId: artifact.occurrence_id, revision: artifact.revision, recordingPath: source, bundlePath: bundle });
      } catch { /* symlink/absence is a safe refusal; the sentinel is the assertion. */ }
    }
    assert.equal(readFileSync(outside, "utf8"), "outside sentinel");
  } finally {
    toggler?.kill();
    h.cleanup();
  }
});

test("one encrypted recording cannot be claimed by two occurrences", () => {
  const h = harness();
  try {
    const first = artifactAndAudio();
    const secondRaw = structuredClone(first.artifact) as typeof first.artifact;
    secondRaw.occurrence_id = "vc:second@2026-09-02T14:00:00Z";
    secondRaw.provider_meeting_id = "vc:second";
    const second = parseTeamMemMeetingArtifact(secondRaw);
    const source = runtimeRecordingPath(h);
    writeFileSync(source, first.bytes);
    const worker = createOutboxWorker({
      outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal: new FakeJournal(),
      clock: { now: () => 1 }, random: () => 0,
      session: { state: () => "awaiting_teammem", publish: () => undefined }, reconciliationEvidence: NOOP_PURGE,
    });
    worker.enqueue({ artifact: first.artifact, serializedArtifact: first.serialized, artifactHash: first.hash, recordingPath: source });
    assert.throws(() => worker.enqueue({
      artifact: second, serializedArtifact: canonicalArtifactJson(second), artifactHash: canonicalArtifactHash(second), recordingPath: source,
    }), /recording.*owner|owned|claim/i);
  } finally { h.cleanup(); }
});

test("a worker without the mandatory reconciliation purge is rejected at construction", () => {
  const h = harness();
  try {
    assert.throws(() => createOutboxWorker({
      outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal: new FakeJournal(),
      clock: { now: () => 1 }, random: () => 0,
      session: { state: () => null, publish: () => undefined },
    } as unknown as Parameters<typeof createOutboxWorker>[0]), /reconciliation.*purge|required/i);
  } finally { h.cleanup(); }
});

test("a cleanup-capable outbox requires atomic publication plus notification intent", () => {
  const h = harness();
  const journal = new FakeJournal();
  const nonAtomic = { ...journal };
  assert.throws(() => createOutboxWorker({
    outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings,
    journal: nonAtomic as unknown as DeliveryJournal, clock: { now: () => 1 }, random: () => 0,
    session: { state: () => "awaiting_teammem", publish: () => undefined },
    reconciliationEvidence: NOOP_PURGE,
  }), /atomic publication|acceptPublication/i);
  h.cleanup();
});

test("a reopened worker recovers every durable-intent crash cut and later deletes its evidence", () => {
  for (const cut of ["before_stage", "after_audio_write", "after_staging_fsync", "after_rename", "before_ready_write"] as const) {
    const h = harness();
    try {
      const { artifact, bytes, serialized, hash } = artifactAndAudio();
      const source = runtimeRecordingPath(h);
      writeFileSync(source, bytes);
      const journal = new FakeJournal();
      const bundlePath = path.join(h.outbox, occurrencePathSegment(artifact.occurrence_id as OccurrenceId), String(artifact.revision));
      journal.savePending({
        occurrenceId: artifact.occurrence_id, revision: artifact.revision, artifactHash: hash, recordingPath: source, bundlePath,
        endedAtMs: Date.parse(artifact.ended_at), transcriptComplete: true, retryCount: 0, nextRetryAtMs: 1, retryReason: null,
        publishedAtMs: null, deletedAtMs: null, publicationUrl: null, vaultCommit: null, recoveryArtifact: serialized, stageToken: "b".repeat(32),
      });
      const child = path.join(h.root, "crash-after-intent.ts");
      if (cut === "before_stage") writeFileSync(child, "process.exit(77);\n");
      else writeFileSync(child, `import { writeMeetingBundle } from ${JSON.stringify(new URL("../src/adapters/filesystem-outbox.ts", import.meta.url).href)};
const input = JSON.parse(process.argv[2]);
writeMeetingBundle({...input, fault: (step) => { if (step === ${JSON.stringify(cut)}) process.exit(77); }});\n`);
      const result = spawnSync(process.execPath, [child, JSON.stringify({ recordingsDir: h.recordings, outboxDir: h.outbox, artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source, stageToken: "b".repeat(32) })]);
      assert.equal(result.status, 77, cut);
      let now = 1;
      const worker = createOutboxWorker({
        outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal,
        clock: { now: () => now }, random: () => 0, reconciliationEvidence: NOOP_PURGE,
        session: { state: () => "awaiting_teammem", publish: () => undefined },
      });
      worker.reconcile();
      assert.deepEqual(readdirSync(bundlePath).sort(), ["READY", "audio.enc", "manifest.json", "meeting.json"], cut);
      now = journal.pending()[0]!.nextRetryAtMs;
      writeFileSync(path.join(h.receipts, `${occurrencePathSegment(artifact.occurrence_id as OccurrenceId)}.json`), `${JSON.stringify(publishedReceipt(artifact, hash))}\n`);
      worker.reconcile();
      assert.equal(existsSync(source), false, cut);
      assert.equal(existsSync(bundlePath), false, cut);
    } finally { h.cleanup(); }
  }
});

test("READY refuses a recording whose direct-child Runtime handle does not match its basename", () => {
  const h = harness();
  try {
    const { artifact, bytes, serialized, hash } = artifactAndAudio();
    const handle = "a".repeat(32);
    const source = path.join(h.recordings, "wrong-name.crsr");
    writeFileSync(source, bytes);

    assert.throws(() => writeMeetingBundle({
      recordingsDir: h.recordings,
      outboxDir: h.outbox,
      artifact,
      serializedArtifact: serialized,
      artifactHash: hash,
      recordingPath: source,
      recordingHandle: handle,
    } as Parameters<typeof writeMeetingBundle>[0]), /handle|basename|recording/i);
    assert.equal(existsSync(path.join(h.outbox, occurrencePathSegment(artifact.occurrence_id as OccurrenceId), String(artifact.revision), "READY")), false);
  } finally { h.cleanup(); }
});

test("cleanup of one revision preserves a newer stage owned by another token", () => {
  const h = harness();
  try {
    const { artifact, bytes, serialized, hash } = artifactAndAudio();
    const source = path.join(h.recordings, "a".repeat(32) + ".crsr");
    writeFileSync(source, bytes);
    const bundle = writeMeetingBundle({ recordingsDir: h.recordings, outboxDir: h.outbox, artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source });
    const occurrence = path.dirname(bundle);
    const nextStage = path.join(occurrence, `.${artifact.revision + 1}.staging-${"b".repeat(32)}`);
    mkdirSync(nextStage);
    writeFileSync(path.join(nextStage, "OWNER"), "b".repeat(32));

    deleteDeliveredEvidence({
      recordingsDir: h.recordings,
      outboxDir: h.outbox,
      occurrenceId: artifact.occurrence_id,
      revision: artifact.revision,
      recordingPath: source,
      bundlePath: bundle,
      stageToken: "a".repeat(32),
    });

    assert.equal(existsSync(nextStage), true);
    assert.equal(existsSync(occurrence), true);
  } finally { h.cleanup(); }
});

test("terminal recovery_unavailable rows do not update again before the retention deadline", () => {
  const h = harness();
  try {
    const { artifact, bytes, hash } = artifactAndAudio();
    const source = path.join(h.recordings, "a".repeat(32) + ".crsr");
    writeFileSync(source, bytes);
    const journal = new FakeJournal();
    const now = Date.parse("2026-09-02T14:00:00Z");
    journal.savePending({
      occurrenceId: artifact.occurrence_id, revision: artifact.revision, artifactHash: hash,
      recordingPath: source, bundlePath: path.join(h.outbox, occurrencePathSegment(artifact.occurrence_id as OccurrenceId), String(artifact.revision)),
      endedAtMs: Date.parse(artifact.ended_at), transcriptComplete: true, retryCount: 0, nextRetryAtMs: now,
      retryReason: "recovery_unavailable", publishedAtMs: null, deletedAtMs: null, publicationUrl: null,
      vaultCommit: null, recoveryArtifact: null, stageToken: null,
    });
    let updates = 0;
    const originalUpdate = journal.update.bind(journal);
    journal.update = (row) => { updates += 1; originalUpdate(row); };
    const worker = createOutboxWorker({
      outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal,
      clock: { now: () => now }, random: () => 0,
      session: { state: () => "awaiting_teammem", publish: () => assert.fail("terminal row must not publish") },
      reconciliationEvidence: NOOP_PURGE,
    });

    worker.reconcile();
    worker.reconcile();
    assert.equal(updates, 0);
    assert.equal(existsSync(source), true);
  } finally { h.cleanup(); }
});

test("recording and stage tombstones replay after real detach deaths without touching other tokens", () => {
  for (const cut of ["after_recording_detach", "after_stage_detach"] as const) {
    const h = harness();
    try {
      const { artifact, bytes, serialized, hash } = artifactAndAudio();
      const handle = "a".repeat(32);
      const token = "1".repeat(32);
      const otherToken = "2".repeat(32);
      const source = path.join(h.recordings, `${handle}.crsr`);
      writeFileSync(source, bytes);
      const bundle = writeMeetingBundle({ recordingsDir: h.recordings, outboxDir: h.outbox, artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source });
      const occurrence = path.dirname(bundle);
      const ownedStage = path.join(occurrence, `.${artifact.revision}.staging-${token}`);
      mkdirSync(ownedStage);
      writeFileSync(path.join(ownedStage, "OWNER"), token);
      writeFileSync(path.join(ownedStage, "audio.enc"), bytes);
      const otherStage = path.join(occurrence, `.${artifact.revision}.staging-${otherToken}`);
      mkdirSync(otherStage);
      writeFileSync(path.join(otherStage, "OWNER"), otherToken);
      writeFileSync(path.join(otherStage, "keep"), "other stage");
      const otherRecordingTombstone = path.join(h.recordings, `.recording-delete-${otherToken}-${handle}-${artifact.revision}`);
      writeFileSync(otherRecordingTombstone, "other recording tombstone");
      const otherStageTombstone = path.join(occurrence, `.stage-delete-${otherToken}-${handle}-${artifact.revision}`);
      mkdirSync(otherStageTombstone);
      writeFileSync(path.join(otherStageTombstone, "keep"), "other stage tombstone");

      const child = path.join(h.root, `kill-${cut}.ts`);
      writeFileSync(child, `import { deleteDeliveredEvidence } from ${JSON.stringify(new URL("../src/adapters/filesystem-outbox.ts", import.meta.url).href)};\nconst input = JSON.parse(process.argv[2]);\ndeleteDeliveredEvidence({...input, fault: (step) => { if (step === ${JSON.stringify(cut)}) process.kill(process.pid, "SIGKILL"); }});\n`);
      const result = spawnSync(process.execPath, [child, JSON.stringify({
        recordingsDir: h.recordings,
        outboxDir: h.outbox,
        occurrenceId: artifact.occurrence_id,
        revision: artifact.revision,
        recordingPath: source,
        bundlePath: bundle,
        stageToken: token,
        recordingHandle: handle,
      })]);
      assert.equal(result.signal, "SIGKILL", cut);
      const detached = cut === "after_recording_detach"
        ? path.join(h.recordings, `.recording-delete-${token}-${handle}-${artifact.revision}`)
        : path.join(occurrence, `.stage-delete-${token}-${handle}-${artifact.revision}`);
      assert.equal(existsSync(detached), true, cut);

      const deadline = Date.parse(artifact.ended_at) + 14 * 24 * 60 * 60 * 1_000;
      const journal = new FakeJournal();
      journal.savePending({
        occurrenceId: artifact.occurrence_id,
        revision: artifact.revision,
        artifactHash: hash,
        recordingPath: source,
        bundlePath: bundle,
        endedAtMs: Date.parse(artifact.ended_at),
        transcriptComplete: true,
        retryCount: 0,
        nextRetryAtMs: deadline,
        retryReason: "recovery_unavailable",
        publishedAtMs: null,
        deletedAtMs: null,
        publicationUrl: null,
        vaultCommit: null,
        recoveryArtifact: null,
        stageToken: token,
        recordingHandle: handle,
      });
      let updates = 0;
      const originalUpdate = journal.update.bind(journal);
      journal.update = (row) => { updates += 1; originalUpdate(row); };
      const worker = createOutboxWorker({
        outboxDir: h.outbox,
        receiptsDir: h.receipts,
        recordingsDir: h.recordings,
        journal,
        clock: { now: () => deadline },
        random: () => 0,
        session: { state: () => "awaiting_teammem", publish: () => assert.fail("terminal recovery must not publish") },
        reconciliationEvidence: NOOP_PURGE,
      });
      worker.reconcile();
      const deleted = journal.rows.get(`${artifact.occurrence_id}:${artifact.revision}`)!;
      assert.equal(existsSync(detached), false, cut);
      assert.equal(deleted.deletedAtMs, deadline, cut);
      assert.equal(deleted.retryReason, "recovery_unavailable", cut);
      assert.equal(existsSync(otherStage), true, cut);
      assert.equal(existsSync(otherRecordingTombstone), true, cut);
      assert.equal(existsSync(otherStageTombstone), true, cut);
      assert.equal(updates, 1, cut);
      worker.reconcile();
      assert.equal(updates, 1, `${cut} replay must be update-free`);
    } finally {
      h.cleanup();
    }
  }
});

test("deadline cleanup preserves terminal recovery reason and isolates an unrepairable legacy row", () => {
  const h = harness();
  try {
    const first = artifactAndAudio();
    const secondRaw = structuredClone(first.artifact) as typeof first.artifact;
    secondRaw.occurrence_id = "vc:terminal-second@2026-09-02T14:00:00Z";
    secondRaw.provider_meeting_id = "vc:terminal-second";
    const second = parseTeamMemMeetingArtifact(secondRaw);
    const secondSerialized = canonicalArtifactJson(second);
    const secondHash = canonicalArtifactHash(second);
    const secondHandle = "b".repeat(32);
    const secondSource = path.join(h.recordings, `${secondHandle}.crsr`);
    writeFileSync(secondSource, first.bytes);
    const secondBundle = writeMeetingBundle({
      recordingsDir: h.recordings,
      outboxDir: h.outbox,
      artifact: second,
      serializedArtifact: secondSerialized,
      artifactHash: secondHash,
      recordingPath: secondSource,
      recordingHandle: secondHandle,
    });
    const deadline = Date.parse(second.ended_at) + 14 * 24 * 60 * 60 * 1_000;
    const journal = new FakeJournal();
    journal.savePending({
      occurrenceId: first.artifact.occurrence_id,
      revision: first.artifact.revision,
      artifactHash: first.hash,
      recordingPath: path.join(h.recordings, "wrong-name.crsr"),
      bundlePath: path.join(h.outbox, occurrencePathSegment(first.artifact.occurrence_id as OccurrenceId), String(first.artifact.revision)),
      endedAtMs: Date.parse(first.artifact.ended_at),
      transcriptComplete: true,
      retryCount: 0,
      nextRetryAtMs: deadline,
      retryReason: "recovery_unavailable",
      publishedAtMs: null,
      deletedAtMs: null,
      publicationUrl: null,
      vaultCommit: null,
      recoveryArtifact: null,
      stageToken: null,
      recordingHandle: null,
    });
    journal.savePending({
      occurrenceId: second.occurrence_id,
      revision: second.revision,
      artifactHash: secondHash,
      recordingPath: secondSource,
      bundlePath: secondBundle,
      endedAtMs: Date.parse(second.ended_at),
      transcriptComplete: true,
      retryCount: 0,
      nextRetryAtMs: deadline,
      retryReason: "recovery_unavailable",
      publishedAtMs: null,
      deletedAtMs: null,
      publicationUrl: null,
      vaultCommit: null,
      recoveryArtifact: null,
      stageToken: "b".repeat(32),
      recordingHandle: secondHandle,
    });
    let updates = 0;
    const originalUpdate = journal.update.bind(journal);
    journal.update = (row) => { updates += 1; originalUpdate(row); };
    const worker = createOutboxWorker({
      outboxDir: h.outbox,
      receiptsDir: h.receipts,
      recordingsDir: h.recordings,
      journal,
      clock: { now: () => deadline },
      random: () => 0,
      session: { state: () => "awaiting_teammem", publish: () => assert.fail("terminal recovery must not publish") },
      reconciliationEvidence: NOOP_PURGE,
    });

    assert.doesNotThrow(() => worker.reconcile());
    const invalid = journal.rows.get(`${first.artifact.occurrence_id}:${first.artifact.revision}`)!;
    const deleted = journal.rows.get(`${second.occurrence_id}:${second.revision}`)!;
    assert.equal(invalid.retryReason, "recovery_unavailable");
    assert.equal(invalid.deletedAtMs, null);
    assert.equal(deleted.retryReason, "recovery_unavailable");
    assert.equal(deleted.deletedAtMs, deadline);
    assert.equal(existsSync(secondSource), false);
    assert.equal(existsSync(secondBundle), false);
    assert.equal(updates, 1);
    worker.reconcile();
    assert.equal(updates, 1, "terminal deletion replay is update-free");
  } finally {
    h.cleanup();
  }
});

test("restart after a real process death immediately after occurrence detach leaves the current random tombstone", async () => {
  const h = harness();
  try {
    const { artifact, bytes, serialized, hash } = artifactAndAudio();
    const source = path.join(h.recordings, "a".repeat(32) + ".crsr");
    writeFileSync(source, bytes);
    const bundle = writeMeetingBundle({ recordingsDir: h.recordings, outboxDir: h.outbox, artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source });
    const privateDir = path.join(path.dirname(bundle), "private");
    mkdirSync(privateDir);
    // 10k is enough to hold recursive removal open on the supported local
    // filesystem; the test needs the rename/removal cut, not a huge fixture.
    for (let index = 0; index < 10_000; index += 1) writeFileSync(path.join(privateDir, String(index)), bytes);
    const child = path.join(h.root, "kill-after-detach.ts");
    writeFileSync(child, `import { deleteDeliveredEvidence } from ${JSON.stringify(new URL("../src/adapters/filesystem-outbox.ts", import.meta.url).href)};\nconst input = JSON.parse(process.argv[2]);\ndeleteDeliveredEvidence({...input, fault: (step) => { if (step === "after_bundle_detach") process.kill(process.pid, "SIGKILL"); }});\n`);
    const childProcess = spawn(process.execPath, [child, JSON.stringify({
      recordingsDir: h.recordings, outboxDir: h.outbox, occurrenceId: artifact.occurrence_id,
      revision: artifact.revision, recordingPath: source, bundlePath: bundle, stageToken: "a".repeat(32),
    })]);
    await new Promise<void>((resolve) => childProcess.once("exit", () => resolve()));
    const detached = path.join(path.dirname(bundle), `.bundle-delete-${"a".repeat(32)}-${"a".repeat(32)}-${artifact.revision}`);
    assert.equal(existsSync(detached), true);
    assert.deepEqual(readdirSync(path.dirname(bundle)).filter((entry) => entry.startsWith(".bundle-delete-")), [path.basename(detached)]);

    const journal = new FakeJournal();
    const deadline = Date.parse(artifact.ended_at) + 14 * 24 * 60 * 60 * 1_000;
    journal.savePending({
      occurrenceId: artifact.occurrence_id, revision: artifact.revision, artifactHash: hash,
      recordingPath: source, bundlePath: bundle, endedAtMs: Date.parse(artifact.ended_at), transcriptComplete: true,
      retryCount: 0, nextRetryAtMs: deadline, retryReason: "recovery_unavailable", publishedAtMs: null,
      deletedAtMs: null, publicationUrl: null, vaultCommit: null, recoveryArtifact: null, stageToken: "a".repeat(32),
    });
    createOutboxWorker({
      outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal,
      clock: { now: () => deadline }, random: () => 0,
      session: { state: () => "awaiting_teammem", publish: () => undefined }, reconciliationEvidence: NOOP_PURGE,
    }).reconcile();
    assert.equal(existsSync(detached), false);
  } finally { h.cleanup(); }
});

for (const interruption of [
  "filesystem_cleanup",
  "deletion_update_before_commit",
  "deletion_update_after_commit",
] as const) {
  test(`accepted publication evidence converges monotonically after ${interruption} interruption`, () => {
    const h = harness();
    try {
      const { artifact, bytes, serialized, hash } = artifactAndAudio();
      const source = runtimeRecordingPath(h);
      writeFileSync(source, bytes);
      const now = Date.parse("2026-09-02T14:00:00Z");
      let state = "awaiting_teammem";
      let publishCalls = 0;
      const journal = new FakeJournal(() => { publishCalls += 1; state = "published"; });
      let interrupted = false;
      let movedOutbox: string | null = null;
      const originalUpdate = journal.update.bind(journal);
      journal.update = (row) => {
        const publicationWrite = row.publishedAtMs !== null && row.deletedAtMs === null;
        const deletionWrite = row.deletedAtMs !== null;
        if (!interrupted && interruption === "filesystem_cleanup" && publicationWrite) {
          originalUpdate(row);
          movedOutbox = `${h.outbox}.saved`;
          renameSync(h.outbox, movedOutbox);
          const outside = path.join(h.root, "outside");
          mkdirSync(outside);
          symlinkSync(outside, h.outbox);
          interrupted = true;
          return;
        }
        if (!interrupted && interruption === "deletion_update_before_commit" && deletionWrite) {
          interrupted = true;
          throw new Error("deletion update interrupted before durable commit");
        }
        if (!interrupted && interruption === "deletion_update_after_commit" && deletionWrite) {
          originalUpdate(row);
          interrupted = true;
          throw new Error("deletion update interrupted after durable commit");
        }
        originalUpdate(row);
      };
      const worker = createOutboxWorker({
        outboxDir: h.outbox,
        receiptsDir: h.receipts,
        recordingsDir: h.recordings,
        journal,
        clock: { now: () => now },
        random: () => 0,
        session: {
          state: () => state,
          publish: () => assert.fail("atomic journal owns the publication transition"),
        },
        reconciliationEvidence: NOOP_PURGE,
      });
      const bundle = worker.enqueue({ artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source });
      writeFileSync(path.join(h.receipts, `${occurrencePathSegment(artifact.occurrence_id as OccurrenceId)}.json`), `${JSON.stringify(publishedReceipt(artifact, hash))}\n`);

      worker.reconcile();
      if (movedOutbox !== null) {
        unlinkSync(h.outbox);
        renameSync(movedOutbox, h.outbox);
      }
      const afterInterruption = journal.rows.get(`${artifact.occurrence_id}:${artifact.revision}`)!;
      assert.equal(interrupted, true);
      assert.notEqual(afterInterruption.retryReason, "recovery_unavailable");
      assert.equal(afterInterruption.publishedAtMs, now);

      worker.reconcile();
      const converged = journal.rows.get(`${artifact.occurrence_id}:${artifact.revision}`)!;
      assert.equal(state, "published");
      assert.equal(publishCalls, 1, "published replay must not attempt a second transition");
      assert.equal(converged.publishedAtMs, now);
      assert.equal(converged.publicationUrl, publishedReceipt(artifact, hash).markdown_url);
      assert.equal(converged.vaultCommit, "a".repeat(40));
      assert.equal(converged.deletedAtMs, now);
      assert.equal(converged.retryReason, null);
      assert.equal(converged.recoveryArtifact, null);
      assert.equal(existsSync(source), false);
      assert.equal(existsSync(bundle), false);
    } finally { h.cleanup(); }
  });
}

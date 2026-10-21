// Outbox waiting cost and transient I/O. A pending delivery does no recording
// I/O before its retry gate, does not re-read or re-hash the encrypted
// recording while it only waits for a receipt, backs off on a transient read
// error instead of stopping for good, and reports every state change as a
// static code. Synthetic bytes only.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { canonicalArtifactHash, canonicalArtifactJson, parseTeamMemMeetingArtifact } from "../src/contracts/teammem-meeting-v1.ts";
import { occurrencePathSegment, type OccurrenceId } from "../src/domain/occurrence-id.ts";
import { createOutboxWorker, type DeliveryJournal, type DeliveryRow } from "../src/delivery/outbox-worker.ts";
import type { AcceptPublicationInput, SavePendingDeliveryResult } from "../src/ports/session-store.ts";

const FIXTURES = new URL("../fixtures/contracts/", import.meta.url);
const SHA = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const NOOP_PURGE = { purgeExpiredReconciliationEvidence: () => 0 };
const COMMIT = "a".repeat(40);

class FakeJournal implements DeliveryJournal {
  readonly rows = new Map<string, DeliveryRow>();
  private readonly onPublish: () => void;
  constructor(onPublish: () => void) { this.onPublish = onPublish; }
  savePending(row: DeliveryRow): SavePendingDeliveryResult {
    const key = `${row.occurrenceId}:${row.revision}`;
    const existing = this.rows.get(key);
    if (existing !== undefined) return { kind: "replay", row: existing };
    this.rows.set(key, row);
    return { kind: "inserted", row };
  }
  pending(): readonly DeliveryRow[] { return [...this.rows.values()].filter((row) => row.deletedAtMs === null); }
  recoverablePublications(): readonly DeliveryRow[] { return []; }
  claimExpiredBackfillSeedCleanup(): null { return null; }
  completeBackfillSeedCleanup(): void { /* no seed lifecycle */ }
  authorizeDeliveryEvidenceCleanup(): boolean { return true; }
  update(row: DeliveryRow): void { this.rows.set(`${row.occurrenceId}:${row.revision}`, row); }
  acceptPublication(input: AcceptPublicationInput): void {
    const row = this.rows.get(`${input.occurrenceId}:${input.revision}`)!;
    this.update({ ...row, publishedAtMs: input.publishedAtMs, publicationUrl: input.publicationUrl, vaultCommit: input.vaultCommit, retryReason: null });
    this.onPublish();
  }
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "meeting-outbox-gate-"));
  const recordings = path.join(root, "recordings"), outbox = path.join(root, "outbox"), receipts = path.join(root, "receipts");
  mkdirSync(recordings); mkdirSync(receipts);
  const raw = structuredClone(JSON.parse(readFileSync(new URL("teammem-meeting-v1.complete.json", FIXTURES), "utf8"))) as Record<string, unknown>;
  const bytes = Buffer.from("synthetic encrypted audio bytes; never a container header", "utf8");
  (raw.audio as Record<string, unknown>).bytes = bytes.length;
  (raw.audio as Record<string, unknown>).sha256 = SHA(bytes);
  const artifact = parseTeamMemMeetingArtifact(raw);
  const serialized = canonicalArtifactJson(artifact), hash = canonicalArtifactHash(artifact);
  const source = path.join(recordings, `${"a".repeat(32)}.crsr`);
  writeFileSync(source, bytes);
  let state = "awaiting_teammem";
  const journal = new FakeJournal(() => { state = "published"; });
  const log: string[] = [], failures: string[] = [];
  const clock = { now: Date.parse("2026-09-02T14:20:00Z") };
  const worker = createOutboxWorker({ recordingsDir: recordings, outboxDir: outbox, receiptsDir: receipts, journal,
    clock: { now: () => clock.now }, random: () => 0.5, session: { state: () => state, publish: () => { state = "published"; } },
    reconciliationEvidence: NOOP_PURGE, onMaintenanceFailure: (reason) => failures.push(reason), log: (code) => log.push(code) });
  const bundle = worker.enqueue({ artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source });
  const row = () => journal.pending()[0] ?? [...journal.rows.values()][0]!;
  const writeReceipt = () => writeFileSync(path.join(receipts, `${occurrencePathSegment(artifact.occurrence_id as OccurrenceId)}.json`), `${JSON.stringify({
    artifact_hash: hash, markdown_path: "Meetings/2026-W36/[meeting].md",
    markdown_url: `https://example.test/group/vault/-/blob/${COMMIT}/Meetings/2026-W36/%5Bmeeting%5D.md`,
    occurrence_id: artifact.occurrence_id, revision: artifact.revision, schema: "teammem-meeting-receipt/v1", status: "published", vault_commit: COMMIT })}\n`);
  return { root, source, bytes, bundle, worker, clock, row, log, failures, writeReceipt, state: () => state, artifact,
    cleanup: () => { if (existsSync(source)) chmodSync(source, 0o600); rmSync(root, { recursive: true, force: true }); } };
}

test("a waiting delivery does no recording I/O before its retry gate (an unreadable source changes nothing)", () => {
  const f = fixture();
  try {
    f.worker.reconcile();
    const pick = () => { const { retryReason, retryCount, nextRetryAtMs, publishedAtMs } = f.row(); return { retryReason, retryCount, nextRetryAtMs, publishedAtMs }; };
    const waiting = pick();
    assert.equal(waiting.retryReason, "receipt_unavailable");
    chmodSync(f.source, 0o000);
    f.worker.reconcile();
    assert.deepEqual(pick(), waiting, "nothing changes before nextRetryAtMs");
  } finally { f.cleanup(); }
});

test("at its retry gate a delivery still waiting for a receipt checks the READY bundle, never re-reads or re-hashes the recording", () => {
  const f = fixture();
  try {
    f.worker.reconcile();
    chmodSync(f.source, 0o000);
    f.clock.now = f.row().nextRetryAtMs;
    f.worker.reconcile();
    assert.equal(f.row().retryReason, "receipt_unavailable");
    assert.equal(f.row().retryCount, 2);
    assert.deepEqual(f.failures, []);
    assert.deepEqual(f.log, ["delivery_receipt_waiting"], "no recording read was attempted, so no recovery retry");
  } finally { f.cleanup(); }
});

test("a transient read error while accepting a receipt backs off with a bounded delay and publishes once the source is readable", () => {
  const f = fixture();
  try {
    f.worker.reconcile();
    f.writeReceipt();
    chmodSync(f.source, 0o000);
    const gate = f.row().nextRetryAtMs;
    f.clock.now = gate;
    f.worker.reconcile();
    const backedOff = f.row();
    assert.notEqual(backedOff.retryReason, "recovery_unavailable", "a transient error is never terminal");
    assert.equal(backedOff.publishedAtMs, null);
    assert.ok(backedOff.nextRetryAtMs >= gate + 1_000 && backedOff.nextRetryAtMs <= gate + 60_000, "bounded backoff");
    assert.ok(f.log.includes("delivery_recovery_retry"));
    chmodSync(f.source, 0o600);
    f.clock.now = backedOff.nextRetryAtMs;
    f.worker.reconcile();
    assert.equal(f.state(), "published");
    assert.ok(f.log.includes("delivery_published"));
    assert.ok(f.log.every((code) => /^delivery_[a-z_]+$/.test(code)), "static codes, no identifiers or paths");
  } finally { f.cleanup(); }
});

test("an integrity mismatch is terminal, reported through the maintenance failure hook and logged", () => {
  const f = fixture();
  try {
    f.worker.reconcile();
    f.writeReceipt();
    writeFileSync(f.source, Buffer.alloc(f.bytes.length, 0x41));
    f.clock.now = f.row().nextRetryAtMs;
    f.worker.reconcile();
    assert.equal(f.row().retryReason, "recovery_unavailable");
    assert.deepEqual(f.failures, ["delivery_recovery_unavailable"]);
    assert.ok(f.log.includes("delivery_recovery_unavailable"));
  } finally { f.cleanup(); }
});

test("a missing READY bundle is rebuilt at the retry gate, not on every tick before it", () => {
  const f = fixture();
  try {
    f.worker.reconcile();
    rmSync(f.bundle, { recursive: true, force: true });
    f.worker.reconcile();
    assert.equal(existsSync(path.join(f.bundle, "READY")), false, "no filesystem work before the gate");
    f.clock.now = f.row().nextRetryAtMs;
    f.worker.reconcile();
    assert.equal(existsSync(path.join(f.bundle, "READY")), true);
    assert.equal(f.row().retryReason, "receipt_unavailable");
  } finally { f.cleanup(); }
});

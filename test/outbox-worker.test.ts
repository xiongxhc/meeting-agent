import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { parseTeamMemMeetingArtifact, canonicalArtifactHash, canonicalArtifactJson } from "../src/contracts/teammem-meeting-v1.ts";
import { deleteDeliveredEvidence, writeMeetingBundle } from "../src/adapters/filesystem-outbox.ts";
import { readPublicationReceipt } from "../src/adapters/receipt-inbox.ts";
import { occurrencePathSegment, type OccurrenceId } from "../src/domain/occurrence-id.ts";
import { createOutboxWorker, type DeliveryJournal, type DeliveryRow } from "../src/delivery/outbox-worker.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";

const FIXTURES = new URL("../fixtures/contracts/", import.meta.url);
const SHA = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const NOOP_PURGE = { purgeExpiredReconciliationEvidence: () => 0 };

function harness(): { root: string; recordings: string; outbox: string; receipts: string; cleanup(): void } {
  const root = mkdtempSync(path.join(tmpdir(), "meeting-outbox-test-"));
  const recordings = path.join(root, "recordings");
  const outbox = path.join(root, "outbox");
  const receipts = path.join(root, "receipts");
  mkdirSync(recordings);
  mkdirSync(receipts);
  return { root, recordings, outbox, receipts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function artifactAndAudio(): { artifact: ReturnType<typeof parseTeamMemMeetingArtifact>; bytes: Buffer; serialized: string; hash: string } {
  const artifact = structuredClone(JSON.parse(readFileSync(new URL("teammem-meeting-v1.complete.json", FIXTURES), "utf8"))) as Record<string, unknown>;
  const bytes = Buffer.from("synthetic encrypted audio bytes; never a container header", "utf8");
  const audio = artifact.audio as Record<string, unknown>;
  audio.bytes = bytes.length;
  audio.sha256 = SHA(bytes);
  const parsed = parseTeamMemMeetingArtifact(artifact);
  return { artifact: parsed, bytes, serialized: canonicalArtifactJson(parsed), hash: canonicalArtifactHash(parsed) };
}

class FakeJournal implements DeliveryJournal {
  readonly rows = new Map<string, DeliveryRow>();
  failSave = false;

  savePending(row: DeliveryRow): void {
    if (this.failSave) throw new Error("synthetic journal failure");
    this.rows.set(`${row.occurrenceId}:${row.revision}`, row);
  }
  pending(): readonly DeliveryRow[] { return [...this.rows.values()].filter((row) => row.deletedAtMs === null); }
  update(row: DeliveryRow): void { this.savePending(row); }
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

test("writes the exact four-file TeamMem bundle atomically from a verified encrypted recording", () => {
  const h = harness();
  try {
    const { artifact, bytes, serialized, hash } = artifactAndAudio();
    const source = path.join(h.recordings, "final.enc");
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
    const source = path.join(h.recordings, "final.enc");
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
    const source = path.join(h.recordings, "final.enc");
    writeFileSync(source, bytes);
    const journal = new FakeJournal();
    let state = "awaiting_teammem";
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
    const source = path.join(h.recordings, "final.enc");
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
    const completeSource = path.join(h.recordings, "complete.enc");
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
      const source = path.join(h.recordings, "final.enc");
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
    recordingPath: path.join(h.recordings, "final.enc"), bundlePath: path.join(h.outbox, "segment", String(artifact.revision)),
    endedAtMs: Date.parse(artifact.ended_at), transcriptComplete: false, retryCount: 2,
    nextRetryAtMs: now + 4_000, retryReason: "receipt_unavailable", publishedAtMs: null,
    deletedAtMs: null, publicationUrl: null, vaultCommit: null,
    recoveryArtifact: null, stageToken: null,
  };
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
    assert.throws(() => first.savePending({ ...row, occurrenceId: otherOccurrence, artifactHash: `sha256:${"c".repeat(64)}`, bundlePath: `${row.bundlePath}-other` }), /another occurrence/i);
  } finally {
    first.close();
  }
  const second = openSessionStore({ filename: path.join(h.root, "orchestration.db"), nowMs: now + 1 });
  try {
    assert.equal(second.pending().length, 2);
    assert.deepEqual(second.pending().find((pending) => pending.revision === row.revision), row);
    const published: DeliveryRow = { ...row, retryReason: null, publishedAtMs: now + 2, publicationUrl: "https://example.test/-/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Meetings/note.md", vaultCommit: "a".repeat(40) };
    second.update(published);
  } finally {
    second.close();
  }
  const third = openSessionStore({ filename: path.join(h.root, "orchestration.db"), nowMs: now + 3 });
  try {
    assert.equal(third.pending().length, 2);
    assert.deepEqual(third.pending().find((pending) => pending.revision === row.revision), { ...row, retryReason: null, publishedAtMs: now + 2, publicationUrl: "https://example.test/-/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Meetings/note.md", vaultCommit: "a".repeat(40) });
  } finally {
    third.close();
    h.cleanup();
  }
});

test("a corrupted journal row cannot delete a sibling outbox directory", () => {
  const h = harness();
  try {
    const { artifact, bytes, serialized, hash } = artifactAndAudio();
    const source = path.join(h.recordings, "final.enc");
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
    assert.throws(() => worker.reconcile(), /bundle|occurrence|delete/i);
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
    const source = path.join(h.recordings, "final.enc");
    writeFileSync(source, bytes);
    const child = path.join(h.root, "crash-writer.ts");
    writeFileSync(child, `import { writeMeetingBundle } from ${JSON.stringify(new URL("../src/adapters/filesystem-outbox.ts", import.meta.url).href)};
const input = JSON.parse(process.argv[2]);
writeMeetingBundle({...input, fault: (step) => { if (step === "after_audio_write") process.exit(77); }});\n`);
    const result = spawnSync(process.execPath, [child, JSON.stringify({ recordingsDir: h.recordings, outboxDir: h.outbox, artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source })]);
    assert.equal(result.status, 77);
    const occurrence = path.join(h.outbox, occurrencePathSegment(artifact.occurrence_id as OccurrenceId));
    const stages = readdirSync(occurrence).filter((name) => name.startsWith(`.${artifact.revision}.staging-`));
    assert.equal(stages.length, 1);
    assert.equal(existsSync(path.join(occurrence, stages[0]!, "audio.enc")), true);

    const bundle = writeMeetingBundle({ recordingsDir: h.recordings, outboxDir: h.outbox, artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source });
    deleteDeliveredEvidence({ recordingsDir: h.recordings, outboxDir: h.outbox, occurrenceId: artifact.occurrence_id, revision: artifact.revision, recordingPath: source, bundlePath: bundle });
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
    }), /symlink|outside|containment/i);
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
      const source = path.join(h.recordings, "final.enc");
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
    const source = path.join(h.recordings, "final.enc");
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
    const oldSource = path.join(h.recordings, "old.enc");
    writeFileSync(oldSource, first.bytes);
    const complete = structuredClone(oldArtifact) as typeof oldArtifact;
    complete.transcript_complete = true;
    complete.revision += 1;
    const newArtifact = parseTeamMemMeetingArtifact(complete);
    const newSource = path.join(h.recordings, "new.enc");
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

test("matching receipts do nothing in every state except awaiting_teammem or published replay", () => {
  for (const state of [null, "listening", "finalizing", "failed", "notified", "discovered"]) {
    const h = harness();
    try {
      const { artifact, bytes, serialized, hash } = artifactAndAudio();
      const source = path.join(h.recordings, "final.enc");
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
    const firstSource = path.join(h.recordings, "first.enc");
    const secondSource = path.join(h.recordings, "second.enc");
    writeFileSync(firstSource, first.bytes);
    writeFileSync(secondSource, first.bytes);
    const journal = new FakeJournal();
    const published: string[] = [];
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
    const source = path.join(h.recordings, "final.enc");
    writeFileSync(source, bytes);
    const calls: string[] = [];
    const bundle = writeMeetingBundle({ recordingsDir: h.recordings, outboxDir: h.outbox, artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source, directoryFsync: (directory) => calls.push(path.resolve(directory)) });
    const occurrence = path.dirname(bundle);
    assert.ok(calls.indexOf(path.dirname(h.outbox)) >= 0);
    assert.ok(calls.indexOf(h.outbox) >= 0);
    assert.ok(calls.lastIndexOf(occurrence) > calls.indexOf(h.outbox));
  } finally { h.cleanup(); }
});

test("reconcile reconstructs a durable delivery and removes its stage even when OWNER names a live reused PID", () => {
  const h = harness();
  try {
    const { artifact, bytes, serialized, hash } = artifactAndAudio();
    const source = path.join(h.recordings, "final.enc");
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
    const stage = path.join(occurrence, `.${artifact.revision}.staging-reused-pid`);
    mkdirSync(stage);
    writeFileSync(path.join(stage, "OWNER"), String(process.pid));
    writeFileSync(path.join(stage, "audio.enc"), bytes);

    worker.reconcile();
    assert.equal(existsSync(path.join(bundle, "READY")), true, "durable journal input must recreate the missing READY bundle");
    now = journal.pending()[0]!.nextRetryAtMs;
    writeFileSync(path.join(h.receipts, `${occurrencePathSegment(artifact.occurrence_id as OccurrenceId)}.json`), `${JSON.stringify(publishedReceipt(artifact, hash))}\n`);
    worker.reconcile();
    assert.equal(existsSync(source), false);
    assert.equal(existsSync(stage), false, "PID reuse is not ownership of a delivery stage");
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
    const source = path.join(h.recordings, "race.enc");
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
    const source = path.join(h.recordings, "final.enc");
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

test("a reopened worker recovers every durable-intent crash cut and later deletes its evidence", () => {
  for (const cut of ["before_stage", "after_audio_write", "after_staging_fsync", "after_rename", "before_ready_write"] as const) {
    const h = harness();
    try {
      const { artifact, bytes, serialized, hash } = artifactAndAudio();
      const source = path.join(h.recordings, "final.enc");
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

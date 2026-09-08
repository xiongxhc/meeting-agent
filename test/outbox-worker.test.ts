import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { parseTeamMemMeetingArtifact, canonicalArtifactHash, canonicalArtifactJson } from "../src/contracts/teammem-meeting-v1.ts";
import { writeMeetingBundle } from "../src/adapters/filesystem-outbox.ts";
import { readPublicationReceipt } from "../src/adapters/receipt-inbox.ts";
import { occurrencePathSegment, type OccurrenceId } from "../src/domain/occurrence-id.ts";
import { createOutboxWorker, type DeliveryJournal, type DeliveryRow } from "../src/delivery/outbox-worker.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";

const FIXTURES = new URL("../fixtures/contracts/", import.meta.url);
const SHA = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

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

  savePending(row: DeliveryRow): void { this.rows.set(`${row.occurrenceId}:${row.revision}`, row); }
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
      assert.throws(() => writeMeetingBundle({ recordingsDir: h.recordings, outboxDir: h.outbox, artifact, serializedArtifact: serialized, artifactHash: hash, recordingPath: source, ...input }), /audio|artifact|recording|hash/i);
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
      session: { state: () => state, publish: () => { state = "published"; } },
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
    let now = Date.parse("2026-09-02T14:00:00Z");
    const worker = createOutboxWorker({
      outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal,
      clock: { now: () => now }, random: () => 0,
      session: { state: () => "awaiting_teammem", publish: () => undefined },
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

    now = Date.parse(artifact.ended_at) + 14 * 24 * 60 * 60 * 1000 - 1;
    worker.reconcile();
    assert.equal(statSync(source).isFile(), true);
    now += 1;
    worker.reconcile();
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
  };
  const first = openSessionStore({ filename: path.join(h.root, "orchestration.db"), nowMs: now });
  try {
    first.createSession({ occurrenceId: artifact.occurrence_id, providerMeetingId: artifact.provider_meeting_id, occurrenceStartedAt: artifact.started_at, nowMs: now });
    first.savePending(row);
  } finally {
    first.close();
  }
  const second = openSessionStore({ filename: path.join(h.root, "orchestration.db"), nowMs: now + 1 });
  try {
    assert.deepEqual(second.pending(), [row]);
    const published: DeliveryRow = { ...row, retryReason: null, publishedAtMs: now + 2, publicationUrl: "https://example.test/-/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Meetings/note.md", vaultCommit: "a".repeat(40) };
    second.update(published);
  } finally {
    second.close();
  }
  const third = openSessionStore({ filename: path.join(h.root, "orchestration.db"), nowMs: now + 3 });
  try {
    assert.deepEqual(third.pending(), [{ ...row, retryReason: null, publishedAtMs: now + 2, publicationUrl: "https://example.test/-/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Meetings/note.md", vaultCommit: "a".repeat(40) }]);
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
      session: { state: () => "awaiting_teammem", publish: () => undefined },
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

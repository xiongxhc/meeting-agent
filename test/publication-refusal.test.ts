// TeamMem's terminal refusal record (`<segment>/<revision>.refused.json`),
// the refused delivery state it drives, and the TeamMem text rules applied
// before a bundle is written. Real SQLite and real files in a private temp
// root; no network, provider or key.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import Database from "better-sqlite3";

import { createFilesystemPublicationRefusalAlert } from "../src/adapters/filesystem-operator-warning.ts";
import { readPublicationRefusal } from "../src/adapters/receipt-inbox.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { canonicalArtifactHash, canonicalArtifactJson, normalizeTeamMemText, parseTeamMemMeetingArtifact, teamMemTextViolations } from "../src/contracts/teammem-meeting-v1.ts";
import { buildTimedTeamMemMeetingArtifactV2, NO_VERBATIM_INSTRUCTION } from "../src/delivery/artifact-builder.ts";
import { createOutboxWorker, type PublicationRefusalAlert } from "../src/delivery/outbox-worker.ts";
import { createOwnedTimedSampleEvidence } from "../src/domain/attribution-evidence.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { occurrencePathSegment, type OccurrenceId } from "../src/domain/occurrence-id.ts";
import type { TimedReconciledTranscript } from "../src/domain/transcript.ts";

const FIXTURES = new URL("../fixtures/contracts/", import.meta.url);
const SHA = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const COMMIT = "a".repeat(40);
const INVARIANT = "meeting.leakage.forbidden-content";
const REASON = "transcript_text_in_note";

function harness() {
  const root = mkdtempSync(path.join(tmpdir(), "meeting-refusal-test-"));
  const recordings = path.join(root, "recordings"), outbox = path.join(root, "outbox"), receipts = path.join(root, "receipts");
  for (const dir of [recordings, outbox, receipts]) { mkdirSync(dir, { mode: 0o700 }); chmodSync(dir, 0o700); }
  return { root, recordings, outbox, receipts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function artifact(revision = 3, mutate: (value: Record<string, unknown>) => void = () => undefined) {
  const value = structuredClone(JSON.parse(readFileSync(new URL("teammem-meeting-v1.complete.json", FIXTURES), "utf8"))) as Record<string, unknown>;
  const bytes = Buffer.from("synthetic encrypted audio bytes; never a container header", "utf8");
  const audio = value.audio as Record<string, unknown>;
  audio.bytes = bytes.length;
  audio.sha256 = SHA(bytes);
  value.revision = revision;
  mutate(value);
  const parsed = parseTeamMemMeetingArtifact(value);
  return { artifact: parsed, bytes, serialized: canonicalArtifactJson(parsed), hash: canonicalArtifactHash(parsed) };
}

/** The producer's bytes: sorted keys, compact, one trailing newline. */
function refusalRecord(occurrenceId: string, revision: number, artifactHash: string): Record<string, unknown> {
  return { artifact_hash: artifactHash, invariants: [INVARIANT], occurrence_id: occurrenceId, reason_code: REASON, revision,
    schema: "teammem-meeting-refusal/v1", status: "refused" };
}

function writeRefusal(receipts: string, occurrenceId: string, revision: number, body: string | Buffer): string {
  const directory = path.join(receipts, occurrencePathSegment(occurrenceId as OccurrenceId));
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${revision}.refused.json`);
  writeFileSync(file, body);
  return file;
}

function writeReceipt(receipts: string, occurrenceId: string, revision: number, artifactHash: string): void {
  const receipt = { artifact_hash: artifactHash, markdown_path: "Meetings/2026-W36/[meeting].md",
    markdown_url: `https://example.test/group/vault/-/blob/${COMMIT}/Meetings/2026-W36/%5Bmeeting%5D.md`, occurrence_id: occurrenceId, revision,
    schema: "teammem-meeting-receipt/v1", status: "published", vault_commit: COMMIT };
  writeFileSync(path.join(receipts, `${occurrencePathSegment(occurrenceId as OccurrenceId)}.json`), `${JSON.stringify(receipt)}\n`);
}

/** A real SQLite store, one recording and one enqueued revision. */
function durable(h: ReturnType<typeof harness>, built = artifact(), alert?: (input: PublicationRefusalAlert) => void) {
  const filename = path.join(h.root, "orchestration.db");
  const source = path.join(h.recordings, `${"a".repeat(32)}.crsr`);
  writeFileSync(source, built.bytes);
  let now = Date.parse(built.artifact.ended_at) + 1_000;
  let store = openSessionStore({ filename, nowMs: now });
  store.createSession({ occurrenceId: built.artifact.occurrence_id, providerMeetingId: built.artifact.provider_meeting_id, occurrenceStartedAt: built.artifact.started_at, nowMs: now });
  store.finalizeSession({
    transition: { occurrenceId: built.artifact.occurrence_id, fromState: "discovered", toState: "awaiting_teammem", reason: "test", terminalReason: null, nowMs: now },
    recording: { handle: "a".repeat(32), encryptedPath: source, sha256: SHA(built.bytes).slice(7), durationMs: 1, format: "opus", keyId: "fake-key", gaps: [], runtimeGaps: [] },
  });
  const alerts: PublicationRefusalAlert[] = [];
  const failures: string[] = [];
  const worker = () => createOutboxWorker({
    outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal: store,
    clock: { now: () => now }, random: () => 0, reconciliationEvidence: store,
    session: { state: (id) => store.getSession(id)?.state ?? null, publish: () => { throw new Error("unused"); } },
    onMaintenanceFailure: (reason) => { failures.push(reason); },
    onPublicationRefused: (input) => { (alert ?? (() => undefined))(input); alerts.push(input); },
  });
  const bundle = worker().enqueue({ artifact: built.artifact, serializedArtifact: built.serialized, artifactHash: built.hash, recordingPath: source });
  return {
    filename, source, bundle, worker, alerts, failures, built,
    store: () => store,
    now: () => now,
    advance: (value: number) => { now = value; },
    reopen: () => { store.close(); store = openSessionStore({ filename, nowMs: now }); },
    close: () => store.close(),
  };
}

// ---------------------------------------------------------------------------
// The strict reader
// ---------------------------------------------------------------------------

test("the refusal reader accepts the producer's exact bytes, byte for byte as Python's json.dumps writes them", () => {
  const h = harness();
  try {
    const occurrenceId = "会议 (x)@2026-09-02T14:00:00Z", hash = `sha256:${"c".repeat(64)}`;
    // python3: json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"
    const python = `{"artifact_hash":"sha256:${"c".repeat(64)}","invariants":["meeting.leakage.forbidden-content"],"occurrence_id":"会议 (x)@2026-09-02T14:00:00Z","reason_code":"transcript_text_in_note","revision":3,"schema":"teammem-meeting-refusal/v1","status":"refused"}\n`;
    const file = writeRefusal(h.receipts, occurrenceId, 3, python);
    assert.equal(path.basename(path.dirname(file)), "%E4%BC%9A%E8%AE%AE%20%28x%29_20260902T140000Z");
    assert.deepEqual(readPublicationRefusal({ receiptsDir: h.receipts, occurrenceId, revision: 3, artifactHash: hash }), refusalRecord(occurrenceId, 3, hash));
    assert.equal(readPublicationRefusal({ receiptsDir: h.receipts, occurrenceId, revision: 4, artifactHash: hash }), null, "another revision's file is not read");
  } finally { h.cleanup(); }
});

test("the refusal reader rejects every non-exact, non-canonical or unsafe record", () => {
  const h = harness();
  try {
    const { artifact: a, hash } = artifact();
    const id = a.occurrence_id, valid = refusalRecord(id, 3, hash);
    const read = () => readPublicationRefusal({ receiptsDir: h.receipts, occurrenceId: id, revision: 3, artifactHash: hash });
    const file = writeRefusal(h.receipts, id, 3, `${JSON.stringify(valid)}\n`);
    assert.deepEqual(read(), valid);
    const variants: readonly (string | Buffer)[] = [
      { ...valid, revision: 2 }, { ...valid, revision: 4 }, { ...valid, revision: 0 }, { ...valid, revision: 3.5 }, { ...valid, revision: "3" },
      { ...valid, occurrence_id: "other@2026-09-02T14:00:00Z" }, { ...valid, artifact_hash: `sha256:${"b".repeat(64)}` },
      { ...valid, artifact_hash: `sha256:${"C".repeat(64)}` }, { ...valid, schema: "teammem-meeting-refusal/v2" },
      { ...valid, schema: "teammem-meeting-receipt/v1" }, { ...valid, status: "published" }, { ...valid, status: "held" },
      { ...valid, reason_code: "" }, { ...valid, reason_code: "Transcript" }, { ...valid, reason_code: "a b" }, { ...valid, reason_code: "x".repeat(65) },
      { ...valid, reason_code: 7 }, { ...valid, invariants: "meeting.leakage.forbidden-content" }, { ...valid, invariants: [7] },
      { ...valid, invariants: ["b", "a"] }, { ...valid, invariants: ["a", "a"] }, { ...valid, invariants: ["../x"] },
      { ...valid, invariants: ["note text with spaces"] }, { ...valid, extra: true },
      Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "invariants")),
    ].map((value) => `${JSON.stringify(Object.fromEntries(Object.entries(value).sort(([l], [r]) => (l < r ? -1 : 1))))}\n`);
    for (const raw of [...variants, JSON.stringify(valid, null, 2) + "\n", JSON.stringify(valid), JSON.stringify(valid) + "\n\n",
      `${JSON.stringify(Object.fromEntries(Object.entries(valid).reverse()))}\n`, Buffer.from([0xff, 0xfe, 0x7b, 0x7d]), "[]\n", "null\n",
      `${JSON.stringify(valid)}\n${" ".repeat(17 * 1024)}`]) {
      writeFileSync(file, raw);
      assert.equal(read(), null, String(raw).slice(0, 120));
    }
    // A symlinked record, a symlinked occurrence directory and a directory in
    // place of the record are all refused, even with valid bytes behind them.
    const outside = path.join(h.root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "3.refused.json"), `${JSON.stringify(valid)}\n`);
    rmSync(file);
    symlinkSync(path.join(outside, "3.refused.json"), file);
    assert.equal(read(), null);
    rmSync(path.dirname(file), { recursive: true });
    symlinkSync(outside, path.dirname(file));
    assert.equal(read(), null);
    rmSync(path.dirname(file));
    mkdirSync(file, { recursive: true });
    assert.equal(read(), null);
    assert.equal(readPublicationRefusal({ receiptsDir: h.receipts, occurrenceId: "not an occurrence", revision: 3, artifactHash: hash }), null);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// The refused delivery state
// ---------------------------------------------------------------------------

test("an exact refusal makes the pending revision terminal: one operator alert, no further retry, evidence kept until the deadline", () => {
  const h = harness();
  const d = durable(h);
  try {
    const { artifact: a, hash } = d.built;
    d.worker().reconcile();
    const waiting = d.store().pending()[0]!;
    assert.equal(waiting.retryReason, "receipt_unavailable");
    assert.equal(waiting.retryCount, 1);
    writeRefusal(h.receipts, a.occurrence_id, a.revision, `${JSON.stringify(refusalRecord(a.occurrence_id, a.revision, hash))}\n`);
    d.advance(waiting.nextRetryAtMs);
    d.worker().reconcile();
    const refused = d.store().pending()[0]!;
    assert.equal(refused.refusalReason, REASON);
    assert.equal(refused.retryCount, 1, "a refusal is not a retry");
    assert.deepEqual(d.alerts, [{ occurrenceId: a.occurrence_id, revision: a.revision, artifactHash: hash, reasonCode: REASON }]);
    assert.equal(d.store().getSession(a.occurrence_id)?.state, "awaiting_teammem", "nothing was published");
    assert.deepEqual(d.store().notifications(), [], "the organizer gets no speculative message");
    for (const step of [60_000, 60_000, DAY_MS]) {
      d.advance(d.now() + step);
      d.reopen();
      d.worker().reconcile();
      const row = d.store().pending()[0]!;
      assert.equal(row.refusalReason, REASON, "the terminal state survives reopen");
      assert.equal(row.retryCount, 1, "no retry count after refusal");
      assert.equal(row.retryReason, refused.retryReason);
      assert.equal(row.nextRetryAtMs, d.now() + 60_000, "rechecked at the retry cap, never a growing backoff");
    }
    assert.equal(d.alerts.length, 1, "the operator is alerted once");
    assert.equal(existsSync(d.source), true, "the refusal releases no evidence early");
    assert.equal(existsSync(d.bundle), true);
    d.advance(Date.parse(a.ended_at) + 14 * DAY_MS);
    d.worker().reconcile();
    assert.deepEqual(d.store().pending(), [], "retention still ends at ended_at + 14 days");
    assert.equal(existsSync(d.source), false);
    assert.equal(existsSync(d.bundle), false);
  } finally { d.close(); h.cleanup(); }
});

test("a refusal for another revision or artifact hash is ignored and the receipt is retried as before", () => {
  const h = harness();
  const d = durable(h);
  try {
    const { artifact: a, hash } = d.built;
    writeRefusal(h.receipts, a.occurrence_id, a.revision - 1, `${JSON.stringify(refusalRecord(a.occurrence_id, a.revision - 1, hash))}\n`);
    writeRefusal(h.receipts, a.occurrence_id, a.revision, `${JSON.stringify(refusalRecord(a.occurrence_id, a.revision, `sha256:${"b".repeat(64)}`))}\n`);
    for (let pass = 1; pass <= 3; pass += 1) {
      d.worker().reconcile();
      const row = d.store().pending()[0]!;
      assert.equal(row.refusalReason, undefined);
      assert.equal(row.retryCount, pass);
      assert.equal(row.retryReason, "receipt_unavailable");
      d.advance(row.nextRetryAtMs);
    }
    assert.deepEqual(d.alerts, []);
  } finally { d.close(); h.cleanup(); }
});

test("a failed operator alert records nothing, is a visible maintenance failure and is raised again on the next pass", () => {
  const h = harness();
  let failing = true;
  const d = durable(h, artifact(), () => { if (failing) throw new Error("synthetic alert sink failure"); });
  try {
    const { artifact: a, hash } = d.built;
    writeRefusal(h.receipts, a.occurrence_id, a.revision, `${JSON.stringify(refusalRecord(a.occurrence_id, a.revision, hash))}\n`);
    d.worker().reconcile();
    const row = d.store().pending()[0]!;
    assert.equal(row.refusalReason, undefined, "the refusal is not recorded before its alert is durable");
    assert.equal(row.retryReason, "receipt_unavailable", "the row stays retryable, never recovery_unavailable");
    assert.deepEqual(d.failures, ["publication_refusal_alert_failed"]);
    failing = false;
    d.advance(row.nextRetryAtMs);
    d.worker().reconcile();
    assert.equal(d.store().pending()[0]!.refusalReason, REASON);
    assert.equal(d.alerts.length, 1);
  } finally { d.close(); h.cleanup(); }
});

test("a higher revision still publishes after a lower one was refused, and cleans the refused revision with it", () => {
  const h = harness();
  const first = artifact(3);
  const d = durable(h, first);
  try {
    const a = first.artifact;
    writeRefusal(h.receipts, a.occurrence_id, 3, `${JSON.stringify(refusalRecord(a.occurrence_id, 3, first.hash))}\n`);
    d.worker().reconcile();
    assert.equal(d.store().pending()[0]!.refusalReason, REASON);
    const second = artifact(4, (value) => { value.summary = "The team rephrased the notes and published a higher revision."; });
    d.worker().enqueue({ artifact: second.artifact, serializedArtifact: second.serialized, artifactHash: second.hash, recordingPath: d.source });
    writeReceipt(h.receipts, a.occurrence_id, 4, second.hash);
    d.advance(d.now() + 1_000);
    d.worker().reconcile();
    assert.equal(d.store().getSession(a.occurrence_id)?.state, "published");
    assert.deepEqual(d.store().pending(), [], "the complete higher receipt cleans every lower revision, refused or not");
    assert.equal(existsSync(d.source), false);
    const rows = new Database(d.filename, { readonly: true });
    try {
      assert.deepEqual(rows.prepare("SELECT revision, refusal_reason, published_at_ms IS NOT NULL AS published FROM delivery_journal ORDER BY revision").all(),
        [{ revision: 3, refusal_reason: REASON, published: 0 }, { revision: 4, refusal_reason: null, published: 1 }]);
    } finally { rows.close(); }
  } finally { d.close(); h.cleanup(); }
});

test("an exact receipt wins over a refusal, and a refused revision the producer later publishes is still accepted", () => {
  const h = harness();
  const d = durable(h);
  try {
    const { artifact: a, hash } = d.built;
    const refusal = writeRefusal(h.receipts, a.occurrence_id, a.revision, `${JSON.stringify(refusalRecord(a.occurrence_id, a.revision, hash))}\n`);
    d.worker().reconcile();
    assert.equal(d.store().pending()[0]!.refusalReason, REASON);
    // The operator deletes the record (TeamMem's documented retry) and TeamMem
    // publishes this same revision.
    rmSync(refusal);
    writeReceipt(h.receipts, a.occurrence_id, a.revision, hash);
    d.advance(d.now() + 60_000);
    d.worker().reconcile();
    assert.equal(d.store().getSession(a.occurrence_id)?.state, "published");
    assert.equal(d.store().notifications().length, 1, "the organizer hears only of the confirmed publication");
  } finally { d.close(); h.cleanup(); }
  const h2 = harness();
  const d2 = durable(h2);
  try {
    const { artifact: a, hash } = d2.built;
    writeRefusal(h2.receipts, a.occurrence_id, a.revision, `${JSON.stringify(refusalRecord(a.occurrence_id, a.revision, hash))}\n`);
    writeReceipt(h2.receipts, a.occurrence_id, a.revision, hash);
    d2.worker().reconcile();
    assert.equal(d2.store().getSession(a.occurrence_id)?.state, "published");
    assert.deepEqual(d2.alerts, []);
  } finally { d2.close(); h2.cleanup(); }
});

test("migration 031: a refusal reason is bounded, immutable once set and only for an unpublished pending revision", () => {
  const h = harness();
  const d = durable(h);
  const db = new Database(d.filename);
  try {
    assert.equal(d.store().appliedMigrations().some((m) => m.name === "031_delivery_publication_refusal.sql"), true);
    assert.throws(() => db.prepare("UPDATE delivery_journal SET refusal_reason = 'Has Spaces'").run(), /CHECK/);
    assert.throws(() => db.prepare("UPDATE delivery_journal SET refusal_reason = ?").run("x".repeat(65)), /CHECK/);
    db.prepare("UPDATE delivery_journal SET refusal_reason = 'transcript_text_in_note'").run();
    // A caller holding a row read before the refusal cannot clear it.
    const { refusalReason, ...stale } = d.store().pending()[0]!;
    assert.equal(refusalReason, "transcript_text_in_note");
    d.store().update({ ...stale, retryCount: stale.retryCount + 1 });
    assert.equal(d.store().pending()[0]!.refusalReason, "transcript_text_in_note");
    assert.throws(() => db.prepare("UPDATE delivery_journal SET refusal_reason = 'other_reason'").run(), /immutable/);
    assert.throws(() => db.prepare("UPDATE delivery_journal SET refusal_reason = NULL").run(), /immutable/);
    db.prepare("UPDATE delivery_journal SET refusal_reason = 'transcript_text_in_note', published_at_ms = 1, publication_url = 'https://example.test/x', vault_commit = ?").run(COMMIT);
    db.exec("DROP TRIGGER delivery_journal_refusal_monotonic");
    db.prepare("UPDATE delivery_journal SET refusal_reason = NULL").run();
    assert.throws(() => db.prepare("UPDATE delivery_journal SET refusal_reason = 'transcript_text_in_note'").run(), /unpublished pending revision/);
  } finally { db.close(); d.close(); h.cleanup(); }
});

// ---------------------------------------------------------------------------
// The operator alert file
// ---------------------------------------------------------------------------

test("the refusal alert is one private file of identity, hash and reason code, idempotent on replay, cleared exactly", () => {
  const h = harness();
  try {
    const { artifact: a, hash } = artifact();
    const alert = createFilesystemPublicationRefusalAlert({ outboxDir: h.outbox });
    const input = { occurrenceId: a.occurrence_id, revision: 3, artifactHash: hash, reasonCode: REASON };
    alert.raise(input);
    alert.raise(input);
    const directory = path.join(h.outbox, "operator-warnings");
    const files = readdirSync(directory);
    assert.equal(files.length, 1);
    const file = path.join(directory, files[0]!);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const bytes = readFileSync(file, "utf8");
    assert.deepEqual(JSON.parse(bytes), { schema: "meeting-publication-refusal-alert/v1", occurrenceId: a.occurrence_id, revision: 3,
      artifactHash: hash, reason: "publication_refused", reasonCode: REASON });
    assert.equal(bytes.includes(a.title), false, "no title or meeting text");
    alert.raise({ ...input, revision: 4 });
    assert.equal(readdirSync(directory).length, 2, "each refused revision alerts on its own");
    alert.clear({ ...input, revision: 4 });
    alert.clear({ ...input, revision: 4 });
    assert.deepEqual(readdirSync(directory), files, "clear removes exactly that alert, and a replay is a no-op");
    alert.clear({ ...input, revision: 5 });
    writeFileSync(file, "tampered\n");
    assert.throws(() => alert.raise(input), /unsafe or conflicting/);
    assert.throws(() => alert.clear(input), /unsafe or conflicting/, "a file with other bytes is never removed");
    assert.equal(existsSync(file), true);
    for (const bad of [{ ...input, reasonCode: "Bad Code" }, { ...input, revision: 0 }, { ...input, artifactHash: "sha256:x" }, { ...input, occurrenceId: "no-start" }]) {
      assert.throws(() => alert.raise(bad), /invalid publication refusal alert/);
      assert.throws(() => alert.clear(bad), /invalid publication refusal alert/);
    }
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// TeamMem text rules before a bundle is written
// ---------------------------------------------------------------------------

test("the contract mirrors TeamMem's text rules: prose keeps tab and line breaks, names and titles admit no control and no dot segment", () => {
  const check = (mutate: (value: Record<string, unknown>) => void) => teamMemTextViolations(artifact(3, mutate).artifact);
  assert.deepEqual(check(() => undefined), []);
  assert.deepEqual(check((v) => { v.summary = "Line one\nline two\r\n\tindented"; }), []);
  assert.deepEqual(check((v) => { v.summary = "Stray \u001b escape"; }), ["summary"]);
  assert.deepEqual(check((v) => { v.summary = "C1 \u0085 next line"; }), ["summary"]);
  assert.deepEqual(check((v) => { v.summary = "DEL \u007f"; }), ["summary"]);
  assert.deepEqual(check((v) => { v.summary = "vertical \u000b tab"; }), ["summary"]);
  assert.deepEqual(check((v) => { v.title = "Atlas\tLaunch"; }), ["title"]);
  assert.deepEqual(check((v) => { v.title = " .. "; }), ["title"]);
  assert.deepEqual(check((v) => { v.title = "."; }), ["title"]);
  assert.deepEqual(check((v) => { v.title = "..."; }), [], "only `.` and `..` are path segments");
  assert.deepEqual(check((v) => { (v.decisions as Array<Record<string, unknown>>)[0]!.text = "a\u0000b"; }), ["decisions[0].text"]);
  assert.deepEqual(check((v) => { (v.provenance as Record<string, unknown>).text_model = "model\n"; }), ["provenance.text_model"]);
  assert.equal(normalizeTeamMemText("A\tB\nC\u001b\u0085D\u007f\u009f", "line"), "A B C D");
  assert.equal(normalizeTeamMemText("A\tB\nC\r\u000bD\u0000", "text"), "A\tB\nC\r D");
  assert.equal(normalizeTeamMemText("会议 ✓", "line"), "会议 ✓");
});

async function buildDirty(options: { title?: string; summary?: string; project?: string; model?: string; displayName?: string; noVerbatimQuotes?: boolean; instructions?: string[] }) {
  const bytes = Buffer.from("synthetic encrypted audio bytes; never a container header", "utf8");
  const audioHash = SHA(bytes), source = { sourceSessionId: 41n, recordingHandle: "a".repeat(32), sha256: audioHash.slice(7) };
  const identity = buildMeetingIdentity({ providerMeetingId: "synthetic-v2", meetingNo: "synthetic-v2", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: options.title ?? "Synthetic", organizer: null });
  const wall = { startedAt: "2026-09-02T14:00:00.000000Z", endedAt: "2026-09-02T14:00:00.020000Z",
    components: { maximumBracketNs: 1n, maximumResolutionNs: 1n, modelAllowanceNs: 1n, interpolationRoundingNs: 1n,
      captureRoundingNs: 1n, captureUncertaintyNs: null, externalUtcAccuracyNs: null }, mappingRoundingNs: 1n, serializationRoundingNs: 1n };
  const evidence = createOwnedTimedSampleEvidence({ sampleRateHz: 24000, possibleSamples: 480n, candidateLower: [], observedUpper: [],
    ambiguousUpper: 0n, unobservedUpper: 480n, freshCandidates: [] });
  const segment = { segmentId: "obs-final", text: "Final wording.", range: { startSampleInclusive: 0n, endSampleExclusive: 480n, sampleRateHz: 24000, gapOffsetMs: 0n },
    wording: "reconciled" as const, liveSegmentIds: [], cluster: null, speaker: { kind: "anonymous" as const, label: "final-1" }, sampleEvidence: evidence, wall };
  const transcript: TimedReconciledTranscript = { kind: "timed_recording_transcript/v1", source, segments: [segment], warnings: [
    { code: "local_wall_timestamp_estimate", detail: "Synthetic local-wall estimate; physical accuracy unknown." }], transcriptComplete: true,
    provenance: { occurrenceId: identity.occurrenceId, bridgeSessionId: "bridge", generationId: "generation", alignmentAttemptId: "attempt",
      timingContract: "capture-clock/v1", policyId: "local-wall-estimate/v1" } };
  const selected = { generationId: "generation", attemptId: "attempt", source, timingContract: "capture-clock/v1" as const,
    policyId: "local-wall-estimate/v1" as const, coverageStatus: "available" as const, pageCount: 1, entryCount: 1, storedBytes: 100, warnings: [] };
  return buildTimedTeamMemMeetingArtifactV2({ identity, provider: "feishu", revision: 1, endedAt: "2026-09-02T14:10:00Z",
    attendance: [{ feishuUserId: "person", displayName: options.displayName ?? "Person", joinedAt: "2026-09-02T14:00:00Z", leftAt: "2026-09-02T14:10:00Z" }],
    transcript, selectedAlignment: selected, sessionId: 99n, meetingEnded: true, recordingGaps: [], processingWarnings: [],
    ...(options.noVerbatimQuotes === undefined ? {} : { noVerbatimQuotes: options.noVerbatimQuotes }),
    runtime: { async processText(input: { instructions: string }) { options.instructions?.push(input.instructions); return { output: { summary: options.summary ?? "Clean summary.",
      projects: options.project === undefined ? [] : [{ name: options.project, evidence_segment_ids: ["obs-final"] }],
      decisions: [{ text: "Keep it.", evidence_segment_ids: ["obs-final"] }], action_items: [], discussion_points: [], person_summaries: [] }, warnings: [] }; } },
    provenance: { runtimeProfile: "online", sttProvider: "synthetic", sttModel: "synthetic", textProvider: "synthetic", textModel: options.model ?? "synthetic",
      agentVersion: "test", processedAt: "2026-09-02T14:11:00Z", finalBatchModel: "synthetic-final", liveStreamModel: "synthetic-live" },
    audio: { format: "opus", encryption: "age-x25519", durationSeconds: 0.02, bytes: bytes.length, sha256: audioHash, expiresAt: "2026-09-16T14:10:00Z" } });
}

test("the builder normalises a stray control character from the summary model or a name instead of letting TeamMem quarantine the bundle", async () => {
  const clean = await buildDirty({});
  assert.deepEqual(clean.artifact.processing_warnings.map((w) => w.code), ["local_wall_timestamp_estimate"], "clean text adds no warning");
  const built = await buildDirty({ title: "Weekly\tsync", summary: "Agreed \u001b[31mfast\u009b path.\nNext line.", project: "Atlas\nLaunch", model: "text\u0007model" });
  assert.equal(built.artifact.title, "Weekly sync");
  assert.equal(built.artifact.summary, "Agreed [31mfast path.\nNext line.");
  assert.equal(built.artifact.projects[0]!.name, "Atlas Launch");
  assert.equal(built.artifact.provenance.text_model, "textmodel");
  assert.deepEqual(teamMemTextViolations(built.artifact), []);
  assert.deepEqual(built.artifact.processing_warnings.at(-1), { code: "text_normalized", detail: "control characters or unusable names repaired in 4 text field(s)" });
  assert.equal(built.serialized, canonicalArtifactJson(built.artifact));
  assert.equal(built.artifact_hash, canonicalArtifactHash(built.artifact));
});

test("a Feishu topic, display name or project name that is blank or a dot segment gets a fallback with a warning, and publishes", async () => {
  for (const [title, expected] of [[".", "Meeting synthetic-v2"], [" .. ", "Meeting synthetic-v2"], ["\n", "Meeting synthetic-v2"], ["\u0000", "Meeting synthetic-v2"]] as const) {
    const built = await buildDirty({ title });
    assert.equal(built.artifact.title, expected);
    assert.deepEqual(built.artifact.processing_warnings.at(-1), { code: "text_normalized", detail: "control characters or unusable names repaired in 1 text field(s)" });
  }
  const built = await buildDirty({ title: ".", displayName: "..", project: "." });
  assert.equal(built.artifact.participants[0]!.display_name, "Participant");
  assert.equal(built.artifact.projects[0]!.name, "Unnamed project");
  assert.deepEqual(teamMemTextViolations(built.artifact), []);
  assert.deepEqual(built.artifact.processing_warnings.at(-1), { code: "text_normalized", detail: "control characters or unusable names repaired in 3 text field(s)" });
  // The repaired artifact goes through the real outbox and publishes on its receipt.
  const h = harness();
  const bytes = Buffer.from("synthetic encrypted audio bytes; never a container header", "utf8");
  const d = durable(h, { artifact: built.artifact as unknown as ReturnType<typeof artifact>["artifact"], bytes, serialized: built.serialized, hash: built.artifact_hash });
  try {
    writeReceipt(h.receipts, built.artifact.occurrence_id, 1, built.artifact_hash);
    d.worker().reconcile();
    assert.equal(d.store().getSession(built.artifact.occurrence_id)?.state, "published");
  } finally { d.close(); h.cleanup(); }
});

test("after an own-transcript refusal the synthesis is told never to quote the transcript verbatim", async () => {
  const seen: string[] = [];
  await buildDirty({ instructions: seen });
  await buildDirty({ instructions: seen, noVerbatimQuotes: true });
  assert.equal(seen[0]!.includes(NO_VERBATIM_INSTRUCTION), false);
  assert.equal(seen[1], seen[0]! + NO_VERBATIM_INSTRUCTION);
  assert.match(NO_VERBATIM_INSTRUCTION, /verbatim/);
});

test("enqueue refuses an artifact TeamMem would quarantine, before any bundle or journal row exists", () => {
  const h = harness();
  try {
    const dirty = artifact(3, (v) => { v.title = "Atlas\u001bLaunch"; });
    const filename = path.join(h.root, "orchestration.db");
    const source = path.join(h.recordings, `${"a".repeat(32)}.crsr`);
    writeFileSync(source, dirty.bytes);
    const store = openSessionStore({ filename, nowMs: Date.parse(dirty.artifact.ended_at) });
    try {
      const worker = createOutboxWorker({ outboxDir: h.outbox, receiptsDir: h.receipts, recordingsDir: h.recordings, journal: store,
        clock: { now: () => Date.parse(dirty.artifact.ended_at) }, random: () => 0, reconciliationEvidence: store,
        session: { state: () => null, publish: () => undefined } });
      assert.throws(() => worker.enqueue({ artifact: dirty.artifact, serializedArtifact: dirty.serialized, artifactHash: dirty.hash, recordingPath: source }),
        /delivery artifact text violates TeamMem text rules/);
      assert.deepEqual(store.pending(), []);
      assert.deepEqual(readdirSync(h.outbox), []);
      assert.equal(existsSync(source), true, "the recording is untouched");
    } finally { store.close(); }
  } finally { h.cleanup(); }
});

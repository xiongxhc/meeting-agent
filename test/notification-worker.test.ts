import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import {
  createNotificationWorker,
  notificationRequestUuid,
  type NotificationSender,
} from "../src/delivery/notification-worker.ts";
import type { DeliveryRow, SessionStore } from "../src/ports/session-store.ts";

const OCCURRENCE = "om_123@2026-09-02T14:00:00Z";
const HASH = `sha256:${"a".repeat(64)}`;
const COMMIT = "b".repeat(40);
const URL = `https://example.test/group/vault/-/blob/${COMMIT}/Meetings/note.md`;
const HOUR = 60 * 60 * 1_000;

function harness(): { store: SessionStore; filename: string; close(): void } {
  const root = mkdtempSync(path.join(tmpdir(), "meeting-notification-test-"));
  const filename = path.join(root, "orchestration.db");
  const recordingPath = path.join(root, `${"c".repeat(32)}.crsr`);
  mkdirSync(path.dirname(recordingPath), { recursive: true });
  writeFileSync(recordingPath, "ciphertext");
  let store = openSessionStore({ filename, nowMs: 1 });
  store.createSession({ occurrenceId: OCCURRENCE, providerMeetingId: "123", occurrenceStartedAt: "2026-09-02T14:00:00Z", nowMs: 1 });
  store.finalizeSession({
    transition: { occurrenceId: OCCURRENCE, fromState: "discovered", toState: "awaiting_teammem", reason: "test", terminalReason: null, nowMs: 2 },
    recording: { handle: "c".repeat(32), encryptedPath: recordingPath, sha256: "d".repeat(64), durationMs: 1, format: "opus", keyId: "fake", gaps: [], runtimeGaps: [] },
  });
  const delivery: DeliveryRow = {
    occurrenceId: OCCURRENCE, revision: 1, artifactHash: HASH, recordingPath,
    bundlePath: path.join(root, "outbox", "1"), endedAtMs: 2,
    transcriptComplete: false, retryCount: 0, nextRetryAtMs: 2, retryReason: null,
    publishedAtMs: null, deletedAtMs: null, publicationUrl: null, vaultCommit: null,
    recoveryArtifact: "{}", stageToken: "e".repeat(32), recordingHandle: "c".repeat(32),
  };
  store.savePending(delivery);
  return {
    get store() { return store; },
    set store(next: SessionStore) { store = next; },
    filename,
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

function accept(store: SessionStore, revision = 1): void {
  store.acceptPublication({
    occurrenceId: OCCURRENCE, revision, artifactHash: HASH,
    publishedAtMs: 10, publicationUrl: URL, vaultCommit: COMMIT,
    notification: {
      recipientId: "ou_organizer", title: "Weekly planning",
      messageText: `Meeting notes: Weekly planning\n${URL}`,
      requestUuid: notificationRequestUuid({ occurrenceId: OCCURRENCE, revision, artifactHash: HASH, publicationUrl: URL, vaultCommit: COMMIT }),
    },
  });
}

class ExpiringDedupSender implements NotificationSender {
  readonly calls: Array<{ receiveId: string; text: string; uuid: string; timeoutMs: number }> = [];
  readonly accepted = new Map<string, { at: number; messageId: string }>();
  now = 20;
  fail: "none" | "retryable" | "ambiguous-after-send" = "none";
  async sendText(input: { receiveId: string; text: string; uuid: string; timeoutMs: number }): Promise<{ messageId: string }> {
    this.calls.push(input);
    const prior = this.accepted.get(input.uuid);
    if (prior !== undefined && this.now - prior.at < HOUR) return { messageId: prior.messageId };
    if (this.fail === "retryable") throw Object.assign(new Error("redacted"), { deliveryKind: "retryable" as const });
    const accepted = { at: this.now, messageId: `om_${this.accepted.size + 1}` };
    this.accepted.set(input.uuid, accepted);
    if (this.fail === "ambiguous-after-send") throw Object.assign(new Error("redacted"), { deliveryKind: "ambiguous" as const });
    return { messageId: accepted.messageId };
  }
}

test("publication and immutable organizer intent commit together before cleanup", () => {
  const h = harness();
  try {
    accept(h.store);
    assert.equal(h.store.getSession(OCCURRENCE)?.state, "published");
    assert.deepEqual(h.store.notifications().map((row) => ({ recipientId: row.recipientId, title: row.title, publicationUrl: row.publicationUrl, state: row.state })), [
      { recipientId: "ou_organizer", title: "Weekly planning", publicationUrl: URL, state: "pending" },
    ]);
    assert.doesNotThrow(() => accept(h.store));
  } finally { h.close(); }
});

test("null organizer is a durable terminal fact and never guesses a recipient", () => {
  const h = harness();
  try {
    h.store.acceptPublication({ occurrenceId: OCCURRENCE, revision: 1, artifactHash: HASH, publishedAtMs: 10, publicationUrl: URL, vaultCommit: COMMIT, notification: { terminalReason: "organizer_unresolved" } });
    const row = h.store.notifications()[0]!;
    assert.equal(row.state, "terminal");
    assert.equal(row.terminalReason, "organizer_unresolved");
    assert.equal(row.recipientId, null);
  } finally { h.close(); }
});

test("claim is durable before network, reopens safely, and duplicate polls produce one successful DM", async () => {
  const h = harness();
  try {
    accept(h.store);
    let now = 20;
    const sender = new ExpiringDedupSender();
    sender.fail = "ambiguous-after-send";
    const worker = () => createNotificationWorker({ store: h.store, sender, clock: { now: () => now }, random: () => 0, requestTimeoutMs: 5_000, claimTtlMs: 10_000, dedupSafetyMarginMs: 60_000 });
    await Promise.all([worker().poll(), worker().poll()]);
    assert.equal(sender.calls.length, 1);
    const attempted = h.store.notifications()[0]!;
    assert.equal(attempted.firstAttemptAtMs, 20);
    assert.equal(attempted.sentAtMs, null);

    h.store.close();
    h.store = openSessionStore({ filename: h.filename, nowMs: now });
    now = 10_021;
    sender.now = now;
    sender.fail = "none";
    await worker().poll();
    assert.equal(sender.calls.length, 2);
    assert.equal(sender.calls[0]!.uuid, sender.calls[1]!.uuid);
    assert.equal(h.store.notifications()[0]!.providerMessageId, "om_1");
    assert.equal(h.store.getSession(OCCURRENCE)?.state, "notified");
    await worker().poll();
    assert.equal(sender.calls.length, 2);
  } finally { h.close(); }
});

test("expired ambiguity, clock regression, and stale claim completion never resend or overwrite", async () => {
  const h = harness();
  try {
    accept(h.store);
    let now = 20;
    const sender = new ExpiringDedupSender();
    sender.fail = "ambiguous-after-send";
    const worker = createNotificationWorker({ store: h.store, sender, clock: { now: () => now }, random: () => 0, requestTimeoutMs: 5_000, claimTtlMs: 10_000, dedupSafetyMarginMs: 60_000 });
    await worker.poll();
    const attempted = h.store.notifications()[0]!;
    now = 1;
    await worker.poll();
    assert.equal(sender.calls.length, 1);
    assert.deepEqual(
      [h.store.notifications()[0]!.firstAttemptAtMs, h.store.notifications()[0]!.lastAttemptAtMs, h.store.notifications()[0]!.nextAttemptAtMs],
      [attempted.firstAttemptAtMs, attempted.lastAttemptAtMs, attempted.nextAttemptAtMs],
      "clock regression must not reopen or extend the durable dedup window",
    );
    now = 20 + HOUR;
    await worker.poll();
    assert.equal(sender.calls.length, 1);
    assert.equal(h.store.notifications()[0]!.terminalReason, "notification_delivery_uncertain");
    assert.throws(() => h.store.completeNotification({ occurrenceId: OCCURRENCE, revision: 1, claimToken: "d".repeat(32), providerMessageId: "late", sentAtMs: now }), /claim|terminal/i);
    assert.equal(h.store.notifications()[0]!.providerMessageId, null);
  } finally { h.close(); }
});

test("a stale claim cannot overwrite a newer worker's successful completion", () => {
  const h = harness();
  try {
    accept(h.store);
    const first = h.store.claimNotification({ nowMs: 20, claimToken: "1".repeat(32), claimTtlMs: 10, requestTimeoutMs: 5, dedupWindowMs: HOUR, dedupSafetyMarginMs: 60_000 })!;
    const second = h.store.claimNotification({ nowMs: 31, claimToken: "2".repeat(32), claimTtlMs: 10, requestTimeoutMs: 5, dedupWindowMs: HOUR, dedupSafetyMarginMs: 60_000 })!;
    assert.equal(first.claimToken, "1".repeat(32));
    assert.equal(second.claimToken, "2".repeat(32));
    h.store.completeNotification({ occurrenceId: OCCURRENCE, revision: 1, claimToken: second.claimToken!, providerMessageId: "om_new", sentAtMs: 32 });
    assert.throws(() => h.store.completeNotification({ occurrenceId: OCCURRENCE, revision: 1, claimToken: first.claimToken!, providerMessageId: "om_old", sentAtMs: 33 }), /claim/i);
    assert.equal(h.store.notifications()[0]!.providerMessageId, "om_new");
  } finally { h.close(); }
});

test("crash after provider acceptance retries the same UUID inside the finite dedup window", async () => {
  const h = harness();
  try {
    accept(h.store);
    let now = 20;
    const sender = new ExpiringDedupSender();
    let crash = true;
    const worker = () => createNotificationWorker({
      store: h.store, sender, clock: { now: () => now }, random: () => 0,
      requestTimeoutMs: 5, claimTtlMs: 10, dedupSafetyMarginMs: 60_000,
      afterSend: () => { if (crash) throw new Error("synthetic process death before local commit"); },
    });
    await worker().poll();
    const afterCrash = h.store.notifications()[0]!;
    assert.equal(afterCrash.state, "claimed");
    assert.equal(afterCrash.providerMessageId, null);
    assert.equal(sender.accepted.size, 1);

    h.store.close();
    h.store = openSessionStore({ filename: h.filename, nowMs: now });
    now += 11;
    sender.now = now;
    crash = false;
    await worker().poll();
    assert.equal(sender.calls.length, 2);
    assert.equal(sender.calls[0]!.uuid, sender.calls[1]!.uuid);
    assert.equal(sender.accepted.size, 1, "finite provider dedup must collapse the safe retry");
    assert.equal(h.store.notifications()[0]!.state, "sent");
  } finally { h.close(); }
});

test("an expired stale claim is uncertain and never sent after the finite provider window", async () => {
  const h = harness();
  try {
    accept(h.store);
    h.store.claimNotification({ nowMs: 20, claimToken: "3".repeat(32), claimTtlMs: 10, requestTimeoutMs: 5, dedupWindowMs: HOUR, dedupSafetyMarginMs: 60_000 });
    let now = 20 + HOUR;
    const sender = new ExpiringDedupSender();
    sender.now = now;
    await createNotificationWorker({ store: h.store, sender, clock: { now: () => now }, random: () => 0, requestTimeoutMs: 5, claimTtlMs: 10, dedupSafetyMarginMs: 60_000 }).poll();
    assert.equal(sender.calls.length, 0);
    assert.equal(h.store.notifications()[0]!.terminalReason, "notification_delivery_uncertain");
    now = 1;
    await createNotificationWorker({ store: h.store, sender, clock: { now: () => now }, random: () => 0, requestTimeoutMs: 5, claimTtlMs: 10, dedupSafetyMarginMs: 60_000 }).poll();
    assert.equal(sender.calls.length, 0);
  } finally { h.close(); }
});

test("bounded retry schedule isolates rows and terminates finite retry failures", async () => {
  const h = harness();
  try {
    accept(h.store);
    let now = 20;
    const sender = new ExpiringDedupSender();
    sender.fail = "retryable";
    const worker = createNotificationWorker({ store: h.store, sender, clock: { now: () => now }, random: () => 1, requestTimeoutMs: 5_000, claimTtlMs: 5_000, dedupSafetyMarginMs: 60_000, maxAttempts: 2 });
    await worker.poll();
    const once = h.store.notifications()[0]!;
    assert.equal(once.attemptCount, 1);
    assert.ok(once.nextAttemptAtMs > now && once.nextAttemptAtMs <= now + 60_000);
    now = once.nextAttemptAtMs;
    await worker.poll();
    assert.equal(sender.calls.length, 2);
    assert.equal(h.store.notifications()[0]!.terminalReason, "notification_retry_exhausted");
  } finally { h.close(); }
});

test("request UUID covers revision, artifact hash, URL and commit", () => {
  const base = { occurrenceId: OCCURRENCE, revision: 1, artifactHash: HASH, publicationUrl: URL, vaultCommit: COMMIT };
  const uuid = notificationRequestUuid(base);
  assert.match(uuid, /^[0-9a-f-]{36}$/);
  for (const changed of [
    { ...base, revision: 2 }, { ...base, artifactHash: `sha256:${"f".repeat(64)}` },
    { ...base, publicationUrl: `${URL}?x=1` }, { ...base, vaultCommit: "c".repeat(40) },
  ]) assert.notEqual(notificationRequestUuid(changed), uuid);
  assert.equal(createHash("sha256").update(uuid).digest("hex").length, 64);
});

import { createHash, randomUUID } from "node:crypto";

import type { FeishuMessageSender } from "../ports/feishu.ts";
import type { NotificationRow, SessionStore } from "../ports/session-store.ts";

const FEISHU_DEDUP_WINDOW_MS = 60 * 60 * 1_000;

export type NotificationSender = FeishuMessageSender;

export function notificationRequestUuid(input: {
  readonly occurrenceId: string;
  readonly revision: number;
  readonly artifactHash: string;
  readonly publicationUrl: string;
  readonly vaultCommit: string;
}): string {
  const bytes = createHash("sha256").update(JSON.stringify([
    "meeting-agent-notification/v1", input.occurrenceId, input.revision,
    input.artifactHash, input.publicationUrl, input.vaultCommit,
  ])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type NotificationWorker = { poll(): Promise<void> };

export function createNotificationWorker(options: {
  readonly store: SessionStore;
  readonly sender: NotificationSender;
  readonly clock: { now(): number };
  readonly random: () => number;
  readonly requestTimeoutMs: number;
  readonly claimTtlMs: number;
  readonly dedupSafetyMarginMs: number;
  readonly maxAttempts?: number;
  readonly afterSend?: (row: NotificationRow) => void;
}): NotificationWorker {
  const maxAttempts = options.maxAttempts ?? 8;
  for (const [name, value] of Object.entries({ requestTimeoutMs: options.requestTimeoutMs, claimTtlMs: options.claimTtlMs, dedupSafetyMarginMs: options.dedupSafetyMarginMs, maxAttempts })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  }
  if (!Number.isInteger(maxAttempts)) throw new Error("maxAttempts must be an integer");
  if (options.requestTimeoutMs + options.dedupSafetyMarginMs >= FEISHU_DEDUP_WINDOW_MS) throw new Error("notification timeout and safety margin must fit inside Feishu dedup window");
  if (options.claimTtlMs < options.requestTimeoutMs) throw new Error("notification claim TTL must cover request timeout");
  return {
    async poll(): Promise<void> {
      for (;;) {
        const now = options.clock.now();
        const claimToken = randomUUID().replaceAll("-", "");
        const row = options.store.claimNotification({
          nowMs: now, claimToken, claimTtlMs: options.claimTtlMs,
          requestTimeoutMs: options.requestTimeoutMs, dedupWindowMs: FEISHU_DEDUP_WINDOW_MS,
          dedupSafetyMarginMs: options.dedupSafetyMarginMs,
        });
        if (row === null) return;
        if (row.recipientId === null || row.messageText === null || row.requestUuid === null) {
          options.store.failNotification({ occurrenceId: row.occurrenceId, revision: row.revision, claimToken, nowMs: now, nextAttemptAtMs: now, ambiguous: false, terminalReason: "notification_retry_exhausted" });
          continue;
        }
        let providerAccepted = false;
        try {
          const sent = await options.sender.sendText({ receiveId: row.recipientId, text: row.messageText, uuid: row.requestUuid, timeoutMs: options.requestTimeoutMs });
          providerAccepted = true;
          options.afterSend?.(row);
          options.store.completeNotification({ occurrenceId: row.occurrenceId, revision: row.revision, claimToken, providerMessageId: sent.messageId, sentAtMs: options.clock.now() });
        } catch (error) {
          // A failed local commit is deliberately left claimed. After its
          // bounded lease expires the same durable UUID is tried again.
          if (!providerAccepted) {
            const deliveryKind = (error as { deliveryKind?: unknown }).deliveryKind;
            const ambiguous = deliveryKind === "ambiguous";
            const terminalReason = deliveryKind === "terminal" || row.attemptCount >= maxAttempts
              ? (ambiguous ? "notification_delivery_uncertain" : "notification_retry_exhausted")
              : null;
            try {
              const failedAtMs = options.clock.now();
              options.store.failNotification({
                occurrenceId: row.occurrenceId, revision: row.revision, claimToken,
                nowMs: failedAtMs, nextAttemptAtMs: failedAtMs + retryDelayMs(row.attemptCount, options.random),
                ambiguous, terminalReason,
              });
            } catch { /* a lost/stale claim is never overwritten */ }
          }
        }
      }
    },
  };
}

function retryDelayMs(attemptCount: number, random: () => number): number {
  const cap = Math.min(60_000, 1_000 * 2 ** Math.min(attemptCount, 6));
  const unit = Math.max(0, Math.min(1, random()));
  return Math.max(1_000, Math.floor(1_000 + (cap - 1_000) * unit));
}

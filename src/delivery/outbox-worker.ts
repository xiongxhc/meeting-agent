// Local delivery state machine.  The outbox is the durable handoff; polling a
// receipt is deliberately the only thing this worker ever does beyond it.

import { readPublicationReceipt } from "../adapters/receipt-inbox.ts";
import { deleteDeliveredEvidence, writeMeetingBundle } from "../adapters/filesystem-outbox.ts";
import type { TeamMemMeetingArtifact } from "../contracts/teammem-meeting-v1.ts";

const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export type DeliveryRow = {
  readonly occurrenceId: string;
  readonly revision: number;
  readonly artifactHash: string;
  readonly recordingPath: string;
  readonly bundlePath: string;
  readonly endedAtMs: number;
  readonly transcriptComplete: boolean;
  readonly retryCount: number;
  readonly nextRetryAtMs: number;
  readonly retryReason: "receipt_unavailable" | null;
  readonly publishedAtMs: number | null;
  readonly deletedAtMs: number | null;
  readonly publicationUrl: string | null;
  readonly vaultCommit: string | null;
};

/** R68's storage seam: the SQLite adapter is the production implementation. */
export type DeliveryJournal = {
  savePending(row: DeliveryRow): void;
  pending(): readonly DeliveryRow[];
  update(row: DeliveryRow): void;
};

export type OutboxWorker = {
  enqueue(input: {
    readonly artifact: TeamMemMeetingArtifact;
    readonly serializedArtifact: string;
    readonly artifactHash: string;
    readonly recordingPath: string;
  }): string;
  reconcile(): void;
};

export function createOutboxWorker(options: {
  readonly recordingsDir: string;
  readonly outboxDir: string;
  readonly receiptsDir: string;
  readonly journal: DeliveryJournal;
  readonly clock: { now(): number };
  /** Returns a deterministic [0, 1] value in tests. */
  readonly random: () => number;
  readonly session: { state(occurrenceId: string): string | null; publish(occurrenceId: string): void };
}): OutboxWorker {
  return {
    enqueue(input): string {
      const bundlePath = writeMeetingBundle({
        recordingsDir: options.recordingsDir,
        outboxDir: options.outboxDir,
        artifact: input.artifact,
        serializedArtifact: input.serializedArtifact,
        artifactHash: input.artifactHash,
        recordingPath: input.recordingPath,
      });
      const existing = options.journal.pending().find((row) => row.occurrenceId === input.artifact.occurrence_id && row.revision === input.artifact.revision);
      if (existing !== undefined) {
        if (existing.artifactHash !== input.artifactHash) throw new Error("artifact revision is immutable: conflicting content");
        return existing.bundlePath;
      }
      options.journal.savePending({
        occurrenceId: input.artifact.occurrence_id,
        revision: input.artifact.revision,
        artifactHash: input.artifactHash,
        recordingPath: input.recordingPath,
        bundlePath,
        endedAtMs: Date.parse(input.artifact.ended_at),
        transcriptComplete: input.artifact.transcript_complete,
        retryCount: 0,
        nextRetryAtMs: options.clock.now(),
        retryReason: null,
        publishedAtMs: null,
        deletedAtMs: null,
        publicationUrl: null,
        vaultCommit: null,
      });
      return bundlePath;
    },

    reconcile(): void {
      const now = options.clock.now();
      for (const current of options.journal.pending()) {
        if (current.deletedAtMs !== null) continue;
        if (now >= current.endedAtMs + RETENTION_MS) {
          deleteDeliveredEvidence({ recordingsDir: options.recordingsDir, outboxDir: options.outboxDir, occurrenceId: current.occurrenceId, revision: current.revision, recordingPath: current.recordingPath, bundlePath: current.bundlePath });
          options.journal.update({ ...current, deletedAtMs: now, retryReason: null });
          continue;
        }
        if (current.publishedAtMs !== null) continue;
        if (now < current.nextRetryAtMs) continue;
        const receipt = readPublicationReceipt({
          receiptsDir: options.receiptsDir,
          occurrenceId: current.occurrenceId,
          revision: current.revision,
          artifactHash: current.artifactHash,
        });
        if (receipt === null) {
          const retryCount = current.retryCount + 1;
          options.journal.update({
            ...current,
            retryCount,
            retryReason: "receipt_unavailable",
            nextRetryAtMs: now + retryDelayMs(retryCount, options.random),
          });
          continue;
        }
        // The coordinator graph admits only this edge.  Replays after a crash
        // see published and remain idempotent rather than attempting a second
        // transition.
        if (options.session.state(current.occurrenceId) === "awaiting_teammem") options.session.publish(current.occurrenceId);
        const published: DeliveryRow = {
          ...current,
          publishedAtMs: now,
          publicationUrl: receipt.markdown_url,
          vaultCommit: receipt.vault_commit,
          retryReason: null,
        };
        if (current.transcriptComplete) {
          deleteDeliveredEvidence({ recordingsDir: options.recordingsDir, outboxDir: options.outboxDir, occurrenceId: published.occurrenceId, revision: published.revision, recordingPath: published.recordingPath, bundlePath: published.bundlePath });
          options.journal.update({ ...published, deletedAtMs: now });
        } else {
          options.journal.update(published);
        }
      }
    },
  };
}

/** 1–60 seconds, full jitter around an exponential cap; no wall clock reads. */
function retryDelayMs(retryCount: number, random: () => number): number {
  const cap = Math.min(60_000, 1_000 * 2 ** Math.min(retryCount, 6));
  const unit = Math.max(0, Math.min(1, random()));
  return Math.max(1_000, Math.floor(1_000 + (cap - 1_000) * unit));
}

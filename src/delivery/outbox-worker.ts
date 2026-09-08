// Local delivery state machine.  The outbox is the durable handoff; polling a
// receipt is deliberately the only thing this worker ever does beyond it.

import { readPublicationReceipt } from "../adapters/receipt-inbox.ts";
import { deleteDeliveredEvidence, writeMeetingBundle } from "../adapters/filesystem-outbox.ts";
import { parseTeamMemMeetingArtifact, type TeamMemMeetingArtifact } from "../contracts/teammem-meeting-v1.ts";
import { occurrencePathSegment } from "../domain/occurrence-id.ts";
import { randomUUID } from "node:crypto";
import path from "node:path";

const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_RECOVERY_ARTIFACT_BYTES = 16 * 1024 * 1024;

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
  readonly retryReason: "receipt_unavailable" | "recovery_unavailable" | null;
  readonly publishedAtMs: number | null;
  readonly deletedAtMs: number | null;
  readonly publicationUrl: string | null;
  readonly vaultCommit: string | null;
  /** Exact canonical bytes retained only until this occurrence is deleted. */
  readonly recoveryArtifact: string | null;
  /** Durable capability that owns the private pre-READY stage. */
  readonly stageToken: string | null;
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
  readonly reconciliationEvidence: { purgeExpiredReconciliationEvidence(nowMs: number): number };
  readonly onMaintenanceFailure?: (reason: "reconciliation_evidence_purge_failed") => void;
}): OutboxWorker {
  if (options.reconciliationEvidence === undefined) throw new Error("reconciliation purge dependency is required");
  const recordingOwners = new Map<string, string>();
  return {
    enqueue(input): string {
      const existing = options.journal.pending().find((row) => row.occurrenceId === input.artifact.occurrence_id && row.revision === input.artifact.revision);
      if (existing !== undefined) {
        if (existing.artifactHash !== input.artifactHash) throw new Error("artifact revision is immutable: conflicting content");
      }
      const bundlePath = path.join(path.resolve(options.outboxDir), occurrencePathSegment(input.artifact.occurrence_id as `${string}@${string}`), String(input.artifact.revision));
      if (existing === undefined) {
        const owner = recordingOwners.get(path.resolve(input.recordingPath));
        if (owner !== undefined && owner !== input.artifact.occurrence_id) throw new Error("recording is owned by another occurrence");
        if (Buffer.byteLength(input.serializedArtifact, "utf8") > MAX_RECOVERY_ARTIFACT_BYTES) throw new Error("recovery artifact exceeds retention bound");
        const stageToken = randomUUID().replaceAll("-", "");
        // The journal intent precedes the filesystem visibility commit. A
        // save failure therefore cannot strand a READY bundle undiscoverable
        // to polling, retry, or deadline cleanup after restart.
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
          recoveryArtifact: input.serializedArtifact,
          stageToken,
        });
        recordingOwners.set(path.resolve(input.recordingPath), input.artifact.occurrence_id);
      }
      const row = existing ?? options.journal.pending().find((candidate) => candidate.occurrenceId === input.artifact.occurrence_id && candidate.revision === input.artifact.revision);
      if (row === undefined) throw new Error("delivery journal did not retain pending intent");
      const written = writeMeetingBundle({
        recordingsDir: options.recordingsDir,
        outboxDir: options.outboxDir,
        artifact: input.artifact,
        serializedArtifact: input.serializedArtifact,
        artifactHash: input.artifactHash,
        recordingPath: input.recordingPath,
        ...(row.stageToken === null ? {} : { stageToken: row.stageToken }),
      });
      if (written !== bundlePath) throw new Error("outbox writer returned a non-canonical bundle path");
      return bundlePath;
    },

    reconcile(): void {
      const now = options.clock.now();
      try { options.reconciliationEvidence.purgeExpiredReconciliationEvidence(now); } catch { options.onMaintenanceFailure?.("reconciliation_evidence_purge_failed"); }
      for (const current of options.journal.pending()) {
        if (current.deletedAtMs !== null) continue;
        if (now >= current.endedAtMs + RETENTION_MS) {
          deleteOccurrenceEvidence(options, current, now);
          continue;
        }
        if (!recoverBundle(options, current)) continue;
        const state = options.session.state(current.occurrenceId);
        if (current.publishedAtMs !== null) {
          if (state === "published" && current.transcriptComplete) deleteOccurrenceEvidence(options, current, now);
          continue;
        }
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
        // A receipt is evidence, not authorization to mutate an arbitrary
        // orchestration state. Only the legal edge and an interrupted replay
        // are allowed to record it or release encrypted evidence.
        if (state !== "awaiting_teammem" && state !== "published") continue;
        if (state === "awaiting_teammem") options.session.publish(current.occurrenceId);
        const published: DeliveryRow = {
          ...current,
          publishedAtMs: now,
          publicationUrl: receipt.markdown_url,
          vaultCommit: receipt.vault_commit,
          retryReason: null,
        };
        if (current.transcriptComplete) {
          options.journal.update(published);
          deleteOccurrenceEvidence(options, published, now);
        } else {
          options.journal.update(published);
        }
      }
    },
  };
}

function deleteOccurrenceEvidence(
  options: Pick<Parameters<typeof createOutboxWorker>[0], "recordingsDir" | "outboxDir" | "journal">,
  accepted: DeliveryRow,
  now: number,
): void {
  for (const row of options.journal.pending().filter((candidate) => candidate.occurrenceId === accepted.occurrenceId)) {
    deleteDeliveredEvidence({ recordingsDir: options.recordingsDir, outboxDir: options.outboxDir, occurrenceId: row.occurrenceId, revision: row.revision, recordingPath: row.recordingPath, bundlePath: row.bundlePath, ...(row.stageToken === null ? {} : { stageToken: row.stageToken }) });
    options.journal.update({
      ...row,
      ...(row.revision === accepted.revision ? { publishedAtMs: accepted.publishedAtMs, publicationUrl: accepted.publicationUrl, vaultCommit: accepted.vaultCommit } : {}),
      deletedAtMs: now,
      retryReason: null,
      recoveryArtifact: null,
    });
  }
}

function recoverBundle(
  options: Pick<Parameters<typeof createOutboxWorker>[0], "recordingsDir" | "outboxDir" | "journal">,
  row: DeliveryRow,
): boolean {
  if (row.recoveryArtifact === null || row.stageToken === null) {
    options.journal.update({ ...row, retryReason: "recovery_unavailable" });
    return false;
  }
  try {
    const expected = path.join(path.resolve(options.outboxDir), occurrencePathSegment(row.occurrenceId as `${string}@${string}`), String(row.revision));
    if (row.bundlePath !== expected) throw new Error("recovery bundle path differs from durable journal");
    const artifact = parseTeamMemMeetingArtifact(JSON.parse(row.recoveryArtifact));
    const artifactHash = row.artifactHash;
    const written = writeMeetingBundle({
      recordingsDir: options.recordingsDir,
      outboxDir: options.outboxDir,
      artifact,
      serializedArtifact: row.recoveryArtifact,
      artifactHash,
      recordingPath: row.recordingPath,
      stageToken: row.stageToken,
    });
    if (written !== row.bundlePath) throw new Error("recovered bundle path differs from durable journal");
    return true;
  } catch (error) {
    if ((error as Error).message === "recovery bundle path differs from durable journal") throw error;
    options.journal.update({ ...row, retryReason: "recovery_unavailable" });
    return false;
  }
}

/** 1–60 seconds, full jitter around an exponential cap; no wall clock reads. */
function retryDelayMs(retryCount: number, random: () => number): number {
  const cap = Math.min(60_000, 1_000 * 2 ** Math.min(retryCount, 6));
  const unit = Math.max(0, Math.min(1, random()));
  return Math.max(1_000, Math.floor(1_000 + (cap - 1_000) * unit));
}

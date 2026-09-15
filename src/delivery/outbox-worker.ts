// Local delivery state machine.  The outbox is the durable handoff; polling a
// receipt is deliberately the only thing this worker ever does beyond it.

import { readPublicationReceipt } from "../adapters/receipt-inbox.ts";
import { deleteDeliveredEvidence, writeMeetingBundle } from "../adapters/filesystem-outbox.ts";
import { canonicalArtifactHash, canonicalArtifactJson } from "../contracts/teammem-meeting-v1.ts";
import { parseSupportedTeamMemMeetingArtifact, type SupportedTeamMemMeetingArtifact } from "../contracts/teammem-meeting-v2.ts";
import { occurrencePathSegment } from "../domain/occurrence-id.ts";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { notificationRequestUuid } from "./notification-worker.ts";
import type { AcceptPublicationInput } from "../ports/session-store.ts";

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
  /** Persisted Runtime handle binding the direct-child encrypted recording. */
  readonly recordingHandle?: string | null;
};

/** R68's storage seam: the SQLite adapter is the production implementation. */
export type DeliveryJournal = {
  savePending(row: DeliveryRow): void;
  pending(): readonly DeliveryRow[];
  /** Audio is already deleted, but canonical metadata remains until an intent
   * or honest terminal classification commits. */
  recoverablePublications(): readonly DeliveryRow[];
  update(row: DeliveryRow): void;
  /** Publication evidence, legal state transition and notification intent
   * must commit as one operation before cleanup is allowed. */
  acceptPublication(input: AcceptPublicationInput): void;
};

export type OutboxWorker = {
  enqueue(input: {
    readonly artifact: SupportedTeamMemMeetingArtifact;
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
  if (typeof options.journal.acceptPublication !== "function") throw new Error("atomic publication and notification intent journal capability is required");
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
          recordingHandle: recordingHandleFromPath(input.recordingPath),
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
        ...(row.recordingHandle === null || row.recordingHandle === undefined ? {} : { recordingHandle: row.recordingHandle }),
        ...(row.stageToken === null ? {} : { stageToken: row.stageToken }),
      });
      if (written !== bundlePath) throw new Error("outbox writer returned a non-canonical bundle path");
      return bundlePath;
    },

    reconcile(): void {
      const now = options.clock.now();
      try { options.reconciliationEvidence.purgeExpiredReconciliationEvidence(now); } catch { options.onMaintenanceFailure?.("reconciliation_evidence_purge_failed"); }
      for (const current of [...options.journal.pending(), ...options.journal.recoverablePublications()]) {
        let publicationAccepted = current.publishedAtMs !== null;
        try {
          const state = options.session.state(current.occurrenceId);
          if (current.deletedAtMs !== null) {
            if (current.publishedAtMs !== null && (state === "published" || state === "notified") && current.publicationUrl !== null && current.vaultCommit !== null) {
              options.journal.acceptPublication({
                occurrenceId: current.occurrenceId, revision: current.revision, artifactHash: current.artifactHash,
                publishedAtMs: current.publishedAtMs, publicationUrl: current.publicationUrl, vaultCommit: current.vaultCommit,
                notification: notificationFromRecovery(current),
              });
              options.journal.update({ ...current, recoveryArtifact: null });
            }
            continue;
          }
          const retentionExpired = now >= current.endedAtMs + RETENTION_MS;
          let retainRecoveryArtifact = false;
          // A legacy accepted publication may still hold the only canonical
          // organizer/title bytes. Persist their intent before deadline cleanup,
          // but never extend governed retention when recovery cannot commit.
          if (current.publishedAtMs !== null && (state === "published" || state === "notified") && current.publicationUrl !== null && current.vaultCommit !== null) {
            try {
              options.journal.acceptPublication({
                occurrenceId: current.occurrenceId, revision: current.revision, artifactHash: current.artifactHash,
                publishedAtMs: current.publishedAtMs, publicationUrl: current.publicationUrl, vaultCommit: current.vaultCommit,
                notification: notificationFromRecovery(current),
              });
            } catch (error) {
              if (!retentionExpired) throw error;
              retainRecoveryArtifact = current.recoveryArtifact !== null;
            }
          }
          if (retentionExpired) {
            deleteOccurrenceEvidence(options, current, now, [current], retainRecoveryArtifact);
            continue;
          }
          if (current.publishedAtMs !== null) {
            // Startup repair clears missing-source publication markers only
            // after a successful ownership claim. A remaining marker still
            // blocks cleanup of conflicting or malformed recording evidence.
            if ((state === "published" || state === "notified") && current.transcriptComplete && current.retryReason !== "recovery_unavailable") deleteOccurrenceEvidence(options, current, now, eligibleRows(options, current));
            continue;
          }
          if (current.retryReason === "recovery_unavailable") continue;
          const artifact = recoverBundle(options, current);
          if (artifact === null) continue;
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
          if (state !== "awaiting_teammem" && state !== "published" && state !== "notified") continue;
          publicationAccepted = true;
          const published: DeliveryRow = {
            ...current,
            publishedAtMs: now,
            publicationUrl: receipt.markdown_url,
            vaultCommit: receipt.vault_commit,
            retryReason: null,
          };
          options.journal.acceptPublication({
            occurrenceId: current.occurrenceId, revision: current.revision, artifactHash: current.artifactHash,
            publishedAtMs: now, publicationUrl: receipt.markdown_url, vaultCommit: receipt.vault_commit,
            notification: notificationForArtifact(artifact, current, receipt.markdown_url, receipt.vault_commit),
          });
          if (current.transcriptComplete) {
            deleteOccurrenceEvidence(options, published, now, eligibleRows(options, published));
          }
        } catch {
          // A malformed legacy row is terminal and isolated. Classify a row
          // that failed before publication acceptance, but never let it abort
          // siblings or overwrite monotonic publication/deletion evidence.
          if (!publicationAccepted && current.retryReason !== "recovery_unavailable") {
            try { options.journal.update({ ...current, retryReason: "recovery_unavailable" }); } catch { /* keep the row isolated even if it cannot be updated */ }
          }
        }
      }
    },
  };
}

function notificationFromRecovery(row: DeliveryRow): AcceptPublicationInput["notification"] {
  if (row.recoveryArtifact === null || row.publicationUrl === null || row.vaultCommit === null) {
    return { terminalReason: "notification_inputs_unavailable" };
  }
  try {
    const artifact = parseSupportedTeamMemMeetingArtifact(JSON.parse(row.recoveryArtifact));
    if (canonicalArtifactJson(artifact) !== row.recoveryArtifact
      || canonicalArtifactHash(artifact) !== row.artifactHash
      || artifact.occurrence_id !== row.occurrenceId
      || artifact.revision !== row.revision) {
      return { terminalReason: "notification_inputs_unavailable" };
    }
    return notificationForArtifact(artifact, row, row.publicationUrl, row.vaultCommit);
  } catch {
    return { terminalReason: "notification_inputs_unavailable" };
  }
}

function notificationForArtifact(
  artifact: SupportedTeamMemMeetingArtifact,
  row: Pick<DeliveryRow, "occurrenceId" | "revision" | "artifactHash">,
  publicationUrl: string,
  vaultCommit: string,
): AcceptPublicationInput["notification"] {
  return artifact.organizer === null
    ? { terminalReason: "organizer_unresolved" }
    : {
        recipientId: artifact.organizer.person_id,
        title: artifact.title,
        messageText: `Meeting notes: ${artifact.title}\n${publicationUrl}`,
        requestUuid: notificationRequestUuid({ occurrenceId: row.occurrenceId, revision: row.revision, artifactHash: row.artifactHash, publicationUrl, vaultCommit }),
      };
}

function deleteOccurrenceEvidence(
  options: Pick<Parameters<typeof createOutboxWorker>[0], "recordingsDir" | "outboxDir" | "journal">,
  accepted: DeliveryRow,
  now: number,
  rows: readonly DeliveryRow[],
  retainRecoveryArtifact = false,
): void {
  const owned = options.journal.pending().filter((candidate) => candidate.occurrenceId === accepted.occurrenceId);
  const selected = new Set(rows.map((row) => `${row.occurrenceId}:${row.revision}`));
  const deleteRecording = owned.every((row) => selected.has(`${row.occurrenceId}:${row.revision}`));
  for (const row of rows) {
    deleteDeliveredEvidence({ recordingsDir: options.recordingsDir, outboxDir: options.outboxDir, occurrenceId: row.occurrenceId, revision: row.revision, recordingPath: row.recordingPath, bundlePath: row.bundlePath, deleteRecording, ...(row.stageToken === null ? {} : { stageToken: row.stageToken }), ...(row.recordingHandle === null || row.recordingHandle === undefined ? {} : { recordingHandle: row.recordingHandle }) });
    options.journal.update({
      ...row,
      ...(row.revision === accepted.revision ? { publishedAtMs: accepted.publishedAtMs, publicationUrl: accepted.publicationUrl, vaultCommit: accepted.vaultCommit } : {}),
      deletedAtMs: now,
      retryReason: row.retryReason === "recovery_unavailable" ? "recovery_unavailable" : null,
      recoveryArtifact: retainRecoveryArtifact ? row.recoveryArtifact : null,
    });
  }
}

function recoverBundle(
  options: Pick<Parameters<typeof createOutboxWorker>[0], "recordingsDir" | "outboxDir" | "journal">,
  row: DeliveryRow,
): SupportedTeamMemMeetingArtifact | null {
  if (row.recoveryArtifact === null || row.stageToken === null) {
    options.journal.update({ ...row, retryReason: "recovery_unavailable" });
    return null;
  }
  try {
    const expected = path.join(path.resolve(options.outboxDir), occurrencePathSegment(row.occurrenceId as `${string}@${string}`), String(row.revision));
    if (row.bundlePath !== expected) throw new Error("recovery bundle path differs from durable journal");
    const artifact = parseSupportedTeamMemMeetingArtifact(JSON.parse(row.recoveryArtifact));
    const artifactHash = row.artifactHash;
    const written = writeMeetingBundle({
      recordingsDir: options.recordingsDir,
      outboxDir: options.outboxDir,
      artifact,
      serializedArtifact: row.recoveryArtifact,
      artifactHash,
      recordingPath: row.recordingPath,
      ...(row.recordingHandle === null || row.recordingHandle === undefined ? {} : { recordingHandle: row.recordingHandle }),
      stageToken: row.stageToken,
    });
    if (written !== row.bundlePath) throw new Error("recovered bundle path differs from durable journal");
    return artifact;
  } catch (error) {
    if ((error as Error).message === "recovery bundle path differs from durable journal") throw error;
    options.journal.update({ ...row, retryReason: "recovery_unavailable" });
    return null;
  }
}

function eligibleRows(options: Pick<Parameters<typeof createOutboxWorker>[0], "journal">, accepted: DeliveryRow): readonly DeliveryRow[] {
  return options.journal.pending().filter((row) => row.occurrenceId === accepted.occurrenceId && row.revision <= accepted.revision);
}

function recordingHandleFromPath(recordingPath: string): string | null {
  return /^([0-9a-f]{32})\.crsr$/.exec(path.basename(recordingPath))?.[1] ?? null;
}

/** 1–60 seconds, full jitter around an exponential cap; no wall clock reads. */
function retryDelayMs(retryCount: number, random: () => number): number {
  const cap = Math.min(60_000, 1_000 * 2 ** Math.min(retryCount, 6));
  const unit = Math.max(0, Math.min(1, random()));
  return Math.max(1_000, Math.floor(1_000 + (cap - 1_000) * unit));
}

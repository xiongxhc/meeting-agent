// Local delivery state machine.  The outbox is the durable handoff; polling a
// receipt is deliberately the only thing this worker ever does beyond it.

import { readPublicationReceipt } from "../adapters/receipt-inbox.ts";
import { deleteDeliveredEvidence, deleteSeedRecordingEvidence, verifyConsumedMeetingBundle, writeMeetingBundle } from "../adapters/filesystem-outbox.ts";
import { canonicalArtifactHash, canonicalArtifactJson } from "../contracts/teammem-meeting-v1.ts";
import { parseSupportedTeamMemMeetingArtifact, type SupportedTeamMemMeetingArtifact } from "../contracts/teammem-meeting-v2.ts";
import { occurrencePathSegment } from "../domain/occurrence-id.ts";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { notificationRequestUuid } from "./notification-worker.ts";
import type { AcceptPublicationInput, BackfillDeliveryAuthority, BackfillSeedCleanupClaim, DeliveryRow as StoreDeliveryRow, SavePendingDeliveryResult } from "../ports/session-store.ts";

const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_RECOVERY_ARTIFACT_BYTES = 16 * 1024 * 1024;

export type DeliveryRow = StoreDeliveryRow;

/** R68's storage seam: the SQLite adapter is the production implementation. */
export type DeliveryJournal = {
  savePending(row: DeliveryRow, authority?: BackfillDeliveryAuthority): SavePendingDeliveryResult;
  pending(): readonly DeliveryRow[];
  /** Audio is already deleted, but canonical metadata remains until an intent
   * or honest terminal classification commits. */
  recoverablePublications(): readonly DeliveryRow[];
  update(row: DeliveryRow): void;
  /** Publication evidence, legal state transition and notification intent
   * must commit as one operation before cleanup is allowed. */
  acceptPublication(input: AcceptPublicationInput): void;
  claimExpiredBackfillSeedCleanup(input: { readonly nowMs: number; readonly claimToken: string }): BackfillSeedCleanupClaim | null;
  completeBackfillSeedCleanup(input: { readonly occurrenceId: string; readonly claimToken: string; readonly nowMs: number }): void;
  authorizeDeliveryEvidenceCleanup(input: { readonly occurrenceId: string; readonly nowMs: number }): boolean;
};

export type OutboxWorker = {
  enqueue(input: {
    readonly artifact: SupportedTeamMemMeetingArtifact;
    readonly serializedArtifact: string;
    readonly artifactHash: string;
    readonly recordingPath: string;
    readonly backfillAuthority?: BackfillDeliveryAuthority;
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
  readonly onMaintenanceFailure?: (reason: "reconciliation_evidence_purge_failed" | "backfill_seed_cleanup_failed") => void;
}): OutboxWorker {
  if (options.reconciliationEvidence === undefined) throw new Error("reconciliation purge dependency is required");
  if (typeof options.journal.acceptPublication !== "function") throw new Error("atomic publication and notification intent journal capability is required");
  const recordingOwners = new Map<string, string>();
  return {
    enqueue(input): string {
      let requestedArtifact: SupportedTeamMemMeetingArtifact;
      try { requestedArtifact = parseSupportedTeamMemMeetingArtifact(JSON.parse(input.serializedArtifact)); }
      catch { throw new Error("delivery recovery artifact is invalid"); }
      if (canonicalArtifactJson(requestedArtifact) !== input.serializedArtifact ||
          canonicalArtifactJson(input.artifact) !== input.serializedArtifact ||
          canonicalArtifactHash(requestedArtifact) !== input.artifactHash) {
        throw new Error("delivery artifact bytes or hash are not canonical");
      }
      const bundlePath = path.join(path.resolve(options.outboxDir), occurrencePathSegment(input.artifact.occurrence_id as `${string}@${string}`), String(input.artifact.revision));
      const owner = recordingOwners.get(path.resolve(input.recordingPath));
      if (owner !== undefined && owner !== input.artifact.occurrence_id) throw new Error("recording is owned by another occurrence");
      if (Buffer.byteLength(input.serializedArtifact, "utf8") > MAX_RECOVERY_ARTIFACT_BYTES) throw new Error("recovery artifact exceeds retention bound");
      // The journal validates/fences the canonical intent before filesystem
      // visibility. Its returned row is also replay authority after a crash;
      // caller bytes are never substituted for persisted bytes.
      const saved = options.journal.savePending({
        occurrenceId: requestedArtifact.occurrence_id,
        revision: requestedArtifact.revision,
        artifactHash: input.artifactHash,
        recordingPath: input.recordingPath,
        bundlePath,
        endedAtMs: Date.parse(requestedArtifact.ended_at),
        transcriptComplete: requestedArtifact.transcript_complete,
        retryCount: 0,
        nextRetryAtMs: options.clock.now(),
        retryReason: null,
        publishedAtMs: null,
        deletedAtMs: null,
        publicationUrl: null,
        vaultCommit: null,
        recoveryArtifact: input.serializedArtifact,
        stageToken: randomUUID().replaceAll("-", ""),
        recordingHandle: recordingHandleFromPath(input.recordingPath),
      }, input.backfillAuthority);
      const row = saved.row;
      if (row.deletedAtMs !== null || row.recoveryArtifact === null || row.stageToken === null ||
          row.occurrenceId !== requestedArtifact.occurrence_id || row.revision !== requestedArtifact.revision ||
          row.bundlePath !== bundlePath) throw new Error("delivery journal returned an unsafe canonical intent");
      let persistedArtifact: SupportedTeamMemMeetingArtifact;
      try { persistedArtifact = parseSupportedTeamMemMeetingArtifact(JSON.parse(row.recoveryArtifact)); }
      catch { throw new Error("delivery journal retained invalid canonical bytes"); }
      if (canonicalArtifactJson(persistedArtifact) !== row.recoveryArtifact || canonicalArtifactHash(persistedArtifact) !== row.artifactHash) {
        throw new Error("delivery journal retained conflicting canonical bytes");
      }
      recordingOwners.set(path.resolve(row.recordingPath), row.occurrenceId);
      const written = writeMeetingBundle({
        recordingsDir: options.recordingsDir,
        outboxDir: options.outboxDir,
        artifact: persistedArtifact,
        serializedArtifact: row.recoveryArtifact,
        artifactHash: row.artifactHash,
        recordingPath: row.recordingPath,
        ...(row.recordingHandle === null || row.recordingHandle === undefined ? {} : { recordingHandle: row.recordingHandle }),
        ...(row.stageToken === null ? {} : { stageToken: row.stageToken }),
      });
      if (written !== bundlePath) throw new Error("outbox writer returned a non-canonical bundle path");
      return bundlePath;
    },

    reconcile(): void {
      const now = options.clock.now();
      try { options.reconciliationEvidence.purgeExpiredReconciliationEvidence(now); } catch { options.onMaintenanceFailure?.("reconciliation_evidence_purge_failed"); }
      const cleanupToken = randomUUID().replaceAll("-", "");
      const seedCleanup = options.journal.claimExpiredBackfillSeedCleanup({ nowMs: now, claimToken: cleanupToken });
      if (seedCleanup !== null) {
        try {
          deleteSeedRecordingEvidence({ recordingsDir: options.recordingsDir,
            recordingPath: seedCleanup.recordingPath, recordingHandle: seedCleanup.recordingHandle,
            recordingBytes: seedCleanup.recordingBytes, recordingDevice: seedCleanup.recordingDevice,
            recordingInode: seedCleanup.recordingInode });
          options.journal.completeBackfillSeedCleanup({ occurrenceId: seedCleanup.occurrenceId,
            claimToken: seedCleanup.claimToken, nowMs: now });
        } catch {
          // Retain the fixed lease and exact tombstone for reopen/reclaim, but
          // keep the blocked custody operation visible to the existing owner.
          options.onMaintenanceFailure?.("backfill_seed_cleanup_failed");
        }
      }
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
          const receipt = now < current.nextRetryAtMs ? null : readPublicationReceipt({
            receiptsDir: options.receiptsDir,
            occurrenceId: current.occurrenceId,
            revision: current.revision,
            artifactHash: current.artifactHash,
          });
          // Repair only the measured D033 state: an exact receipt plus fully
          // verified consumed-bundle metadata. Other terminal rows stay inert.
          const consumedOnly = current.retryReason === "recovery_unavailable";
          if (consumedOnly && receipt === null) continue;
          const recovered = recoverBundle(options, current, consumedOnly);
          if (recovered === null) continue;
          const { artifact, consumed } = recovered;
          if (now < current.nextRetryAtMs) continue;
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
          const publicationState = options.session.state(current.occurrenceId);
          if (publicationState !== "awaiting_teammem" && publicationState !== "published" && publicationState !== "notified") continue;
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
            ...(consumed ? { consumedInboxAudio: true as const } : {}),
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
  if (!options.journal.authorizeDeliveryEvidenceCleanup({ occurrenceId: accepted.occurrenceId, nowMs: now })) return;
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
  consumedOnly = false,
): { artifact: SupportedTeamMemMeetingArtifact; consumed: boolean } | null {
  if (row.recoveryArtifact === null || row.stageToken === null) {
    if (!consumedOnly) options.journal.update({ ...row, retryReason: "recovery_unavailable" });
    return null;
  }
  try {
    const expected = path.join(path.resolve(options.outboxDir), occurrencePathSegment(row.occurrenceId as `${string}@${string}`), String(row.revision));
    if (row.bundlePath !== expected) throw new Error("recovery bundle path differs from durable journal");
    const artifact = parseSupportedTeamMemMeetingArtifact(JSON.parse(row.recoveryArtifact));
    if (artifact.occurrence_id !== row.occurrenceId || artifact.revision !== row.revision ||
        artifact.transcript_complete !== row.transcriptComplete || Date.parse(artifact.ended_at) !== row.endedAtMs) {
      throw new Error("recovery artifact differs from durable journal");
    }
    const artifactHash = row.artifactHash;
    const input = {
      recordingsDir: options.recordingsDir,
      outboxDir: options.outboxDir,
      artifact,
      serializedArtifact: row.recoveryArtifact,
      artifactHash,
      recordingPath: row.recordingPath,
      ...(row.recordingHandle === null || row.recordingHandle === undefined ? {} : { recordingHandle: row.recordingHandle }),
      stageToken: row.stageToken,
    };
    let written: string, consumed = false;
    try { written = verifyConsumedMeetingBundle(input); consumed = true; }
    catch {
      if (consumedOnly) return null;
      written = writeMeetingBundle(input);
    }
    if (written !== row.bundlePath) throw new Error("recovered bundle path differs from durable journal");
    options.journal.savePending(row);
    return { artifact, consumed };
  } catch (error) {
    if ((error as Error).message === "recovery bundle path differs from durable journal") throw error;
    if (!consumedOnly) options.journal.update({ ...row, retryReason: "recovery_unavailable" });
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

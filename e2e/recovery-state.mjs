// R1 test-entry preparation. SQLite facts never certify that a command ran,
// a Runtime capability authenticated, an owner is reaped, or R1 passed.
// Capability authorization/key IDs stay inside SQLite, including on errors.
import Database from "better-sqlite3";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { audioFormatToken } from "../dist/src/contracts/teammem-meeting-v1.js";

const DAY_MS = 86_400_000;
function requireFact(value, reason) { if (!value) throw new Error(reason); }
function validInstant(value) {
  requireFact(Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000, "invalid recovery clock instant");
  return value;
}
export function createRecoveryClock(initialMs) {
  let current = validInstant(initialMs);
  return Object.freeze({ now: () => current, advanceTo(value) {
    validInstant(value); requireFact(value >= current, "recovery clock regression");
    current = value; return current;
  } });
}
function snapshot(databasePath, work) {
  requireFact(typeof databasePath === "string" && path.isAbsolute(databasePath) && lstatSync(databasePath).isFile(), "invalid recovery database path");
  // Read-only SQLite may create/write WAL shared-memory sidecars. Refuse that
  // mode rather than checkpointing, copying, or ignoring outstanding WAL data.
  requireFact(!existsSync(`${databasePath}-wal`) && !existsSync(`${databasePath}-shm`), "recovery reader requires a non-WAL snapshot");
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    requireFact(db.readonly, "recovery database was not opened readonly");
    requireFact(db.pragma("journal_mode", { simple: true }) !== "wal", "recovery reader requires a non-WAL snapshot");
    return db.transaction(() => {
      requireFact(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version === 31, "unsupported recovery schema");
      return work(db);
    })();
  } finally { db.close(); }
}
/** Initial-run locator only. The controller must bind this ID to its actual
 * capture/admission trace; one SQLite seed alone is never application proof. */
export function readSeedOccurrenceId(databasePath) {
  return snapshot(databasePath, db => {
    const rows = db.prepare("SELECT occurrence_id FROM backfill_seeds ORDER BY occurrence_id LIMIT 2").all();
    requireFact(rows.length === 1, "expected exactly one known-end seed occurrence");
    return rows[0].occurrence_id;
  });
}

export function readKnownEndRecoveryState({ databasePath, occurrenceId }) {
  requireFact(typeof occurrenceId === "string" && occurrenceId.length > 0 && occurrenceId.length <= 8192, "invalid recovery occurrence");
  return snapshot(databasePath, db => {
    const row = db.prepare(`SELECT
      s.ended_at AS endedAt,s.ended_at_ms AS endedAtMs,s.stop_at_ms AS stopAtMs,s.expires_at_ms AS expiresAtMs,
      s.source_session_id AS sourceSessionId,s.bridge_session_id AS bridgeSessionId,s.generation_id AS generationId,
      s.capability_recording_handle AS handle,s.recording_sha256 AS sha256,s.recording_path AS path,
      s.recording_bytes AS bytes,s.recording_device AS device,s.recording_inode AS inode,
      s.recording_format AS seedFormat,r.format AS runtimeFormat,
      s.runtime_profile AS runtimeProfile,s.stt_provider AS sttProvider,s.stt_model AS sttModel,
      s.live_stream_model AS liveStreamModel,s.final_batch_model AS finalBatchModel,
      s.text_provider AS textProvider,s.text_model AS textModel,s.agent_version AS agentVersion,
      l.owner,l.state,l.initial_build_attempts AS initialBuildAttempts,l.initial_build_last_reason AS initialBuildReason,
      l.build_claim_token IS NOT NULL AS buildClaimed,l.build_claim_expires_at_ms AS buildClaimExpiresAtMs,
      l.process_owner_token IS NOT NULL AS processOwned,l.process_cleanup_state AS processCleanupState,
      l.cleanup_claim_token IS NOT NULL AS cleanupClaimed,l.deleted_at_ms AS deletedAtMs,
      l.last_observed_at_ms AS lastObservedAtMs,l.initial_build_next_attempt_at_ms AS nextAttemptAtMs,
      l.stop_at_ms=s.stop_at_ms AND l.expires_at_ms=s.expires_at_ms AS lifecycleBound,
      r.handle=s.capability_recording_handle AND r.sha256=s.recording_sha256
        AND r.sha256=s.capability_sha256 AND r.key_id=s.recording_key_id AND r.key_id=s.capability_key_id
        AND r.encrypted_path=s.recording_path
        AND r.duration_ms=s.recording_duration_ms AS recordingBound,
      b.recording_kind='final' AND b.occurrence_id=s.occurrence_id AND b.bridge_session_id=s.bridge_session_id
        AND b.source_session_id=s.source_session_id AND b.recording_handle=s.capability_recording_handle
        AND b.sha256=s.capability_sha256 AND b.key_id=s.capability_key_id
        AND b.authorization=s.capability_authorization AS recoveryBound,
      session.provider_meeting_id=s.provider_meeting_id AND session.occurrence_started_at=s.occurrence_started_at AS sessionBound,
      g.generation_id IS NOT NULL AS generationRetained,
      g.occurrence_id=s.occurrence_id AND g.bridge_session_id=s.bridge_session_id AND g.runtime_session_id=s.source_session_id
        AND g.recording_handle=s.capability_recording_handle
        AND g.terminal_source='bridge_observed' AND g.terminal_reason='ended' AND g.terminal_at_ms=s.ended_at_ms
        AND g.expires_at_ms=s.expires_at_ms AS generationBound
      FROM backfill_seeds s JOIN backfill_seed_lifecycle l USING(occurrence_id)
      JOIN recordings r USING(occurrence_id) JOIN sessions session USING(occurrence_id)
      JOIN recording_recovery_bindings b ON b.generation_id=s.generation_id
      LEFT JOIN reconciliation_generations g ON g.generation_id=s.generation_id
      WHERE s.occurrence_id=?`).get(occurrenceId);
    requireFact(row, "missing bound known-end seed");
    validInstant(row.endedAtMs); validInstant(row.stopAtMs); validInstant(row.expiresAtMs);
    requireFact(Date.parse(row.endedAt) === row.endedAtMs && row.stopAtMs === row.endedAtMs + 11 * DAY_MS &&
      row.expiresAtMs === row.endedAtMs + 14 * DAY_MS && row.lifecycleBound === 1, "original known-end deadlines mismatch");
    requireFact(row.recordingBound === 1 && audioFormatToken(row.runtimeFormat) === row.seedFormat, "recording identity mismatch");
    requireFact(row.recoveryBound === 1, "recording recovery identity mismatch");
    requireFact(row.sessionBound === 1, "seed session identity mismatch");
    requireFact(row.generationRetained ? row.generationBound === 1 : row.lastObservedAtMs >= row.expiresAtMs,
      "positive known-end generation missing or mismatched");
    requireFact(["seed", "delivery"].includes(row.owner) && ["pending", "stopped", "cleanup_claimed", "deleted"].includes(row.state), "invalid recovery authority");
    requireFact((row.state === "deleted") === (row.deletedAtMs !== null), "invalid recovery deletion tombstone");
    const pending = Object.freeze({
      deliveryCount: db.prepare("SELECT COUNT(*) AS n FROM delivery_journal WHERE occurrence_id=?").get(occurrenceId).n,
      jobCount: db.prepare("SELECT COUNT(*) AS n FROM backfill_jobs WHERE occurrence_id=?").get(occurrenceId).n,
    });
    requireFact(row.owner !== "seed" || (pending.deliveryCount === 0 && pending.jobCount === 0), "seed authority has delivered state");
    requireFact(row.owner !== "delivery" || pending.deliveryCount > 0, "delivery authority lacks actual delivery state");
    const selected = db.prepare(`SELECT a.attempt_id AS attemptId,a.state,a.coverage_status AS coverageStatus,
      a.generation_id=b.generation_id AND a.source_session_id=b.source_session_id AND a.recording_handle=b.recording_handle
        AND a.sha256=b.sha256 AND a.key_id=b.key_id AND a.timing_contract='capture-clock/v1' AS bound
      FROM recording_alignment_selected x JOIN recording_recovery_bindings b USING(generation_id)
      LEFT JOIN recording_alignment_attempts a ON a.attempt_id=x.attempt_id WHERE b.generation_id=?`).get(row.generationId);
    requireFact(!selected || (selected.bound === 1 && selected.state === "complete"), "selected recording attempt identity mismatch");
    const warningRow = db.prepare(`SELECT state,attempt_count AS attemptCount,accepted_at_ms AS acceptedAtMs,
      next_attempt_at_ms AS nextAttemptAtMs,terminal_reason AS terminalReason,claim_token IS NOT NULL AS claimed,
      claim_expires_at_ms AS claimExpiresAtMs,
      stop_at_ms=? AND expires_at_ms=? AS bound FROM backfill_warning_intents WHERE occurrence_id=?`).get(row.stopAtMs, row.expiresAtMs, occurrenceId);
    requireFact(!warningRow || warningRow.bound === 1, "warning original deadlines mismatch");
    let retention = "deleted";
    if (row.deletedAtMs === null) {
      requireFact(existsSync(row.path), "retained recording is missing");
      const stat = lstatSync(row.path, { bigint: true });
      requireFact(stat.isFile() && stat.dev.toString() === row.device && stat.ino.toString() === row.inode && stat.size === BigInt(row.bytes), "retained recording identity mismatch");
      retention = "retained";
    } else {
      requireFact(row.deletedAtMs >= row.expiresAtMs && !existsSync(row.path), "recording deletion contradicts governed tombstone");
    }
    const markerCleared = row.processCleanupState === null && row.processOwned === 0;
    const initialBuildFailed = row.initialBuildAttempts > 0 && row.initialBuildReason === "build_failed";
    const ready = row.owner === "seed" && row.state === "pending" && initialBuildFailed && markerCleared &&
      row.buildClaimed === 0 && row.cleanupClaimed === 0 && retention === "retained";
    const stage = !markerCleared ? "runtime-cleanup-blocked" : row.owner === "delivery" ? "delivery-owned"
      : row.state === "deleted" ? "seed-deleted" : row.state === "cleanup_claimed" ? "seed-cleanup-claimed"
        : row.state === "stopped" ? "seed-stopped" : ready ? "initial-build-failed" : "seed-pending";
    return Object.freeze({ occurrenceId, endedAtMs: row.endedAtMs, stopAtMs: row.stopAtMs, expiresAtMs: row.expiresAtMs,
      source: Object.freeze({ sourceSessionId: row.sourceSessionId, bridgeSessionId: row.bridgeSessionId, generationId: row.generationId,
        handle: row.handle, sha256: row.sha256, path: row.path, bytes: row.bytes, device: row.device, inode: row.inode, retention }),
      provenance: Object.freeze({ runtimeProfile: row.runtimeProfile, sttProvider: row.sttProvider, sttModel: row.sttModel,
        liveStreamModel: row.liveStreamModel, finalBatchModel: row.finalBatchModel, textProvider: row.textProvider,
        textModel: row.textModel, agentVersion: row.agentVersion }),
      lifecycle: Object.freeze({ owner: row.owner, state: row.state, initialBuildAttempts: row.initialBuildAttempts,
        initialBuildReason: row.initialBuildReason, buildClaimed: row.buildClaimed === 1, buildClaimExpiresAtMs: row.buildClaimExpiresAtMs,
        processCleanupState: row.processCleanupState, processOwned: row.processOwned === 1, cleanupClaimed: row.cleanupClaimed === 1,
        deletedAtMs: row.deletedAtMs, lastObservedAtMs: row.lastObservedAtMs, nextAttemptAtMs: row.nextAttemptAtMs }),
      pending, warning: warningRow ? Object.freeze({ state: warningRow.state, attemptCount: warningRow.attemptCount,
        acceptedAtMs: warningRow.acceptedAtMs, nextAttemptAtMs: warningRow.nextAttemptAtMs,
        terminalReason: warningRow.terminalReason, claimed: warningRow.claimed === 1, claimExpiresAtMs: warningRow.claimExpiresAtMs }) : null,
      generationRetained: row.generationRetained === 1,
      selectedAlignment: selected ? Object.freeze({ attemptId: selected.attemptId, state: selected.state, coverageStatus: selected.coverageStatus }) : null,
      stage, r1Preconditions: Object.freeze({ seedOwned: row.owner === "seed", initialBuildFailed,
        runtimeCleanupMarkerCleared: markerCleared, noDeliveryOrJob: pending.deliveryCount === 0 && pending.jobCount === 0,
        initialFailureRestartReady: ready }),
    });
  });
}

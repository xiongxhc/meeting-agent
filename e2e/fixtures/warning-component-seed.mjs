// Component-only setup; NEVER imported by the application recovery variant.
// Actual migrated store/coordinator transitions with explicitly synthetic
// recording/capability bytes. Parent owns private root cleanup after leaf reap.
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openSessionStore } from "../../dist/src/adapters/sqlite-session-store.js";
import { buildMeetingIdentity } from "../../dist/src/domain/meeting.js";
import { createCoordinator } from "../../dist/src/sessions/coordinator.js";
const ENDED = 1_788_357_600_123, STOP = ENDED + 11 * 86_400_000, EXPIRY = ENDED + 14 * 86_400_000;
export function createWarningComponentSeed() {
  const root = mkdtempSync("/private/tmp/meeting-warning-crash-");
  const databasePath = path.join(root, "state.db"), recordingsDir = path.join(root, "recordings"), outboxDir = path.join(root, "outbox");
  mkdirSync(recordingsDir, { mode: 0o700 }); mkdirSync(outboxDir, { mode: 0o700 });
  const handle = "a".repeat(32), recordingPath = path.join(recordingsDir, `${handle}.crsr`);
  const ciphertext = Buffer.from("component-only synthetic ciphertext");
  writeFileSync(recordingPath, ciphertext, { mode: 0o600 });
  const hash = createHash("sha256").update(ciphertext).digest("hex");
  const capability = { sourceSessionId: 41n, recordingHandle: handle, sha256: hash, keyId: "c".repeat(16), authorization: "d".repeat(64) };
  const identity = buildMeetingIdentity({ providerMeetingId: "component-recovery", meetingNo: "4242", occurrenceStartedAt: "2026-09-02T13:59:00Z", title: "Component fixture", organizer: null });
  const store = openSessionStore({ filename: databasePath, nowMs: ENDED });
  const coordinator = createCoordinator({ store, clock: { now: () => ENDED }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 1 });
  coordinator.discover(identity); coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening");
  store.beginReconciliationGeneration(identity.occurrenceId, "component-bridge", ENDED - 1_000);
  store.setReconciliationRuntimeSession(identity.occurrenceId, "component-bridge", 41n);
  coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, {
    recovery: { bridgeSessionId: "component-bridge", capability }, handle, encryptedPath: recordingPath, sha256: hash,
    durationMs: 20, format: "pcm_s16le/24000/1/20ms", keyId: capability.keyId, gaps: [], runtimeGaps: [],
  }, "component-bridge", ENDED, "bridge_observed", {
    terminalReason: "ended", terminalSource: "bridge_observed", endedAt: new Date(ENDED).toISOString(), identity,
    provider: "feishu", encryption: "aes-256-gcm", processingWarnings: [], provenance: {
      runtimeProfile: "online", sttProvider: "component-stt", sttModel: "stt-model", liveStreamModel: "live-model",
      finalBatchModel: "batch-model", textProvider: "component-text", textModel: "text-model", agentVersion: "component-only",
    },
  });
  coordinator.completeReconciliationGeneration(identity.occurrenceId, "component-bridge", ENDED, "bridge_observed", "ended");
  store.stopDueBackfill({ nowMs: STOP });
  store.close();
  return {
    root, databasePath, outboxDir, recordingPath, recordingsDir, handle, hash, occurrenceId: identity.occurrenceId,
    endedAtMs: ENDED, stopAtMs: STOP, expiresAtMs: EXPIRY,
    open: () => openSessionStore({ filename: databasePath, nowMs: ENDED }),
    close() { rmSync(root, { recursive: true, force: true }); },
  };
}

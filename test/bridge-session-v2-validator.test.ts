import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridgeSessionValidatorV2 } from "../src/contracts/bridge-session-v2.ts";

const sessionId = "synthetic-bridge-session";
const timing = { clockDomainId: "domain", hostBeforeNs: "1000", hostAfterNs: "2000" };
const lease = {
  sessionId: "7", bridgeSessionId: sessionId, connectEndpoint: "wss://synthetic.invalid/media", credential: "synthetic-credential",
  expiresAtMs: "1000", reconnectWindowMs: "5000", mediaProtocolVersion: 2, captureFormat: "pcm_s16le/24000/1/20ms", timingContract: "capture-clock/v1",
};
const join = (commandId = "c1") => ({ schema: "bridge-session/v2", sessionId, commandId, type: "join", meetingOccurrenceId: "synthetic-meeting@2026-09-02T14:00:00Z", meetingNo: "000000001", leaseId: "lease-1" });
const event = (sequence: number, payload: Record<string, unknown>) => ({ schema: "bridge-session/v2", sessionId, sequence, observedAt: "2026-09-02T14:01:00.000Z", ...payload });
const snapshot = (sequence: number) => event(sequence, { type: "ui_snapshot", snapshotSequence: sequence, observationTiming: timing, state: "unknown", feishuUserId: null, reason: "no_highlight", barrierBefore: null });

function rejected(result: { ok: boolean; rejection?: { code: string; path: string; detail: string } }, code: string, path?: string): void {
  assert.equal(result.ok, false);
  assert.equal(typeof result.rejection?.detail, "string");
  assert.equal(result.rejection?.code, code);
  if (path !== undefined) assert.equal(result.rejection?.path, path);
}

test("v2 validator accepts the session's own v2 commands and events and returns the parsed value", () => {
  const validator = createBridgeSessionValidatorV2(sessionId);
  assert.equal(validator.sessionId, sessionId);
  const command = validator.acceptCommand(join());
  assert.equal(command.ok, true);
  if (command.ok) assert.equal(command.value.commandId, "c1");
  const media = validator.acceptCommand({ schema: "bridge-session/v2", sessionId, commandId: "c2", type: "connect_media", mediaLease: lease });
  assert.equal(media.ok, true);
  const joined = validator.acceptEvent(event(1, { type: "joined", meetingOccurrenceId: "synthetic-meeting@2026-09-02T14:00:00Z", observationTiming: timing, observationTimingReason: null }));
  assert.equal(joined.ok, true);
  if (joined.ok) assert.equal(joined.value.type, "joined");
  assert.equal(validator.acceptEvent(snapshot(2)).ok, true);
  assert.equal(validator.acceptEvent(event(5, { type: "command_result", commandId: "c1", outcome: "ok", detail: null })).ok, true);
  assert.equal(validator.acceptEvent(event(6, { type: "command_result", commandId: "c2", outcome: "failed", detail: "no media" })).ok, true);
});

test("v2 validator rejects the exact schema literal fences on both directions", () => {
  const validator = createBridgeSessionValidatorV2(sessionId);
  rejected(validator.acceptCommand({ ...join(), schema: "bridge-session/v1" }), "schema_unknown", "/schema");
  rejected(validator.acceptCommand({ ...join(), schema: "bridge-session/v3" }), "schema_unknown", "/schema");
  rejected(validator.acceptEvent({ ...snapshot(1), schema: "bridge-session/v1" }), "schema_unknown", "/schema");
  const missing: Record<string, unknown> = { ...join() }; delete missing.schema;
  rejected(validator.acceptCommand(missing), "missing_field", "/schema");
  rejected(validator.acceptCommand(null), "not_an_object", "");
  rejected(validator.acceptEvent([snapshot(1)]), "not_an_object", "");
  rejected(validator.acceptEvent("string"), "not_an_object", "");
  assert.equal(validator.acceptCommand(join()).ok, true);
});

test("v2 validator rejects a session id mismatch in both directions", () => {
  const validator = createBridgeSessionValidatorV2(sessionId);
  rejected(validator.acceptCommand({ ...join(), sessionId: "other" }), "session_mismatch", "/sessionId");
  rejected(validator.acceptEvent({ ...snapshot(1), sessionId: "other" }), "session_mismatch", "/sessionId");
  const media = { schema: "bridge-session/v2", sessionId: "other", commandId: "c9", type: "connect_media", mediaLease: { ...lease, bridgeSessionId: "other" } };
  rejected(validator.acceptCommand(media), "session_mismatch", "/sessionId");
  assert.equal(validator.acceptEvent(snapshot(1)).ok, true);
});

test("v2 validator rejects duplicate command ids and command results for commands it never issued", () => {
  const validator = createBridgeSessionValidatorV2(sessionId);
  assert.equal(validator.acceptCommand(join("c1")).ok, true);
  rejected(validator.acceptCommand(join("c1")), "command_id_duplicate", "/commandId");
  rejected(validator.acceptCommand({ schema: "bridge-session/v2", sessionId, commandId: "c1", type: "connect_media", mediaLease: lease }), "command_id_duplicate", "/commandId");
  rejected(validator.acceptEvent(event(1, { type: "command_result", commandId: "never", outcome: "ok", detail: null })), "unknown_command_id", "/commandId");
  // A rejected command id is not issued.
  rejected(validator.acceptCommand({ ...join("c2"), meetingNo: "" }), "field_type", "/meetingNo");
  rejected(validator.acceptEvent(event(1, { type: "command_result", commandId: "c2", outcome: "ok", detail: null })), "unknown_command_id", "/commandId");
  assert.equal(validator.acceptEvent(event(1, { type: "command_result", commandId: "c1", outcome: "ok", detail: null })).ok, true);
});

test("v2 validator rejects duplicate and non-monotonic event sequences without advancing", () => {
  const validator = createBridgeSessionValidatorV2(sessionId);
  assert.equal(validator.acceptEvent(snapshot(5)).ok, true);
  rejected(validator.acceptEvent(snapshot(5)), "sequence_duplicate", "/sequence");
  rejected(validator.acceptEvent(snapshot(4)), "sequence_out_of_order", "/sequence");
  rejected(validator.acceptEvent(event(0, { type: "media_disconnected", reason: "x" })), "field_type", "/sequence");
  rejected(validator.acceptEvent(event(9007199254740992, { type: "media_disconnected", reason: "x" })), "v2_payload");
  rejected(validator.acceptEvent(event(1.5, { type: "media_disconnected", reason: "x" })), "field_type", "/sequence");
  assert.equal(validator.acceptEvent(snapshot(7)).ok, true);
  // A rejected message never advances the sequence.
  rejected(validator.acceptEvent({ ...snapshot(9), state: "nonsense" }), "v2_payload");
  assert.equal(validator.acceptEvent(snapshot(8)).ok, true);
});

test("v2 validator rejects oversized and malformed messages with the bounded v2 fences", () => {
  const validator = createBridgeSessionValidatorV2(sessionId);
  rejected(validator.acceptEvent(event(1, { type: "media_disconnected", reason: "x".repeat(4096) })), "message_too_large", "");
  rejected(validator.acceptCommand({ ...join(), leaseId: "x".repeat(65_536) }), "message_too_large", "");
  assert.equal(validator.acceptCommand({ ...join(), leaseId: "x".repeat(65_000) }).ok, true);
  rejected(validator.acceptEvent(event(1, { type: "audio_frame", bytes: "AAAA" })), "unknown_type", "/type");
  rejected(validator.acceptEvent(event(1, { type: "media_disconnected", reason: "x", extra: 1 })), "unknown_field", "/extra");
  rejected(validator.acceptEvent(event(1, { type: "media_disconnected" })), "missing_field", "/reason");
  rejected(validator.acceptEvent(event(1, { type: "joined", meetingOccurrenceId: "m" })), "v2_payload", "/observationTiming");
  rejected(validator.acceptEvent(event(1, { type: "joined", meetingOccurrenceId: "m", observationTiming: null, observationTimingReason: null })), "v2_payload", "/observationTiming");
  rejected(validator.acceptEvent(event(1, { type: "joined", meetingOccurrenceId: "m", observationTiming: { ...timing, hostAfterNs: "1" }, observationTimingReason: null })), "v2_payload", "/observationTiming");
  rejected(validator.acceptEvent(event(1, { type: "active_speaker", feishuUserId: null, confidence: "ui_exact", observationTiming: timing, observationTimingReason: null })), "speaker_identity_required", "/feishuUserId");
  rejected(validator.acceptEvent({ ...snapshot(1), observationTiming: null }), "v2_payload");
  rejected(validator.acceptEvent({ ...snapshot(1), feishuUserId: "u" }), "v2_payload");
  rejected(validator.acceptEvent({ ...snapshot(1), observedAt: "2026-09-02 14:01:00" }), "timestamp_format", "/observedAt");
  rejected(validator.acceptCommand({ ...join(), type: "audio_frame" }), "unknown_type", "/type");
  rejected(validator.acceptCommand({ ...join(), extra: true }), "unknown_field", "/extra");
  rejected(validator.acceptCommand({ ...join(), commandId: "" }), "field_type", "/commandId");
  assert.equal(validator.acceptEvent(snapshot(1)).ok, true);
});

test("v2 connect_media requires exactly the timed media lease shape", () => {
  const validator = createBridgeSessionValidatorV2(sessionId);
  const media = (mediaLease: unknown, commandId = "m") => ({ schema: "bridge-session/v2", sessionId, commandId, type: "connect_media", mediaLease });
  rejected(validator.acceptCommand({ schema: "bridge-session/v2", sessionId, commandId: "v1", type: "connect_media", endpoint: "wss://x", sessionToken: "t", format: "pcm_s16le/24000/1/20ms", expiresAt: "2026-09-02T14:01:00.000Z" }), "missing_field", "/mediaLease");
  rejected(validator.acceptCommand({ ...media(lease), endpoint: "wss://x" }), "media_lease", "/mediaLease");
  rejected(validator.acceptCommand(media(null)), "media_lease", "/mediaLease");
  rejected(validator.acceptCommand(media({ ...lease, extra: 1 })), "media_lease", "/mediaLease");
  rejected(validator.acceptCommand(media({ ...lease, bridgeSessionId: "other" })), "media_lease", "/mediaLease");
  rejected(validator.acceptCommand(media({ ...lease, mediaProtocolVersion: 1 })), "media_lease", "/mediaLease");
  rejected(validator.acceptCommand(media({ ...lease, captureFormat: "opus/48000/2" })), "media_lease", "/mediaLease");
  rejected(validator.acceptCommand(media({ ...lease, timingContract: "capture-clock/v2" })), "media_lease", "/mediaLease");
  rejected(validator.acceptCommand(media({ ...lease, sessionId: 7 })), "media_lease", "/mediaLease");
  rejected(validator.acceptCommand(media({ ...lease, sessionId: "0" })), "media_lease", "/mediaLease");
  rejected(validator.acceptCommand(media({ ...lease, expiresAtMs: "18446744073709551616" })), "media_lease", "/mediaLease");
  rejected(validator.acceptCommand(media({ ...lease, credential: "x".repeat(129) })), "media_lease", "/mediaLease");
  rejected(validator.acceptCommand(media({ ...lease, credential: "bad credential" })), "media_lease", "/mediaLease");
  rejected(validator.acceptCommand(media({ ...lease, connectEndpoint: "" })), "media_lease", "/mediaLease");
  const missingLease: Record<string, unknown> = media(lease); delete missingLease.mediaLease;
  rejected(validator.acceptCommand(missingLease), "missing_field", "/mediaLease");
  assert.equal(validator.acceptCommand(media(lease, "ok")).ok, true);
  // Every rejected connect_media left its command id unissued.
  rejected(validator.acceptEvent(event(1, { type: "command_result", commandId: "m", outcome: "ok", detail: null })), "unknown_command_id", "/commandId");
  assert.equal(validator.acceptEvent(event(1, { type: "command_result", commandId: "ok", outcome: "failed", detail: "no media" })).ok, true);
});

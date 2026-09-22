import type { BridgeCommand, BridgeEvent, BridgeRejectionCode } from "./bridge-session-v1.ts";
import { parseCommandShape, parseEventShape } from "./bridge-session-v1.ts";

export const BRIDGE_SESSION_SCHEMA_V2 = "bridge-session/v2";
export type TimedMediaLease = {
  sessionId: string; bridgeSessionId: string; connectEndpoint: string; credential: string;
  expiresAtMs: string; reconnectWindowMs: string;
  /** 2 or 3 only (D029 §3). Media v3 -- the drainable timed capture -- is an
   * explicit server declaration carried through unchanged; there is no
   * negotiation here and no fallback between the two. */
  mediaProtocolVersion: 2 | 3;
  captureFormat: "pcm_s16le/24000/1/20ms"; timingContract: "capture-clock/v1";
};
export type ObservationTiming = { clockDomainId: string; hostBeforeNs: string; hostAfterNs: string };
export type UiSnapshot = {
  type: "ui_snapshot"; snapshotSequence: number; observationTiming: ObservationTiming | null;
  state: "ui_exact" | "ambiguous" | "unknown" | "unreadable"; feishuUserId: string | null;
  reason: null | "no_highlight" | "identity_unavailable" | "grid_unavailable" | "snapshot_unreadable" | "timing_unavailable";
  barrierBefore: null | "stream_start" | "observation_drop" | "poll_gap" | "clock_reset";
};
export type BridgeCommandV2 = Exclude<BridgeCommand, { type: "connect_media" }> | { type: "connect_media"; mediaLease: TimedMediaLease };
type UiEvent = Extract<BridgeEvent, { type: "joined" | "left" | "participant_joined" | "participant_left" | "active_speaker" }>;
export type BridgeEventV2 = Exclude<BridgeEvent, UiEvent> | (UiEvent & { observationTiming: ObservationTiming | null; observationTimingReason: "timing_unavailable" | null }) | UiSnapshot;
export type BridgeCommandMessageV2 = { schema: typeof BRIDGE_SESSION_SCHEMA_V2; sessionId: string; commandId: string } & BridgeCommandV2;
export type BridgeEventMessageV2 = { schema: typeof BRIDGE_SESSION_SCHEMA_V2; sessionId: string; sequence: number; observedAt: string } & BridgeEventV2;

const uiTypes = new Set(["joined", "left", "participant_joined", "participant_left", "active_speaker"]);
function fail(): never { throw new Error("invalid_bridge_v2"); }
function object(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return fail();
  return input as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
}
function text(value: unknown, bound = 65536): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= bound;
}
function uint(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 20) return fail();
  const number = BigInt(value);
  if (number > 18446744073709551615n) return fail();
  return number;
}
function identifier(value: unknown): value is string {
  return text(value, 64) && !/[\p{Cc}\p{Cf}]/u.test(value);
}
function timing(input: unknown): void {
  const value = object(input);
  exact(value, ["clockDomainId", "hostBeforeNs", "hostAfterNs"]);
  if (!identifier(value.clockDomainId)) fail();
  const before = uint(value.hostBeforeNs), after = uint(value.hostAfterNs);
  if (after < before || after - before > 2_000_000_000n) fail();
}
function envelope(input: unknown, cap: number): Record<string, unknown> {
  const value = object(input);
  if (value.schema !== BRIDGE_SESSION_SCHEMA_V2 || !text(value.sessionId) || Buffer.byteLength(JSON.stringify(value)) > cap) fail();
  return value;
}
export function parseCommandV2(input: unknown): BridgeCommandMessageV2 {
  const value = envelope(input, 65536);
  if (value.type !== "connect_media") {
    if (!parseCommandShape({ ...value, schema: "bridge-session/v1" }).ok) fail();
  } else {
    exact(value, ["schema", "sessionId", "commandId", "type", "mediaLease"]);
    const lease = object(value.mediaLease);
    exact(lease, ["sessionId", "bridgeSessionId", "connectEndpoint", "credential", "expiresAtMs", "reconnectWindowMs", "mediaProtocolVersion", "captureFormat", "timingContract"]);
    if (!text(value.commandId) || !identifier(lease.bridgeSessionId) || lease.bridgeSessionId !== value.sessionId || !text(lease.connectEndpoint, 2048)
        || !text(lease.credential, 128) || /[\p{Cc}\p{Cf}]/u.test(lease.credential) || (lease.mediaProtocolVersion !== 2 && lease.mediaProtocolVersion !== 3)
        || lease.captureFormat !== "pcm_s16le/24000/1/20ms" || lease.timingContract !== "capture-clock/v1"
        || uint(lease.sessionId) === 0n || uint(lease.expiresAtMs) === 0n || uint(lease.reconnectWindowMs) === 0n) fail();
  }
  return input as BridgeCommandMessageV2;
}
export function parseEventV2(input: unknown): BridgeEventMessageV2 {
  const value = envelope(input, 4096);
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) fail();
  if (value.type === "ui_snapshot") {
    exact(value, ["schema", "sessionId", "sequence", "observedAt", "type", "snapshotSequence", "observationTiming", "state", "feishuUserId", "reason", "barrierBefore"]);
    if (!Number.isSafeInteger(value.snapshotSequence) || (value.snapshotSequence as number) < 1
        || ![null, "stream_start", "observation_drop", "poll_gap", "clock_reset"].includes(value.barrierBefore as string | null)) fail();
    if (!parseEventShape({ schema: "bridge-session/v1", sessionId: value.sessionId, sequence: value.sequence, observedAt: value.observedAt, type: "media_disconnected", reason: "validation" }).ok) fail();
    if (value.observationTiming === null) {
      if (value.state !== "unreadable" || value.reason !== "timing_unavailable") fail();
    } else { timing(value.observationTiming); if (value.reason === "timing_unavailable") fail(); }
    switch (value.state) {
      case "ui_exact": if (!text(value.feishuUserId, 1024) || value.reason !== null) fail(); break;
      case "ambiguous": if (value.feishuUserId !== null || ![null, "identity_unavailable"].includes(value.reason as string | null)) fail(); break;
      case "unknown": if (value.feishuUserId !== null || !["no_highlight", "identity_unavailable"].includes(value.reason as string)) fail(); break;
      case "unreadable": if (value.feishuUserId !== null || !["grid_unavailable", "snapshot_unreadable", "timing_unavailable"].includes(value.reason as string)) fail(); break;
      default: fail();
    }
  } else if (uiTypes.has(value.type as string)) {
    const { observationTiming, observationTimingReason, ...legacy } = value;
    if (!Object.hasOwn(value, "observationTiming") || !Object.hasOwn(value, "observationTimingReason")) fail();
    if (observationTiming === null) { if (observationTimingReason !== "timing_unavailable") fail(); }
    else { timing(observationTiming); if (observationTimingReason !== null) fail(); }
    if (!parseEventShape({ ...legacy, schema: "bridge-session/v1" }).ok) fail();
  } else if (!parseEventShape({ ...value, schema: "bridge-session/v1" }).ok) fail();
  return input as BridgeEventMessageV2;
}

/**
 * Session-scoped bridge-session/v2 stream validator: the v1 fences (exact
 * schema literal, session id, issued command ids, strictly increasing event
 * sequence, closed shapes) over the v2 grammar, returning the v1-style result
 * so a transport can classify on `code` rather than on a thrown string.
 * Beyond v1 it also rejects a command id issued twice and the v2 line bounds
 * (65536-byte commands, 4096-byte events), which parseCommandV2/parseEventV2
 * already enforce.
 */
export type BridgeRejectionCodeV2 = BridgeRejectionCode | "message_too_large" | "media_lease" | "v2_payload" | "command_id_duplicate";
export type BridgeRejectionV2 = { code: BridgeRejectionCodeV2; path: string; detail: string };
export type BridgeResultV2<T> = { ok: true; value: T } | { ok: false; rejection: BridgeRejectionV2 };
export interface BridgeSessionValidatorV2 {
  readonly sessionId: string;
  acceptCommand(input: unknown): BridgeResultV2<BridgeCommandMessageV2>;
  acceptEvent(input: unknown): BridgeResultV2<BridgeEventMessageV2>;
}

function rejectV2(code: BridgeRejectionCodeV2, path: string, detail: string): { ok: false; rejection: BridgeRejectionV2 } {
  return { ok: false, rejection: { code, path, detail } };
}
function envelopeRejection(input: unknown, cap: number): BridgeRejectionV2 | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { code: "not_an_object", path: "", detail: "expected a JSON object" };
  const value = input as Record<string, unknown>;
  if (!Object.hasOwn(value, "schema")) return { code: "missing_field", path: "/schema", detail: "schema is required" };
  if (value.schema !== BRIDGE_SESSION_SCHEMA_V2) return { code: "schema_unknown", path: "/schema", detail: `expected ${BRIDGE_SESSION_SCHEMA_V2}` };
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(value)); } catch { return { code: "not_an_object", path: "", detail: "expected a JSON-serialisable object" }; }
  if (bytes > cap) return { code: "message_too_large", path: "", detail: `expected at most ${cap} bytes` };
  return null;
}
/** Explains a parseCommandV2 failure with the v1 rejection where the v1 grammar applies. */
function commandRejection(value: Record<string, unknown>): BridgeRejectionV2 {
  if (value.type === "connect_media") {
    if (!Object.hasOwn(value, "mediaLease")) return { code: "missing_field", path: "/mediaLease", detail: "mediaLease is required" };
    return { code: "media_lease", path: "/mediaLease", detail: "connect_media carries exactly schema, sessionId, commandId, type and a timed media lease" };
  }
  const legacy = parseCommandShape({ ...value, schema: "bridge-session/v1" });
  return legacy.ok ? { code: "v2_payload", path: "", detail: "command violates bridge-session/v2" } : legacy.rejection;
}
/** Explains a parseEventV2 failure with the v1 rejection where the v1 grammar applies. */
function eventRejection(value: Record<string, unknown>): BridgeRejectionV2 {
  if (value.type === "ui_snapshot") {
    const legacy = parseEventShape({ schema: "bridge-session/v1", sessionId: value.sessionId, sequence: value.sequence, observedAt: value.observedAt, type: "media_disconnected", reason: "validation" });
    return legacy.ok ? { code: "v2_payload", path: "", detail: "ui_snapshot violates bridge-session/v2" } : legacy.rejection;
  }
  const legacyFields: Record<string, unknown> = { ...value, schema: "bridge-session/v1" };
  if (uiTypes.has(value.type as string)) {
    delete legacyFields.observationTiming; delete legacyFields.observationTimingReason;
    const legacy = parseEventShape(legacyFields);
    return legacy.ok
      ? { code: "v2_payload", path: "/observationTiming", detail: "ui-derived events carry observationTiming or an explicit timing_unavailable reason" }
      : legacy.rejection;
  }
  const legacy = parseEventShape(legacyFields);
  return legacy.ok ? { code: "v2_payload", path: "", detail: "event violates bridge-session/v2" } : legacy.rejection;
}

export function createBridgeSessionValidatorV2(sessionId: string): BridgeSessionValidatorV2 {
  const issued = new Set<string>();
  let lastSequence = 0;
  return {
    sessionId,
    acceptCommand(input) {
      const envelopeFailure = envelopeRejection(input, 65536);
      if (envelopeFailure !== null) return { ok: false, rejection: envelopeFailure };
      let message: BridgeCommandMessageV2;
      try { message = parseCommandV2(input); } catch { return { ok: false, rejection: commandRejection(input as Record<string, unknown>) }; }
      if (message.sessionId !== sessionId) return rejectV2("session_mismatch", "/sessionId", `expected session ${sessionId}`);
      if (issued.has(message.commandId)) return rejectV2("command_id_duplicate", "/commandId", `command ${message.commandId} was already issued in this session`);
      issued.add(message.commandId);
      return { ok: true, value: message };
    },
    acceptEvent(input) {
      const envelopeFailure = envelopeRejection(input, 4096);
      if (envelopeFailure !== null) return { ok: false, rejection: envelopeFailure };
      let event: BridgeEventMessageV2;
      try { event = parseEventV2(input); } catch { return { ok: false, rejection: eventRejection(input as Record<string, unknown>) }; }
      if (event.sessionId !== sessionId) return rejectV2("session_mismatch", "/sessionId", `expected session ${sessionId}`);
      if (event.sequence === lastSequence) return rejectV2("sequence_duplicate", "/sequence", `sequence ${event.sequence} was already observed`);
      if (event.sequence < lastSequence) return rejectV2("sequence_out_of_order", "/sequence", `sequence ${event.sequence} is behind ${lastSequence}`);
      if (event.type === "command_result" && !issued.has(event.commandId)) return rejectV2("unknown_command_id", "/commandId", `no command ${event.commandId} was issued in this session`);
      lastSequence = event.sequence;
      return { ok: true, value: event };
    },
  };
}

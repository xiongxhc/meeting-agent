import type { BridgeCommand, BridgeEvent } from "./bridge-session-v1.ts";
import { parseCommandShape, parseEventShape } from "./bridge-session-v1.ts";

export const BRIDGE_SESSION_SCHEMA_V2 = "bridge-session/v2";
export type TimedMediaLease = {
  sessionId: string; bridgeSessionId: string; connectEndpoint: string; credential: string;
  expiresAtMs: string; reconnectWindowMs: string; mediaProtocolVersion: 2;
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
        || !text(lease.credential, 128) || /[\p{Cc}\p{Cf}]/u.test(lease.credential) || lease.mediaProtocolVersion !== 2
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

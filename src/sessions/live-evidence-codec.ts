// Private storage only. The actual SDK remains the sole Runtime wire parser.
import type { CaptureUnavailableReason, SourceSampleRange, VersionFourVoiceTranscriptFinalEvent, WholeFrameNominalEnvelope } from "@conversation/runtime";
import type { ProvisionalResult } from "../ports/session-store.ts";

const reasons: readonly CaptureUnavailableReason[] = ["provider_offsets_unavailable", "provider_offsets_out_of_range", "capture_boundary_evicted", "capture_timing_missing", "capture_timing_inconsistent", "capture_epoch_changed", "capture_not_contiguous", "capture_evidence_limit"];
const anonymousReasons: readonly Extract<ProvisionalResult, { kind: "anonymous" }>["reason"][] = ["coverage_missing", "timing_unavailable", "coverage_barrier", "identity_ambiguous", "activation_not_fresh", "attendance_missing", "catchup_timeout", "pending_limit", "observation_limit", "generation_changed", "owner_closed", "owner_restarted", "evidence_expired", "ui_storage_loss"];
const MAX_U64 = (1n << 64n) - 1n;
function invalid(): never { throw new Error("invalid private live evidence"); }
function object(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  if (keys.some((key) => !(key in row)) || Object.keys(row).some((key) => !keys.includes(key) && !optional.includes(key))) return invalid();
  return row;
}
function u64(value: unknown): bigint { if (typeof value !== "bigint" || value < 0n || value > MAX_U64) return invalid(); return value; }
function string(value: unknown, max: number): string { if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > max) return invalid(); return value; }
function identifier(value: unknown): string { const id = string(value, 20); if (!/^[1-9][0-9]*$/.test(id) || BigInt(id) > MAX_U64) return invalid(); return id; }
function capture(value: unknown): SourceSampleRange {
  const o = object(value, ["kind", "clockDomainId", "captureEpoch", "firstFrameSequence", "lastFrameSequence", "sourceStartSample", "sourceEndSample", "sampleRateHz"]);
  if (o.kind !== "source_sample_range/v1" || o.sampleRateHz !== 24000 || /[\p{Cc}\p{Cf}]/u.test(string(o.clockDomainId, 64))) return invalid();
  for (const key of ["captureEpoch", "firstFrameSequence", "lastFrameSequence", "sourceStartSample", "sourceEndSample"]) u64(o[key]);
  if ((o.firstFrameSequence as bigint) > (o.lastFrameSequence as bigint) || (o.sourceStartSample as bigint) >= (o.sourceEndSample as bigint)) return invalid();
  return o as SourceSampleRange;
}
function envelope(value: unknown): WholeFrameNominalEnvelope {
  const o = object(value, ["kind", "hostStartNs", "hostEndNs", "firstFrameHostEndNs", "mappingQuality", "captureUncertaintyNs", "knownRoundingAllowanceNs"]);
  if (o.kind !== "whole_touched_frame_nominal_host_envelope/v1" || o.mappingQuality !== "nominal_frame_endpoint_interpolation") return invalid();
  const start = u64(o.hostStartNs), end = u64(o.hostEndNs), first = u64(o.firstFrameHostEndNs);
  if (start >= end || first <= start || first > end) return invalid();
  u64(o.knownRoundingAllowanceNs); if (o.captureUncertaintyNs !== null) u64(o.captureUncertaintyNs);
  return o as WholeFrameNominalEnvelope;
}
function stringify(value: unknown): string {
  const result = JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? { u64: u64(item).toString() } : item);
  if (Buffer.byteLength(result) > 4096) return invalid();
  return result;
}
function parse(payload: string): unknown {
  if (Buffer.byteLength(payload) > 4096) return invalid();
  try { return JSON.parse(payload, (_key, value: unknown) => {
    if (typeof value === "object" && value !== null && "u64" in value) {
      const o = object(value, ["u64"]);
      if (typeof o.u64 !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(o.u64)) return invalid();
      return u64(BigInt(o.u64));
    }
    return value;
  }) as unknown; } catch { return invalid(); }
}
export function encodeLiveEvidence(event: VersionFourVoiceTranscriptFinalEvent): string {
  const base = { schema: 1, sessionId: u64(event.sessionId), segmentId: identifier(event.segmentId), turnId: event.turnId === null ? null : u64(event.turnId) };
  if (base.sessionId === 0n) return invalid();
  let source: SourceSampleRange | undefined;
  try {
    source = event.capture === undefined ? undefined : capture(event.capture);
    const coverage = event.liveCoverage === undefined ? undefined : envelope(event.liveCoverage);
    if (coverage && !source) return invalid();
    const reason = event.captureUnavailableReason;
    if (reason !== undefined && !reasons.includes(reason)) return invalid();
    return stringify({ ...base, ...(source ? { capture: source } : {}), ...(coverage ? { liveCoverage: coverage } : {}),
      ...(!coverage ? { captureUnavailableReason: reason ?? "capture_timing_missing" } : {}) });
  } catch {
    // A bad timing coordinate never removes otherwise-admissible wording.
    return stringify({ ...base, ...(source ? { capture: source } : {}), captureUnavailableReason: "capture_timing_inconsistent" });
  }
}
export function decodeLiveEvidence(payload: string, text: string): VersionFourVoiceTranscriptFinalEvent {
  const o = object(parse(payload), ["schema", "sessionId", "segmentId", "turnId"], ["capture", "liveCoverage", "captureUnavailableReason"]);
  if (o.schema !== 1 || u64(o.sessionId) === 0n || (o.turnId !== null && u64(o.turnId) === 0n)) return invalid();
  identifier(o.segmentId);
  if (o.capture !== undefined) capture(o.capture);
  if (o.liveCoverage !== undefined) { envelope(o.liveCoverage); if (o.capture === undefined || o.captureUnavailableReason !== undefined) return invalid(); }
  else if (!reasons.includes(o.captureUnavailableReason as CaptureUnavailableReason)) return invalid();
  const fields = { ...o }; delete fields.schema;
  return { type: "voice_transcript_final", ...fields, text: string(text, 16384) } as VersionFourVoiceTranscriptFinalEvent;
}
export function encodeProvisionalResult(value: ProvisionalResult): string {
  const o = object(value, value.kind === "anonymous" ? ["kind", "reason"] : ["kind", "feishuUserId"]);
  if (o.kind === "anonymous") { if (!anonymousReasons.includes(o.reason as typeof anonymousReasons[number])) return invalid(); }
  else if (o.kind === "provisional_ui_observed") string(o.feishuUserId, 1024);
  else return invalid();
  return stringify(o);
}
export function decodeProvisionalResult(payload: string): ProvisionalResult {
  const value = parse(payload) as ProvisionalResult;
  encodeProvisionalResult(value);
  return value;
}

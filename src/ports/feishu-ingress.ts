import { createHash } from "node:crypto";
import { makeOccurrenceId, type OccurrenceId } from "../domain/occurrence-id.ts";
import type { OrganizerResolution, ResolvedInviteOrganizer } from "./feishu.ts";

export type FeishuScope = { readonly region: "feishu" | "lark"; readonly tenantKey: string; readonly appId: string };
export type NormalizedInvite = FeishuScope & {
  readonly eventId: string; readonly createTime: string; readonly providerMeetingId: string;
  readonly meetingNo: string; readonly title: string; readonly startSeconds: string;
  readonly endSeconds: string | null; readonly inviteSeconds: string; readonly callId: string;
  readonly occurrenceId: OccurrenceId; readonly occurrenceStartedAt: string;
  readonly normalizedJson: string; readonly normalizedSha256: string; readonly normalizedBytes: number;
};
export type InviteOccurrence = FeishuScope & {
  readonly occurrenceId: OccurrenceId; readonly providerMeetingId: string; readonly meetingNo: string;
  readonly occurrenceStartedAt: string; readonly title: string;
  readonly state: "pending_metadata" | "metadata_blocked" | "admitted" | "existing_session";
  readonly acceptedAtMs: number; readonly lastObservedAtMs: number;
  readonly firstAttemptAtMs: number | null; readonly lastAttemptAtMs: number | null;
  readonly generationStartedAtMs: number | null; readonly nextAttemptAtMs: number;
  readonly totalAttempts: number; readonly generationAttempts: number; readonly retryGeneration: number;
  readonly operatorRetryCount: number; readonly lastOperator: string | null; readonly lastOperatorRetryAtMs: number | null;
  readonly lastBlockedReason: string | null; readonly lastBlockedAtMs: number | null;
  readonly claimToken: string | null; readonly claimExpiresAtMs: number | null;
  readonly organizer: ResolvedInviteOrganizer | null;
  readonly reference: Extract<OrganizerResolution, { status: "resolved" }>["reference"] | null;
  readonly admittedAtMs: number | null;
};
export type InviteClaim = InviteOccurrence & { readonly claimToken: string; readonly claimExpiresAtMs: number };
export const INVITE_EVENT = "vc.bot.meeting_invited_v1";
export function boundedInviteString(value: unknown, max = 1024): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > max ||
      [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error("invalid_invite");
  return value;
}
export function validateFeishuScope(scope: FeishuScope): void {
  if (!["feishu", "lark"].includes(scope.region)) throw new Error("invalid_invite_scope");
  boundedInviteString(scope.tenantKey); boundedInviteString(scope.appId);
  if (!/^cli_[0-9a-fA-F]{16}$/.test(scope.appId)) throw new Error("invalid_invite_scope");
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_invite");
  return value as Record<string, unknown>;
}
function decimal(value: unknown): string {
  if (typeof value !== "string" || value.length > 20 || !/^[0-9]+$/.test(value)) throw new Error("invalid_invite");
  return value;
}
export function inviteSecondsToUtc(value: unknown): string {
  const seconds = BigInt(decimal(value));
  if (seconds > 253402300799n) throw new Error("invalid_invite");
  return new Date(Number(seconds * 1000n)).toISOString().replace(".000Z", "Z");
}
export function normalizeInvite(raw: unknown, scope: FeishuScope): NormalizedInvite {
  validateFeishuScope(scope);
  const outer = object(raw), header = object(outer.header), event = object(outer.event), meeting = object(event.meeting);
  if (outer.schema !== "2.0" || header.event_type !== INVITE_EVENT || header.app_id !== scope.appId || header.tenant_key !== scope.tenantKey ||
      Object.keys(event).some((key) => key in header || ["schema", "header", "event"].includes(key)) ||
      Object.keys(outer).some((key) => !["schema", "header", "event"].includes(key))) throw new Error("invalid_invite");
  const eventId = boundedInviteString(header.event_id), createTime = decimal(header.create_time);
  const providerMeetingId = boundedInviteString(meeting.id), meetingNo = boundedInviteString(meeting.meeting_no);
  if (!/^[0-9]{9}$/.test(meetingNo)) throw new Error("invalid_invite");
  const title = boundedInviteString(meeting.topic, 4096), startSeconds = decimal(meeting.start_time);
  const occurrenceStartedAt = inviteSecondsToUtc(startSeconds), occurrenceId = makeOccurrenceId(providerMeetingId, occurrenceStartedAt);
  const endSeconds = meeting.end_time == null ? null : decimal(meeting.end_time);
  if (endSeconds !== null) inviteSecondsToUtc(endSeconds);
  const inviteSeconds = decimal(event.invite_time); inviteSecondsToUtc(inviteSeconds);
  const callId = boundedInviteString(event.call_id);
  const normalizedJson = JSON.stringify(["feishu-invite/v1", scope.region, scope.tenantKey, scope.appId, "2.0", INVITE_EVENT,
    eventId, createTime, providerMeetingId, meetingNo, title, startSeconds, endSeconds, inviteSeconds, callId]);
  const normalizedBytes = Buffer.byteLength(normalizedJson, "utf8");
  if (normalizedBytes > 65536) throw new Error("invalid_invite");
  return { region: scope.region, tenantKey: scope.tenantKey, appId: scope.appId, eventId, createTime, providerMeetingId, meetingNo, title, startSeconds, endSeconds, inviteSeconds, callId,
    occurrenceId, occurrenceStartedAt, normalizedJson, normalizedBytes, normalizedSha256: createHash("sha256").update(normalizedJson).digest("hex") };
}
/** Revalidate the store boundary, including caller-supplied hash/derived identity. */
export function validateNormalizedInvite(value: NormalizedInvite): void {
  const decoded = normalizeInvite({ schema: "2.0", header: { event_id: value.eventId, event_type: INVITE_EVENT, app_id: value.appId,
    tenant_key: value.tenantKey, create_time: value.createTime }, event: { meeting: { id: value.providerMeetingId,
    meeting_no: value.meetingNo, topic: value.title, start_time: value.startSeconds, end_time: value.endSeconds },
    invite_time: value.inviteSeconds, call_id: value.callId } }, value);
  for (const key of ["normalizedJson", "normalizedSha256", "normalizedBytes", "occurrenceId", "occurrenceStartedAt"] as const) {
    if (value[key] !== decoded[key]) throw new Error("invalid_invite");
  }
}

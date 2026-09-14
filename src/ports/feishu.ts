import type { FeishuScope, InviteOccurrence } from "./feishu-ingress.ts";

/** Joining code selects a configured candidate, never an API lookup or binding proof. */
export type OrganizerReference =
  | { readonly kind: "reservation"; readonly reserveId: string }
  | { readonly kind: "calendar_event"; readonly calendarId: string; readonly eventId: string;
      readonly occurrenceId: string; readonly providerMeetingId: string; readonly occurrenceStartedAt: string;
      readonly vcOrganizerOpenId?: string };
export type OrganizerReferenceEntry = FeishuScope & { readonly meetingNo: string; readonly reference: OrganizerReference };
/** Reject unowned payload instead of persisting arbitrary caller fields. */
export function validateOrganizerReferenceKeys(reference: OrganizerReference): void {
  const keys = reference.kind === "reservation" ? ["kind","reserveId"] : reference.kind === "calendar_event"
    ? ["kind","calendarId","eventId","occurrenceId","providerMeetingId","occurrenceStartedAt","vcOrganizerOpenId"] : [];
  if (keys.length === 0 || Object.keys(reference).some((key)=>!keys.includes(key))) throw new Error("invalid_invite_reference");
}
export type ResolvedInviteOrganizer = FeishuScope & {
  readonly idType: "open_id"; readonly id: string; readonly displayName: string;
  readonly source: "reservation" | "calendar_event";
};
export type MetadataBlockedReason = "reference_missing" | "permission_denied" | "identity_invalid" | "display_missing" |
  "reference_invalid" | "occurrence_mismatch" | "inactive_meeting" | "metadata_unavailable" | "timeout" | "cancelled" |
  "retry_exhausted" | "clock_regression" | "counter_exhausted";
export type OrganizerResolution =
  | { readonly status: "resolved"; readonly organizer: ResolvedInviteOrganizer; readonly reference: OrganizerReference }
  | { readonly status: "blocked"; readonly reason: MetadataBlockedReason; readonly retryable: boolean };
export type FeishuOrganizerLookup = {
  resolve(invite: InviteOccurrence, signal: AbortSignal): Promise<OrganizerResolution>;
};

// Accepted notification sender contract is unchanged.
export type FeishuSendTextInput = {
  readonly receiveId: string;
  readonly text: string;
  readonly uuid: string;
  readonly timeoutMs: number;
};
export type FeishuMessageSender = {
  sendText(input: FeishuSendTextInput): Promise<{ readonly messageId: string }>;
};

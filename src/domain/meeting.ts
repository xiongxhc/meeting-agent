// Meeting identity: the occurrence plus the fields TeamMem's meeting.json
// needs at the top of the artifact (title, provider meeting id, meeting
// number, organizer). Attendance lives in ./participants.ts; occurrence-id
// mechanics live in ./occurrence-id.ts.

import { makeOccurrenceId, type OccurrenceId } from "./occurrence-id.ts";

/**
 * Where the organizer was resolved from. Matches TeamMem's
 * `organizer_source`: `reservation` (Feishu reservation's reserve_user_id),
 * `calendar_event` (the calendar event's organizer) or `meeting_list`
 * (Feishu's meeting list organizer for this exact occurrence) -- never
 * `host_user`, never inferred from attendees.
 */
export type OrganizerSource = "reservation" | "calendar_event" | "meeting_list";

/** Why a meeting has no organizer: `instant_meeting` only when Feishu reported this
 * exact occurrence with no organizer; every other null is `organizer_unresolved`. */
export type OrganizerUnresolvedReason = "instant_meeting" | "organizer_unresolved";

export type Organizer = {
  readonly feishuUserId: string;
  readonly displayName: string;
  readonly source: OrganizerSource;
};

export type MeetingIdentity = {
  readonly occurrenceId: OccurrenceId;
  readonly providerMeetingId: string;
  readonly meetingNo: string;
  readonly occurrenceStartedAt: string;
  readonly title: string;
  /** null when no organizer is known -- the organizer notification then
   * fails closed rather than guessing a recipient. */
  readonly organizer: Organizer | null;
  /** With a null organizer, why; absent means `organizer_unresolved`. */
  readonly organizerUnresolvedReason?: OrganizerUnresolvedReason;
};

export type BuildMeetingIdentityInput = {
  readonly providerMeetingId: string;
  readonly meetingNo: string;
  readonly occurrenceStartedAt: string;
  readonly title: string;
  readonly organizer: Organizer | null;
  readonly organizerUnresolvedReason?: OrganizerUnresolvedReason;
};

/**
 * Builds a MeetingIdentity, deriving occurrenceId from providerMeetingId and
 * occurrenceStartedAt so the two can never disagree (the schema requires
 * started_at to equal the occurrence_id start exactly).
 */
export function buildMeetingIdentity(input: BuildMeetingIdentityInput): MeetingIdentity {
  const occurrenceId = makeOccurrenceId(input.providerMeetingId, input.occurrenceStartedAt);
  return {
    occurrenceId,
    providerMeetingId: input.providerMeetingId,
    meetingNo: input.meetingNo,
    occurrenceStartedAt: input.occurrenceStartedAt,
    title: input.title,
    organizer: input.organizer,
    ...(input.organizer === null && input.organizerUnresolvedReason !== undefined ? { organizerUnresolvedReason: input.organizerUnresolvedReason } : {}),
  };
}

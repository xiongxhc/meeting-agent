// Organizer resolution: a PORT. This defines the interface Task 10's real
// Feishu HTTP adapter must implement, plus the resolution logic that sits
// above it. No HTTP client lives here.
//
// The organizer is the meeting's CREATOR: the reservation's reserve_user_id
// (looked up by meeting number), or -- for calendar-created meetings with no
// reservation -- the calendar event's organizer. It is NEVER host_user,
// participants[].is_host, is_cohost, the person who invited the agent, an
// attendee, or company rank. An instant meeting has no reservation and no
// calendar event, so it resolves to null; the caller then records
// organizer_unresolved_reason: "instant_meeting" and the notification fails
// closed instead of guessing a recipient.

import type { OrganizerSource } from "../domain/meeting.ts";

/** A Feishu host reference, as it appears on raw meeting/reservation/
 * calendar-event payloads. Present on the record types below purely so a
 * structural test can prove the resolver never reads it -- organizer
 * resolution has no legitimate use for it. */
export type FeishuHostUser = {
  readonly id: string;
};

/**
 * The reservation record looked up by meeting number. `reserveUserId` is the
 * meeting's creator per Feishu's reservation API; `hostUser` is present (the
 * real API returns it alongside reserve_user_id) but is never read here.
 */
export type FeishuReservationRecord = {
  readonly meetingNo: string;
  readonly reserveUserId: string;
  readonly reserveUserDisplayName: string;
  readonly hostUser?: FeishuHostUser;
};

/**
 * The calendar event record for a calendar-created meeting with no
 * reservation. `organizerId`/`organizerDisplayName` are the event creator;
 * `hostUser` is never read here.
 */
export type FeishuCalendarEventRecord = {
  readonly meetingNo: string;
  readonly organizerId: string;
  readonly organizerDisplayName: string;
  readonly hostUser?: FeishuHostUser;
};

/**
 * Everything organizer resolution may look up, keyed by meeting number. Task
 * 10 implements this against the real Feishu HTTP API; this module only
 * consumes it.
 */
export type FeishuOrganizerLookup = {
  findReservation(meetingNo: string): Promise<FeishuReservationRecord | null>;
  findCalendarEvent(meetingNo: string): Promise<FeishuCalendarEventRecord | null>;
};

export type ResolvedOrganizer = {
  readonly feishuUserId: string;
  readonly displayName: string;
  readonly source: OrganizerSource;
};

/**
 * Resolves the organizer for a meeting number: the reservation's creator if
 * a reservation exists, else the calendar event's organizer, else null (an
 * instant meeting has neither). Reads only reserveUserId/
 * reserveUserDisplayName or organizerId/organizerDisplayName -- never
 * hostUser, never is_host/is_cohost, never an inviter, never an attendee.
 */
export async function resolveOrganizer(
  meetingNo: string,
  lookup: FeishuOrganizerLookup,
): Promise<ResolvedOrganizer | null> {
  const reservation = await lookup.findReservation(meetingNo);
  if (reservation !== null) {
    return {
      feishuUserId: reservation.reserveUserId,
      displayName: reservation.reserveUserDisplayName,
      source: "reservation",
    };
  }

  const calendarEvent = await lookup.findCalendarEvent(meetingNo);
  if (calendarEvent !== null) {
    return {
      feishuUserId: calendarEvent.organizerId,
      displayName: calendarEvent.organizerDisplayName,
      source: "calendar_event",
    };
  }

  return null;
}

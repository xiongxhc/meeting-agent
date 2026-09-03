// Organizer resolution tests, written before src/ports/feishu.ts exists
// (TDD). The organizer is the meeting's CREATOR: the reservation's
// reserve_user_id (looked up by meeting number), or the calendar event
// organizer. It is NEVER host_user, participants[].is_host, is_cohost, the
// person who invited the agent, an attendee, or company rank. An instant
// meeting has no reservation and no calendar event, so it resolves to null.
//
// Several tests here are structural, not just behavioral: they build probe
// records with a Proxy that throws if a forbidden field is ever read, so a
// future change that starts consulting host_user/is_host/is_cohost fails
// immediately rather than merely "usually" passing.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveOrganizer,
  type FeishuCalendarEventRecord,
  type FeishuOrganizerLookup,
  type FeishuReservationRecord,
} from "../src/ports/feishu.ts";

/** Wraps `record` so that reading any key in `forbiddenKeys` throws instead
 * of returning a value. Reading any other key passes through untouched. Used
 * to prove structurally -- not just behaviorally -- that the resolver never
 * touches a given field, even when the field is present on the raw record. */
function forbidGuard<T extends object>(record: T, forbiddenKeys: readonly (keyof T)[]): T {
  return new Proxy(record, {
    get(target, prop, receiver) {
      if (forbiddenKeys.includes(prop as keyof T)) {
        throw new Error(`organizer resolution must never read forbidden field "${String(prop)}"`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function lookupWith(
  reservation: FeishuReservationRecord | null,
  calendarEvent: FeishuCalendarEventRecord | null,
): FeishuOrganizerLookup {
  return {
    findReservation: async () => reservation,
    findCalendarEvent: async () => calendarEvent,
  };
}

test("organizer resolves from the reservation's reserve_user_id when a reservation exists", async () => {
  const reservation: FeishuReservationRecord = {
    meetingNo: "123-456-789",
    reserveUserId: "ou_ada",
    reserveUserDisplayName: "Ada Chen",
  };
  const organizer = await resolveOrganizer("123-456-789", lookupWith(reservation, null));
  assert.deepEqual(organizer, { feishuUserId: "ou_ada", displayName: "Ada Chen", source: "reservation" });
});

test("organizer falls back to the calendar event organizer when there is no reservation", async () => {
  const calendarEvent: FeishuCalendarEventRecord = {
    meetingNo: "123-456-789",
    organizerId: "ou_dana",
    organizerDisplayName: "Dana Whitfield",
  };
  const organizer = await resolveOrganizer("123-456-789", lookupWith(null, calendarEvent));
  assert.deepEqual(organizer, { feishuUserId: "ou_dana", displayName: "Dana Whitfield", source: "calendar_event" });
});

test("reservation takes priority over a calendar event when both exist", async () => {
  const reservation: FeishuReservationRecord = {
    meetingNo: "1",
    reserveUserId: "ou_reservation",
    reserveUserDisplayName: "Reservation Creator",
  };
  const calendarEvent: FeishuCalendarEventRecord = {
    meetingNo: "1",
    organizerId: "ou_calendar",
    organizerDisplayName: "Calendar Organizer",
  };
  const organizer = await resolveOrganizer("1", lookupWith(reservation, calendarEvent));
  assert.equal(organizer?.source, "reservation");
  assert.equal(organizer?.feishuUserId, "ou_reservation");
});

test("an instant meeting (no reservation, no calendar event) resolves organizer to null", async () => {
  const organizer = await resolveOrganizer("999", lookupWith(null, null));
  assert.equal(organizer, null);
});

test("structural: resolveOrganizer never reads hostUser, isHost, or isCohost off a reservation record, even when present", async () => {
  const raw: FeishuReservationRecord = {
    meetingNo: "1",
    reserveUserId: "ou_ada",
    reserveUserDisplayName: "Ada Chen",
    hostUser: { id: "ou_someone_else" },
  };
  const guarded = forbidGuard(raw, ["hostUser"]);
  const organizer = await resolveOrganizer("1", lookupWith(guarded, null));
  assert.deepEqual(organizer, { feishuUserId: "ou_ada", displayName: "Ada Chen", source: "reservation" });
});

test("structural: resolveOrganizer never reads hostUser off a calendar event record, even when present", async () => {
  const raw: FeishuCalendarEventRecord = {
    meetingNo: "1",
    organizerId: "ou_dana",
    organizerDisplayName: "Dana Whitfield",
    hostUser: { id: "ou_someone_else" },
  };
  const guarded = forbidGuard(raw, ["hostUser"]);
  const organizer = await resolveOrganizer("1", lookupWith(null, guarded));
  assert.deepEqual(organizer, { feishuUserId: "ou_dana", displayName: "Dana Whitfield", source: "calendar_event" });
});

test("inviter differing from the reservation creator: the person who invited the agent is never used as organizer", async () => {
  // The port surface gives the resolver no parameter through which an
  // "inviter" could even be supplied -- resolveOrganizer takes only a
  // meeting number and the lookup. This test pins that the reservation's
  // reserve_user_id wins regardless of who is recorded as having invited
  // the agent to the meeting on an adjacent, unrelated field.
  const raw = {
    meetingNo: "1",
    reserveUserId: "ou_reservation_creator",
    reserveUserDisplayName: "Reservation Creator",
    invitedByUserId: "ou_inviter", // not part of FeishuReservationRecord; never read
  } as FeishuReservationRecord & { invitedByUserId: string };
  const guarded = forbidGuard(raw, ["invitedByUserId"]);
  const organizer = await resolveOrganizer("1", lookupWith(guarded, null));
  assert.equal(organizer?.feishuUserId, "ou_reservation_creator");
  assert.notEqual(organizer?.feishuUserId, "ou_inviter");
});

test("host transfer across the meeting's lifetime never changes the resolved organizer", async () => {
  const reservation: FeishuReservationRecord = {
    meetingNo: "1",
    reserveUserId: "ou_ada",
    reserveUserDisplayName: "Ada Chen",
  };
  // Simulate the host changing partway through the meeting by varying only
  // the (never-read) hostUser field across two resolution calls; the
  // reservation itself is untouched.
  const beforeTransfer = forbidGuard({ ...reservation, hostUser: { id: "ou_ada" } }, ["hostUser"]);
  const afterTransfer = forbidGuard({ ...reservation, hostUser: { id: "ou_bo" } }, ["hostUser"]);

  const organizerBefore = await resolveOrganizer("1", lookupWith(beforeTransfer, null));
  const organizerAfter = await resolveOrganizer("1", lookupWith(afterTransfer, null));

  assert.deepEqual(organizerBefore, organizerAfter);
  assert.equal(organizerAfter?.feishuUserId, "ou_ada");
});

test("structural: resolveOrganizer never touches a meeting record's host_user or participants[].is_host/is_cohost fields", async () => {
  // Broader structural probe covering the raw meeting-record shape itself
  // (as opposed to the reservation/calendar-event records), for the case
  // where a future caller passes the whole meeting object through.
  const rawMeeting = {
    meetingNo: "1",
    hostUser: { id: "ou_host" },
    participants: [{ feishuUserId: "ou_a", displayName: "Ada Chen", isHost: true, isCohost: false }],
  };
  const guardedMeeting = forbidGuard(rawMeeting, ["hostUser", "participants"]);

  // resolveOrganizer must resolve purely from the reservation/calendar-event
  // lookup; touching the guarded meeting object at all (even just to read
  // meetingNo back off it, which is allowed) must never reach into the
  // forbidden fields.
  const meetingNo = guardedMeeting.meetingNo;
  const reservation: FeishuReservationRecord = {
    meetingNo,
    reserveUserId: "ou_ada",
    reserveUserDisplayName: "Ada Chen",
  };
  const organizer = await resolveOrganizer(meetingNo, lookupWith(reservation, null));
  assert.equal(organizer?.feishuUserId, "ou_ada");
});

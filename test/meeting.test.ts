// MeetingIdentity construction tests. buildMeetingIdentity is a thin wire
// between occurrence-id.ts (already independently tested) and the
// organizer/meeting-number/title fields TeamMem's artifact needs -- these
// tests pin that wiring, not the occurrence-id mechanics themselves.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildMeetingIdentity, type Organizer } from "../src/domain/meeting.ts";
import { occurrencePathSegment } from "../src/domain/occurrence-id.ts";

test("buildMeetingIdentity derives occurrenceId from providerMeetingId and occurrenceStartedAt", () => {
  const identity = buildMeetingIdentity({
    providerMeetingId: "vc:9f3a/board-sync",
    meetingNo: "123-456-789",
    occurrenceStartedAt: "2026-09-02T14:00:00Z",
    title: "Board sync",
    organizer: null,
  });

  assert.equal(identity.occurrenceId, "vc:9f3a/board-sync@2026-09-02T14:00:00Z");
  assert.equal(identity.providerMeetingId, "vc:9f3a/board-sync");
  assert.equal(identity.meetingNo, "123-456-789");
  assert.equal(identity.occurrenceStartedAt, "2026-09-02T14:00:00Z");
  assert.equal(identity.title, "Board sync");
  assert.equal(
    occurrencePathSegment(identity.occurrenceId),
    "vc%3A9f3a%2Fboard-sync_20260902T140000Z",
  );
});

test("buildMeetingIdentity carries a resolved organizer through unchanged", () => {
  const organizer: Organizer = { feishuUserId: "ou_ada", displayName: "Ada Chen", source: "reservation" };
  const identity = buildMeetingIdentity({
    providerMeetingId: "vc:1",
    meetingNo: "1",
    occurrenceStartedAt: "2026-09-02T14:00:00Z",
    title: "Standup",
    organizer,
  });
  assert.deepEqual(identity.organizer, organizer);
});

test("buildMeetingIdentity keeps organizer null for an instant meeting", () => {
  const identity = buildMeetingIdentity({
    providerMeetingId: "vc:instant-1",
    meetingNo: "2",
    occurrenceStartedAt: "2026-09-02T14:00:00Z",
    title: "Instant meeting",
    organizer: null,
  });
  assert.equal(identity.organizer, null);
});

test("buildMeetingIdentity rejects a malformed occurrenceStartedAt (delegates validation to occurrence-id)", () => {
  assert.throws(() =>
    buildMeetingIdentity({
      providerMeetingId: "vc:1",
      meetingNo: "1",
      occurrenceStartedAt: "not-an-instant",
      title: "Bad start",
      organizer: null,
    }),
  );
});

test("recurring occurrences of the same provider meeting id produce distinct MeetingIdentity occurrence ids", () => {
  const first = buildMeetingIdentity({
    providerMeetingId: "vc:weekly-standup",
    meetingNo: "1",
    occurrenceStartedAt: "2026-09-01T09:00:00Z",
    title: "Weekly standup",
    organizer: null,
  });
  const second = buildMeetingIdentity({
    providerMeetingId: "vc:weekly-standup",
    meetingNo: "1",
    occurrenceStartedAt: "2026-09-08T09:00:00Z",
    title: "Weekly standup",
    organizer: null,
  });
  assert.notEqual(first.occurrenceId, second.occurrenceId);
});

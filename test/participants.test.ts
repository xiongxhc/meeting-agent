// Attendance reducer tests, written before src/domain/participants.ts exists
// (TDD). The one rule this file exists to pin: only a participant_joined
// event ever creates an actual participant/interval. Invitees and no-shows
// never become participants, no matter how many other lifecycle events
// (invite, host change, display-name change) are observed for them.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  reduceAttendance,
  type AttendanceInterval,
  type MeetingLifecycleEvent,
} from "../src/domain/participants.ts";
import { makeOccurrenceId } from "../src/domain/occurrence-id.ts";

function joined(feishuUserId: string, displayName: string, occurredAt: string): MeetingLifecycleEvent {
  return { type: "participant_joined", feishuUserId, displayName, occurredAt };
}

function left(feishuUserId: string, occurredAt: string): MeetingLifecycleEvent {
  return { type: "participant_left", feishuUserId, occurredAt };
}

function invited(feishuUserId: string, displayName: string): MeetingLifecycleEvent {
  return { type: "participant_invited", feishuUserId, displayName };
}

function hostChanged(feishuUserId: string, occurredAt: string): MeetingLifecycleEvent {
  return { type: "host_changed", feishuUserId, occurredAt };
}

function renamed(feishuUserId: string, displayName: string, occurredAt: string): MeetingLifecycleEvent {
  return { type: "participant_display_name_changed", feishuUserId, displayName, occurredAt };
}

function byUser(intervals: readonly AttendanceInterval[], feishuUserId: string): AttendanceInterval[] {
  return intervals.filter((i) => i.feishuUserId === feishuUserId);
}

test("participant_joined followed by participant_left produces one attendance interval", () => {
  const intervals = reduceAttendance([
    joined("ou_a", "Ada Chen", "2026-09-02T14:00:20Z"),
    left("ou_a", "2026-09-02T14:20:00Z"),
  ]);
  assert.deepEqual(intervals, [
    { feishuUserId: "ou_a", displayName: "Ada Chen", joinedAt: "2026-09-02T14:00:20Z", leftAt: "2026-09-02T14:20:00Z" },
  ]);
});

test("an open interval with no matching leave event stays open (leftAt: null) at the end of the meeting", () => {
  const intervals = reduceAttendance([joined("ou_a", "Ada Chen", "2026-09-02T14:00:00Z")]);
  assert.deepEqual(intervals, [
    { feishuUserId: "ou_a", displayName: "Ada Chen", joinedAt: "2026-09-02T14:00:00Z", leftAt: null },
  ]);
});

test("invitees and no-shows never become participants: participant_invited alone produces no interval", () => {
  const intervals = reduceAttendance([invited("ou_never_joined", "Never Joined")]);
  assert.deepEqual(intervals, []);
});

test("an invitee who is later invited again but never joins still produces nothing", () => {
  const intervals = reduceAttendance([
    invited("ou_a", "Ada Chen"),
    invited("ou_a", "Ada Chen"),
  ]);
  assert.deepEqual(intervals, []);
});

test("host_changed alone (no join) creates no participant", () => {
  const intervals = reduceAttendance([hostChanged("ou_host", "2026-09-02T14:00:00Z")]);
  assert.deepEqual(intervals, []);
});

test("host transfer between two already-joined participants does not alter either participant's intervals", () => {
  const events: MeetingLifecycleEvent[] = [
    joined("ou_a", "Ada Chen", "2026-09-02T14:00:00Z"),
    joined("ou_b", "Bo Lin", "2026-09-02T14:00:05Z"),
    hostChanged("ou_a", "2026-09-02T14:00:00Z"),
    hostChanged("ou_b", "2026-09-02T14:10:00Z"),
    hostChanged("ou_a", "2026-09-02T14:20:00Z"),
  ];
  const intervals = reduceAttendance(events);
  assert.deepEqual(intervals, [
    { feishuUserId: "ou_a", displayName: "Ada Chen", joinedAt: "2026-09-02T14:00:00Z", leftAt: null },
    { feishuUserId: "ou_b", displayName: "Bo Lin", joinedAt: "2026-09-02T14:00:05Z", leftAt: null },
  ]);
});

test("participant_left with no prior join is ignored (never fabricates a participant)", () => {
  const intervals = reduceAttendance([left("ou_ghost", "2026-09-02T14:00:00Z")]);
  assert.deepEqual(intervals, []);
});

test("duplicate participant_joined events (identical timestamp) produce exactly one interval, not two", () => {
  const intervals = reduceAttendance([
    joined("ou_a", "Ada Chen", "2026-09-02T14:00:00Z"),
    joined("ou_a", "Ada Chen", "2026-09-02T14:00:00Z"),
  ]);
  assert.equal(byUser(intervals, "ou_a").length, 1);
  assert.deepEqual(intervals, [
    { feishuUserId: "ou_a", displayName: "Ada Chen", joinedAt: "2026-09-02T14:00:00Z", leftAt: null },
  ]);
});

test("a second participant_joined while already open (no intervening leave) is treated as a duplicate join, not a new interval", () => {
  const intervals = reduceAttendance([
    joined("ou_a", "Ada Chen", "2026-09-02T14:00:00Z"),
    joined("ou_a", "Ada Chen", "2026-09-02T14:05:00Z"),
  ]);
  assert.equal(byUser(intervals, "ou_a").length, 1);
  assert.equal(intervals[0]?.joinedAt, "2026-09-02T14:00:00Z");
});

test("reordered events are processed in chronological order regardless of array order", () => {
  const intervals = reduceAttendance([
    left("ou_a", "2026-09-02T14:20:00Z"),
    joined("ou_a", "Ada Chen", "2026-09-02T14:00:00Z"),
  ]);
  assert.deepEqual(intervals, [
    { feishuUserId: "ou_a", displayName: "Ada Chen", joinedAt: "2026-09-02T14:00:00Z", leftAt: "2026-09-02T14:20:00Z" },
  ]);
});

test("reconnect: the same person joining twice after leaving produces two separate intervals, not one merged interval", () => {
  // Design decision: a reconnect is not collapsed into its first interval's
  // span, because the gap between leftAt and the next joinedAt is itself
  // meaningful (e.g. it is exactly the kind of "recording gap"-adjacent data
  // later tasks need at full fidelity) and collapsing would silently invent
  // presence during a period nobody observed the person as present.
  const intervals = reduceAttendance([
    joined("ou_a", "Ada Chen", "2026-09-02T14:00:00Z"),
    left("ou_a", "2026-09-02T14:10:00Z"),
    joined("ou_a", "Ada Chen", "2026-09-02T14:24:05Z"),
    left("ou_a", "2026-09-02T14:52:00Z"),
  ]);
  const mine = byUser(intervals, "ou_a");
  assert.equal(mine.length, 2);
  assert.deepEqual(mine, [
    { feishuUserId: "ou_a", displayName: "Ada Chen", joinedAt: "2026-09-02T14:00:00Z", leftAt: "2026-09-02T14:10:00Z" },
    { feishuUserId: "ou_a", displayName: "Ada Chen", joinedAt: "2026-09-02T14:24:05Z", leftAt: "2026-09-02T14:52:00Z" },
  ]);
});

test("display-name change on rejoin: each interval snapshots the display name current at its own join", () => {
  const intervals = reduceAttendance([
    joined("ou_a", "Ada Chen", "2026-09-02T14:00:00Z"),
    left("ou_a", "2026-09-02T14:10:00Z"),
    joined("ou_a", "Ada C.", "2026-09-02T14:24:05Z"),
  ]);
  const mine = byUser(intervals, "ou_a");
  assert.equal(mine[0]?.displayName, "Ada Chen");
  assert.equal(mine[1]?.displayName, "Ada C.");
});

test("an explicit display-name-changed event updates the currently open interval without creating a new one", () => {
  const intervals = reduceAttendance([
    joined("ou_a", "Ada Chen", "2026-09-02T14:00:00Z"),
    renamed("ou_a", "Ada C.", "2026-09-02T14:05:00Z"),
    left("ou_a", "2026-09-02T14:10:00Z"),
  ]);
  assert.deepEqual(intervals, [
    { feishuUserId: "ou_a", displayName: "Ada C.", joinedAt: "2026-09-02T14:00:00Z", leftAt: "2026-09-02T14:10:00Z" },
  ]);
});

test("a display-name-changed event with no open interval (never joined) is a no-op", () => {
  const intervals = reduceAttendance([renamed("ou_a", "Ada C.", "2026-09-02T14:05:00Z")]);
  assert.deepEqual(intervals, []);
});

test("two people joining and leaving independently do not interfere with each other's intervals", () => {
  const intervals = reduceAttendance([
    joined("ou_a", "Ada Chen", "2026-09-02T14:00:00Z"),
    joined("ou_b", "Bo Lin", "2026-09-02T14:01:00Z"),
    left("ou_a", "2026-09-02T14:15:00Z"),
    joined("ou_a", "Ada Chen", "2026-09-02T14:20:00Z"),
    left("ou_b", "2026-09-02T14:25:00Z"),
  ]);
  assert.equal(byUser(intervals, "ou_a").length, 2);
  assert.equal(byUser(intervals, "ou_b").length, 1);
});

test("recurring occurrences: the reducer is a pure function of its own event list and never leaks state across occurrences", () => {
  // Two occurrences of the same recurring meeting id, one week apart, each
  // with their own independent event list for the same person.
  const occurrenceA = makeOccurrenceId("vc:weekly-standup", "2026-09-01T09:00:00Z");
  const occurrenceB = makeOccurrenceId("vc:weekly-standup", "2026-09-08T09:00:00Z");
  assert.notEqual(occurrenceA, occurrenceB);

  const eventsA: MeetingLifecycleEvent[] = [joined("ou_a", "Ada Chen", "2026-09-01T09:00:10Z")];
  const eventsB: MeetingLifecycleEvent[] = [invited("ou_a", "Ada Chen")]; // absent the second week

  const intervalsA = reduceAttendance(eventsA);
  const intervalsB = reduceAttendance(eventsB);

  assert.equal(intervalsA.length, 1);
  assert.equal(intervalsB.length, 0);
});

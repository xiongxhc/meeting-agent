// Occurrence identity tests, written before src/domain/occurrence-id.ts exists
// (TDD). The module must match the frozen cross-repository schema
// teammem-meeting-v1, "Occurrence identity" section, byte for byte.
//
// The single most important property here: occurrencePathSegment must be
// byte-identical to TeamMem's Python
//   f"{urllib.parse.quote(meeting_id, safe='')}_{start.strftime('%Y%m%dT%H%M%SZ')}"
// which escapes `!`, `*`, `'`, `(`, `)` -- encodeURIComponent alone does not.
// TeamMem's bundle loader rejects a bundle whose directory segment does not
// equal the segment derived from occurrence_id, so drifting from Python here
// silently quarantines every artifact for an affected meeting.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  makeOccurrenceId,
  occurrencePathSegment,
  parseOccurrencePathSegment,
  shortOccurrenceId,
  type OccurrenceId,
} from "../src/domain/occurrence-id.ts";

const WINDOWS_ILLEGAL_CHARS = /[<>:"/\\|?*]/;

test("occurrencePathSegment matches TeamMem's Python urllib.parse.quote(safe='') byte for byte", () => {
  // Meeting id and expected outputs are copied verbatim from
  // task-2-brief.md, which states they were verified on-machine:
  //
  //   input (meeting id):  vc:9f3a/board-sync!*'()~_.-+ 中
  //   python quote(safe=''):  vc%3A9f3a%2Fboard-sync%21%2A%27%28%29~_.-%2B%20%E4%B8%AD
  //   js encodeURIComponent:  vc%3A9f3a%2Fboard-sync!*'()~_.-%2B%20%E4%B8%AD
  //
  // encodeURIComponent alone leaves `! * ' ( )` unescaped; Python does not.
  const meetingId = "vc:9f3a/board-sync!*'()~_.-+ 中";
  const startedAt = "2026-09-02T14:00:00Z";
  const id = makeOccurrenceId(meetingId, startedAt);

  const expectedEncodedMeetingId =
    "vc%3A9f3a%2Fboard-sync%21%2A%27%28%29~_.-%2B%20%E4%B8%AD";
  const expected = `${expectedEncodedMeetingId}_20260902T140000Z`;

  assert.equal(occurrencePathSegment(id), expected);

  // Negative control: prove the naive encodeURIComponent-only spelling would
  // have been wrong, so this test cannot pass by both sides being equally
  // sloppy.
  const naive = `${encodeURIComponent(meetingId)}_20260902T140000Z`;
  assert.notEqual(naive, expected);
});

test("occurrencePathSegment round-trips through parseOccurrencePathSegment for special-character meeting ids", () => {
  const cases: ReadonlyArray<{ meetingId: string; startedAt: string }> = [
    { meetingId: "vc:9f3a/board-sync", startedAt: "2026-09-02T14:00:00Z" },
    { meetingId: "room 42 / stand-up", startedAt: "2026-01-05T09:30:00Z" },
    { meetingId: "100% budget:review", startedAt: "2026-12-31T23:59:59Z" },
    { meetingId: "会议 室/日程", startedAt: "2026-03-15T00:00:00Z" },
    { meetingId: "vc:9f3a/board-sync!*'()~_.-+ 中", startedAt: "2026-09-02T14:00:00Z" },
  ];

  for (const { meetingId, startedAt } of cases) {
    const id = makeOccurrenceId(meetingId, startedAt);
    const segment = occurrencePathSegment(id);

    assert.ok(
      !WINDOWS_ILLEGAL_CHARS.test(segment),
      `segment for ${JSON.stringify(meetingId)} contains a character illegal on Windows: ${segment}`,
    );

    const roundTripped = parseOccurrencePathSegment(segment);
    assert.equal(roundTripped, id, `round trip failed for meeting id ${JSON.stringify(meetingId)}`);
  }
});

test("parseOccurrencePathSegment splits on the LAST underscore, surviving an encoded meeting id that itself contains underscores", () => {
  // "_" is left unescaped by both encodeURIComponent and Python's quote, so
  // an encoded meeting id can contain the same character used as the
  // segment's own separator. The only safe split is from the right.
  const meetingId = "team_alpha:daily/sync_v2";
  const startedAt = "2026-01-05T09:30:00Z";
  const id = makeOccurrenceId(meetingId, startedAt);

  const segment = occurrencePathSegment(id);
  assert.equal(segment, "team_alpha%3Adaily%2Fsync_v2_20260105T093000Z");

  assert.equal(parseOccurrencePathSegment(segment), id);
});

test("a meeting id containing a literal '@' still round-trips (the logical split is greedy from the left, anchored on a valid trailing instant)", () => {
  const meetingId = "team@lounge/board-sync";
  const startedAt = "2026-09-02T14:00:00Z";
  const id = makeOccurrenceId(meetingId, startedAt);
  assert.equal(id, "team@lounge/board-sync@2026-09-02T14:00:00Z");

  const segment = occurrencePathSegment(id);
  assert.equal(segment, "team%40lounge%2Fboard-sync_20260902T140000Z");
  assert.equal(parseOccurrencePathSegment(segment), id);
});

test("parseOccurrencePathSegment rejects a segment whose suffix is not a valid compact instant", () => {
  assert.throws(() => parseOccurrencePathSegment("board-sync_not-a-timestamp"));
});

test("parseOccurrencePathSegment rejects a segment with no underscore at all", () => {
  assert.throws(() => parseOccurrencePathSegment("no-separator-here"));
});

test("makeOccurrenceId rejects a blank meeting id", () => {
  assert.throws(() => makeOccurrenceId("", "2026-09-02T14:00:00Z"));
});

test("makeOccurrenceId rejects a startedAt with fractional seconds or a non-UTC offset", () => {
  assert.throws(() => makeOccurrenceId("vc:1", "2026-09-02T14:00:00.500Z"));
  assert.throws(() => makeOccurrenceId("vc:1", "2026-09-02T18:00:00+04:00"));
  assert.throws(() => makeOccurrenceId("vc:1", "2026-09-02 14:00:00Z"));
});

test("makeOccurrenceId rejects impossible whole-second UTC instants", () => {
  // These match the spelling rule but are not instants. A regex-only check
  // would make them durable occurrence identities that no UTC clock can name.
  for (const startedAt of [
    "2026-02-29T12:00:00Z",
    "2026-04-31T12:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T12:60:00Z",
    "2026-01-01T12:00:60Z",
  ]) {
    assert.throws(() => makeOccurrenceId("vc:impossible", startedAt));
  }
});

test("parseOccurrencePathSegment rejects noncanonical percent spellings", () => {
  const canonical = occurrencePathSegment(makeOccurrenceId("vc!", "2026-09-02T14:00:00Z"));
  assert.equal(canonical, "vc%21_20260902T140000Z");
  assert.throws(() => parseOccurrencePathSegment("vc!_20260902T140000Z"));
  assert.throws(() => parseOccurrencePathSegment("vc%21_20260902T140000z"));
});

test("shortOccurrenceId is the first 8 lowercase hex characters of sha256 of the ENCODED path segment, not the raw id", () => {
  const id = makeOccurrenceId("vc:9f3a/board-sync", "2026-09-02T14:00:00Z");
  const segment = occurrencePathSegment(id);

  // Independently computed expected value: sha256 over the encoded segment
  // string, not over the logical "<meeting-id>@<start>" form.
  const expected = createHash("sha256").update(segment, "utf8").digest("hex").slice(0, 8);

  const actual = shortOccurrenceId(id);
  assert.equal(actual, expected);
  assert.match(actual, /^[0-9a-f]{8}$/);

  // Prove it is NOT hashing the raw logical id: hashing the logical id
  // directly gives a different prefix for this fixture.
  const hashOfLogicalId = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 8);
  assert.notEqual(actual, hashOfLogicalId);
});

test("shortOccurrenceId is stable and deterministic across repeated calls", () => {
  const id: OccurrenceId = makeOccurrenceId("vc:stable", "2026-05-01T00:00:00Z");
  assert.equal(shortOccurrenceId(id), shortOccurrenceId(id));
});

test("recurring occurrences of the same provider meeting id produce distinct occurrence ids, segments, and short ids", () => {
  const first = makeOccurrenceId("vc:recurring-standup", "2026-09-01T09:00:00Z");
  const second = makeOccurrenceId("vc:recurring-standup", "2026-09-08T09:00:00Z");

  assert.notEqual(first, second);
  assert.notEqual(occurrencePathSegment(first), occurrencePathSegment(second));
  assert.notEqual(shortOccurrenceId(first), shortOccurrenceId(second));
});

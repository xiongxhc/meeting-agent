import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeGenerationAttendance, mergeGenerationTranscripts, publishedGaps } from "../src/delivery/generation-merge.ts";
import type { TimedReconciledTranscript } from "../src/domain/transcript.ts";

test("attendance that ends exactly where the next generation's begins is one interval", () => {
  assert.deepEqual(mergeGenerationAttendance([
    { feishuUserId: "alice", displayName: "Alice", joinedAt: "2026-09-02T14:00:00.000Z", leftAt: "2026-09-02T14:20:00.000Z" },
    { feishuUserId: "alice", displayName: "Alice", joinedAt: "2026-09-02T14:20:00.000Z", leftAt: "2026-09-02T14:30:00.000Z" },
  ]), [{ feishuUserId: "alice", displayName: "Alice", joinedAt: "2026-09-02T14:00:00.000Z", leftAt: "2026-09-02T14:30:00.000Z" }]);
  // An interval still open when its generation ended continues into the next one.
  assert.deepEqual(mergeGenerationAttendance([
    { feishuUserId: "bob", displayName: "Bob", joinedAt: "2026-09-02T14:00:00.000Z", leftAt: null },
    { feishuUserId: "bob", displayName: "Bob B.", joinedAt: "2026-09-02T14:22:00.000Z", leftAt: "2026-09-02T14:25:00.000Z" },
  ]), [{ feishuUserId: "bob", displayName: "Bob B.", joinedAt: "2026-09-02T14:00:00.000Z", leftAt: "2026-09-02T14:25:00.000Z" }]);
  // A real absence stays two intervals.
  assert.equal(mergeGenerationAttendance([
    { feishuUserId: "carol", displayName: "Carol", joinedAt: "2026-09-02T14:00:00.000Z", leftAt: "2026-09-02T14:05:00.000Z" },
    { feishuUserId: "carol", displayName: "Carol", joinedAt: "2026-09-02T14:06:00.000Z", leftAt: null },
  ]).length, 2);
});

function transcript(complete: boolean, warnings: TimedReconciledTranscript["warnings"] = []): TimedReconciledTranscript {
  return { segments: [], warnings, transcriptComplete: complete } as unknown as TimedReconciledTranscript;
}

test("the merged transcript is complete only when every generation's is", () => {
  assert.equal(mergeGenerationTranscripts(transcript(true), [{ ordinal: 1, transcript: transcript(false) }]).transcriptComplete, false);
  assert.equal(mergeGenerationTranscripts(transcript(false), [{ ordinal: 1, transcript: transcript(true) }]).transcriptComplete, false);
  assert.equal(mergeGenerationTranscripts(transcript(true), [{ ordinal: 1, transcript: transcript(true) }]).transcriptComplete, true);
  const merged = mergeGenerationTranscripts(transcript(true, [{ code: "local_wall_timestamp_estimate", detail: "a" }]),
    [{ ordinal: 1, transcript: transcript(true, [{ code: "local_wall_timestamp_estimate", detail: "b" }]) }]);
  assert.equal(merged.warnings.filter(({ code }) => code === "local_wall_timestamp_estimate").length, 1);
});

test("an open gap is published only for the last generation, closed at the end", () => {
  const window = { occurrenceStartedAt: "2026-09-02T14:00:00Z", endedAt: "2026-09-02T14:40:00.000Z", seedGaps: [] };
  assert.deepEqual(publishedGaps({ ...window, otherGaps: [{ direction: "capture", startedAt: "2026-09-02T14:21:00.000Z", endedAt: null }] }), []);
  assert.deepEqual(publishedGaps({ ...window, otherGaps: [{ direction: "capture", startedAt: "2026-09-02T14:21:00.000Z", endedAt: null, closeAtEnd: true }] }),
    [{ startedAt: "2026-09-02T14:21:00.000Z", endedAt: "2026-09-02T14:40:00.000Z", reason: "bridge_capture_gap" }]);
});

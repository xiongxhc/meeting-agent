// The speaker reconciler: live active-speaker UI observations plus
// post-meeting diarization in, a transcript whose speakers are named,
// anonymous, or ambiguous -- and never guessed -- out.
//
// What this suite exists to prove, in the order the risk sits:
//
//   1. A SEGMENT IS NAMED ONLY FROM ALIGNED UI EVIDENCE. Exact overlap names;
//      a mid-segment switch, two lit tiles, or no signal at all does not. The
//      property test at the end asserts the invariant over random inputs: every
//      named segment has one ui_exact identity covering at least
//      MIN_ALIGNED_COVERAGE of it with at most MAX_CONFLICTING_OVERLAP_MS of
//      positive evidence for anyone else, and no meeting without UI evidence
//      names anyone -- whatever the attendance list says.
//   2. CLUSTERS GROUP, THEY DO NOT IDENTIFY. A cluster with no UI evidence stays
//      speaker_NN even when exactly one attendee is left over, even when it
//      spoke the most, and even when a sibling segment in the same cluster IS
//      named. A cluster whose UI-named segments disagree resolves to ambiguous.
//   3. THE LOCAL DIARIZATION BACKEND (ruling R55) RETURNS NO TEXT. The
//      reconciled transcript must still carry wording, taken from the live
//      segments by media-timeline overlap, and is complete when that coverage
//      is full; the empty local text is informational, not a deletion permit.
//   4. INCOMPLETENESS IS A FIELD. `transcriptComplete` and the closed warning
//      list are what Task 9a's backfill and the retention monitor read.
//   5. THE PERSISTED HANDLE IS WHAT reconcileRecording IS CALLED WITH -- read
//      from the store, never assumed to be in memory.
//
// Fixtures are synthetic: ou_alpha / ou_beta / ou_gamma are not people.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AttendanceInterval } from "../src/domain/participants.ts";
import type {
  ActiveSpeakerObservation,
  ReconciledSegment,
  ReconciledTranscript,
} from "../src/domain/transcript.ts";
import type {
  DiarizedSegment,
  RecordingReconciliation,
  TranscriptSegment,
} from "../src/ports/conversation-runtime.ts";
import type { ReconciliationEvidenceRow, RecordingRow } from "../src/ports/session-store.ts";
import {
  MAX_CONFLICTING_OVERLAP_MS,
  reconcilePersistedSpeakers,
  MIN_ALIGNED_COVERAGE,
  reconcileSpeakers,
  reconcileTranscript,
  type ReconcileTranscriptInput,
} from "../src/sessions/speaker-reconciler.ts";
import { fakeRuntime } from "./lib/session-fakes.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGIN = "2026-09-02T14:00:00.000Z";
const ORIGIN_MS = Date.parse(ORIGIN);
const ENDED_AT = "2026-09-02T15:00:00.000Z";

const ALPHA = "ou_synthetic_alpha";
const BETA = "ou_synthetic_beta";
const GAMMA = "ou_synthetic_gamma";

/** Media-timeline milliseconds to a wall-clock instant. */
function at(ms: number): string {
  return new Date(ORIGIN_MS + ms).toISOString();
}

function attendee(feishuUserId: string, displayName: string): AttendanceInterval {
  return { feishuUserId, displayName, joinedAt: at(0), leftAt: null };
}

const ATTENDANCE: readonly AttendanceInterval[] = [
  attendee(ALPHA, "Alpha Synthetic"),
  attendee(BETA, "Beta Synthetic"),
  attendee(GAMMA, "Gamma Synthetic"),
];

function live(segmentId: string, startMs: number, endMs: number, text: string): TranscriptSegment {
  return { segmentId, text, final: true, startedAt: at(startMs), endedAt: at(endMs) };
}

function exact(ms: number, feishuUserId: string): ActiveSpeakerObservation {
  return { bridgeSessionId: "bridge_synthetic", sequence: ms + 1, observedAt: at(ms), confidence: "ui_exact", feishuUserId };
}

function ambiguous(ms: number): ActiveSpeakerObservation {
  return { bridgeSessionId: "bridge_synthetic", sequence: ms + 1, observedAt: at(ms), confidence: "ambiguous", feishuUserId: null };
}

function diarized(
  segmentId: string,
  startedAtMs: number,
  endedAtMs: number,
  speakerCluster: string | null,
  text = "",
): DiarizedSegment {
  return { segmentId, startedAtMs: BigInt(startedAtMs), endedAtMs: BigInt(endedAtMs), text, speakerCluster };
}

function input(overrides: Partial<ReconcileTranscriptInput>): ReconcileTranscriptInput {
  return {
    attendance: ATTENDANCE,
    liveSegments: [],
    evidence: [],
    reconciliation: { unavailable: "not requested in this test" },
    alignment: { kind: "durable_runtime_anchor", mediaOriginAt: ORIGIN, runtimeSessionId: 17n },
    endedAt: ENDED_AT,
    ...overrides,
  };
}

function only(result: ReconciledTranscript): ReconciledSegment {
  assert.equal(result.segments.length, 1, "expected exactly one reconciled segment");
  return result.segments[0] as ReconciledSegment;
}

function codes(result: ReconciledTranscript): string[] {
  return result.warnings.map((warning) => warning.code);
}

// ---------------------------------------------------------------------------
// 1. Live UI evidence alone (no diarization yet)
// ---------------------------------------------------------------------------

test("exact UI overlap names the segment, with the evidence on the record", () => {
  const result = reconcileTranscript(
    input({
      liveSegments: [live("seg_01", 10_000, 14_000, "we should ship on friday")],
      evidence: [exact(9_800, ALPHA)],
    }),
  );
  const segment = only(result);
  assert.deepEqual(segment.speaker, { kind: "named", feishuUserId: ALPHA });
  assert.equal(segment.text, "we should ship on friday");
  assert.equal(segment.startedAtMs, 10_000);
  assert.equal(segment.endedAtMs, 14_000);
  assert.equal(segment.provenance.reason, "ui_aligned");
  assert.equal(segment.provenance.wording, "live");
  assert.deepEqual(segment.provenance.uiExactMs, { [ALPHA]: 4_000 });
  assert.equal(segment.provenance.ambiguousMs, 0);
  assert.equal(segment.provenance.unobservedMs, 0);
  // The provisional evidence is retained as evidence, not consumed into an answer.
  assert.deepEqual(result.evidence, [exact(9_800, ALPHA)]);
  assert.deepEqual(result.silentAttendees, [BETA, GAMMA]);
});

test("a UI switch mid-segment is conflicting evidence and resolves to ambiguous", () => {
  const result = reconcileTranscript(
    input({
      liveSegments: [live("seg_01", 20_000, 30_000, "two people in one segment")],
      evidence: [exact(20_000, ALPHA), exact(25_000, BETA)],
    }),
  );
  const segment = only(result);
  assert.deepEqual(segment.speaker, { kind: "ambiguous" });
  assert.equal(segment.provenance.reason, "ui_conflict");
  assert.deepEqual(segment.provenance.uiExactMs, { [ALPHA]: 5_000, [BETA]: 5_000 });
  // Both people were observed speaking but neither met the naming rule.
  assert.deepEqual(result.silentAttendees, [GAMMA]);
  assert.deepEqual(result.spokeButUnattributed, [ALPHA, BETA]);
});

test("a UI switch within the jitter allowance at a segment edge still names the dominant identity", () => {
  // The bridge re-emits a state only when the highlight changes, and the
  // highlight trails speech by a fraction of a second. A switch 200ms before
  // the segment ends is boundary jitter, not a second speaker.
  const result = reconcileTranscript(
    input({
      liveSegments: [live("seg_01", 40_000, 44_000, "handing over")],
      evidence: [exact(40_000, ALPHA), exact(43_800, BETA)],
    }),
  );
  const segment = only(result);
  assert.deepEqual(segment.speaker, { kind: "named", feishuUserId: ALPHA });
  assert.equal(segment.provenance.reason, "ui_aligned");
  assert.equal(segment.provenance.uiExactMs[BETA], 200);
});

test("a second identity past the jitter allowance is a conflict even when the dominant one covers most of the segment", () => {
  // 90% ALPHA, 10% BETA on a 20-second segment: coverage clears the fraction
  // but the 2 seconds of BETA are positive evidence of a second speaker, well
  // past MAX_CONFLICTING_OVERLAP_MS. The absolute cap is what keeps a long
  // segment from absorbing a real second speaker under a percentage.
  const result = reconcileTranscript(
    input({
      liveSegments: [live("seg_01", 0, 20_000, "long turn with a real interjection")],
      evidence: [exact(0, ALPHA), exact(18_000, BETA)],
    }),
  );
  const segment = only(result);
  assert.deepEqual(segment.speaker, { kind: "ambiguous" });
  assert.equal(segment.provenance.reason, "ui_conflict");
  assert.ok(2_000 > MAX_CONFLICTING_OVERLAP_MS);
});

test("no active-speaker signal at all leaves every segment anonymous -- even with a single attendee", () => {
  const result = reconcileTranscript(
    input({
      attendance: [attendee(ALPHA, "Alpha Synthetic")],
      liveSegments: [
        live("seg_01", 10_000, 14_000, "first"),
        live("seg_02", 20_000, 24_000, "second"),
      ],
      evidence: [],
    }),
  );
  assert.equal(result.segments.length, 2);
  for (const [index, segment] of result.segments.entries()) {
    // The only attendee is NOT the answer. Elimination is a guess.
    assert.deepEqual(segment.speaker, { kind: "anonymous", label: `speaker_0${index + 1}` });
    assert.equal(segment.provenance.reason, "no_signal");
    assert.equal(segment.provenance.unobservedMs, 4_000);
  }
  assert.deepEqual(result.silentAttendees, [ALPHA]);
});

test("speech before the first observation is unobserved, not attributed to whoever lit up later", () => {
  const result = reconcileTranscript(
    input({
      liveSegments: [live("seg_01", 10_000, 14_000, "spoken before any tile lit")],
      evidence: [exact(14_000, ALPHA)],
    }),
  );
  const segment = only(result);
  assert.deepEqual(segment.speaker, { kind: "anonymous", label: "speaker_01" });
  assert.equal(segment.provenance.reason, "no_signal");
});

test("partial coverage with no conflicting evidence is insufficient, not a guess", () => {
  // ALPHA lit for the last half of the segment only; nothing else observed.
  // Absence of evidence for the first half is not evidence of a second
  // speaker, so this is anonymous rather than ambiguous -- and not named.
  const result = reconcileTranscript(
    input({
      liveSegments: [live("seg_01", 10_000, 20_000, "half covered")],
      evidence: [exact(15_000, ALPHA)],
    }),
  );
  const segment = only(result);
  assert.deepEqual(segment.speaker, { kind: "anonymous", label: "speaker_01" });
  assert.equal(segment.provenance.reason, "ui_insufficient");
  assert.deepEqual(segment.provenance.uiExactMs, { [ALPHA]: 5_000 });
  assert.equal(segment.provenance.unobservedMs, 5_000);
});

test("two active tiles (the bridge's `ambiguous`) make the segment ambiguous, never a pick between them", () => {
  const result = reconcileTranscript(
    input({
      liveSegments: [live("seg_01", 10_000, 14_000, "overlapping speech")],
      evidence: [exact(0, ALPHA), ambiguous(9_500), exact(14_000, ALPHA)],
    }),
  );
  const segment = only(result);
  assert.deepEqual(segment.speaker, { kind: "ambiguous" });
  assert.equal(segment.provenance.reason, "ui_ambiguous");
  assert.equal(segment.provenance.ambiguousMs, 4_000);
});

test("an ambiguous flicker inside the jitter allowance does not unseat an otherwise exact identity", () => {
  const result = reconcileTranscript(
    input({
      liveSegments: [live("seg_01", 10_000, 20_000, "one speaker, one flicker")],
      evidence: [exact(10_000, ALPHA), ambiguous(15_000), exact(15_300, ALPHA)],
    }),
  );
  const segment = only(result);
  assert.deepEqual(segment.speaker, { kind: "named", feishuUserId: ALPHA });
  assert.equal(segment.provenance.ambiguousMs, 300);
});

test("the last observed state does not name a much later turn merely because the bridge emits only changes", () => {
  const result = reconcileTranscript(
    input({
      liveSegments: [live("seg_01", 3_000_000, 3_004_000, "late in the meeting")],
      evidence: [exact(60_000, ALPHA)],
    }),
  );
  assert.deepEqual(only(result).speaker, { kind: "anonymous", label: "speaker_01" });
});

test("with no diarization, the live segments come back in time order with no clusters", () => {
  const result = reconcileTranscript(
    input({
      liveSegments: [
        live("seg_02", 20_000, 24_000, "second"),
        live("seg_01", 10_000, 14_000, "first"),
      ],
    }),
  );
  assert.deepEqual(
    result.segments.map((s) => [s.segmentId, s.cluster]),
    [
      ["seg_01", null],
      ["seg_02", null],
    ],
  );
});

// ---------------------------------------------------------------------------
// 2. Post-meeting diarization: the online backend (text present)
// ---------------------------------------------------------------------------

const ONLINE: RecordingReconciliation = {
  segments: [
    diarized("dia_01", 10_000, 14_000, "cluster-a", "we should ship on friday"),
    diarized("dia_02", 20_000, 30_000, "cluster-b", "friday is tight for the backend"),
    diarized("dia_03", 40_000, 44_000, "cluster-a", "then thursday code freeze"),
    diarized("dia_04", 50_000, 80_000, "cluster-b", "the long explanation nobody named"),
  ],
  warnings: [],
};

const LIVE_FOR_ONLINE: readonly TranscriptSegment[] = [
  live("seg_01", 10_100, 14_000, "we should ship on Friday"),
  live("seg_02", 20_000, 29_900, "friday is tight for backend"),
  live("seg_03", 40_000, 44_000, "then thursday code freeze"),
  live("seg_04", 50_000, 80_000, "the long explanation"),
];

test("online backend: reconciled segments carry the reconciled wording, clusters become speaker_NN by first appearance, and the transcript is complete", () => {
  const result = reconcileTranscript(
    input({
      liveSegments: LIVE_FOR_ONLINE,
      reconciliation: ONLINE,
      evidence: [],
    }),
  );
  assert.deepEqual(
    result.segments.map((s) => [s.segmentId, s.text, s.cluster, s.speaker]),
    [
      ["dia_01", "we should ship on friday", "cluster-a", { kind: "anonymous", label: "speaker_01" }],
      ["dia_02", "friday is tight for the backend", "cluster-b", { kind: "anonymous", label: "speaker_02" }],
      ["dia_03", "then thursday code freeze", "cluster-a", { kind: "anonymous", label: "speaker_01" }],
      ["dia_04", "the long explanation nobody named", "cluster-b", { kind: "anonymous", label: "speaker_02" }],
    ],
  );
  for (const segment of result.segments) {
    assert.equal(segment.provenance.wording, "reconciled");
  }
  // The live segments were superseded, and the provenance says which ones.
  assert.deepEqual(result.segments[0]?.provenance.liveSegmentIds, ["seg_01"]);
  assert.equal(result.transcriptComplete, true);
  assert.deepEqual(result.warnings, []);
});

test("a cluster is never mapped to a person by elimination, by attendee order, or by speaking duration", () => {
  // Two attendees. UI evidence names ALPHA on cluster-a's segments only.
  // cluster-b spoke the most (40s vs 8s) and BETA is the only attendee left,
  // and cluster-b STILL stays anonymous.
  const result = reconcileTranscript(
    input({
      attendance: [attendee(ALPHA, "Alpha Synthetic"), attendee(BETA, "Beta Synthetic")],
      liveSegments: LIVE_FOR_ONLINE,
      reconciliation: ONLINE,
      evidence: [exact(9_900, ALPHA), exact(19_000, BETA), exact(39_900, ALPHA), exact(49_000, BETA)],
    }),
  );
  // Wait -- BETA IS observed here, so this is the positive control: with
  // aligned UI evidence cluster-b's segments ARE named. The elimination test
  // proper is the next assertion block, with BETA's observations removed.
  assert.deepEqual(result.segments[1]?.speaker, { kind: "named", feishuUserId: BETA });

  const withoutBeta = reconcileTranscript(
    input({
      attendance: [attendee(ALPHA, "Alpha Synthetic"), attendee(BETA, "Beta Synthetic")],
      liveSegments: LIVE_FOR_ONLINE,
      reconciliation: ONLINE,
      // The bridge saw ALPHA's tile twice and never resolved a tile for the
      // rest -- `ambiguous` at the hand-offs, which is what an unresolved
      // single tile produces.
      evidence: [exact(9_900, ALPHA), ambiguous(19_000), exact(39_900, ALPHA), ambiguous(49_000)],
    }),
  );
  assert.deepEqual(
    withoutBeta.segments.map((s) => s.speaker),
    [
      { kind: "named", feishuUserId: ALPHA },
      { kind: "ambiguous" },
      { kind: "named", feishuUserId: ALPHA },
      { kind: "ambiguous" },
    ],
  );
  assert.deepEqual(withoutBeta.silentAttendees, [BETA]);

  // And with NO observation at all over cluster-b -- pure absence -- it is
  // anonymous with its cluster label, not BETA.
  const absence = reconcileTranscript(
    input({
      attendance: [attendee(ALPHA, "Alpha Synthetic"), attendee(BETA, "Beta Synthetic")],
      liveSegments: LIVE_FOR_ONLINE,
      reconciliation: ONLINE,
      evidence: [exact(9_900, ALPHA)],
    }),
  );
  // ALPHA's state is HELD from 9.9s to the end, because the bridge emits only
  // changes and a voice with no tile (a dial-in, say) never changes anything.
  // Held evidence names a segment only when its cluster corroborates it --
  // some segment of the same cluster saw ALPHA's tile light for it. cluster-b
  // never did, so the held state is a relic there, and the diarizer's second
  // voice stays anonymous: not BETA (elimination), not ALPHA (a stale tile).
  assert.deepEqual(absence.segments[1]?.speaker, { kind: "anonymous", label: "speaker_02" });
  assert.equal(absence.segments[1]?.provenance.reason, "ui_insufficient");
  assert.equal(absence.segments[1]?.cluster, "cluster-b");
  // The held evidence is still on the record: ALPHA's tile covered it.
  assert.deepEqual(absence.segments[1]?.provenance.uiExactMs, { [ALPHA]: 10_000 });
  assert.deepEqual(absence.silentAttendees, [BETA]);
});

test("a held UI state never names a later segment, even when its cluster matches", () => {
  // ALPHA lit at 9.9s for dia_01 and nothing changed afterwards (nobody else
  // lit a tile). dia_03 is the same voice cluster, so the held state is
  // consistent with the diarizer, but a cluster cannot turn a stale tile into
  // evidence that this person is still present and speaking.
  const result = reconcileTranscript(
    input({
      liveSegments: LIVE_FOR_ONLINE,
      reconciliation: {
        segments: [ONLINE.segments[0] as DiarizedSegment, ONLINE.segments[2] as DiarizedSegment],
        warnings: [],
      },
      evidence: [exact(9_900, ALPHA)],
    }),
  );
  assert.notEqual(result.segments.find((segment) => segment.segmentId === "dia_03")?.speaker.kind, "named");
});

test("clusters can only take a name away, never grant one: a fresh name on one cluster does not spread to its unobserved siblings' text", () => {
  // Same shape as above but the sibling segment is under an `ambiguous`
  // observation: the cluster agrees it is ALPHA's voice, and the segment is
  // STILL ambiguous, because the only thing that names is UI evidence on the
  // segment itself.
  const result = reconcileTranscript(
    input({
      liveSegments: LIVE_FOR_ONLINE,
      reconciliation: {
        segments: [ONLINE.segments[0] as DiarizedSegment, ONLINE.segments[2] as DiarizedSegment],
        warnings: [],
      },
      evidence: [exact(9_900, ALPHA), ambiguous(39_000)],
    }),
  );
  assert.notEqual(result.segments.find((segment) => segment.segmentId === "dia_03")?.speaker.kind, "named");
});

test("a cluster whose UI-named segments disagree resolves to ambiguous for the whole cluster, with a warning", () => {
  const result = reconcileTranscript(
    input({
      liveSegments: LIVE_FOR_ONLINE,
      reconciliation: ONLINE,
      // cluster-a: dia_01 under ALPHA, dia_03 under BETA. Either the UI or the
      // diarizer is wrong about one of them, and nothing here can say which.
      evidence: [exact(9_900, ALPHA), ambiguous(19_000), exact(39_900, BETA), ambiguous(49_000)],
    }),
  );
  assert.deepEqual(result.segments[0]?.speaker, { kind: "ambiguous" });
  assert.equal(result.segments[0]?.provenance.reason, "cluster_conflict");
  assert.deepEqual(result.segments[2]?.speaker, { kind: "ambiguous" });
  // The direct UI evidence is still on the record for a human to review.
  assert.deepEqual(result.segments[0]?.provenance.uiExactMs, { [ALPHA]: 4_000 });
  assert.deepEqual(result.segments[2]?.provenance.uiExactMs, { [BETA]: 4_000 });
  assert.deepEqual(result.warnings, [
    { code: "cluster_identity_conflict", cluster: "cluster-a", feishuUserIds: [ALPHA, BETA] },
  ]);
  // An attribution conflict is not transcription incompleteness.
  assert.equal(result.transcriptComplete, true);
});

test("a live segment the reconciliation did not cover is kept, with its own wording, and flagged", () => {
  const result = reconcileTranscript(
    input({
      liveSegments: [...LIVE_FOR_ONLINE, live("seg_99", 100_000, 104_000, "the diarizer missed this")],
      reconciliation: ONLINE,
    }),
  );
  const stray = result.segments.find((s) => s.segmentId === "seg_99");
  assert.ok(stray);
  assert.equal(stray.text, "the diarizer missed this");
  assert.equal(stray.provenance.wording, "live");
  assert.equal(stray.cluster, null);
  assert.deepEqual(result.warnings, [{ code: "live_segment_outside_reconciliation", segmentIds: ["seg_99"] }]);
  assert.equal(result.transcriptComplete, false);
});

test("runtime warnings pass through as their own code and make the transcript incomplete", () => {
  const result = reconcileTranscript(
    input({
      liveSegments: LIVE_FOR_ONLINE,
      reconciliation: { ...ONLINE, warnings: ["partial_decode"] },
    }),
  );
  assert.deepEqual(codes(result), ["runtime_warning"]);
  assert.equal(result.transcriptComplete, false);
});

test("a reconciliation with no segments while the meeting had speech is incomplete, and the live wording is kept", () => {
  const result = reconcileTranscript(
    input({
      liveSegments: LIVE_FOR_ONLINE,
      reconciliation: { segments: [], warnings: [] },
    }),
  );
  assert.equal(result.segments.length, 4);
  assert.deepEqual(codes(result), ["reconciliation_empty", "live_segment_outside_reconciliation"]);
  assert.equal(result.transcriptComplete, false);
});

test("a silent meeting -- no live speech, no diarized speech -- is complete and empty", () => {
  const result = reconcileTranscript(input({ reconciliation: { segments: [], warnings: [] } }));
  assert.deepEqual(result.segments, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.transcriptComplete, true);
  assert.deepEqual(result.silentAttendees, [ALPHA, BETA, GAMMA]);
});

// ---------------------------------------------------------------------------
// 3. Post-meeting diarization: the local SpeechBrain backend (ruling R55)
// ---------------------------------------------------------------------------

const LOCAL: RecordingReconciliation = {
  segments: ONLINE.segments.map((segment) => ({ ...segment, text: "" })),
  warnings: [],
};

test("local backend: empty reconciled text falls back to live wording by media-timeline overlap, and the transcript is NOT empty", () => {
  const result = reconcileTranscript(
    input({
      liveSegments: LIVE_FOR_ONLINE,
      reconciliation: LOCAL,
      evidence: [exact(9_900, ALPHA), ambiguous(19_000), exact(39_900, ALPHA), ambiguous(49_000)],
    }),
  );
  assert.deepEqual(
    result.segments.map((s) => [s.segmentId, s.text, s.cluster, s.speaker]),
    [
      ["seg_01", "we should ship on Friday", "cluster-a", { kind: "named", feishuUserId: ALPHA }],
      ["seg_02", "friday is tight for backend", "cluster-b", { kind: "ambiguous" }],
      ["seg_03", "then thursday code freeze", "cluster-a", { kind: "named", feishuUserId: ALPHA }],
      ["seg_04", "the long explanation", "cluster-b", { kind: "ambiguous" }],
    ],
  );
  for (const segment of result.segments) {
    assert.notEqual(segment.text, "");
    assert.equal(segment.provenance.wording, "live");
  }
  // Empty text is normal for the local cluster-only backend. Coverage, not a
  // second transcription, controls completeness.
  assert.deepEqual(result.warnings, [{ code: "reconciled_text_missing", segments: 4 }]);
  assert.equal(result.transcriptComplete, true);
});

test("local backend: anonymous labels follow the clusters, so the same voice keeps the same speaker_NN", () => {
  const result = reconcileTranscript(input({ liveSegments: LIVE_FOR_ONLINE, reconciliation: LOCAL }));
  assert.deepEqual(
    result.segments.map((s) => s.speaker),
    [
      { kind: "anonymous", label: "speaker_01" },
      { kind: "anonymous", label: "speaker_02" },
      { kind: "anonymous", label: "speaker_01" },
      { kind: "anonymous", label: "speaker_02" },
    ],
  );
});

test("local backend: a live segment straddling two clusters is overlapping speech -- ambiguous, no cluster, and flagged", () => {
  const result = reconcileTranscript(
    input({
      liveSegments: [live("seg_01", 10_000, 30_000, "the STT ran two people together")],
      reconciliation: {
        segments: [diarized("dia_01", 10_000, 20_000, "cluster-a"), diarized("dia_02", 20_000, 30_000, "cluster-b")],
        warnings: [],
      },
      // The UI says ALPHA the whole time; the diarizer says two voices. That
      // is a conflict, and a conflict never resolves to a name.
      evidence: [exact(10_000, ALPHA)],
    }),
  );
  const segment = only(result);
  assert.deepEqual(segment.speaker, { kind: "ambiguous" });
  assert.equal(segment.cluster, null);
  assert.equal(segment.provenance.reason, "multi_voice");
  assert.equal(segment.text, "the STT ran two people together");
  assert.deepEqual(codes(result).sort(), ["multi_voice_live_segment", "reconciled_text_missing"]);
});

test("local backend: a diarized segment the STT heard nothing in is dropped, not emitted as an empty line", () => {
  const result = reconcileTranscript(
    input({
      liveSegments: [live("seg_01", 10_000, 14_000, "only this was transcribed")],
      reconciliation: LOCAL,
    }),
  );
  assert.deepEqual(
    result.segments.map((s) => s.segmentId),
    ["seg_01"],
  );
  assert.equal(only(result).cluster, "cluster-a");
});

test("duplicate empty-text diarization rows covering only part of live speech cannot certify it complete", () => {
  const result = reconcileTranscript(input({
    liveSegments: [live("seg_duplicate", 10_000, 20_000, "all ten seconds must survive")],
    reconciliation: {
      segments: [
        diarized("dia_one", 10_000, 14_000, "cluster-a"),
        diarized("dia_duplicate", 10_000, 14_000, "cluster-a"),
      ],
      warnings: [],
    },
  }));
  assert.ok(result.segments.some((segment) => segment.segmentId === "seg_duplicate"));
  assert.ok(codes(result).includes("live_segment_outside_reconciliation"));
  assert.equal(result.transcriptComplete, false);
});

test("R55 union coverage handles overlapping, nested, adjacent, and gapped diarization without duplicate credit", () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly ranges: readonly [number, number][]; readonly complete: boolean }> = [
    { name: "overlapping partial", ranges: [[10_000, 14_000], [13_000, 16_000]], complete: false },
    { name: "nested full", ranges: [[10_000, 20_000], [12_000, 14_000]], complete: true },
    { name: "adjacent full", ranges: [[10_000, 15_000], [15_000, 20_000]], complete: true },
    { name: "partial gap", ranges: [[10_000, 14_000], [16_000, 20_000]], complete: false },
  ];
  for (const fixture of cases) {
    const result = reconcileTranscript(input({
      liveSegments: [live(`seg_${fixture.name}`, 10_000, 20_000, "local wording")],
      reconciliation: { segments: fixture.ranges.map(([start, end], index) => diarized(`dia_${index}`, start, end, "cluster-a")), warnings: [] },
    }));
    assert.equal(result.transcriptComplete, fixture.complete, fixture.name);
    assert.equal(codes(result).includes("live_segment_outside_reconciliation"), !fixture.complete, fixture.name);
    assert.equal(result.segments.filter((segment) => segment.text === "local wording").length, 1, fixture.name);
  }
});

test("an unanchored online reconciliation keeps durable live wording exactly once", () => {
  const result = reconcileTranscript(input({
    alignment: null,
    liveSegments: [live("seg_once", 10_000, 14_000, "do not duplicate this")],
    reconciliation: { segments: [diarized("dia_once", 10_000, 14_000, "cluster-a", "do not duplicate this")], warnings: [] },
  }));
  assert.deepEqual(result.segments.map((segment) => segment.text), ["do not duplicate this"]);
  assert.ok(result.segments.every((segment) => segment.speaker.kind !== "named"));
  assert.equal(result.transcriptComplete, false);
});

// ---------------------------------------------------------------------------
// 4. reconcileSpeakers: the persisted handle and the runtime call
// ---------------------------------------------------------------------------

const RECORDING_ROW: RecordingRow = {
  occurrenceId: "synthetic-meeting-0001@2026-09-02T14:00:00Z",
  handle: "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
  encryptedPath: "/synthetic-runtime/recordings/0a1b2c3d4e5f60718293a4b5c6d7e8f9.enc",
  sha256: "0".repeat(64),
  durationMs: 3_600_000,
  format: "ogg/opus",
  keyId: "runtime-key-20260902",
  finalizedAtMs: Date.parse(ENDED_AT),
  gaps: [],
  runtimeGaps: [],
};

function recordings(row: RecordingRow | null): { recording(occurrenceId: string): RecordingRow | null } {
  return {
    recording(occurrenceId: string) {
      return row !== null && row.occurrenceId === occurrenceId ? row : null;
    },
  };
}

test("reconcileSpeakers reads the PERSISTED handle and hands exactly that to reconcileRecording", async () => {
  const runtime = fakeRuntime({ reconciliation: ONLINE });
  const result = await reconcileSpeakers({
    occurrenceId: RECORDING_ROW.occurrenceId,
    sessionId: 17n,
    recordings: recordings(RECORDING_ROW),
    runtime,
    attendance: ATTENDANCE,
    liveSegments: LIVE_FOR_ONLINE,
    evidence: [],
    alignment: { kind: "durable_runtime_anchor", mediaOriginAt: ORIGIN, runtimeSessionId: 17n },
    endedAt: ENDED_AT,
  });
  assert.deepEqual(runtime.callsOf("reconcileRecording"), [
    { method: "reconcileRecording", input: { sessionId: 17n, recordingHandle: RECORDING_ROW.handle } },
  ]);
  assert.equal(result.recordingHandle, RECORDING_ROW.handle);
  assert.equal(result.transcriptComplete, true);
  assert.equal(result.segments[0]?.provenance.wording, "reconciled");
});

test("reconcileSpeakers with the fake's fully-covered local backend produces a worded, complete transcript", async () => {
  const runtime = fakeRuntime({ reconciliation: ONLINE, diarizationBackend: "local" });
  const result = await reconcileSpeakers({
    occurrenceId: RECORDING_ROW.occurrenceId,
    sessionId: 17n,
    recordings: recordings(RECORDING_ROW),
    runtime,
    attendance: ATTENDANCE,
    liveSegments: LIVE_FOR_ONLINE,
    evidence: [],
    alignment: { kind: "durable_runtime_anchor", mediaOriginAt: ORIGIN, runtimeSessionId: 17n },
    endedAt: ENDED_AT,
  });
  assert.equal(result.segments.length, 4);
  for (const segment of result.segments) assert.notEqual(segment.text, "");
  assert.deepEqual(codes(result), ["reconciled_text_missing"]);
  assert.equal(result.transcriptComplete, true);
});

test("no trustworthy media anchor fails closed: live wording is retained but nobody is named", () => {
  const result = reconcileTranscript(
    input({
      alignment: null,
      liveSegments: [live("seg_anchor", 10_000, 14_000, "keep this wording")],
      evidence: [exact(9_900, ALPHA)],
      reconciliation: { segments: [diarized("dia_anchor", 10_000, 14_000, "cluster-a", "keep this wording")], warnings: [] },
    }),
  );
  assert.deepEqual(result.segments.map((segment) => segment.speaker.kind), ["anonymous"]);
  assert.deepEqual(codes(result).sort(), ["media_timeline_alignment_unavailable"]);
  assert.equal(result.transcriptComplete, false);
});

test("the durable production entry cannot promote exact UI evidence without a persisted Runtime anchor", async () => {
  const runtime = fakeRuntime({ reconciliation: ONLINE });
  const durable: ReconciliationEvidenceRow = {
    occurrenceId: RECORDING_ROW.occurrenceId,
    generationId: "bridge_durable",
    runtimeSessionId: 9_007_199_254_740_993n,
    alignment: null,
    alignmentStatus: "unavailable_current_sdk",
    captureComplete: true,
    incompleteReason: null,
    expiresAtMs: Date.parse(ENDED_AT) + 14 * 24 * 60 * 60 * 1000,
    bridgeEvents: [
      { generationId: "bridge_durable", bridgeSessionId: "bridge_durable", sequence: 1, schema: "bridge-session/v1", observedAt: at(0), type: "participant_joined", feishuUserId: ALPHA, displayName: "Alpha Synthetic", confidence: null },
      { generationId: "bridge_durable", bridgeSessionId: "bridge_durable", sequence: 2, schema: "bridge-session/v1", observedAt: at(9_900), type: "active_speaker", feishuUserId: ALPHA, displayName: null, confidence: "ui_exact" },
    ],
    liveSegments: [{ ...live("seg_durable", 10_000, 14_000, "durably retained wording"), generationId: "bridge_durable" }],
  };
  const result = await reconcilePersistedSpeakers({
    occurrenceId: RECORDING_ROW.occurrenceId,
    recordings: recordings(RECORDING_ROW),
    evidence: { reconciliationEvidence: () => durable },
    runtime,
  });
  assert.deepEqual(runtime.callsOf("reconcileRecording"), [
    { method: "reconcileRecording", input: { sessionId: 9_007_199_254_740_993n, recordingHandle: RECORDING_ROW.handle } },
  ]);
  assert.ok(result.segments.some((segment) => segment.text === "durably retained wording"));
  assert.ok(result.segments.every((segment) => segment.speaker.kind !== "named"));
  assert.ok(codes(result).includes("media_timeline_alignment_unavailable"));
  assert.equal(result.transcriptComplete, false);
});

test("missing durable runtime identity still returns persisted attendance and live wording", async () => {
  const durable: ReconciliationEvidenceRow = {
    occurrenceId: RECORDING_ROW.occurrenceId,
    generationId: "bridge_no_runtime",
    runtimeSessionId: null,
    alignment: null,
    alignmentStatus: "unavailable_current_sdk",
    captureComplete: true,
    incompleteReason: null,
    expiresAtMs: Date.parse(ENDED_AT) + 14 * 24 * 60 * 60 * 1000,
    bridgeEvents: [{ generationId: "bridge_no_runtime", bridgeSessionId: "bridge_no_runtime", sequence: 1, schema: "bridge-session/v1", observedAt: at(0), type: "participant_joined", feishuUserId: ALPHA, displayName: "Alpha Synthetic", confidence: null }],
    liveSegments: [{ ...live("seg_before_start_failure", 10_000, 14_000, "words before runtime start failure"), generationId: "bridge_no_runtime" }],
  };
  const result = await reconcilePersistedSpeakers({
    occurrenceId: RECORDING_ROW.occurrenceId,
    recordings: recordings(null),
    evidence: { reconciliationEvidence: () => durable },
    runtime: fakeRuntime(),
  });
  assert.deepEqual(result.segments.map((segment) => segment.text), ["words before runtime start failure"]);
  assert.deepEqual(result.silentAttendees, [ALPHA]);
  assert.equal(result.recordingHandle, null);
  assert.ok(codes(result).includes("reconciliation_unavailable"));
  assert.equal(result.transcriptComplete, false);
});

test("a Runtime bigint beyond JavaScript's exact timeline range fails closed without coercing it", async () => {
  const runtime = fakeRuntime({
    reconciliation: {
      segments: [{
        segmentId: "dia_too_large",
        startedAtMs: BigInt(Number.MAX_SAFE_INTEGER),
        endedAtMs: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        text: "runtime text must not be rounded",
        speakerCluster: "cluster-a",
      }],
      warnings: [],
    },
  });
  const result = await reconcileSpeakers({
    occurrenceId: RECORDING_ROW.occurrenceId,
    sessionId: 17n,
    recordings: recordings(RECORDING_ROW),
    runtime,
    attendance: ATTENDANCE,
    liveSegments: [live("seg_safe", 10_000, 14_000, "retained live wording")],
    evidence: [exact(9_900, ALPHA)],
    alignment: { kind: "durable_runtime_anchor", mediaOriginAt: ORIGIN, runtimeSessionId: 17n },
    endedAt: ENDED_AT,
  });
  assert.equal(result.segments[0]?.text, "retained live wording");
  assert.deepEqual(result.warnings, [{ code: "reconciliation_unavailable", detail: "diarized dia_too_large endedAtMs exceeds JavaScript's exact numeric timeline range" }]);
  assert.equal(result.transcriptComplete, false);
});

test("an anchor with a different Runtime bigint session is rejected rather than used to name", async () => {
  const runtime = fakeRuntime();
  const result = await reconcileSpeakers({
    occurrenceId: RECORDING_ROW.occurrenceId,
    sessionId: 17n,
    recordings: recordings(null),
    runtime,
    attendance: ATTENDANCE,
    liveSegments: [live("seg_wrong_session", 10_000, 14_000, "retain")],
    evidence: [exact(9_900, ALPHA)],
    alignment: { kind: "durable_runtime_anchor", mediaOriginAt: ORIGIN, runtimeSessionId: 18n },
    endedAt: ENDED_AT,
  });
  assert.notEqual(result.segments[0]?.speaker.kind, "named");
  assert.ok(codes(result).includes("media_timeline_alignment_unavailable"));
});

test("an uncovered live interval is incomplete even when another reconciled interval has wording", () => {
  const result = reconcileTranscript(
    input({
      liveSegments: [live("seg_covered", 10_000, 14_000, "covered"), live("seg_missed", 20_000, 24_000, "must survive")],
      reconciliation: { segments: [diarized("dia_covered", 10_000, 14_000, "cluster-a", "covered")], warnings: [] },
    }),
  );
  assert.ok(result.segments.some((segment) => segment.segmentId === "seg_missed" && segment.text === "must survive"));
  assert.equal(result.transcriptComplete, false);
  assert.deepEqual(codes(result), ["live_segment_outside_reconciliation"]);
});

test("unclustered speech gets stable deterministic speaker labels instead of null", () => {
  const result = reconcileTranscript(
    input({
      liveSegments: [live("seg_b", 20_000, 24_000, "second"), live("seg_a", 10_000, 14_000, "first")],
      reconciliation: { unavailable: "offline" },
    }),
  );
  assert.deepEqual(result.segments.map((segment) => segment.speaker), [
    { kind: "anonymous", label: "speaker_01" },
    { kind: "anonymous", label: "speaker_02" },
  ]);
});

test("a participant whose exact UI evidence overlaps speech but cannot name it is not reported silent", () => {
  const result = reconcileTranscript(
    input({
      attendance: [attendee(ALPHA, "Alpha Synthetic"), attendee(BETA, "Beta Synthetic")],
      liveSegments: [live("seg_short", 10_000, 20_000, "short signal")],
      evidence: [exact(18_000, ALPHA)],
      reconciliation: { unavailable: "offline" },
    }),
  );
  assert.deepEqual(result.silentAttendees, [BETA]);
  assert.deepEqual(result.spokeButUnattributed, [ALPHA]);
});

test("a tile held after its participant left cannot name later speech", () => {
  const result = reconcileTranscript(
    input({
      attendance: [{ feishuUserId: ALPHA, displayName: "Alpha Synthetic", joinedAt: at(0), leftAt: at(14_000) }],
      liveSegments: [live("seg_after_leave", 20_000, 24_000, "someone else spoke")],
      evidence: [exact(9_900, ALPHA)],
      reconciliation: { unavailable: "offline" },
    }),
  );
  assert.notEqual(only(result).speaker.kind, "named");
  assert.deepEqual(result.spokeButUnattributed, []);
});

test("mixed timestamp precision is ordered by instant, then bridge sequence, never lexical spelling", () => {
  const result = reconcileTranscript(
    input({
      liveSegments: [live("seg_order", 10_000, 14_000, "ordered")],
      evidence: [
        { bridgeSessionId: "bridge_synthetic", sequence: 2, observedAt: "2026-09-02T14:00:10.000Z", confidence: "ambiguous", feishuUserId: null },
        { bridgeSessionId: "bridge_synthetic", sequence: 1, observedAt: "2026-09-02T14:00:10Z", confidence: "ui_exact", feishuUserId: ALPHA },
      ],
      reconciliation: { unavailable: "offline" },
    }),
  );
  assert.deepEqual(result.evidence.map((event) => event.sequence), [1, 2]);
  assert.notEqual(only(result).speaker.kind, "named");
});

test("no persisted recording: the runtime is never called, the transcript is live-only and incomplete", async () => {
  const runtime = fakeRuntime({ reconciliation: ONLINE });
  const result = await reconcileSpeakers({
    occurrenceId: RECORDING_ROW.occurrenceId,
    sessionId: 17n,
    recordings: recordings(null),
    runtime,
    attendance: ATTENDANCE,
    liveSegments: LIVE_FOR_ONLINE,
    evidence: [exact(9_900, ALPHA), ambiguous(19_000)],
    alignment: { kind: "durable_runtime_anchor", mediaOriginAt: ORIGIN, runtimeSessionId: 17n },
    endedAt: ENDED_AT,
  });
  assert.deepEqual(runtime.callsOf("reconcileRecording"), []);
  assert.equal(result.recordingHandle, null);
  assert.equal(result.segments.length, 4);
  assert.deepEqual(result.segments[0]?.speaker, { kind: "named", feishuUserId: ALPHA });
  assert.equal(result.warnings[0]?.code, "reconciliation_unavailable");
  assert.equal(result.transcriptComplete, false);
});

test("a reconcileRecording failure is a typed warning, not a thrown error, and the live transcript survives", async () => {
  const runtime = fakeRuntime({ reconcileRecordingError: new Error("synthetic diarization outage") });
  const result = await reconcileSpeakers({
    occurrenceId: RECORDING_ROW.occurrenceId,
    sessionId: 17n,
    recordings: recordings(RECORDING_ROW),
    runtime,
    attendance: ATTENDANCE,
    liveSegments: LIVE_FOR_ONLINE,
    evidence: [],
    alignment: { kind: "durable_runtime_anchor", mediaOriginAt: ORIGIN, runtimeSessionId: 17n },
    endedAt: ENDED_AT,
  });
  assert.equal(runtime.callsOf("reconcileRecording").length, 1);
  assert.equal(result.recordingHandle, RECORDING_ROW.handle);
  assert.deepEqual(result.warnings, [
    { code: "reconciliation_unavailable", detail: "synthetic diarization outage" },
  ]);
  assert.equal(result.transcriptComplete, false);
  assert.equal(result.segments.length, 4);
});

test("reconcileRecording is refused by the fake while the voice session is live, and the refusal surfaces as unavailable", async () => {
  // The runtime refuses processText and reconcileRecording while a voice
  // session is live (runtime-sdk-ready.md, behavioural constraints). The fake
  // enforces it; a reconciler that ran before the meeting ended would see
  // exactly this.
  const runtime = fakeRuntime({ reconciliation: ONLINE });
  await runtime.startVoiceSession({ profile: "online", responseMode: "external_gate" });
  const result = await reconcileSpeakers({
    occurrenceId: RECORDING_ROW.occurrenceId,
    sessionId: 17n,
    recordings: recordings(RECORDING_ROW),
    runtime,
    attendance: ATTENDANCE,
    liveSegments: LIVE_FOR_ONLINE,
    evidence: [],
    alignment: { kind: "durable_runtime_anchor", mediaOriginAt: ORIGIN, runtimeSessionId: 17n },
    endedAt: ENDED_AT,
  });
  assert.equal(result.warnings[0]?.code, "reconciliation_unavailable");
  assert.match(String((result.warnings[0] as { detail: string }).detail), /live/);
});

// ---------------------------------------------------------------------------
// 5. The invariant, over random inputs
// ---------------------------------------------------------------------------

/** Deterministic xorshift so a failure is reproducible from the seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

test("PROPERTY: every named segment has one identity covering >= MIN_ALIGNED_COVERAGE with <= MAX_CONFLICTING_OVERLAP_MS against it, and no evidence-free meeting names anyone", () => {
  const random = prng(20260902);
  const ids = [ALPHA, BETA, GAMMA];
  for (let round = 0; round < 300; round += 1) {
    const evidence: ActiveSpeakerObservation[] = [];
    const observations = Math.floor(random() * 8);
    let cursor = 0;
    for (let i = 0; i < observations; i += 1) {
      cursor += Math.floor(random() * 15_000);
      evidence.push(
        random() < 0.2 ? ambiguous(cursor) : exact(cursor, ids[Math.floor(random() * ids.length)] as string),
      );
    }
    const liveSegments: TranscriptSegment[] = [];
    let start = Math.floor(random() * 5_000);
    for (let i = 0; i < 6; i += 1) {
      const duration = 500 + Math.floor(random() * 20_000);
      liveSegments.push(live(`seg_${i}`, start, start + duration, `utterance ${i}`));
      start += duration + Math.floor(random() * 3_000);
    }
    const useClusters = random() < 0.5;
    const reconciliation: RecordingReconciliation | { readonly unavailable: string } = useClusters
      ? {
          segments: liveSegments.map((segment, i) =>
            diarized(
              `dia_${i}`,
              Date.parse(segment.startedAt) - ORIGIN_MS,
              Date.parse(segment.endedAt) - ORIGIN_MS,
              `cluster-${Math.floor(random() * 3)}`,
              random() < 0.5 ? "" : `reconciled ${i}`,
            ),
          ),
          warnings: [],
        }
      : { unavailable: "not requested" };

    const result = reconcileTranscript(input({ liveSegments, evidence, reconciliation }));
    for (const segment of result.segments) {
      const duration = segment.endedAtMs - segment.startedAtMs;
      const observedIds = new Set(evidence.filter((e) => e.confidence === "ui_exact").map((e) => e.feishuUserId));
      if (segment.speaker.kind !== "named") continue;
      const named = segment.speaker.feishuUserId;
      assert.ok(observedIds.has(named), `round ${round}: named ${named} was never observed by the UI`);
      const covered = segment.provenance.uiExactMs[named] ?? 0;
      const conflicting =
        segment.provenance.ambiguousMs +
        Object.entries(segment.provenance.uiExactMs)
          .filter(([id]) => id !== named)
          .reduce((sum, [, ms]) => sum + ms, 0);
      assert.ok(covered >= MIN_ALIGNED_COVERAGE * duration, `round ${round}: coverage ${covered}/${duration}`);
      assert.ok(conflicting <= MAX_CONFLICTING_OVERLAP_MS, `round ${round}: conflicting ${conflicting}`);
    }
    if (evidence.every((e) => e.confidence !== "ui_exact")) {
      assert.ok(
        result.segments.every((s) => s.speaker.kind !== "named"),
        `round ${round}: named without any ui_exact observation`,
      );
    }
  }
});

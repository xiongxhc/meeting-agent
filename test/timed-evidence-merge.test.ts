import assert from "node:assert/strict";
import { test } from "node:test";
import * as owned from "../src/domain/attribution-evidence.ts";
import * as merge from "../src/sessions/timed-evidence-merge.ts";
import type { DiarizedSegment, RecordingAlignmentEntry, VersionFourVoiceTranscriptFinalEvent } from "@conversation/runtime";
import type { BridgeEventMessageV2 } from "../src/contracts/bridge-session-v2.ts";

function ui(sequence: number, before: bigint, id: string | null = "person"): Extract<BridgeEventMessageV2, { type: "ui_snapshot" }> {
  return { schema: "bridge-session/v2", sessionId: "bridge", sequence, type: "ui_snapshot", snapshotSequence: sequence,
    observedAt: "2026-09-02T14:00:00Z", observationTiming: { clockDomainId: "domain", hostBeforeNs: before.toString(), hostAfterNs: (before + 1n).toString() },
    state: id === null ? "unknown" : "ui_exact", feishuUserId: id, reason: id === null ? "no_highlight" : null, barrierBefore: null };
}
function joinedUi(): Extract<BridgeEventMessageV2, { type: "participant_joined" }> {
  return { schema: "bridge-session/v2", sessionId: "bridge", sequence: 1, type: "participant_joined", observedAt: "2026-09-02T14:00:00Z",
    feishuUserId: "person", displayName: "Person", observationTiming: { clockDomainId: "domain", hostBeforeNs: "1", hostAfterNs: "2" }, observationTimingReason: null };
}

test("streamed UI cursor requires full frame containment with exact endpoint equality", () => {
  const observations = [joinedUi(), ui(2, 900000000n, null), ui(3, 990000000n), ui(4, 1020000000n), ui(5, 1040000000n)];
  let reads = 0;
  const iterable = { *[Symbol.iterator]() { for (const event of observations) { reads++; yield event; } } };
  const cursor = new merge.FrameUiCursor(iterable, "bridge");
  const result = cursor.read(frameWall());
  assert.equal(result.candidate, "person"); assert.equal(result.activationNs, 900000000n);
  assert.ok(reads <= 5, "only bounded lookahead is consumed");
  const miss = new merge.FrameUiCursor(observations.slice(0, 3).concat(ui(4, 1019999999n)), "bridge").read(frameWall());
  assert.equal(miss.candidate, null);
});

test("UI missing attendance, two-second gaps and unreadable barriers cannot supply a full-frame name", () => {
  const positive = [ui(2, 900000000n, null), ui(3, 990000000n), ui(4, 1020000000n)];
  assert.equal(new merge.FrameUiCursor(positive, "bridge").read(frameWall()).candidate, null);
  const gap = [joinedUi(), ui(2, 2n, null), ui(3, 10n), ui(4, 3000000000n)];
  assert.equal(new merge.FrameUiCursor(gap, "bridge").read(frameWall()).candidate, null);
  const barrier = [...positive.slice(0, 2), { ...ui(4, 1010000000n), type: "ui_snapshot" as const, state: "unreadable" as const,
    feishuUserId: null, reason: "snapshot_unreadable" as const }, ui(5, 1020000000n)];
  assert.equal(new merge.FrameUiCursor([joinedUi(), ...barrier], "bridge").read(frameWall()).candidate, null);
});

test("UI snapshot holes and regressing host brackets cannot authorize a frame", () => {
  const base = [joinedUi(), ui(2, 900000000n, null), ui(3, 990000000n)];
  assert.equal(new merge.FrameUiCursor([...base, { ...ui(4, 1020000000n), snapshotSequence: 5 }], "bridge").read(frameWall()).candidate, null);
  const regressed: BridgeEventMessageV2 = { ...joinedUi(), sequence: 4, observationTiming: { clockDomainId: "domain", hostBeforeNs: "3", hostAfterNs: "4" } };
  assert.throws(() => new merge.FrameUiCursor([...base, regressed, { ...ui(5, 1020000000n), snapshotSequence: 4 }], "bridge").read(frameWall()), /clock regressed/);
});

test("a nonnominal frame cannot earn a name or wall endpoints even with a span-shaped object", async () => {
  const source = { sourceSessionId: 41n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64) };
  const result = await merge.mergeTimedRecordingEvidence({ source, bridgeSessionId: "bridge", entries: [{ ...frameWall(),
    provenance: { ...frameWall().provenance!, quality: "unknown_priming" } }],
    ui: [joinedUi(), ui(2, 900000000n, null), ui(3, 990000000n), ui(4, 1020000000n)], live: [],
    final: { source, segments: [final("a", 0n, 480n)], warnings: [] }, uiLossReason: null, wordingLossReason: null });
  assert.equal(result.segments[0]?.speaker.kind, "anonymous"); assert.equal(result.segments[0]?.wall, null);
  assert.equal(result.segments[0]?.text, "final wording"); assert.equal(result.transcriptComplete, true);
});

test("durable administrative rows between snapshots do not erase observed attendance or UI coverage", () => {
  const base = [joinedUi(), ui(2, 900000000n, null), ui(3, 990000000n)];
  const admin: BridgeEventMessageV2 = { schema: "bridge-session/v2", sessionId: "bridge", sequence: 4, observedAt: "2026-09-02T14:00:00Z",
    type: "command_result", commandId: "command", outcome: "ok", detail: null };
  const result = new merge.FrameUiCursor([...base, admin, { ...ui(5, 1020000000n), snapshotSequence: 4 }], "bridge").read(frameWall());
  assert.equal(result.candidate, "person");
  for (const payload of [{ type: "media_disconnected", reason: "synthetic" }, { type: "reconnecting", attempt: 1 }] as const) {
    const barrier = { schema: "bridge-session/v2" as const, sessionId: "bridge", sequence: 4, observedAt: "2026-09-02T14:00:00Z", ...payload };
    assert.equal(new merge.FrameUiCursor([...base, barrier, { ...ui(5, 1020000000n), snapshotSequence: 4 }], "bridge").read(frameWall()).candidate, null);
  }
});

test("selected frame merge earns a name from observed full-frame coverage, not provisional result or display ms", async () => {
  const source = { sourceSessionId: 41n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64) };
  const result = await merge.mergeTimedRecordingEvidence({ source, bridgeSessionId: "bridge", entries: [frameWall()],
    ui: [joinedUi(), ui(2, 900000000n, null), ui(3, 990000000n), ui(4, 1020000000n)],
    live: [], final: { source, segments: [final("one", 0n, 480n)], warnings: [] }, uiLossReason: null, wordingLossReason: null });
  assert.deepEqual(result.segments[0]?.speaker, { kind: "named", feishuUserId: "person" });
  assert.equal(owned.getOwnedTimedSampleSnapshot(result.segments[0]?.sampleEvidence)?.candidateLower[0]?.[1], 478n);
  assert.equal(result.segments[0]?.wall?.startedAt, "1969-12-31T23:59:59.999998Z");
  assert.equal(result.transcriptComplete, true);
});

test("unlocated UI loss disables only naming while independent full final wording recovers live-cache loss", async () => {
  const source = { sourceSessionId: 41n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64) };
  const result = await merge.mergeTimedRecordingEvidence({ source, bridgeSessionId: "bridge", entries: [frameWall()],
    ui: [joinedUi(), ui(2, 900000000n, null), ui(3, 990000000n), ui(4, 1020000000n)],
    live: [], final: { source, segments: [final("one", 0n, 480n)], warnings: [] }, uiLossReason: "ui_sequence_gap", wordingLossReason: "runtime_queue_overflow" });
  assert.equal(result.segments[0]?.speaker.kind, "anonymous");
  assert.equal(result.segments[0]?.text, "final wording");
  assert.equal(result.transcriptComplete, true);
  assert.ok(result.warnings.some(({ code }) => code === "timed_ui_evidence_loss"));
  const lostWithRegressedRead = await merge.mergeTimedRecordingEvidence({ source, bridgeSessionId: "bridge", entries: [frameWall()],
    ui: [joinedUi(), ui(2, 990000000n), ui(3, 900000000n)], live: [],
    final: { source, segments: [final("one", 0n, 480n)], warnings: [] }, uiLossReason: "ui_invalid", wordingLossReason: null });
  assert.equal(lostWithRegressedRead.segments[0]?.text, "final wording");
  assert.equal(lostWithRegressedRead.segments[0]?.speaker.kind, "anonymous");
});

test("live submitted samples map through exact epoch and frame provenance before whole-buffer replacement", async () => {
  const source = { sourceSessionId: 41n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64) };
  const liveEvent: VersionFourVoiceTranscriptFinalEvent = { type: "voice_transcript_final", sessionId: 41n, segmentId: "item", turnId: null,
    text: "live original", capture: { kind: "source_sample_range/v1", clockDomainId: "domain", captureEpoch: 1n, firstFrameSequence: 1n,
      lastFrameSequence: 1n, sourceStartSample: 24n, sourceEndSample: 456n, sampleRateHz: 24000 } };
  const input = { source, bridgeSessionId: "bridge", entries: [frameWall()],
    ui: [joinedUi(), ui(2, 900000000n, null), ui(3, 990000000n), ui(4, 1020000000n)],
    live: [liveEvent], final: { source, segments: [final("batch", 24n, 456n, "final authoritative")], warnings: [] }, uiLossReason: null, wordingLossReason: null };
  const result = await merge.mergeTimedRecordingEvidence(input);
  assert.deepEqual(result.segments.map(({ text }) => text), ["final authoritative"]);
  const local = await merge.mergeTimedRecordingEvidence({ ...input, final: { ...input.final, segments: [final("batch", 0n, 480n, "")] } });
  assert.equal(local.segments[0]?.text, "live original");
  assert.deepEqual(local.segments[0]?.range, { startSampleInclusive: 24n, endSampleExclusive: 456n, sampleRateHz: 24000, gapOffsetMs: 0n });
  assert.equal(local.transcriptComplete, true);
  const mismatched = await merge.mergeTimedRecordingEvidence({ ...input, live: [{ ...liveEvent, capture: { ...liveEvent.capture!, captureEpoch: 2n } }] });
  assert.equal(mismatched.segments.length, 2); assert.equal(mismatched.transcriptComplete, false);
  assert.equal(mismatched.segments.find(({ wording }) => wording === "live")?.wall, null);
});

function frameWall(): Extract<RecordingAlignmentEntry, { kind: "frame" }> {
  return { kind: "frame", mediaStartSample: 0n, mediaEndSample: 480n, sampleRateHz: 24000, gapOffsetMs: 0n,
    epoch: { bridgeSessionId: "bridge", clockDomainId: "domain", captureEpoch: 1n },
    provenance: { captureEpoch: 1n, sequence: 1n, outputStartSample: 0n, sampleCount: 480,
      sourceStartNumerator: 0n, sourceEndNumerator: 11520000n, sourceDenominator: 24000, sourceRateHz: 24000,
      quality: "nominal_frame_endpoint_interpolation", span: { hostStartNs: 1000000000n, hostEndNs: 1020000000n, roundingEnvelopeNs: 1n, captureUncertaintyNs: null } },
    captureStatus: "available", reasons: [], wall: { quality: "local_wall_estimate", policyId: "local-wall-estimate/v1", localStartNs: -1001n, localEndNs: 19998999n,
      wallEpoch: 1n, wallRun: 1n, maximumBracketNs: 1n, maximumResolutionNs: 1n, modelAllowanceNs: 10000000n,
      interpolationRoundingNs: 1n, captureRoundingNs: 1n, captureUncertaintyNs: null, externalUtcAccuracyNs: null, overallPhysicalAccuracyNs: null } };
}

test("signed local-wall estimates floor negative sub-microseconds instead of inventing a millisecond", () => {
  assert.deepEqual(merge.localNsToArtifactInstant(-1n), { instant: "1969-12-31T23:59:59.999999Z", roundingNs: 999n });
  assert.deepEqual(merge.localNsToArtifactInstant(-1001n), { instant: "1969-12-31T23:59:59.999998Z", roundingNs: 999n });
  assert.deepEqual(merge.localNsToArtifactInstant(1999n), { instant: "1970-01-01T00:00:00.000001Z", roundingNs: 999n });
  assert.equal(merge.localNsToArtifactInstant(1n).instant, merge.localNsToArtifactInstant(999n).instant);
  const mapped = merge.mapFrameWallEndpoint(frameWall(), 1n);
  assert.equal(mapped?.localUnixNs, 40665n); // -1001 + floor(20,000,000 / 480)
  assert.equal(mapped?.mappingRoundingNs, 1n);
  assert.equal(merge.mapFrameWallEndpoint({ ...frameWall(), wall: null }, 1n), null);
  assert.equal(merge.mapFrameWallEndpoint(frameWall(), 481n), null);
});

test("one local-wall warning summarizes used components without turning unknown accuracy into zero", async () => {
  const source = { sourceSessionId: 41n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64) };
  const first = frameWall(), second = { ...frameWall(), mediaStartSample: 480n, mediaEndSample: 960n,
    provenance: { ...frameWall().provenance!, sequence: 2n, outputStartSample: 480n,
      span: { ...frameWall().provenance!.span!, hostStartNs: 1020000000n, hostEndNs: 1040000000n } },
    wall: { ...frameWall().wall!, localStartNs: 19998999n, localEndNs: 39998999n, maximumBracketNs: 5000000n,
      captureUncertaintyNs: 10n, externalUtcAccuracyNs: 20n } };
  const result = await merge.mergeTimedRecordingEvidence({ source, bridgeSessionId: "bridge", entries: [first, second], ui: [], live: [],
    final: { source, segments: [final("a", 1n, 479n), final("b", 480n, 960n)], warnings: [] }, uiLossReason: null, wordingLossReason: null });
  const warnings = result.warnings.filter(({ code }) => code === "local_wall_timestamp_estimate");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.detail, /maximumBracketNs=5000000;/);
  assert.match(warnings[0]!.detail, /captureUncertaintyNs=null;externalUtcAccuracyNs=null;/);
  assert.match(warnings[0]!.detail, /mappingRoundingNs=1;serializationRoundingNs=999;overallPhysicalUtcAccuracy=null$/);
  assert.ok(warnings[0]!.detail.length <= 500);
  assert.equal(result.transcriptComplete, true);
});

test("interior discontinuities, missing wall and changed epochs cannot be interpolated between valid endpoints", async () => {
  const source = { sourceSessionId: 41n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64) };
  const frame = (index: number): merge.AlignmentFrame => ({ ...frameWall(), mediaStartSample: BigInt(index * 480), mediaEndSample: BigInt((index + 1) * 480),
    provenance: { ...frameWall().provenance!, sequence: BigInt(index + 1), outputStartSample: BigInt(index * 480),
      span: { ...frameWall().provenance!.span!, hostStartNs: 1000000000n + BigInt(index * 20000000), hostEndNs: 1020000000n + BigInt(index * 20000000) } },
    wall: { ...frameWall().wall!, localStartNs: BigInt(index * 20000000), localEndNs: BigInt((index + 1) * 20000000) } });
  const run = (entries: RecordingAlignmentEntry[]) => merge.mergeTimedRecordingEvidence({ source, bridgeSessionId: "bridge", entries, ui: [], live: [],
    final: { source, segments: [final("a", 0n, 1440n)], warnings: [] }, uiLossReason: null, wordingLossReason: null });
  const continuous = await run([frame(0), frame(1), frame(2)]); assert.ok(continuous.segments[0]?.wall);
  for (const middle of [[{ kind: "discontinuity" as const, captureEpoch: 1n, reason: "pause" }, frame(1)],
    [{ ...frame(1), wall: null }], [{ ...frame(1), wall: { ...frame(1).wall!, wallRun: 2n } }]]) {
    const result = await run([frame(0), ...middle, frame(2)]);
    assert.equal(result.segments[0]?.wall, null); assert.equal(result.segments[0]?.text, "final wording");
  }
  await assert.rejects(run([frame(0), { ...frame(1), mediaStartSample: 481n }, frame(2)]), /hole/);
  await assert.rejects(run([{ ...frame(0), epoch: { ...frame(0).epoch!, bridgeSessionId: "foreign" } }, frame(1), frame(2)]), /bridge/);
});

test("freshness keeps huge host coordinates and the conservative prior-before two-second boundary", async () => {
  const source = { sourceSessionId: 41n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64) }, hostEnd = 9007201500000003n;
  const frame = { ...frameWall(), provenance: { ...frameWall().provenance!, span: { ...frameWall().provenance!.span!,
    hostStartNs: hostEnd - 20000000n, hostEndNs: hostEnd } } };
  for (const delta of [-1n, 0n, 1n]) {
    const before = hostEnd - 2000000000n + delta;
    const result = await merge.mergeTimedRecordingEvidence({ source, bridgeSessionId: "bridge", entries: [frame],
      ui: [joinedUi(), { ...ui(2, before, null), observationTiming: { clockDomainId: "domain", hostBeforeNs: before.toString(), hostAfterNs: (before + 100n).toString() } },
        ui(3, hostEnd - 30000000n), ui(4, hostEnd)], live: [], final: { source, segments: [final("a", 0n, 480n)], warnings: [] }, uiLossReason: null, wordingLossReason: null });
    assert.equal(result.segments[0]?.speaker.kind, delta < 0n ? "anonymous" : "named");
  }
});

test("partial contributions require whole-frame coverage without imposing a global hundred-percent naming rule", async () => {
  const source = { sourceSessionId: 41n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64) };
  const second = { ...frameWall(), mediaStartSample: 480n, mediaEndSample: 960n,
    provenance: { ...frameWall().provenance!, sequence: 2n, outputStartSample: 480n,
      span: { ...frameWall().provenance!.span!, hostStartNs: 1020000000n, hostEndNs: 1040000000n } } };
  const run = (start: bigint, end: bigint) => merge.mergeTimedRecordingEvidence({ source, bridgeSessionId: "bridge", entries: [frameWall(), second],
    ui: [joinedUi(), ui(2, 900000000n, null), ui(3, 990000000n), ui(4, 1020000000n)], live: [],
    final: { source, segments: [final("a", start, end)], warnings: [] }, uiLossReason: null, wordingLossReason: null });
  const mostly = await run(1n, 500n);
  assert.equal(mostly.segments[0]?.speaker.kind, "named");
  assert.equal(owned.getOwnedTimedSampleSnapshot(mostly.segments[0]?.sampleEvidence)?.candidateLower[0]?.[1], 478n);
  const tiny = await run(4n, 9n);
  assert.equal(tiny.segments[0]?.speaker.kind, "anonymous");
  assert.equal(owned.getOwnedTimedSampleSnapshot(tiny.segments[0]?.sampleEvidence)?.candidateLower[0]?.[1], 3n);
});

test("missing first touched host timing cannot borrow a later frame end as the freshness origin", async () => {
  const source = { sourceSessionId: 41n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64) };
  const first: merge.AlignmentFrame = { ...frameWall(), mediaEndSample: 20n, provenance: null, wall: null, captureStatus: "capture_alignment_missing" };
  const second = { ...frameWall(), mediaStartSample: 20n, mediaEndSample: 500n,
    provenance: { ...frameWall().provenance!, sequence: 2n, outputStartSample: 20n, sourceStartNumerator: 480000n, sourceEndNumerator: 12000000n } };
  const result = await merge.mergeTimedRecordingEvidence({ source, bridgeSessionId: "bridge", entries: [first, second],
    ui: [joinedUi(), ui(2, 900000000n, null), ui(3, 990000000n), ui(4, 1020000000n)], live: [],
    final: { source, segments: [final("a", 0n, 500n)], warnings: [] }, uiLossReason: null, wordingLossReason: null });
  assert.equal(result.segments[0]?.speaker.kind, "anonymous"); assert.equal(result.segments[0]?.text, "final wording");
});

test("cancellation returns owned iterators without retaining a partial transcript", async () => {
  const abort = new AbortController(), source = { sourceSessionId: 41n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64) };
  let returned = false;
  function* entries() { try { yield frameWall(); abort.abort(); yield frameWall(); } finally { returned = true; } }
  await assert.rejects(merge.mergeTimedRecordingEvidence({ source, bridgeSessionId: "bridge", entries: entries(), ui: [], live: [],
    final: { source, segments: [final("a", 0n, 480n)], warnings: [] }, uiLossReason: null, wordingLossReason: null, signal: abort.signal }), /cancelled/);
  assert.equal(returned, true);
});

test("a result-scoped cluster may veto contradictory earned names but cannot confer a name", async () => {
  const source = { sourceSessionId: 41n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64) };
  const second = { ...frameWall(), mediaStartSample: 480n, mediaEndSample: 960n,
    provenance: { ...frameWall().provenance!, sequence: 2n, outputStartSample: 480n,
      span: { ...frameWall().provenance!.span!, hostStartNs: 1060000000n, hostEndNs: 1080000000n } } };
  const events: BridgeEventMessageV2[] = [joinedUi(), { ...joinedUi(), sequence: 2, feishuUserId: "other" } as BridgeEventMessageV2,
    ui(3, 900000000n, null), ui(4, 990000000n), ui(5, 1020000000n), ui(6, 1030000000n, "other"), ui(7, 1080000000n, "other")];
  const input = { source, bridgeSessionId: "bridge", entries: [frameWall(), second], ui: events, live: [],
    final: { source, segments: [final("a", 0n, 480n), final("b", 480n, 960n)], warnings: [] }, uiLossReason: null, wordingLossReason: null };
  const conflict = await merge.mergeTimedRecordingEvidence(input);
  assert.deepEqual(conflict.segments.map(({ speaker }) => speaker.kind), ["ambiguous", "ambiguous"]);
  assert.equal(conflict.warnings.filter(({ code }) => code === "timed_cluster_conflict").length, 1);
  assert.equal(conflict.transcriptComplete, true);
  const isolated = await merge.mergeTimedRecordingEvidence({ ...input,
    final: { ...input.final, segments: [final("a", 0n, 480n), { ...final("b", 480n, 960n), speakerCluster: "cluster-2" }] } });
  assert.deepEqual(isolated.segments.map(({ speaker }) => speaker), [{ kind: "named", feishuUserId: "person" }, { kind: "named", feishuUserId: "other" }]);
  const noPromotion = await merge.mergeTimedRecordingEvidence({ ...input, ui: events.slice(0, 5) });
  assert.equal(noPromotion.segments[1]?.speaker.kind, "anonymous");
});

test("positive ambiguous UI beyond the fixed conflict allowance remains ambiguous, not missing evidence", async () => {
  const source = { sourceSessionId: 41n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64) };
  const frame = { ...frameWall(), mediaEndSample: 24000n,
    provenance: { ...frameWall().provenance!, sampleCount: 24000, sourceEndNumerator: 576000000n,
      span: { ...frameWall().provenance!.span!, hostEndNs: 2000000000n } } };
  const ambiguous: BridgeEventMessageV2 = { ...ui(2, 1500000000n), state: "ambiguous", feishuUserId: null, reason: null };
  const result = await merge.mergeTimedRecordingEvidence({ source, bridgeSessionId: "bridge", entries: [frame], ui: [joinedUi(), ambiguous], live: [],
    final: { source, segments: [final("a", 0n, 24000n)], warnings: [] }, uiLossReason: null, wordingLossReason: null });
  assert.equal(result.segments[0]?.speaker.kind, "ambiguous");
  assert.equal(result.transcriptComplete, true);
});

const range = (start: bigint, end: bigint) => ({ startSampleInclusive: start, endSampleExclusive: end, sampleRateHz: 24000,
  gapOffsetMs: 0n, quantizationPolicy: "provider_seconds_outward_samples/v1" as const });
const final = (id: string, start: bigint, end: bigint, text = "final wording"): DiarizedSegment => ({ segmentId: id,
  startedAtMs: start / 24n, endedAtMs: end / 24n, text, speakerCluster: "cluster-1", mediaSampleRange: range(start, end) });
const live = (id: string, start: bigint, end: bigint) => ({ segmentId: id, text: "live wording", range: range(start, end) });

test("operational whole-buffer union replaces equal and padded live units, not word identity", () => {
  const equal = merge.selectTimedWording([final("same", 0n, 2400n, "budget deferred")], [{ ...live("same", 0n, 2400n), text: "budget approved" }]);
  assert.deepEqual(equal.units.map(({ segmentId, text }) => [segmentId, text]), [["final:same", "budget deferred"]]);
  assert.equal(equal.uncoveredLive, false);
  assert.equal(merge.selectTimedWording([final("a", 0n, 2640n)], [live("b", 240n, 2400n)]).units.length, 1);
  const padded = merge.selectTimedWording([final("a", 240n, 2400n)], [live("b", 0n, 2640n)]);
  assert.equal(padded.units.length, 2); assert.equal(padded.uncoveredLive, true);
});

test("wording union uses adjacency not80percent and retains uncovered units exactly once", () => {
  const adjacent = merge.selectTimedWording([final("b", 1200n, 2400n, "second"), final("a", 0n, 1200n, "first")], [live("x", 0n, 2400n)]);
  assert.deepEqual(adjacent.units.map(({ text }) => text), ["first", "second"]);
  const gap = merge.selectTimedWording([final("a", 0n, 1199n), final("b", 1200n, 2400n)], [live("x", 0n, 2400n), live("y", 4800n, 7200n)]);
  assert.equal(gap.uncoveredLive, true);
  assert.deepEqual(gap.units.filter(({ wording }) => wording === "live").map(({ segmentId }) => segmentId), ["live:x", "live:y"]);
  assert.equal(merge.selectTimedWording([final("a", 2399n, 4800n)], [live("x", 0n, 2400n)]).uncoveredLive, true);
});

test("synthetic sub-ms buffer coverage stays exact and missing locators cannot authorize replacement", () => {
  assert.equal(merge.selectTimedWording([final("a", 0n, 1n)], [live("x", 0n, 2n)]).uncoveredLive, true);
  assert.equal(merge.selectTimedWording([final("a", 0n, 1n)], [live("x", 0n, 1n)]).units.length, 1);
  const result = merge.selectTimedWording([final("a", 0n, 2400n)], [{ ...live("x", 0n, 2400n), range: null }]);
  assert.equal(result.units.length, 2); assert.equal(result.uncoveredLive, true);
  assert.equal(merge.selectTimedWording([{ ...final("a", 0n, 2400n), mediaSampleRange: null }], [live("x", 0n, 2400n)]).units.length, 2);
});

test("cluster-only fallback preserves the coverage and 500ms jitter gates instead of calling every second label multivoice", () => {
  const first = final("a", 0n, 21600n, ""), second = { ...final("b", 21600n, 22080n, ""), speakerCluster: "cluster-2" };
  const jitter = merge.selectTimedWording([first, second], [live("x", 0n, 22080n)]).units[0]!;
  assert.equal(jitter.cluster, "cluster-1"); assert.equal(jitter.multiVoice, false);
  const two = merge.selectTimedWording([first, { ...second, mediaSampleRange: range(21600n, 43200n) }], [live("x", 0n, 43200n)]).units[0]!;
  assert.equal(two.cluster, null); assert.equal(two.multiVoice, true);
});

test("sample attribution cannot round 79.99 percent upward or a 500ms conflict downward", () => {
  assert.equal(typeof owned.createOwnedTimedSampleEvidence, "function");
  const decide = (candidate: bigint, conflict: bigint, total = 10000n) => {
    const evidence = owned.createOwnedTimedSampleEvidence({ sampleRateHz: 44100, possibleSamples: total,
      candidateLower: [["person", candidate]], observedUpper: [["person", candidate]], ambiguousUpper: conflict,
      unobservedUpper: total - candidate - conflict, freshCandidates: ["person"] });
    return owned.namedTimedCandidate(evidence);
  };
  assert.equal(decide(7999n, 0n), null);
  assert.equal(decide(8000n, 0n), "person");
  assert.equal(decide(8001n, 0n), "person");
  assert.equal(decide(96000n, 22050n, 120000n), "person");
  assert.equal(decide(96000n, 22051n, 120000n), null);
});

test("owned sample evidence rejects copied/mutated attribution and preserves huge bigint totals", () => {
  const total = 9007199254740995n;
  const entries: [string, bigint][] = [["__proto__", total]];
  const evidence = owned.createOwnedTimedSampleEvidence({ sampleRateHz: 24000, possibleSamples: total,
    candidateLower: entries, observedUpper: entries, ambiguousUpper: 0n, unobservedUpper: 0n, freshCandidates: ["__proto__"] });
  entries[0] = ["attacker", total];
  assert.equal(owned.namedTimedCandidate(evidence), "__proto__");
  assert.equal(owned.getOwnedTimedSampleSnapshot({ ...evidence }), null);
  assert.equal(owned.getOwnedTimedSampleSnapshot(evidence)?.possibleSamples, total);
  assert.throws(() => owned.createOwnedTimedSampleEvidence({ sampleRateHz: 24000, possibleSamples: 10n,
    candidateLower: [["x", 11n]], observedUpper: [["x", 10n]], ambiguousUpper: 0n, unobservedUpper: 0n, freshCandidates: ["x"] }), /sample evidence/);
});

test("conservative upper uncertainty is not forced into an exact contribution partition", () => {
  const evidence = owned.createOwnedTimedSampleEvidence({ sampleRateHz: 24000, possibleSamples: 10n,
    candidateLower: [["person", 0n]], observedUpper: [["person", 10n]], ambiguousUpper: 0n,
    unobservedUpper: 10n, freshCandidates: [] });
  assert.equal(owned.namedTimedCandidate(evidence), null);
  assert.equal(owned.getOwnedTimedSampleSnapshot(evidence)?.unobservedUpper, 10n);
});

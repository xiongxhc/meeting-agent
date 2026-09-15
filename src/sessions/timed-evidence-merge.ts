import type { DiarizedMediaSampleRange, DiarizedSegment, RecordingAlignmentEntry, LocalWallEstimate, RecordingIdentity, FinalizedRecordingReconciliation, VersionFourVoiceTranscriptFinalEvent } from "../ports/conversation-runtime.ts";
import type { BridgeEventMessageV2, UiSnapshot } from "../contracts/bridge-session-v2.ts";
import type { TimedEvidenceStatus } from "../ports/session-store.ts";
import type { TimedEvidenceMergeResult, TimedReconciledSegment, TimedTranscriptWarning, TimedWallComponents } from "../domain/transcript.ts";
import { createOwnedTimedSampleEvidence, namedTimedCandidate } from "../domain/attribution-evidence.ts";
import { setImmediate as yieldTurn } from "node:timers/promises";

export type FrameUiEvidence = { candidate: string | null; activationNs: bigint | null; observedIdentities: readonly string[]; ambiguous: boolean };
type UiRun = { id: string; start: bigint; end: bigint; activation: bigint | null };

/** Single forward UI reader: one lookahead, one run, bounded membership; no snapshot history. */
export class FrameUiCursor {
  private readonly iterator: Iterator<BridgeEventMessageV2>;
  private next: IteratorResult<BridgeEventMessageV2> | null = null;
  private readonly bridgeSessionId: string;
  private domain: string | null = null;
  private readonly retired = new Set<string>();
  private matchedDomain = false;
  private rows = 0;
  private sequence = 0;
  private snapshotSequence = 0;
  private lastHost: { before: bigint; after: bigint } | null = null;
  private readonly attendance = new Map<string, bigint>();
  private previous: UiSnapshot | null = null;
  private run: UiRun | null = null;
  private watermark: bigint | null = null;

  constructor(events: Iterable<BridgeEventMessageV2>, bridgeSessionId: string) {
    this.iterator = events[Symbol.iterator](); this.bridgeSessionId = bridgeSessionId;
  }
  private clear() { this.previous = null; this.run = null; this.watermark = null; }
  private peek() { return this.next ??= this.iterator.next(); }
  private take(): BridgeEventMessageV2 {
    const next = this.peek(); if (next.done) throw new Error("timed UI exhausted");
    this.next = null;
    if (++this.rows > 65536) throw new Error("timed UI output bound exceeded");
    return next.value;
  }
  close() { this.iterator.return?.(); }

  read(frame: AlignmentFrame): FrameUiEvidence {
    const empty: FrameUiEvidence = { candidate: null, activationNs: null, observedIdentities: [], ambiguous: false };
    const span = frame.provenance?.span, desired = frame.epoch?.clockDomainId;
    if (!span || !desired || frame.epoch?.bridgeSessionId !== this.bridgeSessionId || frame.captureStatus !== "available" ||
      frame.provenance?.quality !== "nominal_frame_endpoint_interpolation") return empty;
    if (this.domain !== desired) {
      if (this.retired.has(desired)) return empty;
      if (this.domain !== null) this.retired.add(this.domain);
      if (this.retired.size > 65536) throw new Error("timed UI domain bound exceeded");
      this.domain = desired; this.matchedDomain = false; this.lastHost = null; this.attendance.clear(); this.clear();
    }
    const positive = new Set<string>();
    let ambiguous = false;
    const noteRun = () => {
      if (this.run && this.run.start < span.hostEndNs && this.run.end >= span.hostStartNs) positive.add(this.run.id);
    };
    noteRun();
    while (this.watermark === null || this.watermark < span.hostEndNs) {
      const next = this.peek(); if (next.done) break;
      const event = next.value;
      const timing = "observationTiming" in event ? event.observationTiming : null;
      if (timing && timing.clockDomainId !== desired && this.matchedDomain) break; // Leave the next domain for its capture frames.
      this.take();
      if (event.sessionId !== this.bridgeSessionId) throw new Error("timed UI bridge binding changed");
      if (event.sequence <= this.sequence) throw new Error("timed UI sequence regressed");
      if (this.sequence !== 0 && event.sequence !== this.sequence + 1) { this.clear(); this.attendance.clear(); }
      this.sequence = event.sequence;
      if (event.type === "media_disconnected" || event.type === "reconnecting" || event.type === "left") { this.clear(); this.attendance.clear(); continue; }
      // B1 persists admin rows before its observation-only reducer filter.
      if (!("observationTiming" in event)) continue;
      if (!timing || timing.clockDomainId !== desired) { this.clear(); this.attendance.clear(); continue; }
      this.matchedDomain = true;
      const before = BigInt(timing.hostBeforeNs), after = BigInt(timing.hostAfterNs);
      if (after < before || (this.lastHost && (before < this.lastHost.before || after < this.lastHost.after))) throw new Error("timed UI clock regressed");
      this.lastHost = { before, after };
      if (event.type === "participant_joined") {
        if (!this.attendance.has(event.feishuUserId) && this.attendance.size >= 500) throw new Error("timed participant output bound exceeded");
        this.attendance.set(event.feishuUserId, after); continue;
      }
      if (event.type === "participant_left") {
        this.attendance.delete(event.feishuUserId);
        if (this.run?.id === event.feishuUserId) this.clear();
        continue;
      }
      if (event.type === "active_speaker") {
        if (event.confidence === "ambiguous" || this.run?.id !== event.feishuUserId) this.clear();
        if (before <= span.hostEndNs && after >= span.hostStartNs) {
          if (event.confidence === "ambiguous") ambiguous = true;
          else if (event.feishuUserId !== null) positive.add(event.feishuUserId);
        }
        continue;
      }
      if (event.type !== "ui_snapshot") { this.clear(); continue; }
      if (event.snapshotSequence <= this.snapshotSequence) throw new Error("timed UI snapshot sequence regressed");
      if (this.snapshotSequence !== 0 && event.snapshotSequence !== this.snapshotSequence + 1) { this.clear(); this.attendance.clear(); }
      this.snapshotSequence = event.snapshotSequence;
      const prior = this.previous?.observationTiming;
      const adjacent = prior !== null && prior !== undefined && BigInt(prior.hostAfterNs) <= before && after - BigInt(prior.hostBeforeNs) <= 2000000000n;
      if (!adjacent || event.barrierBefore !== null) this.clear();
      if (event.state !== "ui_exact" || event.feishuUserId === null) {
        if (event.state === "ambiguous" && before <= span.hostEndNs && after >= span.hostStartNs) ambiguous = true;
        this.run = null; this.previous = event; continue;
      }
      if (this.run?.id === event.feishuUserId && adjacent) this.run.end = before;
      else {
        const changed = this.previous !== null && ((this.previous.state === "unknown" && this.previous.reason === "no_highlight") ||
          (this.previous.state === "ui_exact" && this.previous.feishuUserId !== event.feishuUserId));
        this.run = { id: event.feishuUserId, start: after, end: before,
          activation: changed && prior ? BigInt(prior.hostBeforeNs) : null };
      }
      this.previous = event; this.watermark = before;
      if (before <= span.hostEndNs && after >= span.hostStartNs) positive.add(event.feishuUserId);
      noteRun();
      if (positive.size > 500) throw new Error("timed attribution output bound exceeded");
    }
    const run = this.run, joined = run === null ? undefined : this.attendance.get(run.id);
    const covered = run !== null && run.start <= span.hostStartNs && run.end >= span.hostEndNs &&
      joined !== undefined && joined <= span.hostStartNs && !ambiguous && positive.size === 1;
    return { candidate: covered ? run.id : null, activationNs: covered ? run.activation : null,
      observedIdentities: [...positive], ambiguous };
  }
}

export type AlignmentFrame = Extract<RecordingAlignmentEntry, { kind: "frame" }>;
export type MappedWallEndpoint = {
  readonly localUnixNs: bigint;
  readonly mappingRoundingNs: bigint;
  readonly wall: LocalWallEstimate;
};
function floorDiv(value: bigint, denominator: bigint): bigint {
  const quotient = value / denominator;
  return value < 0n && value % denominator !== 0n ? quotient - 1n : quotient;
}

/** Frozen artifact precision is microseconds; mathematical floor, including before epoch zero. */
export function localNsToArtifactInstant(localNs: bigint): { instant: string; roundingNs: bigint } {
  if (localNs < -(1n << 63n) || localNs > (1n << 63n) - 1n) throw new Error("unrepresentable local-wall timestamp");
  const micros = floorDiv(localNs, 1000n), seconds = floorDiv(micros, 1000000n), fraction = micros - seconds * 1000000n;
  const iso = new Date(Number(seconds * 1000n)).toISOString();
  if (!/^\d{4}-/.test(iso) || iso.startsWith("0000")) throw new Error("unrepresentable local-wall timestamp");
  return { instant: `${iso.slice(0, 19)}.${fraction.toString().padStart(6, "0")}Z`, roundingNs: localNs - micros * 1000n };
}

/** Nominal local estimate within one admitted frame; not an acoustic endpoint or a host-span claim. */
export function mapFrameWallEndpoint(frame: AlignmentFrame, sample: bigint): MappedWallEndpoint | null {
  const wall = frame.wall;
  if (!wall || !frame.epoch || frame.captureStatus !== "available" || !frame.provenance?.span ||
    frame.provenance.quality !== "nominal_frame_endpoint_interpolation" ||
    sample < frame.mediaStartSample || sample > frame.mediaEndSample || frame.mediaEndSample <= frame.mediaStartSample) return null;
  const denominator = frame.mediaEndSample - frame.mediaStartSample;
  const numerator = (wall.localEndNs - wall.localStartNs) * (sample - frame.mediaStartSample);
  if (numerator < 0n) return null;
  const localUnixNs = wall.localStartNs + numerator / denominator;
  if (localUnixNs < -(1n << 63n) || localUnixNs > (1n << 63n) - 1n) return null;
  return { localUnixNs, mappingRoundingNs: numerator % denominator === 0n ? 0n : 1n, wall };
}

/** Mapped submitted utterance buffer, not a speech/word boundary. */
export type TimedSampleRange = Pick<DiarizedMediaSampleRange, "startSampleInclusive" | "endSampleExclusive" | "sampleRateHz" | "gapOffsetMs">;
export type MappedLiveWording = { readonly segmentId: string; readonly text: string; readonly range: TimedSampleRange | null };
export type TimedWordingUnit = MappedLiveWording & {
  readonly wording: "live" | "reconciled";
  readonly cluster: string | null;
  readonly multiVoice: boolean;
  readonly liveSegmentIds: readonly string[];
};

const compare = (a: bigint, b: bigint) => a < b ? -1 : a > b ? 1 : 0;
const sameRegion = (a: Pick<TimedSampleRange, "sampleRateHz" | "gapOffsetMs">, b: Pick<TimedSampleRange, "sampleRateHz" | "gapOffsetMs">) =>
  a.sampleRateHz === b.sampleRateHz && a.gapOffsetMs === b.gapOffsetMs;
const overlaps = (a: TimedSampleRange | null, b: TimedSampleRange | null) =>
  a !== null && b !== null && sameRegion(a, b) && a.startSampleInclusive < b.endSampleExclusive && b.startSampleInclusive < a.endSampleExclusive;

/** Operational utterance-buffer replacement; this does not establish word identity. */
function covered(target: TimedSampleRange | null, sources: readonly DiarizedSegment[]): boolean {
  if (target === null || target.endSampleExclusive <= target.startSampleInclusive) return false;
  let cursor = target.startSampleInclusive;
  const ranges = sources.flatMap(({ mediaSampleRange }) => mediaSampleRange && sameRegion(target, mediaSampleRange) ? [mediaSampleRange] : [])
    .sort((a, b) => compare(a.startSampleInclusive, b.startSampleInclusive) || compare(a.endSampleExclusive, b.endSampleExclusive));
  for (const range of ranges) {
    if (range.startSampleInclusive > cursor) return false;
    if (range.endSampleExclusive > cursor) cursor = range.endSampleExclusive;
    if (cursor >= target.endSampleExclusive) return true;
  }
  return false;
}

function orderUnits(a: TimedWordingUnit, b: TimedWordingUnit): number {
  if (a.range !== null && b.range !== null) {
    const ar = BigInt(a.range.sampleRateHz), br = BigInt(b.range.sampleRateHz);
    const order = compare((a.range.startSampleInclusive * 1000n + a.range.gapOffsetMs * ar) * br,
      (b.range.startSampleInclusive * 1000n + b.range.gapOffsetMs * br) * ar);
    if (order) return order;
  } else if (a.range !== b.range) return a.range === null ? 1 : -1;
  return a.segmentId < b.segmentId ? -1 : a.segmentId > b.segmentId ? 1 : 0;
}

function clusterForLive(target: TimedSampleRange | null, final: readonly DiarizedSegment[]): { cluster: string | null; multiVoice: boolean } {
  if (!target) return { cluster: null, multiVoice: false };
  const clusters = new Map<string, TimedSampleRange[]>();
  for (const segment of final) if (segment.speakerCluster !== null && overlaps(target, segment.mediaSampleRange ?? null)) {
    const ranges = clusters.get(segment.speakerCluster) ?? [];
    ranges.push(segment.mediaSampleRange!); clusters.set(segment.speakerCluster, ranges);
  }
  const count = (ranges: TimedSampleRange[], inner: boolean) => {
    const sorted = ranges.map((r) => ({ start: maximum(target.startSampleInclusive, r.startSampleInclusive + (inner ? 1n : 0n)),
      end: minimum(target.endSampleExclusive, r.endSampleExclusive - (inner ? 1n : 0n)) })).sort((a, b) => compare(a.start, b.start));
    let end = target.startSampleInclusive, total = 0n;
    for (const range of sorted) if (range.end > end) { total += maximum(0n, range.end - maximum(end, range.start)); end = range.end; }
    return total;
  };
  const ranked = [...clusters].map(([cluster, ranges]) => ({ cluster, lower: count(ranges, true), upper: count(ranges, false) }))
    .sort((a, b) => compare(b.lower, a.lower) || (a.cluster < b.cluster ? -1 : 1));
  const first = ranked[0], total = target.endSampleExclusive - target.startSampleInclusive, rate = BigInt(target.sampleRateHz);
  if (first && 5n * first.lower >= 4n * total && 1000n * ranked.slice(1).reduce((sum, item) => sum + item.upper, 0n) <= 500n * rate) {
    return { cluster: first.cluster, multiVoice: false };
  }
  return { cluster: null, multiVoice: ranked.filter((item) => 1000n * item.lower > 500n * rate).length >= 2 };
}

export function selectTimedWording(final: readonly DiarizedSegment[], live: readonly MappedLiveWording[]): {
  units: TimedWordingUnit[]; uncoveredLive: boolean; missingFinalText: boolean;
} {
  if (final.length > 1024 || live.length > 256 || new Set(final.map(({ segmentId }) => segmentId)).size !== final.length ||
    new Set(live.map(({ segmentId }) => segmentId)).size !== live.length) throw new Error("invalid bounded timed wording input");
  const worded = final.filter((segment) => segment.text.trim() !== "");
  const units: TimedWordingUnit[] = worded.map((segment) => ({
    segmentId: `final:${segment.segmentId}`, text: segment.text, range: segment.mediaSampleRange ?? null,
    wording: "reconciled", cluster: segment.speakerCluster, multiVoice: false,
    liveSegmentIds: live.filter((item) => overlaps(item.range, segment.mediaSampleRange ?? null)).map(({ segmentId }) => segmentId),
  }));
  let uncoveredLive = false;
  for (const segment of live) {
    if (covered(segment.range, worded)) continue;
    units.push({ ...segment, segmentId: `live:${segment.segmentId}`, wording: "live", ...clusterForLive(segment.range, final), liveSegmentIds: [segment.segmentId] });
    if (!covered(segment.range, final)) uncoveredLive = true;
  }
  return { units: units.sort(orderUnits), uncoveredLive, missingFinalText: final.some((segment) => !segment.text.trim()) };
}

const componentKeys = ["maximumBracketNs", "maximumResolutionNs", "modelAllowanceNs", "interpolationRoundingNs", "captureRoundingNs", "captureUncertaintyNs", "externalUtcAccuracyNs"] as const;
function mergeComponents(left: TimedWallComponents | null, right: TimedWallComponents): TimedWallComponents {
  const value = { ...right };
  if (left) for (const key of componentKeys) {
    const a = left[key], b = right[key];
    Object.assign(value, { [key]: a === null || b === null ? null : a > b ? a : b });
  }
  return Object.fromEntries(componentKeys.map((key) => [key, value[key]])) as TimedWallComponents;
}
const maximum = (a: bigint, b: bigint) => a > b ? a : b;
const minimum = (a: bigint, b: bigint) => a < b ? a : b;
const clippedCount = (a: bigint, b: bigint, c: bigint, d: bigint) => maximum(0n, minimum(b, d) - maximum(a, c));
type SampleAccumulator = {
  range: TimedSampleRange | null; final: boolean; covered: bigint;
  lower: Map<string, bigint>; upper: Map<string, bigint>; ambiguous: bigint; unobserved: bigint; fresh: Set<string>;
  firstHostEnd: bigint | null; firstClockDomain: string | null; start: MappedWallEndpoint | null; end: MappedWallEndpoint | null;
  island: string | null; wallInvalid: boolean; components: TimedWallComponents | null; mappingRounding: bigint;
  previousHostEnd: bigint | null;
};
function accumulator(range: TimedSampleRange | null, final: boolean): SampleAccumulator {
  return { range, final, covered: 0n, lower: new Map(), upper: new Map(), ambiguous: 0n, unobserved: 0n, fresh: new Set(),
    firstHostEnd: null, firstClockDomain: null, start: null, end: null, island: null, wallInvalid: false, components: null, mappingRounding: 0n, previousHostEnd: null };
}
function add(map: Map<string, bigint>, key: string, count: bigint) {
  if (!map.has(key) && map.size >= 500) throw new Error("timed attribution output bound exceeded");
  map.set(key, (map.get(key) ?? 0n) + count);
}
function contribute(stats: SampleAccumulator, frame: AlignmentFrame, observation: FrameUiEvidence, barrier: number) {
  const range = stats.range;
  if (!range || !sameRegion(range, frame) || range.startSampleInclusive >= frame.mediaEndSample || range.endSampleExclusive <= frame.mediaStartSample) return;
  const count = clippedCount(range.startSampleInclusive, range.endSampleExclusive, frame.mediaStartSample, frame.mediaEndSample);
  const firstTouched = stats.covered === 0n;
  stats.covered += count;
  const inner = stats.final ? clippedCount(range.startSampleInclusive + 1n, range.endSampleExclusive - 1n, frame.mediaStartSample, frame.mediaEndSample) : count;
  const span = frame.provenance?.span;
  if (firstTouched) { stats.firstHostEnd = span?.hostEndNs ?? null; stats.firstClockDomain = frame.epoch?.clockDomainId ?? null; }
  if (observation.ambiguous || observation.observedIdentities.length > 1) stats.ambiguous += count;
  else if (observation.observedIdentities[0]) add(stats.upper, observation.observedIdentities[0], count);
  if (observation.candidate !== null && frame.captureStatus === "available") {
    add(stats.lower, observation.candidate, inner);
    if (observation.activationNs !== null && stats.firstHostEnd !== null && stats.firstClockDomain === frame.epoch?.clockDomainId &&
      observation.activationNs >= stats.firstHostEnd - 2000000000n) stats.fresh.add(observation.candidate);
    stats.unobserved += count - inner;
  } else stats.unobserved += count;
  const wall = frame.wall, epoch = frame.epoch;
  if (!wall || !epoch || !span) { stats.wallInvalid = true; return; }
  const island = JSON.stringify([barrier, epoch.bridgeSessionId, epoch.clockDomainId, epoch.captureEpoch.toString(), wall.wallEpoch.toString(), wall.wallRun.toString(), frame.gapOffsetMs.toString()]);
  if (stats.island !== null && (stats.island !== island || stats.previousHostEnd === null ||
    span.hostStartNs + 1n < stats.previousHostEnd || span.hostStartNs > stats.previousHostEnd + 1n)) stats.wallInvalid = true;
  stats.island = island; stats.previousHostEnd = span.hostEndNs;
  stats.components = mergeComponents(stats.components, wall);
  if (range.startSampleInclusive >= frame.mediaStartSample && range.startSampleInclusive < frame.mediaEndSample) stats.start = mapFrameWallEndpoint(frame, range.startSampleInclusive);
  if (range.endSampleExclusive > frame.mediaStartSample && range.endSampleExclusive <= frame.mediaEndSample) stats.end = mapFrameWallEndpoint(frame, range.endSampleExclusive);
  stats.mappingRounding = maximum(stats.mappingRounding, maximum(stats.start?.mappingRoundingNs ?? 0n, stats.end?.mappingRoundingNs ?? 0n));
}
function finishSegment(unit: TimedWordingUnit, stats: SampleAccumulator, label: string): TimedReconciledSegment {
  const range = stats.range;
  const total = range === null ? 0n : range.endSampleExclusive - range.startSampleInclusive;
  const sampleEvidence = range === null ? null : createOwnedTimedSampleEvidence({ sampleRateHz: range.sampleRateHz, possibleSamples: total,
    candidateLower: [...stats.lower], observedUpper: [...stats.upper], ambiguousUpper: stats.ambiguous,
    unobservedUpper: stats.unobserved + total - stats.covered, freshCandidates: [...stats.fresh] });
  const candidate = sampleEvidence === null ? null : namedTimedCandidate(sampleEvidence);
  const upper = [...stats.upper.values()].sort((a, b) => compare(b, a));
  const otherUpper = upper.slice(1).reduce((total, value) => total + value, 0n);
  const conflicted = range !== null && (1000n * stats.ambiguous > 500n * BigInt(range.sampleRateHz) ||
    1000n * otherUpper > 500n * BigInt(range.sampleRateHz));
  let wall: TimedReconciledSegment["wall"] = null;
  if (!stats.wallInvalid && stats.start && stats.end && stats.components && stats.covered === total) {
    const start = localNsToArtifactInstant(stats.start.localUnixNs), end = localNsToArtifactInstant(stats.end.localUnixNs);
    wall = { startedAt: start.instant, endedAt: end.instant, components: stats.components, mappingRoundingNs: stats.mappingRounding,
      serializationRoundingNs: maximum(start.roundingNs, end.roundingNs) };
  }
  return { segmentId: unit.segmentId, text: unit.text, range, wording: unit.wording, liveSegmentIds: unit.liveSegmentIds, cluster: unit.cluster,
    speaker: unit.multiVoice || conflicted ? { kind: "ambiguous" } : candidate === null ? { kind: "anonymous", label } : { kind: "named", feishuUserId: candidate }, sampleEvidence, wall };
}

type LiveMapping = { event: VersionFourVoiceTranscriptFinalEvent; stats: SampleAccumulator; nextSource: bigint; nextSequence: bigint; failed: boolean };
function mapLiveFrame(mapping: LiveMapping, frame: AlignmentFrame): boolean {
  const capture = mapping.event.capture, provenance = frame.provenance;
  if (!capture || !provenance || mapping.failed || frame.epoch?.captureEpoch !== capture.captureEpoch || frame.epoch.clockDomainId !== capture.clockDomainId) return false;
  if (provenance.sequence < capture.firstFrameSequence || provenance.sequence > capture.lastFrameSequence) return false;
  const sourceEnd = provenance.outputStartSample + BigInt(provenance.sampleCount);
  const start = maximum(capture.sourceStartSample, provenance.outputStartSample), end = minimum(capture.sourceEndSample, sourceEnd);
  if (frame.sampleRateHz !== capture.sampleRateHz || BigInt(provenance.sampleCount) !== frame.mediaEndSample - frame.mediaStartSample ||
    provenance.sequence !== mapping.nextSequence || start !== mapping.nextSource || end <= start) { mapping.failed = true; return false; }
  const mediaStart = frame.mediaStartSample + start - provenance.outputStartSample;
  if (mapping.stats.range === null) mapping.stats.range = { startSampleInclusive: mediaStart,
    endSampleExclusive: mediaStart + capture.sourceEndSample - capture.sourceStartSample, sampleRateHz: frame.sampleRateHz, gapOffsetMs: frame.gapOffsetMs };
  if (!sameRegion(mapping.stats.range, frame) || mediaStart !== mapping.stats.range.startSampleInclusive + mapping.stats.covered) { mapping.failed = true; return false; }
  mapping.nextSource = end; mapping.nextSequence++;
  return true;
}

export async function mergeTimedRecordingEvidence(input: {
  readonly source: RecordingIdentity; readonly bridgeSessionId: string;
  readonly entries: Iterable<RecordingAlignmentEntry> | AsyncIterable<RecordingAlignmentEntry>; readonly ui: Iterable<BridgeEventMessageV2>;
  readonly live: readonly VersionFourVoiceTranscriptFinalEvent[]; readonly final: FinalizedRecordingReconciliation | { readonly unavailable: true };
  readonly uiLossReason: TimedEvidenceStatus["uiLossReason"]; readonly wordingLossReason: TimedEvidenceStatus["wordingLossReason"];
  readonly signal?: AbortSignal;
}): Promise<TimedEvidenceMergeResult> {
  const final = "unavailable" in input.final ? null : input.final;
  const finalSegments = final?.segments ?? [];
  if (final && (final.source.sourceSessionId !== input.source.sourceSessionId || final.source.recordingHandle !== input.source.recordingHandle ||
    final.source.sha256 !== input.source.sha256)) throw new Error("final recording source changed");
  if (input.live.length > 256 || finalSegments.length > 1024 || input.live.some((event) => event.sessionId !== input.source.sourceSessionId)) throw new Error("invalid bounded timed source input");
  const stats = new Map(finalSegments.map((segment) => [`final:${segment.segmentId}`, accumulator(segment.mediaSampleRange ?? null, true)]));
  const pendingStats = [...stats.values()].filter((item) => item.range !== null)
    .sort((a, b) => compare(a.range!.startSampleInclusive, b.range!.startSampleInclusive));
  let nextStats = 0, activeStats: SampleAccumulator[] = [];
  const liveMappings: LiveMapping[] = input.live.map((event) => ({ event, stats: accumulator(null, false),
    nextSource: event.capture?.sourceStartSample ?? 0n, nextSequence: event.capture?.firstFrameSequence ?? 0n, failed: false }));
  const cursor = new FrameUiCursor(input.ui, input.bridgeSessionId);
  let captureLoss = false, entries = 0, previousEnd = 0n, barrier = 0;
  try {
    for await (const entry of input.entries) {
      if (input.signal?.aborted) throw new Error("timed evidence read cancelled");
      if (++entries > 2000000) throw new Error("timed alignment read bound exceeded");
      if (entries % 64 === 0) await yieldTurn();
      if (entry.kind === "audio_gap") captureLoss = true;
      if (entry.kind === "discontinuity" || entry.kind === "audio_gap" || entry.kind === "alignment_limit" || entry.kind === "epoch") barrier++;
      if (entry.kind !== "frame") continue;
      if (entry.epoch !== null && entry.epoch.bridgeSessionId !== input.bridgeSessionId) throw new Error("timed recording bridge binding changed");
      if (entry.mediaStartSample !== previousEnd) throw new Error("timed recording frame hole or duplicate");
      previousEnd = entry.mediaEndSample;
      const admitted = input.uiLossReason === null ? cursor.read(entry) : { candidate: null, activationNs: null, observedIdentities: [], ambiguous: false };
      while (nextStats < pendingStats.length && pendingStats[nextStats]!.range!.startSampleInclusive < entry.mediaEndSample) activeStats.push(pendingStats[nextStats++]!);
      for (const item of activeStats) contribute(item, entry, admitted, barrier);
      activeStats = activeStats.filter((item) => item.range!.endSampleExclusive > entry.mediaEndSample);
      for (const mapping of liveMappings) if (mapLiveFrame(mapping, entry)) contribute(mapping.stats, entry, admitted, barrier);
    }
  } finally { cursor.close(); }
  const live = liveMappings.map((mapping): MappedLiveWording => {
    const capture = mapping.event.capture;
    if (mapping.failed || !capture || mapping.nextSource !== capture.sourceEndSample || mapping.nextSequence !== capture.lastFrameSequence + 1n) mapping.stats.range = null;
    stats.set(`live:${mapping.event.segmentId}`, mapping.stats);
    return { segmentId: mapping.event.segmentId, text: mapping.event.text, range: mapping.stats.range };
  });
  const wording = selectTimedWording(finalSegments, live), labels = new Map<string, string>();
  let segments = wording.units.map((unit) => {
    const key = unit.cluster ?? unit.segmentId;
    if (!labels.has(key)) labels.set(key, `speaker_${String(labels.size + 1).padStart(2, "0")}`);
    return finishSegment(unit, stats.get(unit.segmentId)!, labels.get(key)!);
  });
  const warnings: TimedTranscriptWarning[] = [];
  const clusterNames = new Map<string, string | null>();
  for (const segment of segments) if (segment.cluster !== null && segment.speaker.kind === "named") {
    const prior = clusterNames.get(segment.cluster);
    clusterNames.set(segment.cluster, prior === undefined || prior === segment.speaker.feishuUserId ? segment.speaker.feishuUserId : null);
  }
  const conflicting = new Set([...clusterNames].filter(([, name]) => name === null).map(([cluster]) => cluster));
  if (conflicting.size) {
    segments = segments.map((segment) => segment.cluster !== null && conflicting.has(segment.cluster) ? { ...segment, speaker: { kind: "ambiguous" } } : segment);
    warnings.push({ code: "timed_cluster_conflict", detail: `conflicting_cluster_count=${conflicting.size}` });
  }
  let wallComponents: TimedWallComponents | null = null, mappingRounding = 0n, serializationRounding = 0n;
  for (const { wall } of segments) if (wall) {
    wallComponents = mergeComponents(wallComponents, wall.components);
    mappingRounding = maximum(mappingRounding, wall.mappingRoundingNs);
    serializationRounding = maximum(serializationRounding, wall.serializationRoundingNs);
  }
  if (wallComponents) warnings.push({ code: "local_wall_timestamp_estimate", detail:
    `policy=local-wall-estimate/v1;componentMaxima;${componentKeys.map((key) => `${key}=${wallComponents[key]};`).join("")}` +
    `mappingRoundingNs=${mappingRounding};serializationRoundingNs=${serializationRounding};overallPhysicalUtcAccuracy=null` });
  if (input.uiLossReason !== null) warnings.push({ code: "timed_ui_evidence_loss", detail: input.uiLossReason });
  if (input.wordingLossReason !== null) warnings.push({ code: "timed_live_wording_loss", detail: input.wordingLossReason });
  if (captureLoss) warnings.push({ code: "timed_capture_loss", detail: "capture_discontinuity" });
  if (wording.uncoveredLive) warnings.push({ code: "timed_live_outside_final", detail: "retained submitted utterance buffer outside final coverage" });
  if (!final) warnings.push({ code: "timed_final_processing_incomplete", detail: "final_reconciliation_unavailable" });
  else if (final.warnings.length) warnings.push({ code: "timed_final_processing_incomplete", detail: `provider_warning_count=${final.warnings.length}` });
  const hasFinalWords = finalSegments.some((segment) => segment.text.trim() !== "");
  return { source: { ...input.source }, segments, warnings, transcriptComplete: final !== null && !captureLoss && !wording.uncoveredLive && final.warnings.length === 0 &&
    (input.wordingLossReason === null || hasFinalWords) };
}

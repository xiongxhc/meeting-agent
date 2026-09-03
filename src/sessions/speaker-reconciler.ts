// The speaker reconciler: provisional live evidence plus post-meeting
// diarization in, a transcript whose speakers are named, anonymous, or
// ambiguous out -- and never guessed.
//
// THE ONE RULE, AND WHERE IT LIVES. A segment becomes a named Feishu person
// from exactly one kind of evidence: the bridge's `ui_exact` active-speaker
// observations, aligned with the segment on the media timeline (see
// attributeFromUi). Nothing else in this module can produce `named`. The
// diarizer's clusters group speech; they never supply identity, and this
// module uses them in one direction only -- TO TAKE A NAME AWAY (see
// applyClusterVetoes). No path here maps a cluster onto a person by attendee
// order, by speaking duration, by who talked most, or by elimination. The
// attendance list is read for one thing: to report who was never named.
//
// WHAT "SUFFICIENTLY ALIGNED" MEANS HERE. Three constants, each with one job:
//
//   MIN_ALIGNED_COVERAGE (0.8): one identity's tile must have been lit for at
//   least this fraction of the segment. The Feishu highlight trails speech by
//   a fraction of a second at both ends and the STT's segment boundaries have
//   their own jitter, so 100% is unreachable in practice; 80% leaves room for
//   that while still requiring the identity to own the segment, not merely
//   touch it. A 50% rule would name a segment that two people split evenly
//   whenever one of them was observed and the other was not.
//
//   MAX_CONFLICTING_OVERLAP_MS (500): positive evidence for anyone else --
//   another identity's tile, or the bridge's own `ambiguous` -- may total at
//   most this much, in ABSOLUTE terms. The fraction alone would let a
//   60-second segment absorb 12 seconds of a second speaker; a second speaker
//   is a second speaker however long the first one talked. Half a second is
//   the scale of UI latency at a hand-off (the old tile still lit while the
//   new one lights), which is the only kind of foreign evidence a named
//   segment may carry.
//
//   FRESH_OBSERVATION_LEAD_MS (2000): the bridge emits an observation only
//   when the highlighted tile CHANGES, and a voice with no tile (a dial-in, a
//   participant whose tile never resolves) changes nothing -- so a state can
//   be held long after its speaker fell silent. An observation is "fresh" for
//   a segment when it was made no earlier than this before the segment began
//   and no later than its end: the tile lit for THIS turn. A held state is
//   trusted only where the diarizer corroborates it -- the segment's cluster
//   has some segment for which that identity's tile freshly lit. Two seconds
//   is the scale of a turn boundary; a held state older than that on a
//   cluster the identity was never fresh on is treated as a relic.
//
// THE TWO BACKENDS (ruling R55). With the online diarization backend the
// reconciliation carries text and its segments are the transcript's units.
// With the local SpeechBrain sidecar it carries anonymous clusters and EMPTY
// text: the live streaming segments are then the units, and the diarization
// contributes only cluster boundaries, matched by media-timeline overlap. Both
// paths share every attribution rule; only where the words come from differs,
// and `provenance.wording` says which.
//
// INCOMPLETENESS IS A FIELD. `transcriptComplete` is false whenever the final
// transcription did not happen or did not finish -- see
// INCOMPLETE_TRANSCRIPT_CODES in src/domain/transcript.ts. Attribution
// warnings (a conflicted cluster, a straddling segment) are on the record but
// are not incompleteness: re-running the reconciliation would not change them.

import type { AttendanceInterval } from "../domain/participants.ts";
import {
  INCOMPLETE_TRANSCRIPT_CODES,
  type ActiveSpeakerObservation,
  type AttributionReason,
  type ReconciledSegment,
  type ReconciledTranscript,
  type SpeakerAttribution,
  type TranscriptWarning,
} from "../domain/transcript.ts";
import type {
  ConversationRuntimePort,
  DiarizedSegment,
  RecordingReconciliation,
  TranscriptSegment,
} from "../ports/conversation-runtime.ts";
import type { RecordingRow } from "../ports/session-store.ts";

export const MIN_ALIGNED_COVERAGE = 0.8;
export const MAX_CONFLICTING_OVERLAP_MS = 500;
export const FRESH_OBSERVATION_LEAD_MS = 2_000;

export type ReconcileTranscriptInput = {
  /** Actual joiners, from src/domain/participants.ts. Used only to report
   * silent attendees -- never to attribute. */
  readonly attendance: readonly AttendanceInterval[];
  /** Finalized live segments, wall-clock timestamps, as the session retained
   * them (MeetingSessionState.liveTranscript). */
  readonly liveSegments: readonly TranscriptSegment[];
  /** The bridge's active-speaker observations, wall-clock, as the session
   * retained them (MeetingSessionState.speakerEvidence). */
  readonly evidence: readonly ActiveSpeakerObservation[];
  /** The runtime's reconciliation, or why there is none. */
  readonly reconciliation: RecordingReconciliation | { readonly unavailable: string };
  /** The wall-clock instant at media-timeline zero -- the start of the
   * recording. Live segments and observations are converted onto the media
   * timeline against it. */
  readonly mediaOriginAt: string;
  /** When the meeting ended. Closes the last observed active-speaker state. */
  readonly endedAt: string;
};

/**
 * Pure. Same inputs, same transcript; no clock, no I/O.
 */
export function reconcileTranscript(input: ReconcileTranscriptInput): ReconciledTranscript {
  const originMs = parseInstant(input.mediaOriginAt, "mediaOriginAt");
  const endedAtMs = parseInstant(input.endedAt, "endedAt") - originMs;

  const evidence = [...input.evidence].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const states = evidenceStates(evidence, originMs, endedAtMs);

  const live: LiveInterval[] = input.liveSegments
    .map((segment) => ({
      segmentId: segment.segmentId,
      start: parseInstant(segment.startedAt, `segment ${segment.segmentId} startedAt`) - originMs,
      end: parseInstant(segment.endedAt, `segment ${segment.segmentId} endedAt`) - originMs,
      text: segment.text,
    }))
    .sort(byStartThenId);

  const warnings: TranscriptWarning[] = [];
  const units = buildUnits(live, input.reconciliation, warnings);

  // Attribution from UI evidence -- the only source of a name.
  const attributed = units.map((unit) => ({ unit, ...attributeFromUi(unit, states) }));

  // Clusters can veto a name; they cannot grant one.
  applyClusterVetoes(attributed, warnings);

  // speaker_NN labels, numbered by first appearance of each cluster.
  const labels = new Map<string, string>();
  for (const { unit } of attributed) {
    if (unit.cluster !== null && !labels.has(unit.cluster)) {
      labels.set(unit.cluster, `speaker_${String(labels.size + 1).padStart(2, "0")}`);
    }
  }

  const named = new Set<string>();
  const segments: ReconciledSegment[] = attributed.map(({ unit, reason, candidate, uiExactMs, ambiguousMs, unobservedMs }) => {
    let speaker: SpeakerAttribution;
    if (reason === "ui_aligned" && candidate !== null) {
      speaker = { kind: "named", feishuUserId: candidate };
      named.add(candidate);
    } else if (reason === "ui_conflict" || reason === "ui_ambiguous" || reason === "multi_voice" || reason === "cluster_conflict") {
      speaker = { kind: "ambiguous" };
    } else {
      speaker = { kind: "anonymous", label: unit.cluster === null ? null : (labels.get(unit.cluster) ?? null) };
    }
    return {
      segmentId: unit.segmentId,
      startedAtMs: unit.start,
      endedAtMs: unit.end,
      text: unit.text,
      speaker,
      cluster: unit.cluster,
      provenance: {
        wording: unit.wording,
        liveSegmentIds: unit.liveSegmentIds,
        reason,
        uiExactMs,
        ambiguousMs,
        unobservedMs,
      },
    };
  });

  const attendees = [...new Set(input.attendance.map((interval) => interval.feishuUserId))].sort();

  return {
    segments,
    warnings,
    transcriptComplete: !warnings.some((warning) => INCOMPLETE_TRANSCRIPT_CODES.has(warning.code)),
    evidence,
    silentAttendees: attendees.filter((id) => !named.has(id)),
  };
}

export type ReconcileSpeakersInput = Omit<ReconcileTranscriptInput, "reconciliation"> & {
  readonly occurrenceId: string;
  /** Where the finalized recording's handle is PERSISTED -- the coordinator
   * (SessionCoordinator.recording) or the store behind it. The handle is
   * read from here, never assumed to still be in memory: after a restart the
   * session object is gone and this row is the only reference to the audio. */
  readonly recordings: { recording(occurrenceId: string): RecordingRow | null };
  readonly runtime: Pick<ConversationRuntimePort, "reconcileRecording">;
};

export type SpeakerReconciliationResult = ReconciledTranscript & {
  /** The persisted handle the reconciliation was requested for, or null when
   * no recording was ever persisted for the occurrence. */
  readonly recordingHandle: string | null;
};

/**
 * Reads the persisted recording handle, asks the runtime to reconcile that
 * recording, and reconciles the transcript. NEVER THROWS for a missing
 * recording or a runtime failure: both become `reconciliation_unavailable`,
 * the transcript is built from the live segments, and `transcriptComplete`
 * is false -- which is what the backfill worker keys on to try again.
 *
 * Post-meeting only. The runtime refuses reconcileRecording while a voice
 * session is live on the same session; a refusal surfaces here as
 * `reconciliation_unavailable` like any other failure.
 */
export async function reconcileSpeakers(input: ReconcileSpeakersInput): Promise<SpeakerReconciliationResult> {
  const { occurrenceId, recordings, runtime, ...rest } = input;
  const row = recordings.recording(occurrenceId);
  if (row === null) {
    return {
      recordingHandle: null,
      ...reconcileTranscript({
        ...rest,
        reconciliation: { unavailable: `no persisted recording for occurrence ${occurrenceId}` },
      }),
    };
  }

  let reconciliation: ReconcileTranscriptInput["reconciliation"];
  try {
    reconciliation = await runtime.reconcileRecording({ recordingHandle: row.handle });
  } catch (error) {
    reconciliation = { unavailable: error instanceof Error ? error.message : String(error) };
  }
  return { recordingHandle: row.handle, ...reconcileTranscript({ ...rest, reconciliation }) };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Interval = { readonly start: number; readonly end: number };

type LiveInterval = Interval & { readonly segmentId: string; readonly text: string };

/** One transcript unit before attribution: a worded diarized segment, or a
 * live segment the reconciliation did not supersede. */
type Unit = Interval & {
  readonly segmentId: string;
  readonly text: string;
  readonly cluster: string | null;
  readonly wording: "reconciled" | "live";
  readonly liveSegmentIds: readonly string[];
  /** The live segment spanned two or more voice clusters. */
  readonly multiVoice: boolean;
};

/** One observed active-speaker state, from its observation to the next. */
type EvidenceState = Interval & { readonly observation: ActiveSpeakerObservation };

type UiAttribution = {
  readonly reason: AttributionReason;
  /** The identity `ui_aligned` would name. Null for every other reason. */
  readonly candidate: string | null;
  /** Whether `candidate`'s tile lit for THIS segment (fresh), as opposed to
   * being a state held over from an earlier turn. */
  readonly fresh: boolean;
  readonly uiExactMs: Record<string, number>;
  readonly ambiguousMs: number;
  readonly unobservedMs: number;
};

function parseInstant(value: string, what: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`${what} is not a timestamp: ${JSON.stringify(value)}`);
  return ms;
}

function overlap(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function duration(interval: Interval): number {
  return Math.max(0, interval.end - interval.start);
}

function byStartThenId(a: { start: number; segmentId: string }, b: { start: number; segmentId: string }): number {
  return a.start !== b.start ? a.start - b.start : a.segmentId.localeCompare(b.segmentId);
}

/** The bridge emits an observation only when the highlighted tile changes,
 * so each observation is the state from its instant until the next one; the
 * last holds to the end of the meeting. Whether a HELD state may name a
 * segment is decided later, against the cluster (see applyClusterVetoes). */
function evidenceStates(
  evidence: readonly ActiveSpeakerObservation[],
  originMs: number,
  endedAtMs: number,
): EvidenceState[] {
  const states: EvidenceState[] = [];
  for (let i = 0; i < evidence.length; i += 1) {
    const observation = evidence[i] as ActiveSpeakerObservation;
    const next = evidence[i + 1];
    const start = parseInstant(observation.observedAt, "observation observedAt") - originMs;
    const end = next === undefined ? Math.max(start, endedAtMs) : parseInstant(next.observedAt, "observation observedAt") - originMs;
    states.push({ start, end, observation });
  }
  return states;
}

function buildUnits(
  live: readonly LiveInterval[],
  reconciliation: ReconcileTranscriptInput["reconciliation"],
  warnings: TranscriptWarning[],
): Unit[] {
  if ("unavailable" in reconciliation) {
    warnings.push({ code: "reconciliation_unavailable", detail: reconciliation.unavailable });
    return live.map((segment) => liveUnit(segment, null, false));
  }

  for (const detail of reconciliation.warnings) warnings.push({ code: "runtime_warning", detail });

  const diarized: DiarizedSegment[] = [...reconciliation.segments].sort(
    (a, b) => (a.startedAtMs !== b.startedAtMs ? a.startedAtMs - b.startedAtMs : a.segmentId.localeCompare(b.segmentId)),
  );
  if (diarized.length === 0 && live.length > 0) warnings.push({ code: "reconciliation_empty" });

  const worded = diarized.filter((segment) => segment.text.trim() !== "");
  if (worded.length < diarized.length) {
    warnings.push({ code: "reconciled_text_missing", segments: diarized.length - worded.length });
  }

  const units: Unit[] = worded.map((segment) => {
    const interval = { start: segment.startedAtMs, end: segment.endedAtMs };
    return {
      ...interval,
      segmentId: segment.segmentId,
      text: segment.text,
      cluster: segment.speakerCluster,
      wording: "reconciled",
      liveSegmentIds: live.filter((l) => overlap(l, interval) > 0).map((l) => l.segmentId),
      multiVoice: false,
    };
  });

  const outside: string[] = [];
  const multiVoice: string[] = [];
  for (const segment of live) {
    // A live segment the reconciled wording covers is superseded by it.
    const consumedMs = worded.reduce((sum, d) => sum + overlap(segment, { start: d.startedAtMs, end: d.endedAtMs }), 0);
    if (worded.length > 0 && duration(segment) > 0 && consumedMs >= MIN_ALIGNED_COVERAGE * duration(segment)) continue;

    const { cluster, straddles } = clusterFor(segment, diarized);
    units.push(liveUnit(segment, cluster, straddles));
    if (worded.length > 0) outside.push(segment.segmentId);
    if (straddles) multiVoice.push(segment.segmentId);
  }
  if (outside.length > 0) warnings.push({ code: "live_segment_outside_reconciliation", segmentIds: outside });
  if (multiVoice.length > 0) warnings.push({ code: "multi_voice_live_segment", segmentIds: multiVoice });

  return units.sort(byStartThenId);
}

function liveUnit(segment: LiveInterval, cluster: string | null, multiVoice: boolean): Unit {
  return {
    start: segment.start,
    end: segment.end,
    segmentId: segment.segmentId,
    text: segment.text,
    cluster,
    wording: "live",
    liveSegmentIds: [segment.segmentId],
    multiVoice,
  };
}

/** The voice cluster a live segment sits in, by the same alignment rule as
 * UI evidence: one cluster covering MIN_ALIGNED_COVERAGE of it with at most
 * MAX_CONFLICTING_OVERLAP_MS of any other. Two clusters each past the cap is
 * overlapping speech the STT ran together -- `straddles`. */
function clusterFor(
  segment: LiveInterval,
  diarized: readonly DiarizedSegment[],
): { cluster: string | null; straddles: boolean } {
  const byCluster = new Map<string, number>();
  for (const d of diarized) {
    if (d.speakerCluster === null) continue;
    const ms = overlap(segment, { start: d.startedAtMs, end: d.endedAtMs });
    if (ms > 0) byCluster.set(d.speakerCluster, (byCluster.get(d.speakerCluster) ?? 0) + ms);
  }
  const ranked = [...byCluster.entries()].sort((a, b) => b[1] - a[1]);
  const dominant = ranked[0];
  if (dominant === undefined || duration(segment) === 0) return { cluster: null, straddles: false };
  const others = ranked.slice(1).reduce((sum, [, ms]) => sum + ms, 0);
  if (dominant[1] >= MIN_ALIGNED_COVERAGE * duration(segment) && others <= MAX_CONFLICTING_OVERLAP_MS) {
    return { cluster: dominant[0], straddles: false };
  }
  const pastCap = ranked.filter(([, ms]) => ms > MAX_CONFLICTING_OVERLAP_MS).length;
  return { cluster: null, straddles: pastCap >= 2 };
}

/** The only function that can propose a name. */
function attributeFromUi(unit: Unit, states: readonly EvidenceState[]): UiAttribution {
  const uiExactMs: Record<string, number> = {};
  let ambiguousMs = 0;
  let observedMs = 0;
  const fresh = new Set<string>();
  for (const state of states) {
    const ms = overlap(unit, state);
    if (ms > 0) {
      observedMs += ms;
      if (state.observation.confidence === "ui_exact") {
        const id = state.observation.feishuUserId;
        uiExactMs[id] = (uiExactMs[id] ?? 0) + ms;
      } else {
        ambiguousMs += ms;
      }
    }
    if (
      state.observation.confidence === "ui_exact" &&
      state.start >= unit.start - FRESH_OBSERVATION_LEAD_MS &&
      state.start < unit.end
    ) {
      fresh.add(state.observation.feishuUserId);
    }
  }
  const dur = duration(unit);
  const unobservedMs = Math.max(0, dur - observedMs);
  const base = { uiExactMs, ambiguousMs, unobservedMs, candidate: null, fresh: false };

  if (unit.multiVoice) return { ...base, reason: "multi_voice" };
  if (dur === 0 || observedMs === 0) return { ...base, reason: "no_signal" };

  const ranked = Object.entries(uiExactMs).sort((a, b) => b[1] - a[1]);
  const dominant = ranked[0];
  if (dominant === undefined) {
    return { ...base, reason: ambiguousMs > MAX_CONFLICTING_OVERLAP_MS ? "ui_ambiguous" : "no_signal" };
  }
  const [identity, coveredMs] = dominant;
  const otherIdentitiesMs = ranked.slice(1).reduce((sum, [, ms]) => sum + ms, 0);
  const conflictingMs = otherIdentitiesMs + ambiguousMs;

  if (coveredMs >= MIN_ALIGNED_COVERAGE * dur && conflictingMs <= MAX_CONFLICTING_OVERLAP_MS) {
    return { ...base, reason: "ui_aligned", candidate: identity, fresh: fresh.has(identity) };
  }
  if (otherIdentitiesMs > MAX_CONFLICTING_OVERLAP_MS) return { ...base, reason: "ui_conflict" };
  if (ambiguousMs > MAX_CONFLICTING_OVERLAP_MS) return { ...base, reason: "ui_ambiguous" };
  return { ...base, reason: "ui_insufficient" };
}

type Attributed = UiAttribution & { readonly unit: Unit };

/**
 * Two vetoes, both cluster-wide facts about UI evidence, neither a source of
 * identity:
 *
 *   1. A cluster on which two different identities FRESHLY lit is a cluster
 *      the UI and the diarizer disagree about. Every segment in it becomes
 *      ambiguous; the direct evidence stays in the provenance.
 *   2. A held (non-fresh) name on a cluster whose segments never saw that
 *      identity freshly lit is a stale tile over a voice the UI never
 *      confirmed. The segment becomes anonymous.
 *
 * Segments with no cluster are untouched: with no diarizer there is nothing
 * to corroborate against, and the held state is the best evidence there is.
 */
function applyClusterVetoes(attributed: Attributed[], warnings: TranscriptWarning[]): void {
  const freshByCluster = new Map<string, Set<string>>();
  for (const entry of attributed) {
    if (entry.unit.cluster === null || entry.reason !== "ui_aligned" || entry.candidate === null || !entry.fresh) continue;
    const set = freshByCluster.get(entry.unit.cluster) ?? new Set<string>();
    set.add(entry.candidate);
    freshByCluster.set(entry.unit.cluster, set);
  }

  const conflicted = new Set<string>();
  for (const [cluster, identities] of [...freshByCluster.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (identities.size >= 2) {
      conflicted.add(cluster);
      warnings.push({ code: "cluster_identity_conflict", cluster, feishuUserIds: [...identities].sort() });
    }
  }

  for (let i = 0; i < attributed.length; i += 1) {
    const entry = attributed[i] as Attributed;
    const cluster = entry.unit.cluster;
    if (cluster === null) continue;
    if (conflicted.has(cluster)) {
      attributed[i] = { ...entry, reason: "cluster_conflict", candidate: null };
      continue;
    }
    if (entry.reason === "ui_aligned" && entry.candidate !== null && !(freshByCluster.get(cluster)?.has(entry.candidate) ?? false)) {
      attributed[i] = { ...entry, reason: "ui_unconfirmed", candidate: null };
    }
  }
}

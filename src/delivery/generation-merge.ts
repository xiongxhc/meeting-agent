// One publication from every bridge generation of an occurrence.
//
// A meeting whose bridge failed and was relaunched has one recording per
// generation. The published artifact carries one transcript built from all of
// them, the gaps that really separate them, one attendance list, and the audio
// of a single generation (the bundle holds one audio file); a processing
// warning says so. Pure functions: the backfill worker reads the stored
// generations and passes the reconciled pieces in.

import type { AttendanceInterval } from "../domain/participants.ts";
import type { TimedReconciledTranscript } from "../domain/transcript.ts";
import type { RecordingGapRow } from "../ports/session-store.ts";

export const PARTIAL_AUDIO_WARNING = "audio_partial_generations";

/** The shipped generation's transcript keeps its identity (the artifact's
 * provenance and selected alignment are that generation's); every other
 * generation's segments join it under a generation-qualified id. */
export function mergeGenerationTranscripts(shipped: TimedReconciledTranscript,
  others: readonly { readonly ordinal: number; readonly transcript: TimedReconciledTranscript }[]): TimedReconciledTranscript {
  if (others.length === 0) return shipped;
  const segments = [...shipped.segments, ...others.flatMap(({ ordinal, transcript }) =>
    transcript.segments.map((segment) => ({ ...segment, segmentId: `g${ordinal}:${segment.segmentId}` })))];
  const seen = new Set<string>();
  const warnings = [shipped, ...others.map(({ transcript }) => transcript)].flatMap((transcript) => transcript.warnings).filter((warning) => {
    // The local-wall estimate is one fact about the whole artifact.
    const key = warning.code === "local_wall_timestamp_estimate" ? warning.code : `${warning.code}\u0000${warning.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...shipped, segments, warnings,
    transcriptComplete: shipped.transcriptComplete && others.every(({ transcript }) => transcript.transcriptComplete) };
}

/** Per person, intervals in join order; an interval still open when its
 * generation ended, or overlapping the next, is continuous presence across the
 * relaunch and becomes one interval. */
export function mergeGenerationAttendance(intervals: readonly AttendanceInterval[]): AttendanceInterval[] {
  const byPerson = new Map<string, AttendanceInterval[]>();
  for (const interval of intervals) byPerson.set(interval.feishuUserId, [...(byPerson.get(interval.feishuUserId) ?? []), interval]);
  const merged: AttendanceInterval[] = [];
  for (const list of byPerson.values()) {
    const ordered = [...list].sort((left, right) => Date.parse(left.joinedAt) - Date.parse(right.joinedAt));
    let current: AttendanceInterval | null = null;
    for (const next of ordered) {
      if (current !== null && (current.leftAt === null || Date.parse(next.joinedAt) <= Date.parse(current.leftAt))) {
        const leftAt: string | null = current.leftAt === null || next.leftAt === null ? next.leftAt
          : Date.parse(next.leftAt) >= Date.parse(current.leftAt) ? next.leftAt : current.leftAt;
        current = { feishuUserId: current.feishuUserId, displayName: next.displayName, joinedAt: current.joinedAt, leftAt };
        continue;
      }
      if (current !== null) merged.push(current);
      current = next;
    }
    if (current !== null) merged.push(current);
  }
  return merged;
}

export type PublishedGap = { readonly startedAt: string; readonly endedAt: string; readonly reason: string };

/**
 * The seed's own gaps, exactly, plus every closed gap the other generations
 * recorded (each generation's bridge gaps and the transition gap a recovery
 * generation owns), clamped to the meeting window. An open gap of a failed
 * generation is closed by the next generation's transition gap, so it is not
 * published itself; the last generation has no successor, so its open gaps
 * (`closeAtEnd`) run to the published end. A clamped or overlapping extra is
 * dropped rather than letting it move a seed gap.
 */
export function publishedGaps(input: {
  readonly seedGaps: readonly { readonly direction: string; readonly startedAt: string; readonly endedAt: string | null }[];
  readonly otherGaps: readonly (Pick<RecordingGapRow, "direction" | "startedAt" | "endedAt"> & { readonly closeAtEnd?: boolean })[];
  readonly occurrenceStartedAt: string;
  readonly endedAt: string;
}): PublishedGap[] {
  const start = Date.parse(input.occurrenceStartedAt), end = Date.parse(input.endedAt);
  const kept = input.seedGaps.map((gap) => ({ startedAt: gap.startedAt, endedAt: gap.endedAt ?? input.endedAt, reason: `bridge_${gap.direction}_gap` }));
  const overlaps = (left: PublishedGap, right: PublishedGap) =>
    Date.parse(left.startedAt) < Date.parse(right.endedAt) && Date.parse(right.startedAt) < Date.parse(left.endedAt);
  for (const gap of input.otherGaps) {
    const gapEnd = gap.endedAt ?? (gap.closeAtEnd === true ? input.endedAt : null);
    if (gapEnd === null) continue;
    const from = Date.parse(gap.startedAt), to = Date.parse(gapEnd);
    if (!(to > start && from < end)) continue;
    const candidate = { startedAt: from < start ? input.occurrenceStartedAt : gap.startedAt, endedAt: to > end ? input.endedAt : gapEnd,
      reason: `bridge_${gap.direction}_gap` };
    if (Date.parse(candidate.endedAt) <= Date.parse(candidate.startedAt) || kept.some((existing) => overlaps(existing, candidate))) continue;
    kept.push(candidate);
  }
  return kept.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
}

// The reconciled transcript: the domain's answer to "who said this?", which
// is allowed to be "this person", "this voice", or "cannot say" -- and is
// never a guess.
//
// THREE KINDS OF SPEAKER, AND ONLY THREE. `named` is a Feishu person and is
// reachable from exactly one kind of evidence: the bridge's `ui_exact`
// active-speaker observations aligned with the segment on the media timeline
// (the rule itself lives in src/sessions/speaker-reconciler.ts). `anonymous`
// is a voice: the diarizer's cluster gives it a stable `speaker_NN` label,
// and when there is no cluster it still receives a stable `speaker_NN` label
// by transcript order. `ambiguous` is positive evidence that the
// segment cannot be attributed -- two lit tiles, a UI switch inside it, two
// voices in one STT segment, or a cluster whose own evidence disagrees.
//
// EVIDENCE IS KEPT, SEPARATELY FROM THE ANSWER. `ActiveSpeakerObservation`
// is the bridge's observation, verbatim, with its two legal shapes preserved
// (an ambiguous observation cannot carry a person, exactly as the frozen
// contract guarantees on the wire). Every segment carries the millisecond
// arithmetic its attribution was decided on, so the artifact can show WHY a
// segment is named or is not, and a human can disagree with the record in
// hand.
//
// INCOMPLETENESS IS A FIELD. `transcriptComplete` and the closed
// `TranscriptWarning` list are read by the backfill worker and the retention
// monitor; a transcript that is not complete is one whose encrypted audio
// must not be deleted yet.

import type { OwnedUiExactMs } from "./attribution-evidence.ts";
import type { OwnedTimedSampleEvidence } from "./attribution-evidence.ts";
import type { DiarizedMediaSampleRange, LocalWallEstimate, RecordingIdentity } from "../ports/conversation-runtime.ts";

export type TimedWallComponents = Pick<LocalWallEstimate, "maximumBracketNs" | "maximumResolutionNs" | "modelAllowanceNs" |
  "interpolationRoundingNs" | "captureRoundingNs" | "captureUncertaintyNs" | "externalUtcAccuracyNs">;
export type TimedReconciledSegment = {
  readonly segmentId: string;
  readonly text: string;
  readonly range: Pick<DiarizedMediaSampleRange, "startSampleInclusive" | "endSampleExclusive" | "sampleRateHz" | "gapOffsetMs"> | null;
  readonly wording: "live" | "reconciled";
  readonly liveSegmentIds: readonly string[];
  readonly cluster: string | null;
  readonly speaker: SpeakerAttribution;
  readonly sampleEvidence: OwnedTimedSampleEvidence | null;
  readonly wall: { readonly startedAt: string; readonly endedAt: string; readonly components: TimedWallComponents;
    readonly mappingRoundingNs: bigint; readonly serializationRoundingNs: bigint } | null;
};
export type TimedTranscriptWarning = { readonly code: "local_wall_timestamp_estimate" | "timed_ui_evidence_loss" | "timed_live_wording_loss" |
  "timed_final_processing_incomplete" | "timed_capture_loss" | "timed_live_outside_final" | "timed_cluster_conflict"; readonly detail: string };
/** Separate timed path: never reinterprets the legacy single media origin. */
export type TimedEvidenceMergeResult = { readonly source: RecordingIdentity; readonly segments: readonly TimedReconciledSegment[];
  readonly warnings: readonly TimedTranscriptWarning[]; readonly transcriptComplete: boolean };
export type TimedReconciledTranscript = TimedEvidenceMergeResult & {
  readonly kind: "timed_recording_transcript/v1";
  readonly provenance: { readonly occurrenceId: string; readonly bridgeSessionId: string; readonly generationId: string;
    readonly alignmentAttemptId: string; readonly timingContract: "capture-clock/v1"; readonly policyId: "local-wall-estimate/v1" | null };
};

/** One bridge observation of the Feishu active-speaker UI, on the wall
 * clock. Two shapes, never a third: the bridge validator rejects an
 * `ambiguous` observation that names anyone, and this type cannot express
 * one either. */
export type ActiveSpeakerObservation =
  | { readonly bridgeSessionId: string; readonly sequence: number; readonly observedAt: string; readonly observedAtMs?: number; readonly confidence: "ui_exact"; readonly feishuUserId: string }
  | { readonly bridgeSessionId: string; readonly sequence: number; readonly observedAt: string; readonly observedAtMs?: number; readonly confidence: "ambiguous"; readonly feishuUserId: null };

export type SpeakerAttribution =
  | { readonly kind: "named"; readonly feishuUserId: string }
  /** `label` is `speaker_NN`, numbered by first appearance in the transcript.
   * Even an unclustered unit gets one: null would make an unresolved speaker
   * non-deterministic across rendering and recovery. */
  | { readonly kind: "anonymous"; readonly label: string }
  | { readonly kind: "ambiguous" };

/** Why a segment got the attribution it did. One value per segment; the
 * millisecond fields beside it are the evidence the value was decided on. */
export type AttributionReason =
  /** One ui_exact identity covered the segment sufficiently, with at most
   * jitter's worth of evidence for anyone else. Named. */
  | "ui_aligned"
  /** Some ui_exact evidence, not enough of it, and nothing contradicting it.
   * Anonymous, not ambiguous: absence of evidence is not a second speaker. */
  | "ui_insufficient"
  /** Two ui_exact identities each past the jitter allowance. Ambiguous. */
  | "ui_conflict"
  /** The bridge itself said `ambiguous` for enough of the segment: two lit
   * tiles, or one it could not resolve. Ambiguous. */
  | "ui_ambiguous"
  /** No observation of any kind covered the segment. Anonymous. */
  | "no_signal"
  /** The UI evidence would have named this segment, but only as a HELD state
   * (no tile lit for this segment itself) on a cluster that never saw that
   * identity's tile light for any of its segments. The diarizer says a voice
   * the UI never confirmed; the held state is treated as stale. Anonymous. */
  | "ui_unconfirmed"
  /** One live STT segment spans two or more diarized voice clusters:
   * overlapping speech the STT ran together. Ambiguous, no cluster. */
  | "multi_voice"
  /** This segment's cluster carries two different UI-confirmed identities.
   * The UI or the diarizer is wrong about part of the cluster and nothing
   * here can say which part. Ambiguous, cluster-wide. */
  | "cluster_conflict";

export type SegmentProvenance = {
  /** Where the words came from: the post-meeting reconciliation, the live
   * streaming transcript, or nowhere. */
  readonly wording: "reconciled" | "live";
  /** Live segments whose interval overlapped this one (all of them when the
   * wording is live; the superseded ones when it is reconciled). */
  readonly liveSegmentIds: readonly string[];
  readonly reason: AttributionReason;
  /** Milliseconds of this segment during which the UI showed exactly this
   * person's tile lit, per person observed. */
  readonly uiExactMs: OwnedUiExactMs;
  /** Milliseconds under a bridge `ambiguous` observation. */
  readonly ambiguousMs: number;
  /** Milliseconds before the first observation of the meeting -- no state at
   * all, as distinct from an ambiguous one. */
  readonly unobservedMs: number;
};

/** One reconciled transcript segment. Times are on the MEDIA timeline: the
 * recording summary's own clock, in milliseconds from the start of the
 * recording, so they can be compared with the recording's duration and gaps
 * without a conversion the artifact would have to trust. */
export type ReconciledSegment = {
  readonly segmentId: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly text: string;
  readonly speaker: SpeakerAttribution;
  /** The diarizer's anonymous cluster label, verbatim, or null. Never a
   * person: mapping happens in `speaker`, and only from UI evidence. */
  readonly cluster: string | null;
  readonly provenance: SegmentProvenance;
};

/** A durable Runtime-issued relationship between its media timeline and wall
 * clock. It is the only fact that permits a media-relative segment to become
 * a UTC artifact instant; a meeting occurrence start is never a substitute. */
export type MediaTimelineAlignment = {
  readonly kind: "durable_runtime_anchor";
  readonly mediaOriginAt: string;
  readonly runtimeSessionId: bigint;
};

/** The closed warning list. The first four make `transcriptComplete` false;
 * the rest describe attribution and are not incompleteness. */
export type TranscriptWarning =
  /** reconcileRecording could not be called or failed. `detail` is the
   * reason -- never transcript text. */
  | { readonly code: "reconciliation_unavailable"; readonly detail: string }
  /** The reconciliation returned no segments while the live transcript had
   * speech. */
  | { readonly code: "reconciliation_empty" }
  /** Diarized segments without text -- the local diarization backend, which
   * clusters voices without transcribing (ruling R55). The wording fell back
   * to the live segments. `segments` is how many lacked text. */
  | { readonly code: "reconciled_text_missing"; readonly segments: number }
  /** No durable fact relates the bridge/STT wall clock to the Runtime media
   * timeline. Cross-clock matching (and therefore naming) was refused. */
  | { readonly code: "media_timeline_alignment_unavailable" }
  /** Local reconciliation capture is incomplete because a safety bound was
   * exceeded or an untrustworthy legacy child was quarantined on migration. */
  | { readonly code: "durable_evidence_incomplete"; readonly reason: "event_limit_exceeded" | "live_text_limit_exceeded" | "legacy_evidence_invalid_on_migration" }
  /** A warning the runtime attached to the reconciliation, verbatim. */
  | { readonly code: "runtime_warning"; readonly detail: string }
  /** Live segments the reconciled transcript did not cover; kept with their
   * live wording. Speech the STT heard and the diarizer did not. */
  | { readonly code: "live_segment_outside_reconciliation"; readonly segmentIds: readonly string[] }
  /** Live segments that spanned two or more voice clusters. */
  | { readonly code: "multi_voice_live_segment"; readonly segmentIds: readonly string[] }
  /** A cluster whose UI-confirmed identities disagree. */
  | {
      readonly code: "cluster_identity_conflict";
      readonly cluster: string;
      readonly feishuUserIds: readonly string[];
    };

export const INCOMPLETE_TRANSCRIPT_CODES: ReadonlySet<TranscriptWarning["code"]> = new Set<
  TranscriptWarning["code"]
>([
  "reconciliation_unavailable",
  "reconciliation_empty",
  "runtime_warning",
  "live_segment_outside_reconciliation",
  "media_timeline_alignment_unavailable",
  "durable_evidence_incomplete",
]);

export type ReconciledTranscript = {
  /** In media-timeline order. */
  readonly segments: readonly ReconciledSegment[];
  readonly warnings: readonly TranscriptWarning[];
  /** False when any warning in INCOMPLETE_TRANSCRIPT_CODES is present. The
   * single flag the backfill worker and the retention monitor key on. */
  readonly transcriptComplete: boolean;
  /** Null when Task 7 could not durably prove the relation between media zero
   * and wall clock. Task 8 must then refuse to construct a UTC artifact. */
  readonly alignment: MediaTimelineAlignment | null;
  /** The provisional evidence the attribution was decided on, in observation
   * order. Retained so the artifact can carry attribution provenance. */
  readonly evidence: readonly ActiveSpeakerObservation[];
  /** Observed attendees (actual joiners) whom no segment names. Reported,
   * never used: a silent attendee is exactly who elimination would guess. */
  readonly silentAttendees: readonly string[];
  /** Actual attendees for whom the bridge observed speaking during a unit, but
   * whose identity did not meet the naming rule. This is never an input to
   * attribution and is deliberately separate from silence. */
  readonly spokeButUnattributed: readonly string[];
};

/** Processing-warning code for a span in which live speech recognition was
 * down while the recording continued. The transcript is incomplete for it
 * unless final wording from the recording covers it. */
export const RECOGNITION_OUTAGE_WARNING = "live_recognition_outage";

/** A span in which live recognition was down; local clock instants. */
export type RecognitionOutage = { readonly startedAt: string; readonly endedAt: string | null; readonly reason: string };

/** The persisted form: one processing warning per outage, an open one ending
 * at `endedAt`. */
export function recognitionOutageWarnings(outages: readonly RecognitionOutage[], endedAt: string): { readonly code: string; readonly detail: string }[] {
  return outages.map((outage) => ({ code: RECOGNITION_OUTAGE_WARNING,
    detail: `started_at=${outage.startedAt};ended_at=${outage.endedAt ?? endedAt};reason=${outage.reason}` }));
}

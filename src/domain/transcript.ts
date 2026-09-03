// The reconciled transcript: the domain's answer to "who said this?", which
// is allowed to be "this person", "this voice", or "cannot say" -- and is
// never a guess.
//
// THREE KINDS OF SPEAKER, AND ONLY THREE. `named` is a Feishu person and is
// reachable from exactly one kind of evidence: the bridge's `ui_exact`
// active-speaker observations aligned with the segment on the media timeline
// (the rule itself lives in src/sessions/speaker-reconciler.ts). `anonymous`
// is a voice: the diarizer's cluster gives it a stable `speaker_NN` label,
// and when there is no cluster the label is null rather than a fresh number
// per segment, because an unclustered voice is not known to be the same as
// or different from any other. `ambiguous` is positive evidence that the
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

/** One bridge observation of the Feishu active-speaker UI, on the wall
 * clock. Two shapes, never a third: the bridge validator rejects an
 * `ambiguous` observation that names anyone, and this type cannot express
 * one either. */
export type ActiveSpeakerObservation =
  | { readonly observedAt: string; readonly confidence: "ui_exact"; readonly feishuUserId: string }
  | { readonly observedAt: string; readonly confidence: "ambiguous"; readonly feishuUserId: null };

export type SpeakerAttribution =
  | { readonly kind: "named"; readonly feishuUserId: string }
  /** `label` is `speaker_NN`, numbered by first appearance of the voice
   * cluster in the transcript; null when the segment has no cluster. */
  | { readonly kind: "anonymous"; readonly label: string | null }
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
  readonly uiExactMs: Readonly<Record<string, number>>;
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
>(["reconciliation_unavailable", "reconciliation_empty", "reconciled_text_missing", "runtime_warning"]);

export type ReconciledTranscript = {
  /** In media-timeline order. */
  readonly segments: readonly ReconciledSegment[];
  readonly warnings: readonly TranscriptWarning[];
  /** False when any warning in INCOMPLETE_TRANSCRIPT_CODES is present. The
   * single flag the backfill worker and the retention monitor key on. */
  readonly transcriptComplete: boolean;
  /** The provisional evidence the attribution was decided on, in observation
   * order. Retained so the artifact can carry attribution provenance. */
  readonly evidence: readonly ActiveSpeakerObservation[];
  /** Observed attendees (actual joiners) whom no segment names. Reported,
   * never used: a silent attendee is exactly who elimination would guess. */
  readonly silentAttendees: readonly string[];
};

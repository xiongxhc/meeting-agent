// Actual SDK types own postmeeting and opt-in timed live boundaries. The
// injected legacy UTC path remains distinct; no live timestamps are invented.
import type { RuntimeClient, RecordingSummary as SdkRecordingSummary, ProcessedText as SdkProcessedText, FinalizedRecordingCapability,
  RecordingAlignmentPage, RecordingAlignmentComplete, TimedMediaLease, DrainableTimedMediaLease, VersionFourVoiceSessionEvent } from "@conversation/runtime";
export type { ConversationContextExchange, RecordingGap, DiarizedSegment, RecordingReconciliation,
  FinalizedRecordingCapability, RecordingAlignmentPage, RecordingAlignmentComplete,
  AlignmentPolicy, RecordingAlignmentEntry, RuntimeProfile, VersionFourVoiceTranscriptFinalEvent,
  SourceSampleRange, WholeFrameNominalEnvelope, CaptureUnavailableReason } from "@conversation/runtime";
export type { FinalizedRecordingReconciliation, DiarizedMediaSampleRange, RecordingIdentity, LocalWallEstimate } from "@conversation/runtime";
import type { ConversationContextExchange, RecordingGap, RecordingReconciliation } from "@conversation/runtime";

export type ProcessedText = Readonly<Omit<SdkProcessedText, "warnings">> & { readonly warnings: readonly string[] };
/** Actual SDK recovery method, separate from the legacy injected session port. */
export type FinalizedRecordingRuntime = Pick<RuntimeClient<4>, "reconcileFinalizedRecording">;

/** Meeting Agent pins online explicitly; the SDK default remains offline. */
import type { RuntimeProfile } from "@conversation/runtime";

/** SDK spelling: automatic, never the old invented "autonomous" value. */
export type RuntimeResponseMode = "automatic" | "external_gate";

export type RuntimeSessionStatus = "ready" | "degraded" | "unavailable";

/** The unresolved Task 11 media hand-off. This is not represented as an SDK
 * response until Runtime Tasks 6-8 provide the authenticated descriptor. */
export type MediaDescriptor = {
  readonly endpoint: string;
  readonly sessionToken: string;
  readonly format: string;
  readonly expiresAt: string;
};

export type StartVoiceSessionInput = {
  readonly profile: RuntimeProfile;
  readonly responseMode: RuntimeResponseMode;
} & ({ readonly timingContract?: undefined } | { readonly timingContract: "capture-clock/v1"; readonly bridgeSessionId: string });

/** Test/local injection boundary only. Task 11 replaces this with the SDK's
 * eventual session/media construction; production code must not synthesize it. */
export type VoiceSessionHandle = {
  readonly timingContract?: undefined;
  readonly sessionId: bigint;
  readonly profile: RuntimeProfile;
  readonly responseMode: RuntimeResponseMode;
  readonly status: RuntimeSessionStatus;
  readonly media: MediaDescriptor;
} | {
  readonly timingContract: "capture-clock/v1";
  readonly bridgeSessionId: string;
  readonly sessionId: bigint;
  /** Media v2 or v3, exactly as the SDK issued it (D029 §3). The composition
   * starts the drainable session, so a live lease is v3; the v2 shape stays
   * admissible for the legacy timed path and its tests. */
  readonly mediaLease: TimedMediaLease | DrainableTimedMediaLease;
};

/** Exact SDK context shape. It is a conversation exchange, not an ad-hoc
 * metadata blob or serialized wire payload. */

/** Exact SDK recording timeline. Bigints remain bigints at the port boundary;
 * callers may convert only after proving a value is safely representable. */

/** Exact SDK RecordingSummary. `recordingHandle` is opaque and the recording
 * key never leaves the runtime host. */
export type RecordingSummary = Readonly<Omit<SdkRecordingSummary, "gaps">> & { readonly gaps: readonly RecordingGap[] };
/** Legacy injected recordings remain explicitly without restart authority. */
export type FinalizedRecording = RecordingSummary & { readonly recoveryCapability?: FinalizedRecordingCapability };

export type ProcessTextRequest = {
  readonly sessionId: bigint;
  readonly instructions: string;
  readonly input: string;
  readonly outputSchema: Record<string, unknown>;
  readonly maxOutputBytes: number;
};


/** Legacy injected UTC segment. Timed SDK events never fabricate these fields. */
export type TranscriptSegment = {
  readonly segmentId: string;
  readonly text: string;
  readonly final: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
};

export type RuntimeEvent =
  | { readonly type: "timed_voice_event"; readonly bridgeSessionId: string; readonly event: VersionFourVoiceSessionEvent }
  | { readonly type: "transcript_final"; readonly segment: TranscriptSegment }
  | { readonly type: "response_authorized"; readonly segmentId: string }
  | { readonly type: "response_skipped"; readonly segmentId: string; readonly reason: string }
  | { readonly type: "barge_in"; readonly segmentId: string }
  | { readonly type: "provider_unavailable"; readonly detail: string };

export type ConversationRuntimePort = {
  /** Connected control identity, not proof that voice admission has occurred. */
  readonly currentSessionId?: bigint;
  /** Actual adapter requires the explicit timed discriminant and external gate. */
  startVoiceSession(input: StartVoiceSessionInput): Promise<VoiceSessionHandle>;
  seedConversationContext(exchanges: ConversationContextExchange[], operationId: string): Promise<void>;
  authorizeVoiceResponse(input: {
    readonly sessionId: bigint;
    readonly segmentId: string;
    readonly contextExchanges: ConversationContextExchange[];
  }): Promise<bigint>;
  skipVoiceResponse(input: { readonly sessionId: bigint; readonly segmentId: string; readonly reason: string }): Promise<void>;
  /** Post-meeting only; the SDK refuses this while its voice session is live. */
  processText(input: ProcessTextRequest): Promise<ProcessedText>;
  /** Whether the connected Runtime advertised `media_lease_renewal` (read
   * after its ready message). False means "do not renew", never a media loss. */
  supportsMediaLeaseRenewal?(): Promise<boolean>;
  /** Extends the live media credential by one lifetime; resolves to the new
   * expiry (Unix ms). Call only after `supportsMediaLeaseRenewal` is true. */
  renewMediaLease?(input: { readonly sessionId: bigint }): Promise<bigint>;
  /** Post-meeting finalization. Bridge-observed gaps remain separate evidence. */
  finalizeRecording(input: { readonly sessionId: bigint }): Promise<FinalizedRecording>;
  readRecordingAlignment(input: { readonly capability: FinalizedRecordingCapability }): AsyncIterable<RecordingAlignmentPage | RecordingAlignmentComplete>;
  /** Post-meeting only; the SDK refuses this while its voice session is live. */
  reconcileRecording(input: {
    readonly sessionId: bigint;
    readonly recordingHandle: string;
  }): Promise<RecordingReconciliation>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  close(): Promise<void>;
};

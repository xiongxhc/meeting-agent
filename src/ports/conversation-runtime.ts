// Actual SDK types own the postmeeting boundary. Live construction/events are
// still a separate, explicitly fail-closed composition prerequisite.
import type { RecordingSummary as SdkRecordingSummary, ProcessedText as SdkProcessedText, FinalizedRecordingCapability,
  RecordingAlignmentPage, RecordingAlignmentComplete } from "@conversation/runtime";
export type { ConversationContextExchange, RecordingGap, DiarizedSegment, RecordingReconciliation,
  FinalizedRecordingCapability, RecordingAlignmentPage, RecordingAlignmentComplete,
  AlignmentPolicy, RecordingAlignmentEntry, RuntimeProfile } from "@conversation/runtime";
import type { ConversationContextExchange, RecordingGap, RecordingReconciliation } from "@conversation/runtime";

export type ProcessedText = Readonly<Omit<SdkProcessedText, "warnings">> & { readonly warnings: readonly string[] };

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
};

/** Test/local injection boundary only. Task 11 replaces this with the SDK's
 * eventual session/media construction; production code must not synthesize it. */
export type VoiceSessionHandle = {
  readonly sessionId: bigint;
  readonly profile: RuntimeProfile;
  readonly responseMode: RuntimeResponseMode;
  readonly status: RuntimeSessionStatus;
  readonly media: MediaDescriptor;
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


/** Meeting Agent's internal routed event union. Task 11 owns converting the
 * SDK VoiceSession event stream once startVoiceSession has the missing join
 * material; this port never invents an event wire codec. */
export type TranscriptSegment = {
  readonly segmentId: string;
  readonly text: string;
  readonly final: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
};

export type RuntimeEvent =
  | { readonly type: "transcript_final"; readonly segment: TranscriptSegment }
  | { readonly type: "response_authorized"; readonly segmentId: string }
  | { readonly type: "response_skipped"; readonly segmentId: string; readonly reason: string }
  | { readonly type: "barge_in"; readonly segmentId: string }
  | { readonly type: "provider_unavailable"; readonly detail: string };

export type ConversationRuntimePort = {
  /** Explicitly unresolved in the concrete SDK adapter until Task 11. */
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

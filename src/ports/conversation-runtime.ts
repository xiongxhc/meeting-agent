// Conversation Runtime SDK boundary.
//
// The declarations in runtime-sdk-ready.md are authoritative for every SDK
// method below. This package deliberately does not import the SDK yet: Task
// 11 is the one construction boundary where the SDK's current
// startVoiceSession result is insufficient for Meeting Agent. The SDK does
// not yet issue the session ID or authenticated media descriptor that the
// bridge join sequence needs, so the concrete adapter fails closed there.
// Test fakes inject the explicitly-local MeetingVoiceSession only to exercise
// Tasks 1-6 without fabricating a production SDK contract.

/** Meeting Agent pins online explicitly; the SDK default remains offline. */
export type RuntimeProfile = "online" | "offline";

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
export type ConversationContextExchange = { readonly user: string; readonly assistant: string };

/** Exact SDK recording timeline. Bigints remain bigints at the port boundary;
 * callers may convert only after proving a value is safely representable. */
export type RecordingGap = {
  readonly startedAtMs: bigint;
  readonly endedAtMs: bigint | null;
  readonly reason: string;
};

/** Exact SDK RecordingSummary. `recordingHandle` is opaque and the recording
 * key never leaves the runtime host. */
export type RecordingSummary = {
  readonly recordingHandle: string;
  readonly encryptedPath: string;
  readonly sha256: string;
  readonly durationMs: bigint;
  readonly format: string;
  readonly keyId: string;
  readonly gaps: readonly RecordingGap[];
};

export type DiarizedSegment = {
  readonly segmentId: string;
  readonly startedAtMs: bigint;
  readonly endedAtMs: bigint;
  readonly text: string;
  readonly speakerCluster: string | null;
};

export type RecordingReconciliation = {
  readonly segments: readonly DiarizedSegment[];
  readonly warnings: readonly string[];
};

export type ProcessTextRequest = {
  readonly sessionId: bigint;
  readonly instructions: string;
  readonly input: string;
  readonly outputSchema: Record<string, unknown>;
  readonly maxOutputBytes: number;
};

export type ProcessedText = { readonly output: unknown; readonly warnings: readonly string[] };

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
  finalizeRecording(input: { readonly sessionId: bigint }): Promise<RecordingSummary>;
  /** Post-meeting only; the SDK refuses this while its voice session is live. */
  reconcileRecording(input: {
    readonly sessionId: bigint;
    readonly recordingHandle: string;
  }): Promise<RecordingReconciliation>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  close(): Promise<void>;
};

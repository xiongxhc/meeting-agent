// The Conversation Runtime control plane: a PORT.
//
// WHY THIS PORT EXISTS AS AN IN-REPO TYPE RATHER THAN AN IMPORT.
// `@conversation/runtime` is adding startVoiceSession, authorizeVoiceResponse,
// skipVoiceResponse, finalizeRecording, reconcileRecording and processText in
// another repository, and that SDK is not built yet -- the lane handoff file
// runtime-sdk-ready.md does not exist. This plan therefore does NOT take a
// dependency on it. Everything here is declared locally, every test in this
// task runs against the in-repo fake, and the compile-check against the real
// built SDK is deferred to Task 11. src/adapters/conversation-runtime-client.ts
// is the one place that will need to change when it lands: it maps an
// SDK-shaped object onto this port, structurally, with no wire codec of its
// own -- the SDK owns the wire.
//
// TWO PROPERTIES THE SHAPE ITSELF CARRIES:
//
//   1. NO AUDIO. Nothing in this port accepts or returns audio bytes. Media
//      travels on the socket described by MediaDescriptor, between the runtime
//      and the bridge, and the coordinator only ever handles the DESCRIPTOR of
//      that socket. There is no method a frame could arrive on.
//   2. NO PROVIDER. There is no model, no API key, no prompt and no OpenAI
//      anything here. Meeting Agent never calls a provider directly; the
//      runtime does, and this port is the whole of what the Meeting Agent may
//      ask of it.
//
// `SeededContext` (below, on `seedContext`) is imported from
// src/ports/knowledge.ts, a Task 6 addition -- the one place this port
// depends on another one in this codebase. That is the retrieval/knowledge
// domain reaching into the conversation port it has to seed, not the other
// direction: knowledge.ts does not import from this file.

import type { SeededContext } from "./knowledge.ts";

/** Meeting Agent v1 pins `online` explicitly per session; the runtime's own
 * default stays `offline` and is never switched silently. Both values are
 * declared because the port must be able to REPRESENT the runtime answering
 * with a profile we did not ask for -- that mismatch is a case the session
 * has to detect, and a single-member type could not express it. */
export type RuntimeProfile = "online" | "offline";

/** `external_gate` hands the speak/stay-silent decision to the Meeting Agent's
 * invocation gate. `autonomous` lets the runtime decide for itself, which for
 * this product would be unprompted speech, so the session treats it exactly
 * like a profile mismatch. */
export type RuntimeResponseMode = "external_gate" | "autonomous";

export type RuntimeSessionStatus = "ready" | "degraded" | "unavailable";

/** The media socket the runtime opened, described well enough for the bridge
 * to connect to it -- and no more. `format` is the four-part PCM wire form
 * `<encoding>/<sampleRate>/<channels>/<frameMs>ms`; it is passed to the bridge
 * VERBATIM as bridge-session/v1's `connect_media.format`, where the contract
 * validator enforces that grammar. */
export type MediaDescriptor = {
  readonly endpoint: string;
  readonly sessionToken: string;
  readonly format: string;
  readonly expiresAt: string;
};

export type StartVoiceSessionInput = {
  readonly occurrenceId: string;
  readonly profile: RuntimeProfile;
  readonly responseMode: RuntimeResponseMode;
};

/** What the runtime actually opened. The session compares every field against
 * what it asked for: the runtime ANSWERING with a profile is not the same as
 * the runtime HONOURING it, and treating the request as the truth is exactly
 * how a session ends up speaking under a profile nobody chose. */
export type VoiceSessionHandle = {
  readonly runtimeSessionId: string;
  readonly profile: RuntimeProfile;
  readonly responseMode: RuntimeResponseMode;
  readonly status: RuntimeSessionStatus;
  readonly media: MediaDescriptor;
};

/** A gap in the recording, as the runtime accounts for it. Same shape as the
 * bridge's `audio_gap` payload so the two can be compared field for field
 * without a translation step that could quietly normalize a boundary. */
export type RecordingGap = {
  readonly direction: "capture" | "playback";
  readonly startedAt: string;
  readonly endedAt: string | null;
};

export type RecordingHandle = {
  /** An opaque reference to the ENCRYPTED recording. Meeting Agent never holds
   * the recording key and never sees plaintext audio. */
  readonly handle: string;
  readonly sha256: string;
  readonly durationMs: number;
  readonly gaps: readonly RecordingGap[];
};

/** A finalized transcript segment. Structurally satisfies the invocation
 * gate's `InvocationCandidateSegment`, so the gate needs no adapter and no
 * knowledge of this port. `final` is present and always true on this event --
 * the runtime never emits a partial one under `external_gate` -- but it is
 * declared so the gate's own non-final short circuit stays reachable and
 * testable rather than being assumed away here. */
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
  /** A human started speaking while the agent was responding. The turn ends
   * here; the agent does not finish the sentence. */
  | { readonly type: "barge_in"; readonly segmentId: string }
  /** The runtime lost its model provider. Capture continues; speaking cannot. */
  | { readonly type: "provider_unavailable"; readonly detail: string };

export type ConversationRuntimePort = {
  startVoiceSession(input: StartVoiceSessionInput): Promise<VoiceSessionHandle>;

  /** Seeds the context the runtime should draw on when it composes a
   * response for `segmentId` -- current-meeting and Team Vault retrieval
   * results, already bounded, with any unavailability or staleness fact
   * spelled out as text rather than left for the runtime to infer. Must be
   * called before `authorizeVoiceResponse` for the same `segmentId`.
   * Meeting Agent never calls a model provider directly; this is the one
   * door through which retrieved knowledge reaches the runtime that does.
   * See src/sessions/retrieval-router.ts, the only production caller, and
   * src/ports/knowledge.ts for `SeededContext`'s shape. */
  seedContext(context: SeededContext): Promise<void>;

  /** The invocation gate said this segment invoked the agent by name. */
  authorizeVoiceResponse(segmentId: string): Promise<void>;

  /** The invocation gate said it did not. Every finalized segment gets exactly
   * one of these two calls -- silence is a decision the runtime is told about,
   * not an absence of one. */
  skipVoiceResponse(segmentId: string, reason: string): Promise<void>;

  /** Text-in, for a caller that has text the runtime should process. The
   * meeting session NEVER calls this: disclosure is meeting-chat text posted
   * by the bridge, and routing it here would be exactly the spoken disclosure
   * the spec forbids. Declared because the SDK declares it, and asserted
   * un-called by test/meeting-session.test.ts. */
  processText(text: string): Promise<void>;

  /** Closes the recording. `observedGaps` are the gaps the BRIDGE reported, so
   * the runtime can account for time it could not see. */
  finalizeRecording(input: { readonly observedGaps: readonly RecordingGap[] }): Promise<RecordingHandle>;

  /** Re-derives the recording's gap accounting against an authoritative set.
   * Called only when the finalized handle's gaps differ from what the bridge
   * actually observed -- see the meeting session's "exact gap recording". */
  reconcileRecording(input: { readonly gaps: readonly RecordingGap[] }): Promise<RecordingHandle>;

  /** Returns an unsubscribe function. Calling it must stop delivery. */
  subscribe(listener: (event: RuntimeEvent) => void): () => void;

  close(): Promise<void>;
};

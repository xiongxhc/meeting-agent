// A thin structural mapping from the `@conversation/runtime` client onto
// src/ports/conversation-runtime.ts.
//
// STRUCTURE ONLY -- NO WIRE CODEC. The SDK owns the transport, the framing and
// the JSON. Nothing here encodes, decodes, retries, buffers or reorders
// anything: duplicating the SDK's codec is precisely what the plan forbids,
// because two codecs is two truths about the same bytes. What this file does is
// name-level: the SDK's method and event spellings on one side, the port's on
// the other, plus one narrowing of the event union.
//
// The SDK is NOT imported. It is not built yet (the lane handoff file
// runtime-sdk-ready.md does not exist), so `ConversationRuntimeSdk` below is a
// structural description of the surface that repository announced. A
// structural type needs no import to be satisfied: when the real client lands,
// it either satisfies this shape and `createConversationRuntimeClient` accepts
// it unchanged, or it does not and Task 11's compile-check against the built
// SDK says so in one place instead of throughout the session. Every test in
// this task runs against the in-repo fake, never against the SDK.

import type {
  ConversationRuntimePort,
  RecordingGap,
  RecordingHandle,
  RuntimeEvent,
  StartVoiceSessionInput,
  VoiceSessionHandle,
} from "../ports/conversation-runtime.ts";
import type { SeededContext } from "../ports/knowledge.ts";
import type { InvocationDecisionReason, InvocationSink } from "../sessions/invocation-gate.ts";

/** The surface `@conversation/runtime`'s client announces. Structural, so the
 * real client satisfies it without this module importing the package.
 * `seedContext` is a Task 6 addition to the port (src/ports/conversation-
 * runtime.ts) -- the real SDK's actual method for this is unknown until
 * runtime-sdk-ready.md exists; Task 11's compile-check against the built
 * SDK needs to confirm this name and shape, or adjust the forward below. */
export type ConversationRuntimeSdk = {
  startVoiceSession(input: StartVoiceSessionInput): Promise<VoiceSessionHandle>;
  seedContext(context: SeededContext): Promise<void>;
  authorizeVoiceResponse(segmentId: string): Promise<void>;
  skipVoiceResponse(segmentId: string, reason: string): Promise<void>;
  processText(text: string): Promise<void>;
  finalizeRecording(input: { readonly observedGaps: readonly RecordingGap[] }): Promise<RecordingHandle>;
  reconcileRecording(input: { readonly gaps: readonly RecordingGap[] }): Promise<RecordingHandle>;
  on(listener: (event: RuntimeEvent) => void): () => void;
  close(): Promise<void>;
};

/**
 * Wraps an SDK client as a ConversationRuntimePort.
 *
 * The one behavioural line in the whole file is the event filter: the SDK's
 * stream may carry members this product has no use for, and forwarding an
 * event the session cannot name would put an un-routable value into its
 * bounded queue. Unknown members are dropped HERE, at the port boundary, where
 * the closed union is defined -- not deep inside the session's router, where a
 * default branch would quietly absorb them.
 */
export function createConversationRuntimeClient(
  sdk: ConversationRuntimeSdk,
): ConversationRuntimePort {
  return {
    startVoiceSession: (input) => sdk.startVoiceSession(input),
    seedContext: (context) => sdk.seedContext(context),
    authorizeVoiceResponse: (segmentId) => sdk.authorizeVoiceResponse(segmentId),
    skipVoiceResponse: (segmentId, reason) => sdk.skipVoiceResponse(segmentId, reason),
    processText: (text) => sdk.processText(text),
    finalizeRecording: (input) => sdk.finalizeRecording(input),
    reconcileRecording: (input) => sdk.reconcileRecording(input),
    subscribe: (listener) =>
      sdk.on((event) => {
        if (isKnownRuntimeEvent(event)) listener(event);
      }),
    close: () => sdk.close(),
  };
}

const KNOWN_RUNTIME_EVENT_TYPES: readonly string[] = [
  "transcript_final",
  "response_authorized",
  "response_skipped",
  "barge_in",
  "provider_unavailable",
];

function isKnownRuntimeEvent(event: RuntimeEvent): boolean {
  return KNOWN_RUNTIME_EVENT_TYPES.includes(event.type);
}

/**
 * Adapts the runtime port to the invocation gate's two-method sink.
 *
 * The gate (Task 4) already decided; this re-decides NOTHING. It forwards the
 * decision under the same segmentId the gate carried on it, and the gate's
 * dispatcher -- not this adapter -- is what guarantees one call per segment.
 *
 * Both port methods are async and both sink methods return void, so a rejected
 * promise here has nowhere to go. It is routed to `onError` rather than left as
 * an unhandled rejection: a runtime that cannot be told to stay silent is a
 * fact the session must see, and swallowing it would leave the loudest failure
 * mode of this product invisible.
 */
export function createRuntimeInvocationSink(
  runtime: Pick<ConversationRuntimePort, "authorizeVoiceResponse" | "skipVoiceResponse">,
  onError: (segmentId: string, error: unknown) => void,
): InvocationSink {
  return {
    skipVoiceResponse(segmentId: string, reason: InvocationDecisionReason): void {
      runtime.skipVoiceResponse(segmentId, reason).catch((error: unknown) => {
        onError(segmentId, error);
      });
    },
    authorizeVoiceResponse(segmentId: string): void {
      runtime.authorizeVoiceResponse(segmentId).catch((error: unknown) => {
        onError(segmentId, error);
      });
    },
  };
}

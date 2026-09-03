// Structural adapter for the current Conversation Runtime SDK.
//
// There is deliberately no SDK import and no wire codec here. The SDK owns
// transport framing. Task 11 alone owns the still-missing startVoiceSession
// construction: the current SDK VoiceSession has neither the bigint session
// ID nor authenticated media descriptor Meeting Agent needs to join its
// bridge, so this adapter fails closed instead of inventing either value.

import type {
  ConversationContextExchange,
  ConversationRuntimePort,
  ProcessTextRequest,
  ProcessedText,
  RecordingReconciliation,
  RecordingSummary,
  RuntimeEvent,
  RuntimeProfile,
  RuntimeResponseMode,
} from "../ports/conversation-runtime.ts";
import type { InvocationDecisionReason, InvocationSink } from "../sessions/invocation-gate.ts";

/** The currently-built SDK's public client surface, structurally described so
 * a real `RuntimeClient<3>` satisfies it without a dependency or adapter-side
 * protocol types. `startVoiceSession` remains `unknown` because its present
 * VoiceSession result is intentionally opaque until Task 11 can construct a
 * Meeting Agent bridge session from real SDK material. */
export type ConversationRuntimeSdk = {
  startVoiceSession(options?: {
    profile?: RuntimeProfile;
    responseMode?: RuntimeResponseMode;
  }): Promise<unknown>;
  seedConversationContext(exchanges: readonly ConversationContextExchange[], operationId: string): Promise<void>;
  authorizeVoiceResponse(input: {
    sessionId: bigint;
    segmentId: string;
    contextExchanges: ConversationContextExchange[];
  }): Promise<bigint>;
  skipVoiceResponse(input: { sessionId: bigint; segmentId: string; reason: string }): Promise<void>;
  finalizeRecording(input: { sessionId: bigint }): Promise<RecordingSummary>;
  reconcileRecording(input: { sessionId: bigint; recordingHandle: string }): Promise<RecordingReconciliation>;
  processText(input: ProcessTextRequest): Promise<ProcessedText>;
  close(): Promise<void>;
};

export function createConversationRuntimeClient(sdk: ConversationRuntimeSdk): ConversationRuntimePort {
  return {
    async startVoiceSession() {
      // Do not even call the SDK: accepting a VoiceSession that lacks both
      // required fields would force this package to fabricate a session ID or
      // media descriptor. Runtime Tasks 6-8 and Meeting Agent Task 11 close
      // this one explicit construction gap.
      throw new Error("Conversation Runtime startVoiceSession cannot construct a Meeting Agent session before Task 11");
    },
    seedConversationContext: (exchanges, operationId) =>
      sdk.seedConversationContext(exchanges, operationId),
    authorizeVoiceResponse: (input) => sdk.authorizeVoiceResponse(input),
    skipVoiceResponse: (input) => sdk.skipVoiceResponse(input),
    processText: (input) => sdk.processText(input),
    finalizeRecording: (input) => sdk.finalizeRecording(input),
    reconcileRecording: (input) => sdk.reconcileRecording(input),
    // No SDK VoiceSession event stream is available because start is
    // fail-closed above. This inert subscription is safe only in that state;
    // Task 11 replaces it with a real event bridge once it has actual session
    // construction material.
    subscribe: (listener: (event: RuntimeEvent) => void) => {
      void listener;
      return () => {};
    },
    close: () => sdk.close(),
  };
}

/** Adapts a session-aware port to the invocation gate's two-method sink. */
export function createRuntimeInvocationSink(
  runtime: Pick<ConversationRuntimePort, "authorizeVoiceResponse" | "skipVoiceResponse">,
  sessionId: bigint,
  contextExchanges: ConversationContextExchange[],
  onError: (segmentId: string, error: unknown) => void,
): InvocationSink {
  return {
    skipVoiceResponse(segmentId: string, reason: InvocationDecisionReason): void {
      runtime.skipVoiceResponse({ sessionId, segmentId, reason }).catch((error: unknown) => {
        onError(segmentId, error);
      });
    },
    authorizeVoiceResponse(segmentId: string): void {
      runtime.authorizeVoiceResponse({ sessionId, segmentId, contextExchanges }).catch((error: unknown) => {
        onError(segmentId, error);
      });
    },
  };
}
